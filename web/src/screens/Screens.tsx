import { useEffect, useState, type ReactNode } from 'react';

import { api, type User } from '../api';
import {
    AlertIcon,
    AtSignIcon,
    CalendarIcon,
    CandlesIcon,
    ChevronEndIcon,
    ClockIcon,
    CreditCardIcon,
    LockIcon,
    MapPinIcon,
    PhoneIcon,
    SendIcon,
    ShieldCheckIcon,
    SmartphoneIcon,
    TrendingUpIcon,
    WalletIcon,
    WifiOffIcon,
    ZapIcon,
} from '../components/icons';
import { MainAction } from '../components/MainAction';
import { Badge, type Icon, type Tone } from '../components/ui';
import { fmtToman } from '../format';
import { errorMessage, faDigits, formatPhone, t } from '../i18n';
import { useNav } from '../nav';
import { webApp } from '../telegram';
import { balanceOf, totalToman, useWallet } from '../wallet';

function Brand() {
    return (
        <div className="brand">
            <span className="brand-mark"><TrendingUpIcon /></span>
            <span className="brand-name">{t('app.name')}</span>
        </div>
    );
}

export function Loading() {
    return (
        <main className="screen center enter">
            <Brand />
            <div className="loading-row" role="status">
                <span className="spinner" aria-hidden="true" />
                <span className="hint">{t('loading.signingIn')}</span>
            </div>
        </main>
    );
}

export function OutsideTelegram() {
    const bot = import.meta.env.VITE_BOT_USERNAME;
    return (
        <main className="screen center enter">
            <Badge icon={SendIcon} size="lg" />
            <div className="stack">
                <h1>{t('outside.title')}</h1>
                <p className="lead">{t('outside.body')}</p>
            </div>
            {bot && (
                <div className="action-bar">
                    <a className="button" href={`https://t.me/${bot}`}>{t('outside.open')}</a>
                </div>
            )}
        </main>
    );
}

const ERROR_ICONS: Record<string, Icon> = { network: WifiOffIcon, blocked: LockIcon, expired: ClockIcon };
/** Errors a retry cannot fix: Telegram has to relaunch the app with fresh launch parameters. */
const NEEDS_RELAUNCH = new Set(['expired', 'bad_signature']);

export function ErrorScreen({ code, onRetry }: { code: string; onRetry: () => void }) {
    const relaunch = NEEDS_RELAUNCH.has(code);
    return (
        <main className="screen center enter">
            <Badge icon={ERROR_ICONS[code] ?? AlertIcon} tone="danger" size="lg" />
            <div className="stack">
                <h1>{t('error.title')}</h1>
                <p className="lead">{errorMessage(code)}</p>
            </div>
            {code !== 'blocked' && (
                <MainAction
                    text={relaunch ? t('error.close') : t('error.retry')}
                    onClick={relaunch ? () => webApp()?.close() : onRetry}
                />
            )}
        </main>
    );
}

function Feature({ icon, tone, title, body }: { icon: Icon; tone: Tone; title: string; body: string }) {
    return (
        <li className="row">
            <Badge icon={icon} tone={tone} />
            <div className="row-text">
                <span className="row-title">{title}</span>
                <span className="row-subtitle">{body}</span>
            </div>
        </li>
    );
}

export function PhoneScreen({ onShare, error }: { onShare: () => Promise<void>; error: string | null }) {
    const [busy, setBusy] = useState(false);
    const share = async () => {
        if (busy) return;
        setBusy(true);
        try {
            await onShare();
        } finally {
            setBusy(false);
        }
    };
    return (
        <main className="screen enter">
            <header className="hero">
                <span className="hero-art"><Badge icon={SmartphoneIcon} size="lg" /></span>
                <h1>{t('phone.title')}</h1>
                <p className="lead">{t('phone.body')}</p>
            </header>

            <ul className="section">
                <Feature icon={ShieldCheckIcon} tone="success" title={t('phone.verifiedTitle')} body={t('phone.verifiedBody')} />
                <Feature icon={ZapIcon} tone="warning" title={t('phone.noSmsTitle')} body={t('phone.noSmsBody')} />
                <Feature icon={MapPinIcon} tone="accent" title={t('phone.iranTitle')} body={t('phone.iranBody')} />
            </ul>

            {error && (
                <div className="alert" role="alert" key={error}>
                    <AlertIcon />
                    <p>{errorMessage(error)}</p>
                </div>
            )}

            <p className="footnote"><LockIcon />{t('phone.privacy')}</p>

            <MainAction text={busy ? t('phone.sharing') : t('phone.share')} onClick={share} busy={busy} shine />
        </main>
    );
}

// One fetch per user per app run: the avatar remounts on every tab switch.
const photos = new Map<number, Promise<string | null>>();

/**
 * The photo the bot fetched through the Bot API, served by our own origin;
 * failing that the launch parameters' photo_url (on t.me, which the webview
 * cannot always reach); failing both, the name's initial.
 */
function Avatar({ user }: { user: User }) {
    const tgUser = webApp()?.initDataUnsafe.user;
    const fallback = tgUser?.id === user.telegram_id ? tgUser.photo_url : undefined;
    const [sources, setSources] = useState<string[]>([]);
    useEffect(() => {
        let live = true;
        if (!photos.has(user.telegram_id)) photos.set(user.telegram_id, api.photo());
        photos.get(user.telegram_id)!.then((own) => {
            if (live) setSources([own, fallback].filter((s): s is string => Boolean(s)));
        });
        return () => {
            live = false;
        };
    }, [user.telegram_id, fallback]);
    const initial = (user.first_name || user.username || '؟').trim().charAt(0).toUpperCase();
    return (
        <span className="avatar" aria-hidden="true">
            {sources.length ? <img src={sources[0]} alt="" onError={() => setSources((s) => s.slice(1))} /> : initial}
        </span>
    );
}

function InfoRow({ icon, label, children }: { icon: Icon; label: string; children: ReactNode }) {
    return (
        <li className="row">
            <Badge icon={icon} />
            <span className="row-title">{label}</span>
            <span className="row-value">{children}</span>
        </li>
    );
}

const joinedDate = new Intl.DateTimeFormat('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' });

function NavRow({ icon, tone, title, body, onClick }: { icon: Icon; tone: Tone; title: string; body: string; onClick: () => void }) {
    return (
        <li>
            <button type="button" className="row tappable" onClick={onClick}>
                <Badge icon={icon} tone={tone} />
                <span className="row-text">
                    <span className="row-title">{title}</span>
                    <span className="row-subtitle">{body}</span>
                </span>
                <ChevronEndIcon className="row-chevron" />
            </button>
        </li>
    );
}

export function Home({ user }: { user: User }) {
    const nav = useNav();
    const { info } = useWallet();
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
    const joined = new Date(user.created_at);
    return (
        <main className="screen tabbed enter">
            <header className="profile">
                <Avatar user={user} />
                <h1>{name ? t('home.greeting', { name }) : t('home.greetingNoName')}</h1>
                <p className="hint">{t('home.welcome')}</p>
            </header>

            <button type="button" className="balance-card compact" onClick={() => nav.setTab('wallet')}>
                <span className="balance-head"><span>{t('wallet.total')}</span><WalletIcon /></span>
                <span className="balance-total">
                    <strong>{info ? fmtToman(totalToman(info)) : '—'}</strong>
                    <span>{t('common.toman')}</span>
                </span>
                <span className="balance-sub">{t('wallet.availableToman', { amount: fmtToman(balanceOf(info, 'IRT').available) })}</span>
            </button>

            <ul className="section">
                <NavRow icon={CandlesIcon} tone="success" title={t('home.tradeTitle')} body={t('home.tradeBody')} onClick={() => nav.openTrade()} />
                <NavRow icon={CreditCardIcon} tone="accent" title={t('home.chargeTitle')} body={t('home.chargeBody')} onClick={() => { nav.setTab('wallet'); nav.push({ name: 'charge' }); }} />
            </ul>

            <section>
                <h2 className="section-title">{t('home.account')}</h2>
                <ul className="section">
                    <InfoRow icon={PhoneIcon} label={t('home.phone')}>
                        <bdi className="ltr">{formatPhone(user.phone)}</bdi>
                    </InfoRow>
                    {user.username && (
                        <InfoRow icon={AtSignIcon} label={t('home.username')}>
                            <bdi className="ltr">@{user.username}</bdi>
                        </InfoRow>
                    )}
                    {!Number.isNaN(joined.getTime()) && (
                        <InfoRow icon={CalendarIcon} label={t('home.memberSince')}>
                            {faDigits(joinedDate.format(joined))}
                        </InfoRow>
                    )}
                    <InfoRow icon={ShieldCheckIcon} label={t('home.security')}>
                        <span className="status paid">{t('home.smsVerified')}</span>
                    </InfoRow>
                </ul>
            </section>
        </main>
    );
}
