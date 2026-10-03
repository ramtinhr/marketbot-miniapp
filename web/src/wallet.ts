// The user's balances, shared by every page: fetched once, refreshed on
// demand (after a charge or withdrawal) and kept current by the live socket.

import { useEffect, useSyncExternalStore } from 'react';

import { api, ApiError, type Balance, type WalletInfo } from './api';
import { num } from './format';
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
