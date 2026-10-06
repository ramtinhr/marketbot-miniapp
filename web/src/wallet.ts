// The user's balances, shared by every page: fetched once, refreshed on
// demand (after a charge or withdrawal) and kept current by the live socket.

import { useEffect, useSyncExternalStore } from 'react';

import { api, ApiError, type Balance, type WalletInfo } from './api';
import { fmtAsset, fmtNumber, fmtToman, num } from './format';
import { t } from './i18n';
import { listen } from './live';

interface State {
    info: WalletInfo | null;
    error: string | null;
    loading: boolean;
}

let state: State = { info: null, error: null, loading: false };
const subscribers = new Set<() => void>();

function set(next: Partial<State>) {
    state = { ...state, ...next };
    for (const s of subscribers) s();
}

let inflight: Promise<void> | null = null;

export function refreshWallet(): Promise<void> {
    if (inflight) return inflight;
    set({ loading: true });
    inflight = api
        .wallet()
        .then((info) => set({ info, error: null }))
        .catch((err) => set({ error: err instanceof ApiError ? err.code : 'unknown' }))
        .finally(() => {
            inflight = null;
            set({ loading: false });
        });
    return inflight;
}

function setBalances(balances: Balance[]) {
    if (state.info) set({ info: { ...state.info, balances } });
}

const subscribe = (fn: () => void) => {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
};

/** The wallet, fetched on first use and kept live while any page shows it. */
export function useWallet(): State {
    const snapshot = useSyncExternalStore(subscribe, () => state);
    useEffect(() => {
        if (!state.info && !inflight) void refreshWallet();
        return listen((msg) => {
            if (msg.type === 'balances') setBalances(msg.balances);
        });
    }, []);
    return snapshot;
}

export function balanceOf(info: WalletInfo | null, asset: string): { available: number; frozen: number } {
    const b = info?.balances.find((x) => x.asset === asset);
    return { available: num(b?.available), frozen: num(b?.frozen) + num(b?.locked) };
}

/** The currency values are shown in: Toman, or USDT for those who think in dollars. */
export type Quote = 'IRT' | 'USDT';
const QUOTE_KEY = 'wallet.quote';
let quote: Quote = (() => {
    try {
        return localStorage.getItem(QUOTE_KEY) === 'USDT' ? 'USDT' : 'IRT';
    } catch {
        return 'IRT';
    }
})();
const quoteSubscribers = new Set<() => void>();

export function setQuote(next: Quote): void {
    quote = next;
    try {
        localStorage.setItem(QUOTE_KEY, next);
    } catch { /* private mode: only for this visit */ }
    for (const s of quoteSubscribers) s();
}

/**
 * The chosen currency, the same on every page and remembered between visits;
 * Toman while USDT has no price to convert at.
 */
export function useQuote(info: WalletInfo | null): Quote {
    const chosen = useSyncExternalStore((fn) => {
        quoteSubscribers.add(fn);
        return () => quoteSubscribers.delete(fn);
    }, () => quote);
    return chosen === 'USDT' && !info?.prices.USDT ? 'IRT' : chosen;
}

/** A value already in `q`, as its digits: whole Toman, or USDT to the cent - and below a cent, enough to not read as zero. */
export function fmtQuote(value: number, q: Quote): string {
    if (q === 'IRT') return fmtToman(value);
    return value > 0 && value < 0.01 ? fmtNumber(value, 4, { trim: true }) : fmtAsset(value, 'USDT');
}

/** "≈ 1,234 Toman" or "≈ 12.05 USDT". */
export const fmtWorth = (value: number, q: Quote): string =>
    t(q === 'IRT' ? 'wallet.worth' : 'wallet.worthUsdt', { amount: fmtQuote(value, q) });

/** A Toman value in `q`, at USDT's price in Toman. */
export function inQuote(info: WalletInfo | null, toman: number, q: Quote): number {
    if (q === 'IRT') return toman;
    const usdt = info?.prices.USDT ?? 0;
    return usdt ? toman / usdt : 0;
}

/** What everything is worth in Toman at the books' best bids; coins without a price count as zero. */
export function totalToman(info: WalletInfo | null): number {
    if (!info) return 0;
    let total = 0;
    for (const b of info.balances) {
        const amount = num(b.available) + num(b.frozen) + num(b.locked);
        total += b.asset === 'IRT' ? amount : amount * (info.prices[b.asset] ?? 0);
    }
    return total;
}
