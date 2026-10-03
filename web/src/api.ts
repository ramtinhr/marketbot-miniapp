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

export type SignIn = { status: 'ok'; token: string; user: User; verified?: boolean } | { status: 'phone_required' };

export interface OtpSent { expires_in: number; resend_in: number }

/** Amounts are decimal strings, as Postgres numerics come out. */
export interface Balance { asset: string; status: string; available: string; frozen: string; locked: string; updated_at?: string }
export interface WalletInfo { balances: Balance[]; assets: string[]; prices: Record<string, number> }
export interface LedgerEntry {
    id: number;
    asset: string;
    kind: string;
    amount: string;
    available_delta: string;
    frozen_delta: string;
    available_after: string;
    reference_type: string | null;
    reference_id: string | null;
    reason: string | null;
    created_at: string;
}

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'cancelled';
export interface Payment { id: string; provider: string; amount_toman: string; status: PaymentStatus; ref_id: string | null; card_pan: string | null; created_at: string; paid_at: string | null }
export interface ChargeInfo { min_toman: number; max_toman: number; provider: string; payments: Payment[] }

export type WithdrawalStatus = 'pending' | 'processing' | 'paid' | 'rejected' | 'cancelled';
export interface Withdrawal { id: string; asset: string; amount: string; network: string | null; destination: string; status: WithdrawalStatus; note: string | null; created_at: string }

export type Side = 'buy' | 'sell';
export interface DepthLevel { price: string; quantity: string; user_quantity?: string }
export interface Depth { symbol: string; bids: DepthLevel[]; asks: DepthLevel[]; last_price?: string; trading_mode?: string }
export interface DaySummary { open: number; high: number; low: number; close: number; change_pct: number; volume: number; quote_volume: number }
export interface MarketTrade { id: string; symbol: string; price: string; quantity: string; taker_side: Side; executed_at: string; side?: Side }
export interface Market { symbol: string; depth: Depth | null; summary: DaySummary | null; trades: MarketTrade[] }

export type OrderStatus = 'open' | 'partial' | 'filled' | 'cancelled' | 'rejected';
export interface Order {
    id: string;
    symbol: string;
    side: Side;
    price: string;
    quantity: string;
    filled_quantity: string;
    filled_quote?: string;
    status: OrderStatus;
    created_at: string;
}
export interface PlacedOrder { order: Order | null; trades: MarketTrade[]; type: 'limit' | 'market' }

/** The server answered with an error; `code` picks the message the app shows. */
export class ApiError extends Error {
    constructor(readonly status: number, readonly code: string, message: string, readonly data: Record<string, unknown> = {}) {
        super(message);
    }
}

let token: string | null = null;

export function setToken(value: string | null): void {
    token = value;
}

export function currentToken(): string | null {
    return token;
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
    if (!res.ok) throw new ApiError(res.status, data.code || 'internal', data.error || `HTTP ${res.status}`, data);
    return data as T;
}

const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', body });
const query = (params: Record<string, string | number | null | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') q.set(k, String(v));
    const s = q.toString();
    return s ? `?${s}` : '';
};

export const api = {
    signIn: (initData: string) => post<SignIn>('/auth/telegram', { init_data: initData }),
    signInWithPhone: (initData: string, contact: string) =>
        post<SignIn & { status: 'ok' }>('/auth/phone', { init_data: initData, contact }),
    me: () => request<{ user: User; verified: boolean }>('/me'),
    /** The profile photo as an object URL, or null if there is none or it cannot be had. */
    photo: async (): Promise<string | null> => {
        try {
            const res = await fetch(`${API_BASE}/me/photo`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
            if (!res.ok || !res.headers.get('content-type')?.startsWith('image/')) return null;
            return URL.createObjectURL(await res.blob());
        } catch {
            return null;
        }
    },

    sendLoginCode: () => post<OtpSent>('/auth/otp/send'),
    verifyLoginCode: (code: string) => post<{ verified: true }>('/auth/otp/verify', { code }),

    wallet: () => request<WalletInfo>('/wallet'),
    entries: (asset: string | null, before: number | null = null) =>
        request<{ entries: LedgerEntry[]; next_before: number | null }>(`/wallet/entries${query({ asset, before })}`),

    chargeInfo: () => request<ChargeInfo>('/wallet/charge'),
    charge: (amount: number) => post<{ payment_id: string; url: string }>('/wallet/charge', { amount }),

    withdrawals: () => request<{ networks: Record<string, string[]>; withdrawals: Withdrawal[] }>('/wallet/withdrawals'),
    sendWithdrawCode: () => post<OtpSent>('/wallet/withdrawals/otp'),
    withdraw: (body: { asset: string; amount: string; network: string | null; destination: string; code: string }) =>
        post<{ withdrawal: Withdrawal }>('/wallet/withdrawals', body),
    cancelWithdrawal: (id: string) => post<{ withdrawal: Withdrawal }>(`/wallet/withdrawals/${id}/cancel`),

    symbols: () => request<{ symbols: string[] }>('/market/symbols'),
    market: (symbol: string) => request<Market>(`/market/${symbol}`),
    orders: (symbol: string | null, scope: 'open' | 'history' | 'all' = 'open') =>
        request<{ orders: Order[] }>(`/orders${query({ symbol, scope })}`),
    placeOrder: (body: { symbol: string; side: Side; type: 'limit' | 'market'; price?: string; quantity: string }) =>
        post<PlacedOrder>('/orders', body),
    cancelOrder: (id: string) => post<{ order: Order | null }>(`/orders/${id}/cancel`),
};
