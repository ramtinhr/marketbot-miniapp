// The mini app's own server, always same-origin /api/v1 (nginx in
// production, Vite's proxy in development).
const API_BASE = '/api/v1';

export interface User {
    id: number;
    telegram_id: number;
    phone: string;
    first_name: string | null;
    last_name: string | null;
    username: string | null;
    created_at: string;
}

export type SignIn = { status: 'ok'; token: string; user: User } | { status: 'phone_required' };

/** The server answered with an error; `code` picks the message the app shows. */
export class ApiError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
    }
}

let token: string | null = null;

export function setToken(value: string | null): void {
    token = value;
}

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
        res = await fetch(`${API_BASE}${path}`, {
            method: init.method ?? 'GET',
            headers,
            body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        });
    } catch {
        throw new ApiError(0, 'network', 'network error');
    }
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.code || 'internal', data.error || `HTTP ${res.status}`);
    return data as T;
}

export const api = {
    signIn: (initData: string) => request<SignIn>('/auth/telegram', { method: 'POST', body: { init_data: initData } }),
    signInWithPhone: (initData: string, contact: string) =>
        request<SignIn & { status: 'ok' }>('/auth/phone', { method: 'POST', body: { init_data: initData, contact } }),
    me: () => request<{ user: User }>('/me').then((r) => r.user),
};
