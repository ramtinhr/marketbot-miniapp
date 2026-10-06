import { useCallback, useEffect, useState, type CSSProperties } from 'react';

import { api, ApiError, type MarketTrade, type Order } from '../../api';
import { ChevronDownIcon, XIcon } from '../../components/icons';
import { CoinIcon, Empty, Segmented, toast } from '../../components/ui';
import { assetName, baseOf, fmtAsset, fmtDateTime, fmtPercent, fmtPrice, fmtTime, num, priceDigits } from '../../format';
import { errorMessage, t } from '../../i18n';
import { useBackHandler, useNav } from '../../nav';
import { confirm, haptic, selection } from '../../telegram';
import { useAuction } from './auction';
import { AuctionBoard } from './AuctionBoard';
import { quoteFrom, quoteOf, useMarket, type MarketState } from './market';
import { useMyAuctionOrders } from './MyOffers';
import { OrderBook } from './OrderBook';
import { TradeForm, type PriceRequest } from './TradeForm';

function PairSheet({ symbols, current, onPick, onClose }: { symbols: string[]; current: string; onPick: (s: string) => void; onClose: () => void }) {
    useBackHandler(onClose);
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

function Stat({ label, value }: { label: string; value: string }) {
    return <div><dt>{label}</dt><dd style={{ '--len': value.length } as CSSProperties}>{value}</dd></div>;
}

function Ticker({ symbol, s, digits, onPair }: { symbol: string; s: MarketState; digits: number; onPair: () => void }) {
    const base = baseOf(symbol);
    const q = quoteOf(s);
    const price = q.last ?? q.mid;
    const day = s.summary;
    const change = day?.change_pct ?? null;
    const priceText = price === null ? '—' : fmtPrice(price, digits);
    return (
        <header className="panel ticker">
            <div className="ticker-top">
                <button type="button" className="pair" onClick={onPair}>
                    <CoinIcon asset={base} size={36} />
                    <span className="pair-text">
                        <span className="pair-name ltr-inline">{base} / {t('common.tomanShort')}</span>
                        <span className="hint">{assetName(base)}</span>
                    </span>
                    <ChevronDownIcon className="pair-chevron" />
                </button>
                <span className={`live ${s.connected ? 'on' : 'off'}`} aria-label={t('ticker.status')}>
                    <i aria-hidden="true" />{s.connected ? t('ticker.live') : t('ticker.offline')}
                </span>
            </div>
            <div className="ticker-price" style={{ '--len': priceText.length } as CSSProperties}>
                <strong className={s.direction > 0 ? 'up' : s.direction < 0 ? 'down' : ''}>{priceText}</strong>
                {change !== null && <span className={`change ${change > 0 ? 'up' : change < 0 ? 'down' : ''}`}>{fmtPercent(change, 2, { sign: true })}</span>}
            </div>
            <dl className="ticker-stats">
                <Stat label={t('ticker.high')} value={day ? fmtPrice(day.high, digits) : '—'} />
                <Stat label={t('ticker.low')} value={day ? fmtPrice(day.low, digits) : '—'} />
                <Stat label={t('ticker.volume', { base })} value={day ? fmtAsset(day.volume, base, { trim: true }) : '—'} />
            </dl>
        </header>
    );
}

function MarketTrades({ symbol, trades, fresh, digits }: { symbol: string; trades: MarketTrade[]; fresh: Set<string>; digits: number }) {
    const base = baseOf(symbol);
    if (!trades.length) return <Empty text={t('trades.empty')} />;
    return (
        <div className="trades">
            <div className="tr-head">
                <span>{t('book.price')}</span>
                <span>{t('book.amount', { base })}</span>
                <span>{t('trades.time')}</span>
            </div>
            {trades.map((tr) => (
                <div key={tr.id} className={`tr-row ${tr.taker_side} ${fresh.has(tr.id) ? 'flash' : ''}`}>
                    <span className="ob-price">{fmtPrice(tr.price, digits)}</span>
                    <span>{fmtAsset(tr.quantity, base)}</span>
                    <span className="ob-dim">{fmtTime(tr.executed_at)}</span>
                </div>
            ))}
        </div>
    );
}

function OpenOrders({ symbol, orders, digits, cancelOrder, onCancelled }: {
    symbol: string; orders: Order[]; digits: number;
    cancelOrder: (id: string) => Promise<{ order: Order | null }>;
    onCancelled: (o: Order | null) => void;
}) {
    const base = baseOf(symbol);
    const [cancelling, setCancelling] = useState<string | null>(null);
    if (!orders.length) return <Empty text={t('orders.empty')} />;
    const cancel = async (o: Order) => {
        if (!(await confirm(t('orders.cancelConfirm')))) return;
        setCancelling(o.id);
        try {
            const res = await cancelOrder(o.id);
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

/** How the auction is shown: as a trading group's posts, or as an order book. */
type AuctionView = 'board' | 'book';
const VIEW_KEY = 'auction.view';

function useAuctionView(): [AuctionView, (v: AuctionView) => void] {
    const [view, setView] = useState<AuctionView>(() => {
        try {
            return localStorage.getItem(VIEW_KEY) === 'book' ? 'book' : 'board';
        } catch {
            return 'board';
        }
    });
    const set = useCallback((v: AuctionView) => {
        setView(v);
        try {
            localStorage.setItem(VIEW_KEY, v);
        } catch { /* private mode: only for this visit */ }
    }, []);
    return [view, set];
}

export function TradePage() {
    const nav = useNav();
    const symbol = nav.symbol;
    const [symbols, setSymbols] = useState<string[]>([symbol]);
    const [picking, setPicking] = useState(false);
    const [request, setRequest] = useState<PriceRequest | null>(null);
    const [tab, setTab] = useState<'orders' | 'trades'>('orders');
    const { orderType: type, setOrderType: setType } = nav;
    const auctionMode = type === 'auction';
    const [auctionView, setAuctionView] = useAuctionView();
    const board = auctionMode && auctionView === 'board';

    const onFill = useCallback((o: Order) => {
        haptic('success');
        toast(t('orders.filledToast', { side: t(o.side === 'buy' ? 'trade.buy' : 'trade.sell'), qty: fmtAsset(o.quantity, baseOf(o.symbol), { trim: true }), base: baseOf(o.symbol) }));
    }, []);
    const { s, applyOrder } = useMarket(symbol, onFill);
    const { auction, applyAuctionOrder } = useAuction(symbol, auctionMode, onFill);
    const quote = quoteOf(s);
    const auctionQuote = quoteFrom(auction.book, auction.trades);
    const digits = priceDigits(quote.bestAsk || quote.bestBid || quote.last || auctionQuote.mid || 0);
    const orders = auctionMode ? auction.orders : s.orders;
    const { orders: myOrders } = useMyAuctionOrders(auctionMode);
    const openMine = () => { selection(); nav.push({ name: 'auctionOrders' }); };

    useEffect(() => {
        api.symbols().then((r) => setSymbols(r.symbols)).catch(() => {});
    }, []);

    return (
        <main className="screen tabbed wide trade enter">
            <Ticker symbol={symbol} s={s} digits={digits} onPair={() => { selection(); setPicking(true); }} />
            {(auctionMode ? auction.error : s.error) && <p className="tf-error">{errorMessage((auctionMode ? auction.error : s.error) as string)}</p>}
            {auctionMode && (
                <div className="auction-bar">
                    <Segmented
                        className="auction-views"
                        value={auctionView}
                        onChange={setAuctionView}
                        options={[
                            { value: 'board', label: t('board.view.board') },
                            { value: 'book', label: t('board.view.book') },
                        ]}
                    />
                    <button type="button" className="mo-link" onClick={openMine}>
                        {myOrders?.length ? t('mine.linkCount', { n: fmtAsset(myOrders.length, 'IRT') }) : t('mine.link')}
                    </button>
                </div>
            )}

            <div className={`trade-grid ${board ? 'with-board' : ''}`}>
                {board ? (
                    <AuctionBoard
                        symbol={symbol} offers={auction.offers} orders={auction.orders} loading={auction.loading} digits={digits}
                        marketBest={{ bid: quote.bestBid, ask: quote.bestAsk }}
                        type={type} onType={setType} onPlaced={applyAuctionOrder}
                    />
                ) : auctionMode ? (
                    <OrderBook
                        symbol={symbol} depth={auction.book} orders={auction.orders} loading={auction.loading} direction={auction.direction}
                        quote={auctionQuote} digits={digits} auction onPick={(_side, price) => setRequest({ price, n: Date.now() })}
                    />
                ) : (
                    <OrderBook
                        symbol={symbol} depth={s.depth} orders={s.orders} loading={s.loading} direction={s.direction}
                        quote={quote} digits={digits} onPick={(_side, price) => setRequest({ price, n: Date.now() })}
                    />
                )}
                {!board && (
                    <TradeForm
                        symbol={symbol} s={s} quote={quote} auctionDepth={auction.book} digits={digits} request={request}
                        type={type} onType={setType}
                        onPlaced={(o, placedType) => (placedType === 'auction' ? applyAuctionOrder(o) : applyOrder(o))}
                    />
                )}
                <section className="panel lists">
                    <Segmented
                        value={tab}
                        onChange={setTab}
                        options={[
                            { value: 'orders', label: orders.length ? t('orders.titleCount', { n: fmtAsset(orders.length, 'IRT') }) : t('orders.title') },
                            { value: 'trades', label: t('trades.title') },
                        ]}
                    />
                    {tab === 'orders'
                        ? auctionMode
                            ? (
                                <>
                                    <OpenOrders symbol={symbol} orders={auction.orders} digits={digits} cancelOrder={api.cancelAuctionOrder} onCancelled={applyAuctionOrder} />
                                    <button type="button" className="link-button block" onClick={openMine}>{t('mine.allLink')} ›</button>
                                </>
                            )
                            : <OpenOrders symbol={symbol} orders={s.orders} digits={digits} cancelOrder={api.cancelOrder} onCancelled={applyOrder} />
                        : auctionMode
                            ? <MarketTrades symbol={symbol} trades={auction.trades} fresh={auction.fresh} digits={digits} />
                            : <MarketTrades symbol={symbol} trades={s.trades} fresh={s.fresh} digits={digits} />}
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
