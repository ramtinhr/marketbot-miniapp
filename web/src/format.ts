// Numbers, amounts and assets as the app shows them: Persian digits, each
// asset at one precision (so a column of figures lines up), and parsing that
// accepts whatever a Persian keyboard types.

export const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};

export const baseOf = (symbol: string): string => symbol.split('_')[0] ?? symbol;

const ASSET_DIGITS: Record<string, number> = {
    IRT: 0, USDT: 2, USDC: 2,
    BTC: 8, ETH: 6, BNB: 4, SOL: 4,
    XRP: 2, TRX: 2, DOGE: 2, ADA: 2, SHIB: 0,
};
export const assetDigits = (asset: string): number => ASSET_DIGITS[asset] ?? 4;

const ASSET_NAMES: Record<string, string> = {
    IRT: 'تومان', USDT: 'تتر', USDC: 'یو‌اس‌دی‌کوین', BTC: 'بیت‌کوین', ETH: 'اتریوم', BNB: 'بی‌ان‌بی',
    SOL: 'سولانا', XRP: 'ریپل', TRX: 'ترون', DOGE: 'دوج‌کوین', ADA: 'کاردانو', SHIB: 'شیبا',
};
export const assetName = (asset: string): string => ASSET_NAMES[asset] ?? asset;

/** A colour per coin for its round badge. */
const ASSET_COLORS: Record<string, string> = {
    IRT: '#2a82da', USDT: '#26a17b', USDC: '#2775ca', BTC: '#f7931a', ETH: '#627eea', BNB: '#f0b90b',
    SOL: '#9945ff', XRP: '#23292f', TRX: '#eb0029', DOGE: '#c2a633', ADA: '#0033ad', SHIB: '#e42d04',
};
export const assetColor = (asset: string): string => ASSET_COLORS[asset] ?? '#8a9099';

const formats = new Map<string, Intl.NumberFormat>();
function nf(min: number, max: number): Intl.NumberFormat {
    const key = `${min}:${max}`;
    let f = formats.get(key);
    if (!f) {
        f = new Intl.NumberFormat('fa-IR', { minimumFractionDigits: min, maximumFractionDigits: max });
        formats.set(key, f);
    }
    return f;
}

/** A number to exactly `digits` decimals (or up to them, with `trim`). */
export function fmtNumber(n: number, digits: number, { trim = false } = {}): string {
    return nf(trim ? 0 : digits, digits).format(n);
}

/**
 * An amount of `asset` at its precision. `floor` rounds down - for balances,
 * which must never read as more than there is to spend.
 */
export function fmtAsset(v: unknown, asset: string, { floor = false, trim = false } = {}): string {
    const digits = assetDigits(asset);
    let n = num(v);
    if (floor) {
        const f = 10 ** digits;
        n = Math.floor(n * f + 1e-9) / f;
    }
    return fmtNumber(n, digits, { trim });
}

export const fmtToman = (v: unknown): string => fmtAsset(v, 'IRT');

/** Decimals for a pair's prices: whole Toman above 1,000, more below. */
export function priceDigits(ref: number): number {
    if (ref >= 1000) return 0;
    if (ref >= 10) return 2;
    if (ref >= 0.1) return 4;
    return 8;
}

export const fmtPrice = (v: unknown, digits: number): string => fmtNumber(num(v), digits);

export function fmtPercent(n: number, digits = 2, { sign = false } = {}): string {
    const s = nf(digits, digits).format(Math.abs(n));
    const prefix = n > 0 && sign ? '+' : n < 0 ? '−' : '';
    return `\u2066${prefix}${s}٪\u2069`;
}

/** Persian and Arabic-Indic digits, grouping marks and the Persian decimal mark, as plain ASCII. */
export function asciiNumber(raw: string): string {
    return raw
        .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
        .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
        .replace(/[٫/]/g, '.')
        .replace(/[,٬\s]/g, '');
}

/** A typed amount as the decimal string the server takes, or null. */
export function parseAmount(raw: string, maxDecimals = 8): string | null {
    const s = asciiNumber(raw);
    const re = maxDecimals ? new RegExp(`^\\d{1,15}(\\.\\d{1,${maxDecimals}})?$`) : /^\d{1,15}$/;
    return re.test(s) && Number(s) > 0 ? s.replace(/^0+(?=\d)/, '') : null;
}

/** A number rounded down to `digits` places, without an exponent or trailing zeros. */
export function toAmount(n: number, digits = 8): string {
    if (!(n > 0) || !Number.isFinite(n)) return '';
    const f = 10 ** digits;
    const floored = Math.floor(n * f + 1e-6) / f;
    if (!(floored > 0)) return '';
    return digits ? floored.toFixed(digits).replace(/\.?0+$/, '') : floored.toFixed(0);
}

/** What an amount input shows while typing: ASCII digits grouped, the decimals as typed. */
export function groupTyped(raw: string, maxDecimals: number): string {
    const s = asciiNumber(raw).replace(/[^\d.]/g, '');
    const [int = '', ...rest] = s.split('.');
    const dec = rest.join('').slice(0, maxDecimals);
    const grouped = int.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return maxDecimals && s.includes('.') ? `${grouped || '0'}.${dec}` : grouped;
}

const timeFormat = new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateTimeFormat = new Intl.DateTimeFormat('fa-IR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export const fmtTime = (v: string): string => timeFormat.format(new Date(v));
export const fmtDateTime = (v: string): string => dateTimeFormat.format(new Date(v));
