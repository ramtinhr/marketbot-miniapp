import { useCallback, useEffect, useState } from 'react';

import { api, ApiError, type ChargeInfo, type Payment } from '../api';
import { ClockIcon, CreditCardIcon, ShieldCheckIcon } from '../components/icons';
import { MainAction } from '../components/MainAction';
import { Alert, AmountInput, Badge, Empty, PageHeader, toast } from '../components/ui';
import { fmtDateTime, fmtToman, parseAmount } from '../format';
import { t, type MessageKey } from '../i18n';
import { haptic, openExternal, selection } from '../telegram';
import { balanceOf, refreshWallet, useWallet } from '../wallet';

const PRESETS = [200_000, 500_000, 1_000_000, 5_000_000];
const POLL_MS = 3000;

export function PaymentRow({ p }: { p: Payment }) {
    return (
        <li className="row compact">
            <span className="row-text">
                <span className="row-title">{fmtToman(p.amount_toman)} {t('common.toman')}</span>
                <span className="row-subtitle">{fmtDateTime(p.created_at)}{p.ref_id ? ` · ${t('charge.ref', { ref: p.ref_id })}` : ''}</span>
            </span>
            <span className={`status ${p.status}`}>{t(`payment.${p.status}` as MessageKey)}</span>
        </li>
    );
}

export function ChargePage() {
    const { info: wallet } = useWallet();
    const [info, setInfo] = useState<ChargeInfo | null>(null);
    const [amount, setAmount] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [waiting, setWaiting] = useState<string | null>(null);

    const load = useCallback(() => api.chargeInfo().then(setInfo).catch((err) => setError(err instanceof ApiError ? err.code : 'unknown')), []);
    useEffect(() => {
        void load();
    }, [load]);

    // While the gateway is open in the browser, watch the payment settle.
    useEffect(() => {
        if (!waiting) return;
        let stopped = false;
        const check = async () => {
            const latest = await api.chargeInfo().catch(() => null);
            if (stopped || !latest) return;
            setInfo(latest);
            const payment = latest.payments.find((p) => p.id === waiting);
            if (!payment || payment.status === 'pending') return;
            setWaiting(null);
            if (payment.status === 'paid') {
                haptic('success');
                toast(t('charge.done', { amount: fmtToman(payment.amount_toman) }));
                void refreshWallet();
            } else {
                haptic('error');
                toast(t('charge.failed'), 'danger');
            }
        };
        const id = setInterval(() => document.visibilityState === 'visible' && void check(), POLL_MS);
        const onVisible = () => document.visibilityState === 'visible' && void check();
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            stopped = true;
            clearInterval(id);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [waiting]);

    const value = parseAmount(amount, 0);
    const n = value ? Number(value) : 0;
    const min = info?.min_toman ?? 10_000;
    const max = info?.max_toman ?? 50_000_000;
    const outOfRange = Boolean(amount) && (n < min || n > max);

    const pay = async () => {
        if (busy) return;
        if (!value || outOfRange) {
            setError('amount_out_of_range');
            haptic('error');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const started = await api.charge(n);
            setWaiting(started.payment_id);
            openExternal(started.url);
        } catch (err) {
            haptic('error');
            setError(err instanceof ApiError ? err.code : 'unknown');
        } finally {
            setBusy(false);
        }
    };

    return (
        <main className="screen enter">
            <PageHeader title={t('charge.title')} subtitle={t('charge.balance', { amount: fmtToman(balanceOf(wallet, 'IRT').available) })} />

            {waiting ? (
                <section className="notice-card">
                    <Badge icon={ClockIcon} tone="warning" />
                    <div className="stack">
                        <h2>{t('charge.waitingTitle')}</h2>
                        <p className="hint">{t('charge.waitingBody')}</p>
                        <button type="button" className="link-button" onClick={() => setWaiting(null)}>{t('charge.newPayment')}</button>
                    </div>
                </section>
            ) : (
                <>
                    <AmountInput
                        id="charge-amount"
                        label={t('charge.amount')}
                        value={amount}
                        onChange={(v) => { setAmount(v); setError(null); }}
                        unit={t('common.toman')}
                        decimals={0}
                        invalid={outOfRange}
                        hint={t('charge.limits', { min: fmtToman(min), max: fmtToman(max) })}
                    />
                    <div className="chips">
                        {PRESETS.filter((p) => p <= max).map((p) => (
                            <button key={p} type="button" className={`chip ${n === p ? 'active' : ''}`}
                                    onClick={() => { selection(); setAmount(p.toLocaleString('en-US')); setError(null); }}>
                                {fmtToman(p)}
                            </button>
                        ))}
                    </div>
                    <Alert code={error} />
                    <ul className="section">
                        <li className="row">
                            <Badge icon={ShieldCheckIcon} tone="success" />
                            <span className="row-text">
                                <span className="row-title">{t('charge.secureTitle')}</span>
                                <span className="row-subtitle">{t('charge.secureBody')}</span>
                            </span>
                        </li>
                        {info?.provider === 'fake' && (
                            <li className="row">
                                <Badge icon={CreditCardIcon} tone="warning" />
                                <span className="row-text">
                                    <span className="row-title">{t('charge.demoTitle')}</span>
                                    <span className="row-subtitle">{t('charge.demoBody')}</span>
                                </span>
                            </li>
                        )}
                    </ul>
                </>
            )}

            <section>
                <h2 className="section-title">{t('charge.recent')}</h2>
                {info && !info.payments.length ? <Empty text={t('charge.none')} /> : (
                    <ul className="section">{info?.payments.slice(0, 10).map((p) => <PaymentRow key={p.id} p={p} />)}</ul>
                )}
            </section>

            {!waiting && (
                <MainAction text={value && !outOfRange ? t('charge.payAmount', { amount: fmtToman(n) }) : t('charge.pay')} onClick={pay} busy={busy} />
            )}
        </main>
    );
}
