import { useCallback, useEffect, useRef, useState } from 'react';

import { api, ApiError, type AuctionBook, type AuctionOffer, type MarketTrade, type Order } from '../../api';
import { num } from '../../format';
import { listen } from '../../live';
import { isOpen, upsertOrders } from './market';

const MAX_TRADES = 40;

export interface AuctionState {
    book: AuctionBook | null;
    /** Open orders one by one, newest first, for the board. */
    offers: AuctionOffer[];
    trades: MarketTrade[];
    fresh: Set<string>;
    orders: Order[];
    loading: boolean;
    error: string | null;
    direction: number;
}

const empty = (): AuctionState => ({ book: null, offers: [], trades: [], fresh: new Set(), orders: [], loading: true, error: null, direction: 0 });

/**
 * A pair's auction as the trade page shows it in auction mode: its own book,
 * its trades and the user's open auction orders - fetched while `enabled`,
 * then kept live over the same socket as the market.
 */
export function useAuction(symbol: string, enabled: boolean, onFill?: (order: Order) => void) {
    const [s, setS] = useState<AuctionState>(empty);
    const onFillRef = useRef(onFill);
    onFillRef.current = onFill;

    useEffect(() => {
        if (!enabled) return;
        let alive = true;
        setS(empty());
        Promise.all([api.auction(symbol), api.auctionOrders(symbol, 'open').catch(() => ({ orders: [] as Order[] }))])
            .then(([a, o]) => {
                if (!alive) return;
                setS((prev) => ({ ...prev, book: a.book, offers: a.offers ?? [], trades: a.trades, orders: o.orders.filter(isOpen), loading: false, error: null }));
            })
            .catch((err) => alive && setS((prev) => ({ ...prev, loading: false, error: err instanceof ApiError ? err.code : 'unknown' })));

        const off = listen((msg) => {
            if (msg.type === 'auction_book' && msg.book.symbol === symbol) setS((prev) => ({ ...prev, book: msg.book }));
            else if (msg.type === 'auction_offers' && msg.symbol === symbol) setS((prev) => ({ ...prev, offers: msg.offers }));
            else if (msg.type === 'auction_trades' && msg.symbol === symbol) {
                setS((prev) => {
                    const known = new Set(prev.trades.map((x) => x.id));
                    const added = msg.trades.filter((x) => !known.has(x.id)).reverse();
                    if (!added.length) return prev;
                    const trades = [...added, ...prev.trades].slice(0, MAX_TRADES);
                    const before = num(prev.trades[0]?.price);
                    return {
                        ...prev,
                        trades,
                        fresh: new Set(added.map((x) => x.id)),
                        direction: before ? Math.sign(num(trades[0].price) - before) || prev.direction : prev.direction,
                    };
                });
            } else if (msg.type === 'auction_user' && msg.symbol === symbol) {
                for (const o of msg.orders) if (o.status === 'filled') onFillRef.current?.(o);
                setS((prev) => ({ ...prev, orders: upsertOrders(prev.orders, msg.orders) }));
            }
        });
        return () => {
            alive = false;
            off();
        };
    }, [symbol, enabled]);

    const applyOrder = useCallback((o: Order | null) => {
        if (o) setS((prev) => ({ ...prev, orders: upsertOrders(prev.orders, [o]) }));
    }, []);

    return { auction: s, applyAuctionOrder: applyOrder };
}
