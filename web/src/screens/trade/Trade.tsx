import { useCallback, useEffect, useState } from 'react';

import { api, ApiError, type Order } from '../../api';
import { ChevronDownIcon, XIcon } from '../../components/icons';
import { CoinIcon, Empty, Segmented, toast } from '../../components/ui';
import { assetName, baseOf, fmtAsset, fmtDateTime, fmtPercent, fmtPrice, fmtTime, num, priceDigits } from '../../format';
import { errorMessage, t } from '../../i18n';
import { useNav } from '../../nav';
import { confirm, haptic, selection } from '../../telegram';
import { quoteOf, useMarket, type MarketState } from './market';
import { OrderBook } from './OrderBook';
import { TradeForm, type PriceRequest } from './TradeForm';

function PairSheet({ symbols, current, onPick, onClose }: { symbols: string[]; current: string; onPick: (s: string) => void; onClose: () => void }) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    return (
        <div className="sheet-backdrop" onClick={onClose}>
            <div className="sheet" role="dialog" aria-label={t('trade.pickPair')} onClick={(e) => e.stopPropagation()}>
                <div className="sheet-head">
                    <h2>{t('trade.pickPair')}</h2>
                    <button type="button" className="icon-button ghost" onClick={onClose} aria-label={t('common.close')}><XIcon /></button>
                </div>
                <ul className="section">
                    {symbols.map((sym) => {
                        const base = baseOf(sym);
                        return (
                            <li key={sym}>
                                <button type="button" className={`row tappable ${sym === current ? 'selected' : ''}`} onClick={() => onPick(sym)}>
                                    <CoinIcon asset={base} size={34} />
                                    <span className="row-text">
                                        <span className="row-title ltr-inline">{base} / {t('common.tomanShort')}</span>
                                        <span className="row-subtitle">{assetName(base)}</span>
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            </div>
        </div>
    );
}

function Ticker({ symbol, s, digits, onPair }: { symbol: string; s: MarketState; digits: number; onPair: () => void }) {
    const base = baseOf(symbol);
    const q = quoteOf(s);
    const price = q.last ?? q.mid;
    const day = s.summary;
    const change = day?.change_pct ?? null;
    return (
        <header className="panel ticker">
            <button type="button" className="pair" onClick={onPair}>
                <CoinIcon asset={base} size={36} />
                <span className="pair-text">
                    <span className="pair-name ltr-inline">{base} / {t('common.tomanShort')}</span>
                    <span className="hint">{assetName(base)}</span>
                </span>
                <ChevronDownIcon className="pair-chevron" />
            </button>
            <div className="ticker-price">
                <strong className={s.direction > 0 ? 'up' : s.direction < 0 ? 'down' : ''}>{price === null ? '—' : fmtPrice(price, digits)}</strong>
                {change !== null && <span className={`change ${change > 0 ? 'up' : change < 0 ? 'down' : ''}`}>{fmtPercent(change, 2, { sign: true })}</span>}
            </div>
            <dl className="ticker-stats">
                <div><dt>{t('ticker.high')}</dt><dd>{day ? fmtPrice(day.high, digits) : '—'}</dd></div>
                <div><dt>{t('ticker.low')}</dt><dd>{day ? fmtPrice(day.low, digits) : '—'}</dd></div>
                <div><dt>{t('ticker.volume', { base })}</dt><dd>{day ? fmtAsset(day.volume, base, { trim: true }) : '—'}</dd></div>
                <div>
                    <dt>{t('ticker.status')}</dt>
                    <dd className={`live ${s.connected ? 'on' : 'off'}`}><i aria-hidden="true" />{s.connected ? t('ticker.live') : t('ticker.offline')}</dd>
                </div>
            </dl>
        </header>
    );
}

function MarketTrades({ symbol, s, digits }: { symbol: string; s: MarketState; digits: number }) {
    const base = baseOf(symbol);
    if (!s.trades.length) return <Empty text={t('trades.empty')} />;
    return (
        <div className="trades">
            <div className="tr-head">
                <span>{t('book.price')}</span>
                <span>{t('book.amount', { base })}</span>
                <span>{t('trades.time')}</span>
            </div>
            {s.trades.map((tr) => (
                <div key={tr.id} className={`tr-row ${tr.taker_side} ${s.fresh.has(tr.id) ? 'flash' : ''}`}>
                    <span className="ob-price">{fmtPrice(tr.price, digits)}</span>
                    <span>{fmtAsset(tr.quantity, base)}</span>
                    <span className="ob-dim">{fmtTime(tr.executed_at)}</span>
                </div>
            ))}
        </div>
    );
}

function OpenOrders({ symbol, orders, digits, onCancelled }: { symbol: string; orders: Order[]; digits: number; onCancelled: (o: Order | null) => void }) {
    const base = baseOf(symbol);
    const [cancelling, setCancelling] = useState<string | null>(null);
    if (!orders.length) return <Empty text={t('orders.empty')} />;
    const cancel = async (o: Order) => {
        if (!(await confirm(t('orders.cancelConfirm')))) return;
        setCancelling(o.id);
        try {
            const res = await api.cancelOrder(o.id);
            haptic('success');
            toast(t('orders.cancelled'));
            onCancelled(res.order ?? { ...o, status: 'cancelled' });
        } catch (err) {
            haptic('error');
            toast(errorMessage(err instanceof ApiError ? err.code : 'unknown'), 'danger');
        } finally {
            setCancelling(null);
        }
    };
    return (
        <ul className="orders">
            {orders.map((o) => {
                const filled = num(o.filled_quantity) / (num(o.quantity) || 1);
                return (
                    <li key={o.id} className="order">
                        <div className="order-top">
                            <span className={`side-tag ${o.side}`}>{t(o.side === 'buy' ? 'trade.buy' : 'trade.sell')}</span>
                            <span className="hint">{fmtDateTime(o.created_at)}</span>
                            <button type="button" className="link-button small danger" disabled={cancelling === o.id} onClick={() => cancel(o)}>
                                {cancelling === o.id ? t('common.loading') : t('common.cancel')}
                            </button>
                        </div>
                        <dl className="order-figures">
                            <div><dt>{t('trade.price')}</dt><dd>{fmtPrice(o.price, digits)}</dd></div>
                            <div><dt>{t('trade.amount')}</dt><dd>{fmtAsset(o.quantity, base, { trim: true })} {base}</dd></div>
                            <div><dt>{t('orders.filled')}</dt><dd>{fmtPercent(filled * 100, 0)}</dd></div>
                        </dl>
                        <div className="order-progress" aria-hidden="true"><i style={{ width: `${(filled * 100).toFixed(1)}%` }} /></div>
                    </li>
                );
            })}
        </ul>
    );
}

export function TradePage() {
    const nav = useNav();
    const symbol = nav.symbol;
    const [symbols, setSymbols] = useState<string[]>([symbol]);
    const [picking, setPicking] = useState(false);
    const [request, setRequest] = useState<PriceRequest | null>(null);
    const [tab, setTab] = useState<'orders' | 'trades'>('orders');

    const onFill = useCallback((o: Order) => {
        haptic('success');
        toast(t('orders.filledToast', { side: t(o.side === 'buy' ? 'trade.buy' : 'trade.sell'), qty: fmtAsset(o.quantity, baseOf(o.symbol), { trim: true }), base: baseOf(o.symbol) }));
    }, []);
    const { s, applyOrder } = useMarket(symbol, onFill);
    const quote = quoteOf(s);
    const digits = priceDigits(quote.bestAsk || quote.bestBid || quote.last || 0);

    useEffect(() => {
        api.symbols().then((r) => setSymbols(r.symbols)).catch(() => {});
    }, []);

    return (
        <main className="screen tabbed wide trade enter">
            <Ticker symbol={symbol} s={s} digits={digits} onPair={() => { selection(); setPicking(true); }} />
            {s.error && <p className="tf-error">{errorMessage(s.error)}</p>}

            <div className="trade-grid">
                <OrderBook symbol={symbol} s={s} quote={quote} digits={digits} onPick={(_side, price) => setRequest({ price, n: Date.now() })} />
                <TradeForm symbol={symbol} s={s} quote={quote} digits={digits} request={request} onPlaced={applyOrder} />
                <section className="panel lists">
                    <Segmented
                        value={tab}
                        onChange={setTab}
                        options={[
                            { value: 'orders', label: s.orders.length ? t('orders.titleCount', { n: fmtAsset(s.orders.length, 'IRT') }) : t('orders.title') },
                            { value: 'trades', label: t('trades.title') },
                        ]}
                    />
                    {tab === 'orders'
                        ? <OpenOrders symbol={symbol} orders={s.orders} digits={digits} onCancelled={applyOrder} />
                        : <MarketTrades symbol={symbol} s={s} digits={digits} />}
                </section>
            </div>

            {picking && (
                <PairSheet
                    symbols={symbols}
                    current={symbol}
                    onClose={() => setPicking(false)}
                    onPick={(sym) => { setPicking(false); if (sym !== symbol) nav.trade(sym); }}
                />
            )}
        </main>
    );
}
