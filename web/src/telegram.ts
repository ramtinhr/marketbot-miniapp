// The part of Telegram's WebApp object (telegram-web-app.js, loaded in
// index.html) this app uses. https://core.telegram.org/bots/webapps

export interface TelegramUser {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
    photo_url?: string;
}

export interface RequestContactResult {
    status: 'sent' | 'cancelled';
    /** The contact as a query string Telegram signed; what the server verifies. */
    response?: string;
}

export interface BottomButton {
    setParams(params: { text?: string; is_active?: boolean; is_visible?: boolean; has_shine_effect?: boolean }): BottomButton;
    showProgress(leaveActive?: boolean): BottomButton;
    hideProgress(): BottomButton;
    onClick(callback: () => void): BottomButton;
    offClick(callback: () => void): BottomButton;
}

export interface BackButton {
    show(): void;
    hide(): void;
    onClick(callback: () => void): void;
    offClick(callback: () => void): void;
}

type ThemeColorKey = 'bg_color' | 'secondary_bg_color';

interface TelegramWebApp {
    initData: string;
    initDataUnsafe: { user?: TelegramUser; start_param?: string };
    version: string;
    colorScheme: 'light' | 'dark';
    isVersionAtLeast(version: string): boolean;
    ready(): void;
    expand(): void;
    close(): void;
    disableVerticalSwipes?(): void;
    setHeaderColor?(color: ThemeColorKey | `#${string}`): void;
    setBackgroundColor?(color: ThemeColorKey | `#${string}`): void;
    setBottomBarColor?(color: ThemeColorKey | 'bottom_bar_bg_color' | `#${string}`): void;
    onEvent(event: 'themeChanged', callback: () => void): void;
    requestContact(callback: (shared: boolean, result?: RequestContactResult) => void): void;
    onEvent(event: 'activated', callback: () => void): void;
    offEvent(event: 'activated', callback: () => void): void;
    openLink(url: string, options?: { try_instant_view?: boolean }): void;
    showConfirm(message: string, callback: (ok: boolean) => void): void;
    MainButton: BottomButton;
    BackButton: BackButton;
    HapticFeedback?: {
        notificationOccurred(type: 'error' | 'success' | 'warning'): void;
        impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
        selectionChanged(): void;
    };
}

declare global {
    interface Window {
        Telegram?: { WebApp?: TelegramWebApp };
    }
}

/** The WebApp object, or null when the page was opened outside Telegram. */
export function webApp(): TelegramWebApp | null {
    const app = window.Telegram?.WebApp;
    return app && app.initData ? app : null;
}

/**
 * Tells Telegram the app is ready and paints its header and bottom bar in the
 * app's page colour, so the app and Telegram's chrome read as one surface.
 */
export function setUpChrome(app: TelegramWebApp): void {
    app.ready();
    app.expand();
    const paint = () => {
        document.documentElement.dataset.scheme = app.colorScheme;
        if (!app.isVersionAtLeast('6.1')) return;
        app.setHeaderColor?.('secondary_bg_color');
        app.setBackgroundColor?.('secondary_bg_color');
        if (app.isVersionAtLeast('7.10')) app.setBottomBarColor?.('secondary_bg_color');
    };
    paint();
    app.onEvent('themeChanged', paint);
    // Scrolling a page (or an order book) should not swipe the app closed.
    if (app.isVersionAtLeast('7.7')) app.disableVerticalSwipes?.();
}

export class ContactError extends Error {
    constructor(readonly code: 'cancelled' | 'unsupported' | 'no_response') {
        super(code);
    }
}

/** Asks Telegram for the account's phone number; resolves with the signed contact. */
export function requestContact(): Promise<string> {
    const app = webApp();
    if (!app || !app.isVersionAtLeast('6.9')) return Promise.reject(new ContactError('unsupported'));
    return new Promise((resolve, reject) => {
        app.requestContact((shared, result) => {
            if (!shared || result?.status !== 'sent') reject(new ContactError('cancelled'));
            else if (!result.response) reject(new ContactError('no_response'));
            else resolve(result.response);
        });
    });
}

export function haptic(type: 'error' | 'success' | 'warning'): void {
    webApp()?.HapticFeedback?.notificationOccurred(type);
}

export function tap(): void {
    webApp()?.HapticFeedback?.impactOccurred('light');
}

export function selection(): void {
    webApp()?.HapticFeedback?.selectionChanged();
}

/** Opens a page (a payment gateway) in the browser, outside the mini app. */
export function openExternal(url: string): void {
    const absolute = new URL(url, location.origin).toString();
    const app = webApp();
    if (app && app.isVersionAtLeast('6.1')) app.openLink(absolute);
    else window.open(absolute, '_blank', 'noopener');
}

/** Telegram's own yes/no dialog; the browser's elsewhere. */
export function confirm(message: string): Promise<boolean> {
    const app = webApp();
    if (app && app.isVersionAtLeast('6.2')) return new Promise((resolve) => app.showConfirm(message, resolve));
    return Promise.resolve(window.confirm(message));
}
