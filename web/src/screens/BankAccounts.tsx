import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type BankAccount } from '../api';
import { BankCard } from '../components/BankCard';
import { MainAction } from '../components/MainAction';
import { Alert, Empty, PageHeader, toast } from '../components/ui';
import { asciiNumber } from '../format';
import { errorMessage, t } from '../i18n';
import { useBackHandler } from '../nav';
import { confirm, haptic } from '../telegram';
import { validSheba } from './Withdraw';

export function BankAccountsPage() {
    const [accounts, setAccounts] = useState<BankAccount[] | null>(null);
    const [adding, setAdding] = useState(false);
    const [label, setLabel] = useState('');
    const [holder, setHolder] = useState('');
    const [iban, setIban] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const load = useCallback(async () => {
        try { setAccounts((await api.bankAccounts()).accounts); }
        catch (err) { setError(err instanceof ApiError ? err.code : 'unknown'); }
    }, []);
    useEffect(() => { void load(); }, [load]);
    useBackHandler(adding && !busy ? () => { setAdding(false); setError(null); } : null);
    const save = async () => {
        if (busy) return;
        if (!validSheba(iban)) return setError('invalid_sheba');
        if (!label.trim() || !holder.trim()) return setError('invalid_bank_account');
        setBusy(true); setError(null);
        try {
            await api.addBankAccount({ label: label.trim(), holder_name: holder.trim(), iban: `IR${iban}` });
            setAdding(false); setLabel(''); setHolder(''); setIban('');
            haptic('success'); toast(t('banks.saved')); await load();
        } catch (err) { setError(err instanceof ApiError ? err.code : 'unknown'); }
        finally { setBusy(false); }
    };
    const remove = async (account: BankAccount) => {
        if (busy || !(await confirm(t('banks.removeConfirm')))) return;
        setBusy(true);
        try { await api.deleteBankAccount(account.id); toast(t('banks.removed')); await load(); }
        catch (err) { toast(errorMessage(err instanceof ApiError ? err.code : 'unknown'), 'danger'); }
        finally { setBusy(false); }
    };
    return <main className="screen enter">
        <PageHeader title={t(adding ? 'banks.add' : 'banks.title')} />
        {adding ? <>
            <BankCard account={{ label, holder_name: holder, iban: `IR${iban}` }} />
            <div className="field"><div className="field-head"><label htmlFor="bank-label">{t('banks.label')}</label></div><div className="field-box">
                <input id="bank-label" value={label} maxLength={80} onChange={e => setLabel(e.target.value)} />
            </div></div>
            <div className="field"><div className="field-head"><label htmlFor="bank-holder">{t('banks.holder')}</label></div><div className="field-box">
                <input id="bank-holder" value={holder} maxLength={120} onChange={e => setHolder(e.target.value)} />
            </div></div>
            <div className="field"><div className="field-head"><label htmlFor="bank-iban">{t('banks.iban')}</label></div><div className="field-box ltr-box">
                <span className="field-prefix">IR</span><input id="bank-iban" className="ltr" inputMode="numeric" value={iban} maxLength={24}
                    onChange={e => { setIban(asciiNumber(e.target.value).replace(/^IR/i, '').replace(/\D/g, '').slice(0, 24)); setError(null); }} />
            </div></div>
        </> : <>
            {accounts === null ? <p className="hint" role="status">…</p> : !accounts.length ? <Empty text={t('banks.none')} /> :
                <ul className="bank-card-list">{accounts.map(account => <li key={account.id}>
                    <BankCard account={account} />
                    <div className="bank-card-actions"><button type="button" disabled={busy} className="link-button small danger" aria-label={`${t('banks.remove')} ${account.label}`} onClick={() => void remove(account)}>{t('banks.remove')}</button></div>
                </li>)}</ul>}
        </>}
        <Alert code={error} />
        <MainAction text={t(adding ? 'banks.save' : 'banks.add')} busy={busy} onClick={() => adding ? void save() : (setError(null), setAdding(true))} />
    </main>;
}
