import { useCallback, useEffect, useRef, useState } from 'react';

import { api, ApiError, type DaySummary, type Depth, type DepthLevel, type MarketTrade, type Order, type Side } from '../../api';
import { num } from '../../format';
import { listen, watch } from '../../live';

const MAX_TRADES = 40;
export const isOpen = (o: Order) => o.status === 'open' || o.status === 'partial';

export interface MarketState {
    depth: Depth | null;
    summary: DaySummary | null;
    trades: MarketTrade[];
    /** Trades that just arrived, to flash. */
    fresh: Set<string>;
    orders: Order[];
    loading: boolean;
    error: string | null;
    connected: boolean;
    /** Whether the last trade went up (1), down (-1) or nowhere (0) from the one before. */
    direction: number;
}

const empty = (): MarketState => ({
    depth: null, summary: null, trades: [], fresh: new Set(), orders: [], loading: true, error: null, connected: true, direction: 0,
});

function upsertOrders(list: Order[], changed: Order[]): Order[] {
    let next = list;
    for (const o of changed) {
        next = next.filter((x) => x.id !== o.id);
        if (isOpen(o)) next = [o, ...next];
    }
    return next.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * A pair as the trade page shows it: the book, the day, the latest trades and
 * the user's open orders - fetched once, then kept live over the socket.
 */
export function useMarket(symbol: string, onFill?: (order: Order) => void) {
    const [s, setS] = useState<MarketState>(empty);
    const onFillRef = useRef(onFill);
    onFillRef.current = onFill;

    useEffect(() => {
        let alive = true;
        setS(empty());
        watch(symbol);
        Promise.all([api.market(symbol), api.orders(symbol, 'open').catch(() => ({ orders: [] as Order[] }))])
            .then(([m, o]) => {
                if (!alive) return;
                setS((prev) => ({
                    ...prev,
                    // The socket may have delivered a newer book already.
                    depth: prev.depth ?? m.depth,
                    summary: m.summary,
                    trades: m.trades,
                    orders: o.orders.filter(isOpen),
                    loading: false,
                    error: null,
                }));
            })
            .catch((err) => alive && setS((prev) => ({ ...prev, loading: false, error: err instanceof ApiError ? err.code : 'unknown' })));

        const off = listen((msg) => {
            if (msg.type === 'status') setS((prev) => ({ ...prev, connected: msg.connected }));
            else if (msg.type === 'depth' && msg.depth?.symbol === symbol) setS((prev) => ({ ...prev, depth: msg.depth, connected: true }));
            else if (msg.type === 'trades' && msg.symbol === symbol) {
                setS((prev) => {
                    const known = new Set(prev.trades.map((x) => x.id));
                    const added = msg.trades.filter((x) => !known.has(x.id)).reverse();
                    if (!added.length) return prev;
                    const trades = [...added, ...prev.trades].slice(0, MAX_TRADES);
                    const last = num(trades[0]?.price);
                    const before = num(prev.trades[0]?.price);
                    return {
                        ...prev,
                        trades,
                        fresh: new Set(added.map((x) => x.id)),
                        direction: before ? Math.sign(last - before) || prev.direction : prev.direction,
                    };
                });
            } else if (msg.type === 'user' && msg.symbol === symbol) {
                for (const o of msg.orders) if (o.status === 'filled') onFillRef.current?.(o);
                setS((prev) => ({ ...prev, orders: upsertOrders(prev.orders, msg.orders) }));
            }
        });
        return () => {
            alive = false;
            off();
        };
    }, [symbol]);

    const applyOrder = useCallback((o: Order | null) => {
        if (o) setS((prev) => ({ ...prev, orders: upsertOrders(prev.orders, [o]) }));
    }, []);

    return { s, applyOrder };
}

export interface Quote {
    bestBid: number;
    bestAsk: number;
    mid: number | null;
    spread: number | null;
    last: number | null;
}

export function quoteOf(s: MarketState): Quote {
    const bestBid = num(s.depth?.bids[0]?.price);
    const bestAsk = num(s.depth?.asks[0]?.price);
    const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk || null;
    const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
    const last = num(s.trades[0]?.price) || num(s.depth?.last_price) || null;
    return { bestBid, bestAsk, mid, spread, last };
}

/** The running total down a side of the book. */
export function cumulative(levels: DepthLevel[]): number[] {
    let c = 0;
    return levels.map((l) => (c += num(l.quantity)));
}

/**
 * What a market order of `qty` would take from the book, price by price (the
 * engine's own walk). An estimate: the book moves, and a published depth
 * stops at its deepest levels.
 */
export function walkBook(levels: DepthLevel[], qty: number): { filled: number; cost: number } {
    let filled = 0;
    let cost = 0;
    for (const l of levels) {
        if (filled >= qty - 1e-12) break;
        const take = Math.min(qty - filled, num(l.quantity));
        filled += take;
        cost += take * num(l.price);
    }
    return { filled, cost };
}

/** How much `budget` Toman buys walking up the asks. */
export function qtyForCost(asks: DepthLevel[], budget: number): number {
    let qty = 0;
    let left = budget;
    for (const l of asks) {
        const p = num(l.price);
        const size = num(l.quantity);
        if (!p || left <= 0) break;
        const take = Math.min(size, left / p);
        qty += take;
        left -= take * p;
    }
    return qty;
}

export const levelsFor = (depth: Depth | null, side: Side): DepthLevel[] => (side === 'buy' ? depth?.asks : depth?.bids) ?? [];
