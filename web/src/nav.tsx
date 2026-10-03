// Navigation: three tabs, each a root page, and a stack of pages opened from
// them (an asset, the charge form ...). Telegram's back button, in its
// header, pops the stack; outside Telegram a back arrow in the page does.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { selection, webApp } from './telegram';

export type Tab = 'home' | 'wallet' | 'trade';

export type Page =
    | { name: 'asset'; asset: string }
    | { name: 'charge' }
    | { name: 'deposit' }
    | { name: 'withdraw'; asset?: string };

interface Nav {
    tab: Tab;
    stack: Page[];
    /** The pair the trade tab shows. */
    symbol: string;
    setTab(tab: Tab): void;
    push(page: Page): void;
    back(): void;
    /** Switches to the trade tab on `symbol`, closing any open pages. */
    trade(symbol: string): void;
}

const NavContext = createContext<Nav | null>(null);

export function useNav(): Nav {
    const nav = useContext(NavContext);
    if (!nav) throw new Error('useNav outside NavProvider');
    return nav;
}

export function NavProvider({ initialTab = 'home', initialStack = [], children }: { initialTab?: Tab; initialStack?: Page[]; children: ReactNode }) {
    const [tab, setTabState] = useState<Tab>(initialTab);
    const [stack, setStack] = useState<Page[]>(initialStack);
    const [symbol, setSymbol] = useState('USDT_IRT');

    const setTab = useCallback((next: Tab) => {
        selection();
        setTabState(next);
        setStack([]);
        window.scrollTo(0, 0);
    }, []);
    const push = useCallback((page: Page) => {
        setStack((s) => [...s, page]);
        window.scrollTo(0, 0);
    }, []);
    const back = useCallback(() => setStack((s) => s.slice(0, -1)), []);
    const trade = useCallback((next: string) => {
        setSymbol(next);
        setTabState('trade');
        setStack([]);
        window.scrollTo(0, 0);
    }, []);

    // Telegram's header back button, shown while a page is open.
    const backRef = useRef(back);
    backRef.current = back;
    useEffect(() => {
        const app = webApp();
        if (!app || !app.isVersionAtLeast('6.1')) return;
        const onBack = () => backRef.current();
        app.BackButton.onClick(onBack);
        return () => app.BackButton.offClick(onBack);
    }, []);
    useEffect(() => {
        const app = webApp();
        if (!app || !app.isVersionAtLeast('6.1')) return;
        if (stack.length) app.BackButton.show();
        else app.BackButton.hide();
    }, [stack.length]);

    const value = useMemo(() => ({ tab, stack, symbol, setTab, push, back, trade }), [tab, stack, symbol, setTab, push, back, trade]);
    return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}
