import { useCallback, useEffect, useState } from 'react';

import { api, ApiError, setToken, type User } from './api';
import { ErrorScreen, Home, Loading, OutsideTelegram, PhoneScreen } from './screens/Screens';
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
    | { kind: 'home'; user: User };

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

export default function App() {
    const [state, setState] = useState<State>({ kind: 'loading' });

    const signIn = useCallback(async () => {
        const app = webApp();
        if (!app) return setState({ kind: 'outside' });
        setState({ kind: 'loading' });
        try {
            const saved = savedToken();
            if (saved) {
                setToken(saved);
                const user = await api.me().catch(() => null);
                // The same device can hold several Telegram accounts.
                if (user && user.telegram_id === app.initDataUnsafe.user?.id) return setState({ kind: 'home', user });
                remember(null);
            }
            const res = await api.signIn(app.initData);
            if (res.status === 'phone_required') return setState({ kind: 'phone', error: null });
            remember(res.token);
            setState({ kind: 'home', user: res.user });
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
            setState({ kind: 'home', user: res.user });
        } catch (err) {
            haptic('error');
            const code = codeOf(err);
            if (code === 'expired' || code === 'bad_signature' || code === 'blocked') setState({ kind: 'error', code });
            else setState({ kind: 'phone', error: code });
        }
    }, []);

    useEffect(() => {
        void signIn();
    }, [signIn]);

    switch (state.kind) {
        case 'loading': return <Loading />;
        case 'outside': return <OutsideTelegram />;
        case 'phone': return <PhoneScreen onShare={sharePhone} error={state.error} />;
        case 'error': return <ErrorScreen code={state.code} onRetry={signIn} />;
        case 'home': return <Home user={state.user} />;
    }
}
