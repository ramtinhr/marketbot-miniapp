// The part of Telegram's WebApp object (telegram-web-app.js, loaded in
// index.html) this app uses. https://core.telegram.org/bots/webapps

export interface TelegramUser {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
}

export interface RequestContactResult {
    status: 'sent' | 'cancelled';
    /** The contact as a query string Telegram signed; what the server verifies. */
    response?: string;
}

interface TelegramWebApp {
    initData: string;
    initDataUnsafe: { user?: TelegramUser };
    version: string;
    colorScheme: 'light' | 'dark';
    isVersionAtLeast(version: string): boolean;
    ready(): void;
    expand(): void;
    requestContact(callback: (shared: boolean, result?: RequestContactResult) => void): void;
    HapticFeedback?: { notificationOccurred(type: 'error' | 'success' | 'warning'): void };
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
