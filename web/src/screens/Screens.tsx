import { useState } from 'react';

import type { User } from '../api';
import { errorMessage, formatPhone, t } from '../i18n';

export function Loading() {
    return (
        <main className="screen center">
            <div className="spinner" aria-hidden="true" />
            <p className="hint">{t('loading.signingIn')}</p>
        </main>
    );
}

export function OutsideTelegram() {
    const bot = import.meta.env.VITE_BOT_USERNAME;
    return (
        <main className="screen center">
            <h1>{t('outside.title')}</h1>
            <p className="hint">{t('outside.body')}</p>
            {bot && (
                <a className="button" href={`https://t.me/${bot}`}>
                    {t('outside.open')}
                </a>
            )}
        </main>
    );
}

export function ErrorScreen({ code, onRetry }: { code: string; onRetry: () => void }) {
    return (
        <main className="screen center">
            <h1>{t('error.title')}</h1>
            <p className="hint">{errorMessage(code)}</p>
            <button className="button" onClick={onRetry}>{t('error.retry')}</button>
        </main>
    );
}

export function PhoneScreen({ onShare, error }: { onShare: () => Promise<void>; error: string | null }) {
    const [busy, setBusy] = useState(false);
    const share = async () => {
        setBusy(true);
        try {
            await onShare();
        } finally {
            setBusy(false);
        }
    };
    return (
        <main className="screen">
            <div className="grow">
                <div className="icon" aria-hidden="true">📱</div>
                <h1>{t('phone.title')}</h1>
                <p>{t('phone.body')}</p>
                <p className="hint">{t('phone.iranOnly')}</p>
                {error && <p className="error" role="alert">{errorMessage(error)}</p>}
            </div>
            <button className="button" onClick={share} disabled={busy}>
                {busy ? t('phone.sharing') : t('phone.share')}
            </button>
        </main>
    );
}

export function Home({ user }: { user: User }) {
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
    return (
        <main className="screen">
            <h1>{name ? t('home.greeting', { name }) : t('home.greetingNoName')}</h1>
            <section className="card row">
                <span className="hint">{t('home.phone')}</span>
                <span className="ltr">{formatPhone(user.phone)}</span>
            </section>
            <section className="card">
                <h2>{t('home.soonTitle')}</h2>
                <p className="hint">{t('home.soonBody')}</p>
            </section>
        </main>
    );
}
