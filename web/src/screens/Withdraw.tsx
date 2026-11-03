import { useCallback, useEffect, useState } from 'react';

import { bankFromIban } from '../banks';
import { api, ApiError, type BankAccount, type Withdrawal } from '../api';
import { BankCard } from '../components/BankCard';
import { ActionSheet } from '../components/ActionSheet';
import { BankIcon } from '../components/icons';
import { MainAction } from '../components/MainAction';
import { Alert, AmountInput, Badge, CoinIcon, Empty, PageHeader, Segmented, toast } from '../components/ui';
import { asciiNumber, assetDigits, assetName, fmtAsset, fmtDateTime, parseAmount, toAmount } from '../format';
import { errorMessage, t, type MessageKey } from '../i18n';
import { useBackHandler, useNav } from '../nav';
import { confirm, haptic, selection } from '../telegram';
import { useUser } from '../user';
import { balanceOf, refreshWallet, useWallet } from '../wallet';
import { OtpForm } from './Otp';

/** An Iranian IBAN: IR and 24 digits whose ISO 13616 mod-97 check holds (as the server checks). */
export function validSheba(digits: string): boolean {
    if (!/^\d{24}$/.test(digits)) return false;
    const moved = `${digits.slice(2)}1827${digits.slice(0, 2)}`;
    return BigInt(moved) % 97n === 1n;
}

function WithdrawalRow({ w, onCancel }: { w: Withdrawal; onCancel: (w: Withdrawal) => void }) {
    const short = w.destination.length > 18 ? `${w.destination.slice(0, 8)}…${w.destination.slice(-6)}` : w.destination;
    return (
        <li className="row compact">
            <CoinIcon asset={w.asset} size={32} />
            <span className="row-text">
                <span className="row-title">{fmtAsset(w.amount, w.asset, { trim: w.asset !== 'IRT' })} {w.asset === 'IRT' ? t('common.toman') : w.asset}</span>
                <span className="row-subtitle">{w.beneficiary_name && <>{w.beneficiary_name} · </>}<bdi className="ltr">{short}</bdi> · {fmtDateTime(w.created_at)}</span>
            </span>
            <span className="row-end">
                <span className={`status ${w.status}`}>{t(`withdrawal.${w.status}` as MessageKey)}</span>
                {w.status === 'pending' && <button type="button" className="link-button small danger" onClick={() => onCancel(w)}>{t('common.cancel')}</button>}
            </span>
        </li>
    );
}

export function WithdrawPage({ initialAsset }: { initialAsset?: string }) {
    const nav = useNav();
    const user = useUser();
    const [accounts, setAccounts] = useState<BankAccount[] | null>(null);
    const [recipient, setRecipient] = useState<'saved' | 'other' | null>(null);
    const [selectedAccount, setSelectedAccount] = useState<BankAccount | null>(null);
    const [beneficiary, setBeneficiary] = useState('');
    const [sheet, setSheet] = useState<'kind' | 'saved' | null>((initialAsset ?? 'IRT') === 'IRT' ? 'kind' : null);
    const { info } = useWallet();
    const [networks, setNetworks] = useState<Record<string, string[]>>({});
    const [list, setList] = useState<Withdrawal[] | null>(null);
    const [asset, setAsset] = useState(initialAsset ?? 'IRT');
    const [network, setNetwork] = useState<string | null>(null);
    const [destination, setDestination] = useState('');
    const [amount, setAmount] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [step, setStep] = useState<'form' | 'otp'>('form');
    useBackHandler(step === 'otp' && (() => setStep('form')));

    const load = useCallback(() => api.withdrawals().then((r) => {
        setNetworks(r.networks);
        setList(r.withdrawals);
    }).catch((err) => setError(err instanceof ApiError ? err.code : 'unknown')), []);
    useEffect(() => {
        void load();
    }, [load]);

    useEffect(() => {
        if (asset !== 'IRT') return;
        let active = true;
        api.bankAccounts().then(r => { if (active) setAccounts(r.accounts); }).catch(err => { if (active) setError(err instanceof ApiError ? err.code : 'unknown'); });
        return () => { active = false; };
    }, [asset]);

    const assets = ['IRT', ...Object.keys(networks)].filter((a) => a === 'IRT' || info?.assets.includes(a));
    const assetNetworks = asset === 'IRT' ? [] : networks[asset] ?? [];
    useEffect(() => {
        setNetwork(assetNetworks.length === 1 ? assetNetworks[0] : null);
        setDestination('');
        setRecipient(null); setSelectedAccount(null); setBeneficiary('');
        setSheet(asset === 'IRT' ? 'kind' : null);
        setAmount('');
        setError(null);
    }, [asset, assetNetworks.join()]);

    const isToman = asset === 'IRT';
    const decimals = Math.min(8, assetDigits(asset));
    const available = balanceOf(info, asset).available;
    const value = parseAmount(amount, isToman ? 0 : decimals);
    const tooMuch = value !== null && Number(value) > available + 1e-12;
    const sheba = asciiNumber(destination).replace(/^IR/i, '');
    const destOk = isToman ? Boolean(recipient && validSheba(sheba) && (recipient !== 'saved' || selectedAccount)) : /^[A-Za-z0-9:_-]{20,128}$/.test(destination.trim());
    const body = {
        asset,
        amount: value ?? '',
        network: isToman ? null : network,
        destination: isToman ? `IR${sheba}` : destination.trim(),
        ...(isToman && recipient ? { recipient_type: recipient, beneficiary_name: beneficiary.trim(), ...(recipient === 'saved' && selectedAccount ? { bank_account_id: selectedAccount.id } : {}) } : {}),
    };

    const next = () => {
        const problem = !isToman && !network ? 'invalid_network'
            : isToman && !recipient ? 'invalid_recipient'
            : isToman && (!beneficiary.trim() || beneficiary.trim().length > 120) ? 'invalid_beneficiary'
            : !destOk ? (isToman ? 'invalid_sheba' : 'invalid_address')
                : !value ? 'invalid_amount'
                    : tooMuch ? 'insufficient_balance' : null;
        if (problem) {
            setError(problem);
            haptic('error');
            return;
        }
        setError(null);
        setStep('otp');
    };

    const submit = async (code: string) => {
        try {
            await api.withdraw({ ...body, code });
        } catch (err) {
            // A problem with the request rather than the code: back to the form to fix it.
            if (err instanceof ApiError && !err.code.startsWith('otp_')) {
                setError(err.code);
                setStep('form');
                return;
            }
            throw err;
        }
        toast(t('withdraw.done'));
        setStep('form');
        setAmount('');
        setDestination(''); setRecipient(null); setSelectedAccount(null); setBeneficiary('');
        void refreshWallet();
        void load();
    };

    const cancel = async (w: Withdrawal) => {
        if (!(await confirm(t('withdraw.cancelConfirm')))) return;
        try {
            await api.cancelWithdrawal(w.id);
            haptic('success');
            toast(t('withdraw.cancelled'));
            void refreshWallet();
            void load();
        } catch (err) {
            haptic('error');
            toast(errorMessage(err instanceof ApiError ? err.code : 'unknown'), 'danger');
        }
    };

    if (step === 'otp') {
        return (
            <main className="screen enter">
                <PageHeader title={t('withdraw.confirmTitle')} />
                <ul className="section">
                    <li className="row compact"><span className="row-title">{t('withdraw.amount')}</span><span className="row-value strong">{fmtAsset(body.amount, asset, { trim: !isToman })} {isToman ? t('common.toman') : asset}</span></li>
                    <li className="row compact"><span className="row-title">{isToman ? t('withdraw.sheba') : t('withdraw.address')}</span><span className="row-value"><bdi className="ltr">{body.destination}</bdi></span></li>
                    {isToman && <li className="row compact"><span className="row-title">{t('banks.holder')}</span><span className="row-value">{beneficiary}</span></li>}
                    {body.network && <li className="row compact"><span className="row-title">{t('withdraw.network')}</span><span className="row-value ltr-inline">{body.network}</span></li>}
                </ul>
                <OtpForm phone={user.phone} send={api.sendWithdrawCode} verify={submit} submitText={t('withdraw.submit')} />
            </main>
        );
    }

    return (
        <main className="screen enter">
            <PageHeader title={t('withdraw.title')} />

            <div className="asset-chips" role="listbox" aria-label={t('withdraw.asset')}>
                {assets.map((a) => (
                    <button key={a} type="button" role="option" aria-selected={a === asset} className={`asset-chip ${a === asset ? 'active' : ''}`}
                            onClick={() => { selection(); setAsset(a); }}>
                        <CoinIcon asset={a} size={22} />
                        <span>{assetName(a)}</span>
                    </button>
                ))}
            </div>

            {assetNetworks.length > 1 && (
                <div className="field">
                    <div className="field-head"><label>{t('withdraw.network')}</label></div>
                    <Segmented value={network ?? ''} onChange={(v) => setNetwork(v)}
                               options={assetNetworks.map((n) => ({ value: n, label: <span className="ltr-inline">{n}</span> }))} />
                </div>
            )}

            {isToman && <>
                <ul className="section"><li><button type="button" className="row tappable" onClick={() => setSheet('kind')}>
                    <BankIcon /><span className="row-text"><span className="row-title">{t('withdraw.recipient')}</span>
                    <span className="row-subtitle">{recipient === 'saved' ? selectedAccount?.label ?? t('withdraw.savedAccount') : recipient === 'other' ? t('withdraw.otherAccount') : t('withdraw.chooseRecipient')}</span></span>
                    <span className="link-button small">{t('withdraw.changeRecipient')}</span>
                </button></li></ul>
                {recipient === 'saved' && <>
                    <button type="button" className="button secondary" onClick={() => setSheet('saved')}>{selectedAccount?.label ?? t('withdraw.savedAccount')}</button>
                    {selectedAccount && <BankCard account={selectedAccount} selected />}
                </>}
                {recipient === 'other' && <div className="field"><div className="field-head"><label htmlFor="beneficiary">{t('banks.holder')}</label></div>
                    <div className="field-box"><input id="beneficiary" value={beneficiary} maxLength={120} onChange={e => { setBeneficiary(e.target.value); setError(null); }} /></div>
                </div>}
                {sheet && <ActionSheet key={sheet} title={t(sheet === 'kind' ? 'withdraw.chooseRecipient' : 'withdraw.savedAccount')}
                    value={sheet === 'saved' ? selectedAccount?.id : recipient ?? undefined}
                    message={sheet === 'saved' && accounts !== null && !accounts.length ? t('banks.none') : undefined}
                    options={sheet === 'kind' ? [
                        { value: 'saved', label: t('withdraw.savedAccount'), description: t('withdraw.savedAccountHint') },
                        { value: 'other', label: t('withdraw.otherAccount'), description: t('withdraw.otherAccountHint') },
                    ] : [...(accounts ?? []).map(a => ({ value: a.id, label: `${bankFromIban(a.iban).name} · ${a.label} · ${a.holder_name} · ${a.iban}`, content: <BankCard account={a} compact selected={selectedAccount?.id === a.id} /> })), { value: 'add', label: t('banks.add') }]}
                    onClose={() => setSheet(current => current === sheet ? null : current)}
                    onSelect={choice => {
                        setError(null);
                        if (sheet === 'kind') {
                            setRecipient(choice as 'saved' | 'other'); setSelectedAccount(null); setDestination(''); setBeneficiary('');
                            setSheet(choice === 'saved' ? 'saved' : null);
                        } else if (choice === 'add') { nav.push({ name: 'bankAccounts' }); }
                        else {
                            const account = accounts?.find(a => a.id === choice);
                            if (account) { setSelectedAccount(account); setDestination(account.iban); setBeneficiary(account.holder_name); setRecipient('saved'); }
                        }
                    }} />}
            </>}

            {isToman ? recipient === 'other' ? (
                <div className={`field ${error === 'invalid_sheba' ? 'invalid' : ''}`}>
                    <div className="field-head"><label htmlFor="sheba">{t('withdraw.sheba')}</label></div>
                    <div className="field-box ltr-box">
                        <span className="field-prefix">IR</span>
                        <input id="sheba" className="ltr" inputMode="numeric" autoComplete="off" placeholder="000000000000000000000000"
                               value={sheba} maxLength={24}
                               onChange={(e) => { setDestination(asciiNumber(e.target.value).replace(/^IR/i, '').replace(/\D/g, '').slice(0, 24)); setError(null); }} />
                        <BankIcon className="field-icon" />
                    </div>
                    <div className="field-hint">{t('withdraw.shebaHint')}</div>
                </div>
            ) : null : (
                <div className={`field ${error === 'invalid_address' ? 'invalid' : ''}`}>
                    <div className="field-head"><label htmlFor="address">{t('withdraw.address')}</label></div>
                    <div className="field-box">
                        <input id="address" className="ltr" autoComplete="off" spellCheck={false} placeholder={network ? t('withdraw.addressOn', { network }) : ''}
                               value={destination} onChange={(e) => { setDestination(e.target.value); setError(null); }} />
                    </div>
                </div>
            )}

            <AmountInput
                id="withdraw-amount"
                label={t('withdraw.amount')}
                value={amount}
                onChange={(v) => { setAmount(v); setError(null); }}
                unit={isToman ? t('common.toman') : asset}
                decimals={isToman ? 0 : decimals}
                invalid={tooMuch}
                action={
                    <button type="button" className="link-button small" onClick={() => setAmount(toAmount(available, isToman ? 0 : decimals))}>
                        {t('common.max')}
                    </button>
                }
                hint={t('withdraw.available', { amount: fmtAsset(available, asset, { floor: true, trim: !isToman }), unit: isToman ? t('common.toman') : asset })}
            />

            <Alert code={error} />

            <section className="notice-card subtle">
                <Badge icon={BankIcon} tone="accent" />
                <p className="hint">{isToman ? t('withdraw.tomanNote') : t('withdraw.cryptoNote')}</p>
            </section>

            <section>
                <h2 className="section-title">{t('withdraw.recent')}</h2>
                {list && !list.length ? <Empty text={t('withdraw.none')} /> : (
                    <ul className="section">{list?.map((w) => <WithdrawalRow key={w.id} w={w} onCancel={cancel} />)}</ul>
                )}
            </section>

            <MainAction text={t('withdraw.continue')} onClick={next} />
        </main>
    );
}
