import { useCallback, useEffect, useState } from 'react';

import { api, ApiError, type Withdrawal } from '../api';
import { BankIcon } from '../components/icons';
import { MainAction } from '../components/MainAction';
import { Alert, AmountInput, Badge, CoinIcon, Empty, PageHeader, Segmented, toast } from '../components/ui';
import { asciiNumber, assetDigits, assetName, fmtAsset, fmtDateTime, parseAmount, toAmount } from '../format';
import { errorMessage, t, type MessageKey } from '../i18n';
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
                <span className="row-subtitle"><bdi className="ltr">{short}</bdi> · {fmtDateTime(w.created_at)}</span>
            </span>
            <span className="row-end">
                <span className={`status ${w.status}`}>{t(`withdrawal.${w.status}` as MessageKey)}</span>
                {w.status === 'pending' && <button type="button" className="link-button small danger" onClick={() => onCancel(w)}>{t('common.cancel')}</button>}
            </span>
        </li>
    );
}

export function WithdrawPage({ initialAsset }: { initialAsset?: string }) {
    const user = useUser();
    const { info } = useWallet();
    const [networks, setNetworks] = useState<Record<string, string[]>>({});
    const [list, setList] = useState<Withdrawal[] | null>(null);
    const [asset, setAsset] = useState(initialAsset ?? 'IRT');
    const [network, setNetwork] = useState<string | null>(null);
    const [destination, setDestination] = useState('');
    const [amount, setAmount] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [step, setStep] = useState<'form' | 'otp'>('form');

    const load = useCallback(() => api.withdrawals().then((r) => {
        setNetworks(r.networks);
        setList(r.withdrawals);
    }).catch((err) => setError(err instanceof ApiError ? err.code : 'unknown')), []);
    useEffect(() => {
        void load();
    }, [load]);

    const assets = ['IRT', ...Object.keys(networks)].filter((a) => a === 'IRT' || info?.assets.includes(a));
    const assetNetworks = asset === 'IRT' ? [] : networks[asset] ?? [];
    useEffect(() => {
        setNetwork(assetNetworks.length === 1 ? assetNetworks[0] : null);
        setDestination('');
        setAmount('');
        setError(null);
    }, [asset, assetNetworks.join()]);

    const isToman = asset === 'IRT';
    const decimals = Math.min(8, assetDigits(asset));
    const available = balanceOf(info, asset).available;
    const value = parseAmount(amount, isToman ? 0 : decimals);
    const tooMuch = value !== null && Number(value) > available + 1e-12;
    const sheba = asciiNumber(destination).replace(/^IR/i, '');
    const destOk = isToman ? validSheba(sheba) : /^[A-Za-z0-9:_-]{20,128}$/.test(destination.trim());
    const body = {
        asset,
        amount: value ?? '',
        network: isToman ? null : network,
        destination: isToman ? `IR${sheba}` : destination.trim(),
    };

    const next = () => {
        const problem = !isToman && !network ? 'invalid_network'
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
        setDestination('');
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

            {isToman ? (
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
            ) : (
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
