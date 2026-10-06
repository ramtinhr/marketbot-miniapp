// Development only (?preview=...): a stand-in for the server and its socket,
// with a book that moves and trades that print, so every screen can be seen
// and worked on in a browser without Telegram, Kafka or the engine.

import type { AuctionBook, AuctionOffer, Balance, Depth, DepthLevel, MarketTrade, Order, Payment, Withdrawal } from './api';
import { useTransport, type Transport } from './live';

const MIDS: Record<string, number> = {
    USDT_IRT: 102_350, BTC_IRT: 6_985_000_000, ETH_IRT: 342_500_000, TRX_IRT: 25_480, SOL_IRT: 15_850_000,
    XRP_IRT: 238_900, DOGE_IRT: 21_760, BNB_IRT: 64_200_000, ADA_IRT: 72_300, SHIB_IRT: 2.41, USDC_IRT: 102_200,
};
const SYMBOLS = Object.keys(MIDS);
const STEP: Record<string, number> = { USDT_IRT: 10, USDC_IRT: 10, BTC_IRT: 50_000, ETH_IRT: 10_000, SOL_IRT: 1000, BNB_IRT: 5000, SHIB_IRT: 0.01 };

let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const now = () => new Date().toISOString();

const balances: Balance[] = [
    { asset: 'IRT', status: 'active', available: '48250000', frozen: '1500000', locked: '2047000' },
    { asset: 'USDT', status: 'active', available: '412.38', frozen: '0', locked: '20' },
    { asset: 'BTC', status: 'active', available: '0.00412', frozen: '0', locked: '0' },
    { asset: 'TRX', status: 'active', available: '1250', frozen: '0', locked: '0' },
];
const orders: Order[] = [
    { id: id(), symbol: 'USDT_IRT', side: 'buy', price: '102100', quantity: '20', filled_quantity: '5', status: 'partial', created_at: now() },
    { id: id(), symbol: 'USDT_IRT', side: 'sell', price: '102900', quantity: '20', filled_quantity: '0', status: 'open', created_at: now() },
];
const payments: Payment[] = [
    { id: id(), provider: 'fake', amount_toman: '5000000', status: 'paid', ref_id: '8f2a91c0d3', card_pan: null, created_at: new Date(Date.now() - 864e5).toISOString(), paid_at: now() },
    { id: id(), provider: 'fake', amount_toman: '250000', status: 'cancelled', ref_id: null, card_pan: null, created_at: new Date(Date.now() - 3 * 864e5).toISOString(), paid_at: null },
];
const withdrawals: Withdrawal[] = [
    { id: id(), asset: 'IRT', amount: '1500000', network: null, destination: 'IR820540102680020817909002', status: 'pending', note: null, created_at: now() },
];

function book(symbol: string): Depth {
    const mid = MIDS[symbol];
    const step = STEP[symbol] ?? Math.max(mid / 4000, 0.0001);
    const level = (i: number, sign: number): DepthLevel => {
        const qty = (Math.random() * 900 + 40) * (1 + i / 4) * (100_000 / Math.max(mid, 1)) ** 0.6;
        return { price: String(+(mid + sign * step * (i + 1 + Math.floor(Math.random() * 2))).toFixed(6)), quantity: qty.toFixed(mid > 1e6 ? 6 : 2) };
    };
    const sortUniq = (ls: DepthLevel[], dir: number) =>
        [...new Map(ls.map((l) => [l.price, l])).values()].sort((a, b) => dir * (Number(a.price) - Number(b.price)));
    return {
        symbol,
        asks: sortUniq(Array.from({ length: 20 }, (_, i) => level(i * 2, 1)), 1),
        bids: sortUniq(Array.from({ length: 20 }, (_, i) => level(i * 2, -1)), -1),
        last_price: String(mid),
    };
}

const trades: Record<string, MarketTrade[]> = {};
function tradesOf(symbol: string): MarketTrade[] {
    if (!trades[symbol]) {
        const mid = MIDS[symbol];
        trades[symbol] = Array.from({ length: 24 }, (_, i) => ({
            id: id(), symbol, taker_side: Math.random() > 0.5 ? 'buy' : 'sell',
            price: String(+(mid * (1 + (Math.random() - 0.5) / 400)).toFixed(mid > 1000 ? 0 : 4)),
            quantity: (Math.random() * 50 * (100_000 / mid) ** 0.6).toFixed(mid > 1e6 ? 6 : 2),
            executed_at: new Date(Date.now() - i * 37_000).toISOString(),
        }));
    }
    return trades[symbol];
}

// The auction: other users' offers around the mid, and the user's own. Not matched here.
const auctionOthers: Record<string, Order[]> = {};
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const auctionMine: Order[] = [
    { id: id(), symbol: 'USDT_IRT', side: 'buy', price: '101900', quantity: '50', filled_quantity: '0', status: 'open', description: 'فقط تسویهٔ فوری', created_at: ago(12) },
    { id: id(), symbol: 'BTC_IRT', side: 'sell', price: '7010000000', quantity: '0.004', filled_quantity: '0.001', status: 'partial', description: '', created_at: ago(26 * 60) },
];
const auctionClosed: Order[] = [
    { id: id(), symbol: 'USDT_IRT', side: 'sell', price: '102600', quantity: '30', filled_quantity: '30', filled_quote: '3078000', status: 'filled', description: '', created_at: ago(3 * 60) },
    { id: id(), symbol: 'TRX_IRT', side: 'buy', price: '25300', quantity: '400', filled_quantity: '150', filled_quote: '3795000', status: 'cancelled', description: '', created_at: ago(2 * 24 * 60) },
];
function closeMine(o: Order): Order {
    const closed = { ...o, status: 'cancelled' as const };
    auctionMine.splice(auctionMine.indexOf(o), 1);
    auctionClosed.unshift(closed);
    pushAuction(o.symbol);
    return closed;
}
function auctionOffers(symbol: string): Order[] {
    if (!auctionOthers[symbol]) {
        const mid = MIDS[symbol];
        let age = 9;
        const offer = (side: Order['side'], pct: number, qty: number, filled = 0, description = ''): Order => ({
            id: id(), symbol, side, price: String(+(mid * (1 + pct / 100)).toFixed(mid > 1000 ? 0 : 4)),
            quantity: (qty * (100_000 / mid) ** 0.6).toFixed(mid > 1e6 ? 6 : 2),
            filled_quantity: (filled * (100_000 / mid) ** 0.6).toFixed(mid > 1e6 ? 6 : 2),
            status: filled ? 'partial' : 'open', description, created_at: new Date(Date.now() - age-- * 7 * 60_000).toISOString(),
        });
        auctionOthers[symbol] = [
            offer('buy', -2, 500), offer('sell', 1.6, 75, 0, 'خرد هم می‌فروشم، حداقل ۱۰ تا'), offer('buy', -1.1, 90),
            offer('sell', 0.9, 300, 120), offer('buy', -1.1, 140, 0, 'فقط تسویهٔ فوری'), offer('sell', 0.4, 120),
            offer('buy', -0.5, 200), offer('sell', 0.4, 60),
        ];
    }
    return [...auctionOthers[symbol], ...auctionMine.filter((o) => o.symbol === symbol)];
}
/** The board: every open offer, newest first. */
function auctionBoard(symbol: string): AuctionOffer[] {
    return auctionOffers(symbol)
        .map((o) => ({ id: o.id, side: o.side, price: o.price, quantity: o.quantity, remaining: String(+(Number(o.quantity) - Number(o.filled_quantity)).toFixed(8)), description: o.description ?? '', created_at: o.created_at }))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
}
function pushAuction(symbol: string) {
    liveSocket?.push({ type: 'auction_book', book: auctionBook(symbol) });
    liveSocket?.push({ type: 'auction_offers', symbol, offers: auctionBoard(symbol) });
}
function auctionBook(symbol: string): AuctionBook {
    const levels = (side: Order['side'], dir: number) => {
        const by = new Map<string, { quantity: number; orders: number }>();
        for (const o of auctionOffers(symbol).filter((x) => x.side === side)) {
            const l = by.get(o.price) ?? { quantity: 0, orders: 0 };
            by.set(o.price, { quantity: l.quantity + Number(o.quantity) - Number(o.filled_quantity), orders: l.orders + 1 });
        }
        return [...by].sort((a, b) => dir * (Number(a[0]) - Number(b[0]))).map(([price, l]) => ({ price, quantity: String(l.quantity), orders: l.orders }));
    };
    return { symbol, bids: levels('buy', -1), asks: levels('sell', 1), last_price: '' };
}
let liveSocket: FakeSocket | null = null;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function route(method: string, path: string, body: Record<string, unknown>): Promise<Response> {
    await wait(250);
    const [p, qs] = path.split('?');
    const q = new URLSearchParams(qs);
    if (p === '/me') return json({ verified: true });
    if (p === '/auth/otp/send' || p === '/wallet/withdrawals/otp') return json({ expires_in: 120, resend_in: 60 });
    if (p === '/auth/otp/verify') {
        return body.code === '123456' ? json({ verified: true }) : json({ error: 'wrong code', code: 'otp_wrong', attempts_left: 4 }, 400);
    }
    if (p === '/wallet') {
        const prices: Record<string, number> = {};
        for (const s of SYMBOLS) prices[s.split('_')[0]] = MIDS[s];
        return json({ balances, assets: ['IRT', ...SYMBOLS.map((s) => s.split('_')[0])], prices });
    }
    if (p === '/wallet/entries') {
        const asset = q.get('asset') ?? 'IRT';
        return json({
            next_before: null,
            entries: [
                { id: 3, asset, kind: 'trade', amount: '20', available_delta: '20', frozen_delta: '0', available_after: '412.38', reference_type: 'trade', reference_id: null, reason: null, created_at: now() },
                { id: 2, asset, kind: 'lock', amount: '20', available_delta: '-20', frozen_delta: '0', available_after: '392.38', reference_type: 'order', reference_id: null, reason: null, created_at: new Date(Date.now() - 36e5).toISOString() },
                { id: 1, asset, kind: 'credit', amount: '412.38', available_delta: '412.38', frozen_delta: '0', available_after: '412.38', reference_type: 'deposit', reference_id: null, reason: null, created_at: new Date(Date.now() - 864e5).toISOString() },
            ],
        });
    }
    if (p === '/wallet/charge' && method === 'GET') return json({ min_toman: 10_000, max_toman: 50_000_000, provider: 'fake', payments });
    if (p === '/wallet/charge') {
        const pay: Payment = { id: id(), provider: 'fake', amount_toman: String(body.amount), status: 'pending', ref_id: null, card_pan: null, created_at: now(), paid_at: null };
        payments.unshift(pay);
        setTimeout(() => {
            pay.status = 'paid';
            pay.ref_id = 'a1b2c3d4e5';
            balances[0].available = String(Number(balances[0].available) + Number(body.amount));
        }, 4000);
        return json({ payment_id: pay.id, url: '/' });
    }
    if (p === '/wallet/withdrawals' && method === 'GET') return json({ networks: { USDT: ['TRC20', 'ERC20', 'BEP20'], BTC: ['BTC'], TRX: ['TRC20'] }, withdrawals });
    if (p === '/wallet/withdrawals') {
        if (body.code !== '123456') return json({ error: 'wrong code', code: 'otp_wrong', attempts_left: 4 }, 400);
        const w: Withdrawal = { id: id(), asset: String(body.asset), amount: String(body.amount), network: (body.network as string) ?? null, destination: String(body.destination), status: 'pending', note: null, created_at: now() };
        withdrawals.unshift(w);
        return json({ withdrawal: w });
    }
    const cancelW = /^\/wallet\/withdrawals\/(.+)\/cancel$/.exec(p);
    if (cancelW) {
        const w = withdrawals.find((x) => x.id === cancelW[1]);
        if (w) w.status = 'cancelled';
        return json({ withdrawal: w });
    }
    if (p === '/market/symbols') return json({ symbols: SYMBOLS });
    const market = /^\/market\/([A-Z0-9]+_IRT)$/.exec(p);
    if (market) {
        const s = market[1];
        const mid = MIDS[s];
        return json({
            symbol: s, depth: book(s), trades: tradesOf(s),
            summary: { open: mid * 0.986, high: mid * 1.021, low: mid * 0.979, close: mid, change_pct: 1.42, volume: 18_420.5 * (100_000 / mid) ** 0.8, quote_volume: 1.9e9 },
        });
    }
    if (p === '/orders' && method === 'GET') return json({ orders: orders.filter((o) => o.symbol === (q.get('symbol') ?? o.symbol)) });
    if (p === '/orders') {
        const s = String(body.symbol);
        const o: Order = {
            id: id(), symbol: s, side: body.side as Order['side'], price: String(body.price ?? MIDS[s]), quantity: String(body.quantity),
            filled_quantity: body.type === 'market' ? String(body.quantity) : '0', status: body.type === 'market' ? 'filled' : 'open', created_at: now(),
        };
        if (o.status === 'open') orders.unshift(o);
        return json({ order: o, trades: [], type: body.type }, 201);
    }
    if (p === '/auction/orders' && method === 'GET') {
        const scope = q.get('scope') ?? 'open';
        const list = scope === 'history' ? auctionClosed : scope === 'all' ? [...auctionMine, ...auctionClosed] : auctionMine;
        return json({ orders: list.filter((o) => o.symbol === (q.get('symbol') ?? o.symbol)) });
    }
    if (p === '/auction/orders/cancel-all') {
        return json({ orders: auctionMine.filter((o) => !body.symbol || o.symbol === body.symbol).map(closeMine) });
    }
    if (p === '/auction/orders') {
        const o: Order = {
            id: id(), symbol: String(body.symbol), side: body.side as Order['side'], price: String(body.price), quantity: String(body.quantity),
            filled_quantity: '0', status: 'open', description: String(body.description ?? ''), created_at: now(),
        };
        auctionMine.unshift(o);
        pushAuction(o.symbol);
        return json({ order: o, trades: [] }, 201);
    }
    const cancelA = /^\/auction\/orders\/(.+)\/cancel$/.exec(p);
    if (cancelA) {
        const o = auctionMine.find((x) => x.id === cancelA[1]);
        return json({ order: o ? closeMine(o) : null });
    }
    const take = /^\/auction\/offers\/(.+)\/take$/.exec(p);
    if (take) {
        const list = Object.values(auctionOthers).find((l) => l.some((o) => o.id === take[1]));
        const maker = list?.find((o) => o.id === take[1]);
        if (!list || !maker) return json({ error: 'gone', code: 'offer_gone' }, 409);
        const qty = Number(body.quantity);
        const left = Number(maker.quantity) - Number(maker.filled_quantity);
        if (qty > left + 1e-12) return json({ error: 'short', code: 'offer_short', remaining: String(left) }, 409);
        maker.filled_quantity = String(+(Number(maker.filled_quantity) + qty).toFixed(8));
        maker.status = qty >= left - 1e-12 ? 'filled' : 'partial';
        if (maker.status === 'filled') list.splice(list.indexOf(maker), 1);
        const tr: MarketTrade = { id: id(), symbol: maker.symbol, price: maker.price, quantity: String(qty), taker_side: maker.side === 'buy' ? 'sell' : 'buy', executed_at: now() };
        liveSocket?.push({ type: 'auction_trades', symbol: maker.symbol, trades: [tr] });
        pushAuction(maker.symbol);
        const order: Order = { id: id(), symbol: maker.symbol, side: tr.taker_side, price: maker.price, quantity: String(qty), filled_quantity: String(qty), status: 'filled', created_at: now() };
        return json({ order, trades: [tr] }, 201);
    }
    const auction = /^\/auction\/([A-Z0-9]+_IRT)$/.exec(p);
    if (auction) return json({ symbol: auction[1], book: auctionBook(auction[1]), offers: auctionBoard(auction[1]), trades: [] });
    const cancelO = /^\/orders\/(.+)\/cancel$/.exec(p);
    if (cancelO) {
        const i = orders.findIndex((o) => o.id === cancelO[1]);
        const [o] = i >= 0 ? orders.splice(i, 1) : [];
        return json({ order: o ? { ...o, status: 'cancelled' } : null });
    }
    return json({ error: 'not in the preview', code: 'not_found' }, 404);
}

class FakeSocket implements Transport {
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    private symbol: string | null = null;
    private timer: ReturnType<typeof setInterval>;

    constructor() {
        setTimeout(() => this.onopen?.(), 50);
        this.timer = setInterval(() => this.tick(), 1400);
        liveSocket = this;
    }

    private emit(msg: unknown) {
        this.onmessage?.({ data: JSON.stringify(msg) });
    }

    push(msg: unknown) {
        this.emit(msg);
    }

    private tick() {
        const s = this.symbol;
        if (!s) return;
        MIDS[s] *= 1 + (Math.random() - 0.5) / 900;
        this.emit({ type: 'depth', depth: book(s) });
        if (Math.random() > 0.45) {
            const mid = MIDS[s];
            const tr: MarketTrade = {
                id: id(), symbol: s, taker_side: Math.random() > 0.5 ? 'buy' : 'sell',
                price: String(+mid.toFixed(mid > 1000 ? 0 : 4)),
                quantity: (Math.random() * 30 * (100_000 / mid) ** 0.6).toFixed(mid > 1e6 ? 6 : 2), executed_at: now(),
            };
            tradesOf(s).unshift(tr);
            this.emit({ type: 'trades', symbol: s, trades: [tr] });
        }
    }

    send(data: string) {
        const msg = JSON.parse(data);
        if (msg.type === 'subscribe') {
            this.symbol = msg.symbol;
            this.emit({ type: 'depth', depth: book(msg.symbol) });
        }
    }

    close() {
        clearInterval(this.timer);
        if (liveSocket === this) liveSocket = null;
    }
}

export function installPreview(): void {
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url;
        if (!url.startsWith('/api/v1/')) return realFetch(input, init);
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        return route(init?.method ?? 'GET', url.slice('/api/v1'.length), body);
    };
    useTransport(() => new FakeSocket());
}
