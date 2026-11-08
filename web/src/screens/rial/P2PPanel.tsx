import { errorMessage } from '../../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type P2PPayment, type RialOrder } from '../../api';
import { fmtToman, groupTyped, parseAmount } from '../../format';
import { confirm } from '../../telegram';
import { refreshWallet } from '../../wallet';

const labels: Record<P2PPayment['status'], string> = {
    reserved: 'رزرو برای پرداخت', expired: 'مهلت پرداخت تمام شد', awaiting_confirmation: 'در انتظار تأیید دریافت وجه',
    admin_review: 'در حال بررسی ادمین', settled: 'تسویه شد', rejected: 'رد شد؛ وجه به درخواست‌کننده برگشت',
};
const message = (e: unknown) => e instanceof ApiError ? ({
    market_short: 'درخواست کافی برای این مبلغ موجود نیست.', reservation_expired: 'مهلت رزرو تمام شده است.',
    invalid_receipt: 'تصویر فیش و شماره پیگیری معتبر را وارد کنید.', payment_pending: 'وضعیت پرداخت تغییر کرده است؛ دوباره بررسی کنید.',
    payment_pending_cancel: 'پرداخت در انتظار بررسی است.',
} as Record<string,string>)[e.code] || errorMessage(e.code) : 'ارتباط برقرار نشد؛ دوباره تلاش کنید.';

function Payment({ p, now, run }: { p: P2PPayment; now: number; run: (fn: () => Promise<unknown>) => Promise<void> }) {
    const [receipt, setReceipt] = useState('');
    const [reference, setReference] = useState('');
    const [error, setError] = useState('');
    const left = Math.max(0, Math.ceil((new Date(p.expires_at).getTime() - now) / 1000));
    const read = async (file?: File) => {
        setError(''); setReceipt('');
        if (!file) return;
        if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 530000) {
            setError('تصویر JPG، PNG یا WebP با حجم حداکثر ۵۰۰ کیلوبایت انتخاب کنید.'); return;
        }
        const reader = new FileReader();
        reader.onload = () => setReceipt(String(reader.result));
        reader.onerror = () => setError('خواندن تصویر ناموفق بود.');
        reader.readAsDataURL(file);
    };
    return <article className="ab-quote">
        <strong>{fmtToman(p.amount)} تومان · {p.role === 'receiver' ? 'دریافت ریال' : 'پرداخت ریال'}</strong>
        <p>{labels[p.status]}</p><p dir="auto">{p.description}</p>
        {p.status === 'reserved' && p.role === 'payer' && <>
            <p role="timer">مهلت پرداخت و ثبت فیش: {left} ثانیه</p>
            <p className="hint">پس از پایان مهلت واریز نکنید. ثبت فیش باید پیش از پایان رزرو انجام شود.</p>
            <label>تصویر فیش<input type="file" accept="image/png,image/jpeg,image/webp" disabled={!left} onChange={e => void read(e.target.files?.[0])} /></label>
            <label>شماره پیگیری<input value={reference} maxLength={120} onChange={e => setReference(e.target.value)} /></label>
            {receipt && <img src={receipt} alt="پیش‌نمایش فیش" style={{ maxWidth: '100%', maxHeight: 240 }} />}
            <button className="button" disabled={!left || !receipt || !reference.trim()} onClick={() => void run(() => api.p2pReceipt(p.id,receipt,reference))}>ثبت فیش واریز</button>
        </>}
        {p.receipt && <details><summary>مشاهده فیش و شماره پیگیری</summary><p>{p.receipt_reference}</p><a href={p.receipt} target="_blank" rel="noreferrer"><img src={p.receipt} alt="فیش واریز" style={{ maxWidth: '100%', maxHeight: 320 }} /></a></details>}
        {p.status === 'awaiting_confirmation' && <p className="hint">مهلت تأیید: {p.confirmation_due_at && new Date(p.confirmation_due_at).toLocaleString('fa-IR')}؛ پس از آن بررسی توسط ادمین.</p>}
        {p.status === 'awaiting_confirmation' && p.role === 'receiver' && <>
            <button className="button" onClick={() => void run(async () => {
                if (await confirm('واریز را در حساب بانکی خود بررسی کرده‌اید؟ با تأیید، مبلغ مسدودشده به ولت پرداخت‌کننده منتقل می‌شود.')) await api.p2pConfirm(p.id);
            })}>وجه به حسابم واریز شده؛ تأیید می‌کنم</button>
            <button className="link-button" onClick={() => void run(() => api.p2pDispute(p.id))}>وجه دریافت نشده / ارجاع به ادمین</button>
        </>}
        {error && <p role="alert" className="tf-error">{error}</p>}
    </article>;
}

export function P2PPanel() {
    const [payments, setPayments] = useState<P2PPayment[]>([]);
    const [orders, setOrders] = useState<RialOrder[]>([]);
    const [amount, setAmount] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [now, setNow] = useState(Date.now());
    const lastPayments = useRef('');
    const load = useCallback(async () => {
        const [p, o] = await Promise.all([api.p2pPayments(),api.rialOrders('all')]);
        const signature = p.payments.map(item => `${item.id}:${item.status}`).join('|');
        if (signature !== lastPayments.current) {
            lastPayments.current = signature;
            void refreshWallet();
        }
        setPayments(p.payments); setOrders(o.orders.filter(o => o.method === 'p2p'));
    }, []);
    useEffect(() => {
        let active = true;
        const refresh = () => { if (active) void load().catch(e => { if (active) setError(message(e)); }); };
        refresh();
        const poll = setInterval(refresh, 5000);
        const tick = setInterval(() => setNow(Date.now()), 1000);
        return () => { active = false; clearInterval(poll); clearInterval(tick); };
    }, [load]);
    const run = async (fn: () => Promise<unknown>) => {
        if (busy) return;
        setBusy(true); setError('');
        try { await fn(); await load(); await refreshWallet(); }
        catch (e) { setError(message(e)); }
        finally { setBusy(false); }
    };
    return <section dir="rtl" className="ab-composer">
        <h2>همتا به همتا · پرداخت ریالی</h2>
        <p className="hint">مبلغی که می‌خواهید پرداخت کنید وارد کنید. یک یا چند درخواست، فقط برای شما به مدت ۲ دقیقه رزرو می‌شود. با تأیید واریز، معادل مبلغ به ولت شما اضافه می‌شود.</p>
        <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
            <label>مبلغ پرداخت (تومان)<input inputMode="numeric" value={amount} onChange={e => setAmount(groupTyped(e.target.value,0))} /></label>
            <button className="button" disabled={!parseAmount(amount,0)} onClick={() => void run(() => api.reserveP2P(parseAmount(amount,0)!))}>نمایش و رزرو درخواست‌های قابل پرداخت</button>
            {error && <p role="alert" className="tf-error">{error}</p>}
            {orders.filter(o => ['open','partial'].includes(o.status)).map(o => <article className="ab-quote" key={o.id}>
                <p>درخواست دریافت: {fmtToman(o.remaining)} تومان باقی‌مانده</p><p>{o.description}</p>
                <button className="link-button danger" onClick={() => void run(async () => { if (await confirm('درخواست لغو و موجودی آزاد شود؟')) await api.cancelRialOrder(o.id); })}>لغو درخواست</button>
            </article>)}
            {payments.map(p => <Payment key={p.id} p={p} now={now} run={run} />)}
        </fieldset>
    </section>;
}
