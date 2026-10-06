import { useCallback, useEffect, useState } from 'react';

import { api, ApiError, setToken, type User } from './api';
import { reauthenticate } from './live';
import type { OrderType, Page, Tab } from './nav';
import { OtpScreen } from './screens/Otp';
import { ErrorScreen, Loading, OutsideTelegram, PhoneScreen } from './screens/Screens';
import { Shell } from './screens/Shell';
import { ContactError, haptic, requestContact, webApp } from './telegram';

// Telegram keeps this per bot across launches, so reopening the app skips the
// round trip to sign in again. The server is still the judge: a dead token is
// a 401 and the app signs in from the launch parameters instead.
const TOKEN_KEY = 'marketbot-miniapp-token';

type State =
    | { kind: 'loading' }
    | { kind: 'outside' }
    | { kind: 'phone'; error: string | null }
    | { kind: 'error'; code: string }
    // Signed in, but money waits for the SMS code (once per session).
    | { kind: 'otp'; user: User }
    | { kind: 'app'; user: User } & Launch;

interface Launch { tab?: Tab; stack?: Page[]; orderType?: OrderType }

/**
 * Where the app opens: the bot's buttons add `?screen=`, and a t.me link's
 * `startapp=` arrives as the launch parameters' start_param.
 */
function launchScreen(): Launch {
    const screen = new URLSearchParams(window.location.search).get('screen') ?? webApp()?.initDataUnsafe.start_param;
    switch (screen) {
        case 'auction': return { tab: 'trade', orderType: 'auction' };
        case 'myoffers': return { tab: 'trade', orderType: 'auction', stack: [{ name: 'auctionOrders' }] };
        case 'trade': return { tab: 'trade' };
        case 'wallet': return { tab: 'wallet' };
        case 'charge': return { tab: 'wallet', stack: [{ name: 'charge' }] };
        default: return {};
    }
}

export const PREVIEW_USER: User = {
    id: 1,
    telegram_id: 1,
    phone: '+989121234567',
    first_name: 'رامتین',
    last_name: null,
    username: 'ramtin',
    created_at: new Date().toISOString(),
};

/**
 * Development only: `?preview=<screen>` shows that screen with sample data
 * (see preview.ts, which also fakes the server), so the UI can be worked on
 * in a browser.
 */
function previewState(): State | null {
    if (!import.meta.env.DEV) return null;
    const preview = new URLSearchParams(window.location.search).get('preview');
    const user = PREVIEW_USER;
    switch (preview) {
        case 'loading': return { kind: 'loading' };
        case 'outside': return { kind: 'outside' };
        case 'phone': return { kind: 'phone', error: null };
        case 'phone-error': return { kind: 'phone', error: 'phone_not_iranian' };
        case 'error': return { kind: 'error', code: 'network' };
        case 'otp': return { kind: 'otp', user };
        case 'home': return { kind: 'app', user };
        case 'wallet': return { kind: 'app', user, tab: 'wallet' };
        case 'trade': return { kind: 'app', user, tab: 'trade' };
        case 'auction': return { kind: 'app', user, tab: 'trade', orderType: 'auction' };
        case 'myoffers': return { kind: 'app', user, tab: 'trade', orderType: 'auction', stack: [{ name: 'auctionOrders' }] };
        case 'asset': return { kind: 'app', user, tab: 'wallet', stack: [{ name: 'asset', asset: 'USDT' }] };
        case 'charge': return { kind: 'app', user, tab: 'wallet', stack: [{ name: 'charge' }] };
        case 'deposit': return { kind: 'app', user, tab: 'wallet', stack: [{ name: 'deposit' }] };
        case 'withdraw': return { kind: 'app', user, tab: 'wallet', stack: [{ name: 'withdraw' }] };
        default: return null;
    }
}

const codeOf = (err: unknown) => (err instanceof ApiError || err instanceof ContactError ? err.code : 'unknown');

function savedToken(): string | null {
    try {
        return localStorage.getItem(TOKEN_KEY);
    } catch {
        return null;
    }
}

function remember(token: string | null) {
    setToken(token);
    try {
        if (token) localStorage.setItem(TOKEN_KEY, token);
        else localStorage.removeItem(TOKEN_KEY);
    } catch { /* storage unavailable: the session lasts this launch */ }
}

const signedIn = (user: User, verified: boolean | undefined): State => (verified ? { kind: 'app', user, ...launchScreen() } : { kind: 'otp', user });

export default function App() {
    const [preview] = useState(previewState);
    const [state, setState] = useState<State>(preview ?? { kind: 'loading' });

    const signIn = useCallback(async () => {
        const app = webApp();
        if (!app) return setState({ kind: 'outside' });
        setState({ kind: 'loading' });
        try {
            const saved = savedToken();
            if (saved) {
                setToken(saved);
                const me = await api.me().catch(() => null);
                // The same device can hold several Telegram accounts.
                if (me && me.user.telegram_id === app.initDataUnsafe.user?.id) return setState(signedIn(me.user, me.verified));
                remember(null);
            }
            const res = await api.signIn(app.initData);
            if (res.status === 'phone_required') return setState({ kind: 'phone', error: null });
            remember(res.token);
            setState(signedIn(res.user, res.verified));
        } catch (err) {
            setState({ kind: 'error', code: codeOf(err) });
        }
    }, []);

    const sharePhone = useCallback(async () => {
        const app = webApp();
        if (!app) return setState({ kind: 'outside' });
        try {
            const contact = await requestContact();
            const res = await api.signInWithPhone(app.initData, contact);
            remember(res.token);
            haptic('success');
            setState(signedIn(res.user, res.verified));
        } catch (err) {
            haptic('error');
            const code = codeOf(err);
            if (code === 'expired' || code === 'bad_signature' || code === 'blocked') setState({ kind: 'error', code });
            else setState({ kind: 'phone', error: code });
        }
    }, []);

    const verify = useCallback(async (user: User, code: string) => {
        await api.verifyLoginCode(code);
        // The socket was told about the session before it could see money.
        reauthenticate();
        setState({ kind: 'app', user, ...launchScreen() });
    }, []);

    useEffect(() => {
        if (!preview) void signIn();
    }, [signIn, preview]);

    switch (state.kind) {
        case 'loading': return <Loading />;
        case 'outside': return <OutsideTelegram />;
        case 'phone': return <PhoneScreen onShare={sharePhone} error={state.error} />;
        case 'error': return <ErrorScreen code={state.code} onRetry={signIn} />;
        case 'otp': return <OtpScreen phone={state.user.phone} send={api.sendLoginCode} verify={(code) => verify(state.user, code)} />;
        case 'app': return <Shell user={state.user} initialTab={state.tab} initialStack={state.stack} initialOrderType={state.orderType} />;
    }
}
