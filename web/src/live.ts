// One WebSocket to the server for everything live: the watched pair's book
// and trades, and the user's own orders, fills and balances. It reconnects on
// its own, and on every (re)connect says who the user is and which pair to
// watch again, so callers only subscribe once.

import type { AuctionBook, Balance, Depth, MarketTrade, Order } from './api';
import { currentToken } from './api';

export type LiveMessage =
    | { type: 'status'; connected: boolean }
    | { type: 'auth'; ok: boolean }
    | { type: 'depth'; depth: Depth | null }
    | { type: 'trades'; symbol: string; trades: MarketTrade[] }
    | { type: 'user'; symbol: string; orders: Order[]; trades: MarketTrade[] }
    | { type: 'balances'; balances: Balance[] }
    | { type: 'auction_book'; book: AuctionBook }
    | { type: 'auction_trades'; symbol: string; trades: MarketTrade[] }
    | { type: 'auction_user'; symbol: string; orders: Order[]; trades: MarketTrade[] };

type Listener = (msg: LiveMessage) => void;

/** What the connection needs of a socket; the development preview supplies a fake one. */
export interface Transport {
    send(data: string): void;
    close(): void;
    onopen: (() => void) | null;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onclose: (() => void) | null;
}

let openTransport = (url: string): Transport => new WebSocket(url) as unknown as Transport;

export function useTransport(factory: (url: string) => Transport): void {
    openTransport = factory;
}

const listeners = new Set<Listener>();
let socket: Transport | null = null;
let symbol: string | null = null;
let retry = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function send(msg: object) {
    try {
        socket?.send(JSON.stringify(msg));
    } catch { /* not open yet: sent again on open */ }
}

function connect() {
    if (socket || !listeners.size) return;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/market/ws`;
    const s = openTransport(url);
    socket = s;
    let opened = false;
    s.onopen = () => {
        opened = true;
        retry = 0;
        const token = currentToken();
        if (token) send({ type: 'auth', token });
        if (symbol) send({ type: 'subscribe', symbol });
    };
    s.onmessage = (ev) => {
        let msg: LiveMessage;
        try {
            msg = JSON.parse(String(ev.data));
        } catch {
            return;
        }
        for (const l of listeners) l(msg);
    };
    s.onclose = () => {
        if (socket !== s) return;
        socket = null;
        if (opened) for (const l of listeners) l({ type: 'status', connected: false });
        if (!listeners.size) return;
        // 1s, 2s, 4s ... up to 30s between attempts.
        const delay = Math.min(30_000, 1000 * 2 ** retry++);
        clearTimeout(timer);
        timer = setTimeout(connect, delay);
    };
}

/** Listens to everything live; returns the function that stops listening. */
export function listen(listener: Listener): () => void {
    listeners.add(listener);
    connect();
    return () => {
        listeners.delete(listener);
        if (!listeners.size) {
            clearTimeout(timer);
            const s = socket;
            socket = null;
            s?.close();
        }
    };
}

/** Watches `next` (a pair such as USDT_IRT) instead of the current one. */
export function watch(next: string | null): void {
    symbol = next;
    if (next) send({ type: 'subscribe', symbol: next });
}

/** Sends the session token again, e.g. once it is verified. */
export function reauthenticate(): void {
    const token = currentToken();
    if (token) send({ type: 'auth', token });
}
