// Navigation: three tabs, each a root page, and a stack of pages opened from
// them (an asset, the charge form ...). Back - Telegram's header button (and
// Android's back key, which Telegram routes to it), or outside Telegram a back
// arrow in the page - undoes the last thing, in this order: whatever a screen
// registered with useBackHandler (a sheet, a step of a form), the top page,
// then a tab other than home. Only on home with nothing open does Telegram's
// own close button remain.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { selection, webApp } from './telegram';

export type Tab = 'home' | 'wallet' | 'trade';

export type OrderType = 'limit' | 'market' | 'auction';

export type Page =
    | { name: 'asset'; asset: string }
    | { name: 'charge' }
    | { name: 'deposit' }
    | { name: 'withdraw'; asset?: string }
    | { name: 'auctionOrders' };

interface Nav {
    tab: Tab;
    stack: Page[];
    /** The pair the trade tab shows. */
    symbol: string;
    /** Whether back has anything to undo. */
    canGoBack: boolean;
    setTab(tab: Tab): void;
    push(page: Page): void;
    back(): void;
    /** The kind of order the trade tab places. */
    orderType: OrderType;
    setOrderType(type: OrderType): void;
    /** Switches to the trade tab on `symbol`, closing any open pages. */
    trade(symbol: string, type?: OrderType): void;
    /** The pair the order-type sheet is open for, if it is. */
    tradeSheet: string | null;
    /** Asks for the order type (market, limit, auction), then opens the trade tab. */
    openTrade(symbol?: string): void;
    closeTradeSheet(): void;
    /** @internal see useBackHandler */
    addHandler(handler: { current: () => void }): () => void;
}

const NavContext = createContext<Nav | null>(null);

export function useNav(): Nav {
    const nav = useContext(NavContext);
    if (!nav) throw new Error('useNav outside NavProvider');
    return nav;
}

/**
 * While `handler` is given, back calls it instead of leaving the page: for a
 * sheet to close or a form step to go back to the previous one. The latest
 * registered handler wins.
 */
export function useBackHandler(handler: (() => void) | null | false | undefined): void {
    const { addHandler } = useNav();
    const ref = useRef<() => void>(() => {});
    if (handler) ref.current = handler;
    const active = Boolean(handler);
    useEffect(() => (active ? addHandler(ref) : undefined), [active, addHandler]);
}

export function NavProvider({ initialTab = 'home', initialStack = [], initialOrderType = 'limit', children }: {
    initialTab?: Tab;
    initialStack?: Page[];
    initialOrderType?: OrderType;
    children: ReactNode;
}) {
    const [tab, setTabState] = useState<Tab>(initialTab);
    const [stack, setStack] = useState<Page[]>(initialStack);
    const [symbol, setSymbol] = useState('USDT_IRT');
    const [orderType, setOrderType] = useState<OrderType>(initialOrderType);
    const [tradeSheet, setTradeSheet] = useState<string | null>(null);
    const handlers = useRef<{ current: () => void }[]>([]);
    const [handlerCount, setHandlerCount] = useState(0);

    const addHandler = useCallback((handler: { current: () => void }) => {
        handlers.current.push(handler);
        setHandlerCount(handlers.current.length);
        return () => {
            handlers.current = handlers.current.filter((h) => h !== handler);
            setHandlerCount(handlers.current.length);
        };
    }, []);

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
    const trade = useCallback((next: string, type?: OrderType) => {
        setSymbol(next);
        if (type) setOrderType(type);
        setTabState('trade');
        setStack([]);
        window.scrollTo(0, 0);
    }, []);
    const symbolRef = useRef(symbol);
    symbolRef.current = symbol;
    const openTrade = useCallback((next?: string) => {
        selection();
        setTradeSheet(next ?? symbolRef.current);
    }, []);
    const closeTradeSheet = useCallback(() => setTradeSheet(null), []);

    const canGoBack = handlerCount > 0 || stack.length > 0 || tab !== 'home';
    const state = useRef({ stack, tab });
    state.current = { stack, tab };
    const back = useCallback(() => {
        const top = handlers.current.at(-1);
        if (top) return top.current();
        if (state.current.stack.length) {
            setStack((s) => s.slice(0, -1));
            window.scrollTo(0, 0);
        } else if (state.current.tab !== 'home') {
            setTabState('home');
            window.scrollTo(0, 0);
        }
    }, []);

    useEffect(() => {
        const app = webApp();
        if (!app || !app.isVersionAtLeast('6.1')) return;
        app.BackButton.onClick(back);
        return () => app.BackButton.offClick(back);
    }, [back]);
    useEffect(() => {
        const app = webApp();
        if (!app || !app.isVersionAtLeast('6.1')) return;
        if (canGoBack) app.BackButton.show();
        else app.BackButton.hide();
    }, [canGoBack]);
    useEffect(() => () => webApp()?.BackButton.hide(), []);

    const value = useMemo(
        () => ({ tab, stack, symbol, canGoBack, setTab, push, back, orderType, setOrderType, trade, tradeSheet, openTrade, closeTradeSheet, addHandler }),
        [tab, stack, symbol, canGoBack, setTab, push, back, orderType, trade, tradeSheet, openTrade, closeTradeSheet, addHandler],
    );
    return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}
