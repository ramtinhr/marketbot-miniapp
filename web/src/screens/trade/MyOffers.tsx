import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, ApiError, type Order } from '../../api';
import { Alert, CoinIcon, Empty, PageHeader, Segmented, Spinner, toast } from '../../components/ui';
import { assetName, baseOf, fmtAsset, fmtDateTime, fmtPercent, fmtPrice, fmtTime, fmtToman, num, priceDigits } from '../../format';
import { errorMessage, t } from '../../i18n';
import { listen } from '../../live';
import { useNav } from '../../nav';
import { confirm, haptic, selection } from '../../telegram';
import { OfferNote, OfferText } from './AuctionBoard';
import { isOpen, upsertOrders } from './market';

const sameDay = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();
const when = (iso: string) => (sameDay(iso) ? fmtTime(iso).slice(0, 5) : fmtDateTime(iso));
const leftOf = (o: Order) => Math.max(0, num(o.quantity) - num(o.filled_quantity));

/** What open orders hold, by asset, Toman first: Toman at its price for what is left of a buy, the coin for a sell. */
function heldBy(orders: Order[]): { asset: string; amount: number }[] {
    const held = new Map<string, number>();
    for (const o of orders) {
        const asset = o.side === 'buy' ? 'IRT' : baseOf(o.symbol);
        held.set(asset, (held.get(asset) ?? 0) + (o.side === 'buy' ? leftOf(o) * num(o.price) : leftOf(o)));
    }
    return [...held].map(([asset, amount]) => ({ asset, amount }))
        .sort((a, b) => (a.asset === 'IRT' ? -1 : b.asset === 'IRT' ? 1 : a.asset.localeCompare(b.asset)));
}

const fmtHeld = ({ asset, amount }: { asset: string; amount: number }) =>
    (asset === 'IRT' ? `${fmtToman(amount)} ${t('common.toman')}` : `${fmtAsset(amount, asset, { trim: true })} ${asset}`);

/**
 * The user's open auction orders on every pair, newest first: fetched while
 * `enabled`, then kept live over the socket, which tells a user about their own
 * orders whichever pair they watch.
 */
export function useMyAuctionOrders(enabled = true) {
    const [orders, setOrders] = useState<Order[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!enabled) return;
        let alive = true;
        api.auctionOrders(null, 'open')
            .then((r) => alive && setOrders(r.orders.filter(isOpen)))
            .catch((err) => alive && setError(err instanceof ApiError ? err.code : 'unknown'));
        const off = listen((msg) => {
            if (msg.type === 'auction_user') setOrders((prev) => prev && upsertOrders(prev, msg.orders));
        });
        return () => {
            alive = false;
            off();
        };
    }, [enabled]);

    const apply = useCallback((changed: Order[]) => setOrders((prev) => prev && upsertOrders(prev, changed)), []);
    return { orders, error, apply };
}

function PairLink({ symbol }: { symbol: string }) {
    const nav = useNav();
    const base = baseOf(symbol);
    return (
        <button type="button" className="mo-pair" onClick={() => { selection(); nav.trade(symbol, 'auction'); }}>
            <CoinIcon asset={base} size={22} />
            <span>{assetName(base)}</span>
        </button>
    );
}

function OpenCard({ order: o, cancelling, onCancel }: { order: Order; cancelling: boolean; onCancel: (o: Order) => void }) {
    const base = baseOf(o.symbol);
    const filled = num(o.filled_quantity) / (num(o.quantity) || 1);
    const left = leftOf(o);
    return (
        <li className={`order mo-order ${o.side}`}>
            <div className="order-top">
                <PairLink symbol={o.symbol} />
                <span className={`side-tag ${o.side}`}>{t(o.side === 'buy' ? 'trade.buy' : 'trade.sell')}</span>
                <time className="hint" dateTime={o.created_at}>{when(o.created_at)}</time>
                <button type="button" className="link-button small danger" disabled={cancelling} onClick={() => onCancel(o)}>
                    {cancelling ? t('common.loading') : t('board.withdraw')}
                </button>
            </div>
            <OfferText side={o.side} base={base} price={o.price} quantity={String(left)} digits={priceDigits(num(o.price))} />
            <OfferNote text={o.description} />
            <dl className="order-figures">
                <div><dt>{t('mine.posted')}</dt><dd>{fmtAsset(o.quantity, base, { trim: true })} {base}</dd></div>
                <div><dt>{t('orders.filled')}</dt><dd>{fmtPercent(filled * 100, 0)}</dd></div>
                <div><dt>{t('mine.held')}</dt><dd>{fmtHeld({ asset: o.side === 'buy' ? 'IRT' : base, amount: o.side === 'buy' ? left * num(o.price) : left })}</dd></div>
            </dl>
            {filled > 0 && <div className="order-progress" aria-hidden="true"><i style={{ width: `${(filled * 100).toFixed(1)}%` }} /></div>}
        </li>
    );
}

function HistoryCard({ order: o }: { order: Order }) {
    const base = baseOf(o.symbol);
    const filled = num(o.filled_quantity);
    const quote = num(o.filled_quote);
    const status = o.status === 'filled' ? 'filled' : filled > 0 ? 'partCancelled' : 'cancelled';
    return (
        <li className="order mo-order closed">
            <div className="order-top">
                <PairLink symbol={o.symbol} />
                <span className={`side-tag ${o.side}`}>{t(o.side === 'buy' ? 'trade.buy' : 'trade.sell')}</span>
                <time className="hint" dateTime={o.created_at}>{when(o.created_at)}</time>
                <span className={`mo-status ${status}`}>{t(`mine.status.${status}`)}</span>
            </div>
            <OfferText side={o.side} base={base} price={o.price} quantity={o.quantity} digits={priceDigits(num(o.price))} />
            <OfferNote text={o.description} />
            <dl className="order-figures">
                <div><dt>{t('orders.filled')}</dt><dd>{fmtAsset(filled, base, { trim: true })} {base}</dd></div>
                <div><dt>{t('mine.avgPrice')}</dt><dd>{filled ? fmtPrice(quote / filled, priceDigits(quote / filled)) : '—'}</dd></div>
                <div><dt>{t(o.side === 'buy' ? 'trade.cost' : 'trade.proceeds')}</dt><dd>{quote ? fmtToman(quote) : '—'}</dd></div>
            </dl>
        </li>
    );
}

function OpenTab({ orders, error, apply }: { orders: Order[] | null; error: string | null; apply: (o: Order[]) => void }) {
    const nav = useNav();
    const [pair, setPair] = useState<string | null>(null);
    const [cancelling, setCancelling] = useState<string | null>(null);
    const [cancellingAll, setCancellingAll] = useState(false);

    const pairs = useMemo(() => {
        const count = new Map<string, number>();
        for (const o of orders ?? []) count.set(o.symbol, (count.get(o.symbol) ?? 0) + 1);
        return [...count].sort((a, b) => b[1] - a[1]);
    }, [orders]);
    // A pair whose last order went falls back to all of them.
    const current = pair && pairs.some(([s]) => s === pair) ? pair : null;
    const shown = useMemo(() => (orders ?? []).filter((o) => !current || o.symbol === current), [orders, current]);

    if (error) return <Alert code={error} />;
    if (!orders) return <div className="center-pad"><Spinner /></div>;
    if (!orders.length) {
        return (
            <div className="mo-empty">
                <Empty text={t('mine.empty')} />
                <button type="button" className="button" onClick={() => nav.trade(nav.symbol, 'auction')}>{t('mine.post')}</button>
            </div>
        );
    }

    const cancel = async (o: Order) => {
        if (!(await confirm(t('board.withdrawConfirm')))) return;
        setCancelling(o.id);
        try {
            const res = await api.cancelAuctionOrder(o.id);
            haptic('success');
            toast(t('board.withdrawn'));
            apply([res.order ?? { ...o, status: 'cancelled' }]);
        } catch (err) {
            haptic('error');
            toast(errorMessage(err instanceof ApiError ? err.code : 'unknown'), 'danger');
        } finally {
            setCancelling(null);
        }
    };

    const cancelAll = async () => {
        const held = heldBy(shown).map(fmtHeld).join(t('mine.and'));
        const question = current
            ? t('mine.cancelPairConfirm', { n: fmtAsset(shown.length, 'IRT'), asset: assetName(baseOf(current)), held })
            : t('mine.cancelAllConfirm', { n: fmtAsset(shown.length, 'IRT'), held });
        if (!(await confirm(question))) return;
        setCancellingAll(true);
        try {
            const res = await api.cancelAllAuctionOrders(current);
            haptic('success');
            toast(t('mine.cancelledAll', { n: fmtAsset(res.orders.length, 'IRT') }));
            apply(res.orders);
        } catch (err) {
            haptic('error');
            toast(errorMessage(err instanceof ApiError ? err.code : 'unknown'), 'danger');
        } finally {
            setCancellingAll(false);
        }
    };

    return (
        <>
            {pairs.length > 1 && (
                <div className="chips mo-pairs">
                    <button type="button" className={`chip ${current ? '' : 'active'}`} onClick={() => { selection(); setPair(null); }}>
                        {t('mine.allPairs', { n: fmtAsset(orders.length, 'IRT') })}
                    </button>
                    {pairs.map(([s, n]) => (
                        <button key={s} type="button" className={`chip ${current === s ? 'active' : ''}`} onClick={() => { selection(); setPair(s); }}>
                            {assetName(baseOf(s))} ({fmtAsset(n, 'IRT')})
                        </button>
                    ))}
                </div>
            )}

            <section className="panel mo-summary">
                <div className="mo-held">
                    <span className="hint">{t('mine.heldTotal')}</span>
                    {heldBy(shown).map((h) => <strong key={h.asset}>{fmtHeld(h)}</strong>)}
                </div>
                <button type="button" className="button danger-soft" onClick={cancelAll} disabled={cancellingAll} aria-busy={cancellingAll}>
                    {cancellingAll && <Spinner small />}
                    {current
                        ? t('mine.cancelPair', { asset: assetName(baseOf(current)), n: fmtAsset(shown.length, 'IRT') })
                        : t('mine.cancelAll', { n: fmtAsset(shown.length, 'IRT') })}
                </button>
            </section>

            <ul className="orders">
                {shown.map((o) => <OpenCard key={o.id} order={o} cancelling={cancelling === o.id || cancellingAll} onCancel={cancel} />)}
            </ul>
        </>
    );
}

function HistoryTab({ live }: { live: Order[] | null }) {
    const [orders, setOrders] = useState<Order[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Fetched again whenever an open order changes: one that closed belongs here now.
    const openKey = live?.map((o) => `${o.id}:${o.filled_quantity}`).join() ?? '';
    useEffect(() => {
        let alive = true;
        api.auctionOrders(null, 'history')
            .then((r) => alive && setOrders(r.orders))
            .catch((err) => alive && setError(err instanceof ApiError ? err.code : 'unknown'));
        return () => { alive = false; };
    }, [openKey]);

    if (error) return <Alert code={error} />;
    if (!orders) return <div className="center-pad"><Spinner /></div>;
    if (!orders.length) return <Empty text={t('mine.noHistory')} />;
    return <ul className="orders">{orders.map((o) => <HistoryCard key={o.id} order={o} />)}</ul>;
}

/** The user's auction offers on every pair: the open ones to withdraw one by one or all at once, and the closed ones. */
export function AuctionOrdersPage() {
    const [tab, setTab] = useState<'open' | 'history'>('open');
    const { orders, error, apply } = useMyAuctionOrders();
    return (
        <main className="screen enter my-offers">
            <PageHeader title={t('mine.title')} subtitle={t('mine.subtitle')} />
            <Segmented
                value={tab}
                onChange={setTab}
                options={[
                    { value: 'open', label: orders?.length ? t('mine.openCount', { n: fmtAsset(orders.length, 'IRT') }) : t('mine.open') },
                    { value: 'history', label: t('mine.history') },
                ]}
            />
            {tab === 'open' ? <OpenTab orders={orders} error={error} apply={apply} /> : <HistoryTab live={orders} />}
        </main>
    );
}
