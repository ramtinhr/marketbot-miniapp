// The auction in the bot's chat, the way the Mini App's board shows it and the
// way Telegram's USDT groups trade: a message lists the open offers - "USDT at
// X Toman, Y of it, I buy" - each with a button to answer it ("I sell to
// them" / "I buy from them"); answering asks how much, then to confirm. A new
// offer is put together step by step in one message - buy or sell, price,
// volume, description - each step with buttons for the likely answers and room
// to type another, then reviewed and posted. Typing the whole offer as it would
// be posted in a group ("من تتر را به قیمت ۱۰۲۵۰۰ تومان با حجم ۱۰۰ میخرم") skips
// straight to the review. Whoever posted an offer hears in the chat when it is
// taken.
//
// Everything is answered with Bot API actions ({method, ...params}), like the
// rest of the bot. What a chat is in the middle of (an amount to type for an
// offer, an offer being put together) is kept in memory for a few minutes:
// after a restart the user just taps again.

import { randomBytes } from 'node:crypto';

import { DESCRIPTION_MAX, cleanDescription } from './auction.js';
import { asciiAmount, isSymbol } from './trading.js';

const DEFAULT_SYMBOL = 'USDT_IRT';
const PAGE = 6;
const STATE_TTL_MS = 10 * 60_000;
/** The steps of posting an offer, before its review. */
const STEPS = ['side', 'price', 'qty', 'note'];

const NAMES = {
  USDT: 'تتر', USDC: 'یو‌اس‌دی‌کوین', BTC: 'بیت‌کوین', ETH: 'اتریوم', BNB: 'بی‌ان‌بی', SOL: 'سولانا',
  XRP: 'ریپل', TRX: 'ترون', DOGE: 'دوج‌کوین', ADA: 'کاردانو', SHIB: 'شیبا',
};
const DIGITS = { USDT: 2, USDC: 2, BTC: 8, ETH: 6, BNB: 4, SOL: 4, XRP: 2, TRX: 2, DOGE: 2, ADA: 2, SHIB: 0 };
// What people call each coin when they post, after digits and ZWNJ are normalised.
const ALIASES = [
  ['USDT', /تتر|usdt|تدر/], ['USDC', /usdc/], ['BTC', /بیت ?کوین|btc/], ['ETH', /اتریوم|اتر\b|eth\b/],
  ['TRX', /ترون|trx/], ['SOL', /سولانا|\bsol\b/], ['XRP', /ریپل|xrp/], ['DOGE', /دوج|doge/],
  ['BNB', /بی ?ان ?بی|bnb/], ['ADA', /کاردانو|\bada\b/], ['SHIB', /شیبا|shib/],
];

const ERRORS = {
  insufficient_balance: 'موجودی کافی نیست.',
  offer_gone: 'این آگهی دیگر باز نیست؛ انجام یا حذف شده است.',
  offer_short: 'از این آگهی کمتر از این مقدار باقی مانده است.',
  own_offer: 'آگهی خودتان را نمی‌توانید بردارید.',
  order_closed: 'این آگهی قبلاً انجام یا حذف شده است.',
  order_not_found: 'این آگهی پیدا نشد.',
  invalid_quantity: 'مقدار درست نیست (حداکثر ۸ رقم اعشار).',
  invalid_price: 'قیمت درست نیست.',
  invalid_description: `توضیحات حداکثر ${DESCRIPTION_MAX.toLocaleString('fa-IR')} حرف می‌تواند باشد.`,
  wallet_inactive: 'کیف پول این دارایی غیرفعال است؛ با پشتیبانی تماس بگیرید.',
  user_inactive: 'حساب معاملاتی شما فعال نیست؛ با پشتیبانی تماس بگیرید.',
  unknown_user: 'حساب معاملاتی شما پیدا نشد؛ با پشتیبانی تماس بگیرید.',
  exchange_unavailable: 'سرویس موقتاً در دسترس نیست؛ کمی بعد دوباره امتحان کنید.',
};
const errorText = (err) => ERRORS[err?.code] ?? 'مشکلی پیش آمد؛ چند لحظه بعد دوباره تلاش کنید.';

const nameOf = (base) => NAMES[base] ?? base;
const baseOf = (symbol) => symbol.split('_')[0];
const qtyDigits = (base) => Math.min(8, DIGITS[base] ?? 4);
const priceDigits = (p) => (p >= 1000 ? 0 : p >= 10 ? 2 : p >= 0.1 ? 4 : 8);
const fa = (n, digits = 0) => Number(n).toLocaleString('fa-IR', { maximumFractionDigits: digits });
const faInt = (n) => Number(n).toLocaleString('fa-IR');
const clock = (iso) => new Date(iso).toLocaleTimeString('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' });

/** `n` rounded down to `digits` places, as an ASCII amount; '' if nothing is left. */
export function floorAmount(n, digits) {
  if (!(n > 0) || !Number.isFinite(n)) return '';
  const f = 10 ** digits;
  const v = Math.floor(n * f + 1e-6) / f;
  if (!(v > 0)) return '';
  const s = v.toFixed(digits);
  return digits ? s.replace(/\.?0+$/, '') : s;
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const charCount = (s) => [...s].length;
/** An offer's description as a line under its sentence; none if it has none. */
const note = (description) => (description ? [`💬 <i>${escapeHtml(description)}</i>`] : []);

/** The offer as a group would word it: "USDT at X Toman, Y of it, I buy". */
function sentence({ side, base, price, quantity }) {
  const pd = priceDigits(Number(price));
  return `${nameOf(base)} را به قیمت <b>${fa(price, pd)}</b> تومان با حجم <b>${fa(quantity, qtyDigits(base))}</b> <b>${side === 'buy' ? 'می‌خرم' : 'می‌فروشم'}</b>`;
}

/** Text with ASCII digits and decimal points, no grouping, no ZWNJ, Persian letters unified, lower case. */
function normalize(text) {
  return String(text ?? '')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u200c\u200f\u200e]/g, '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/(\d)[,٬](?=\d{3}(?!\d))/g, '$1')
    .replace(/(\d)[٫/](?=\d)/g, '$1.')
    .toLowerCase();
}

/**
 * One amount typed on its own: "102500", "۱۰۲٬۵۰۰ تومان", "102 هزار", "2.5 میلیون".
 * Returns { value, toman } - `toman` when it says Toman - or null.
 */
export function readAmount(text) {
  const s = normalize(text);
  const numbers = s.match(/\d+(?:\.\d+)?/g) ?? [];
  if (numbers.length !== 1) return null;
  const m = /(\d+(?:\.\d+)?)\s*(هزار|میلیون|میلیارد|k(?![a-z])|m(?![a-z]))?/.exec(s);
  const mult = { هزار: 1e3, k: 1e3, میلیون: 1e6, m: 1e6, میلیارد: 1e9 }[m[2]] ?? 1;
  const value = asciiAmount(mult === 1 ? m[1] : String(+(Number(m[1]) * mult).toFixed(8)));
  return value ? { value, toman: /تومان|تومن/.test(s) } : null;
}

/**
 * Reads an offer typed the way Telegram's trading groups post them:
 * "من تتر را به قیمت ۱۰۲٬۵۰۰ تومن با حجم ۱۰۰ میخرم", "۵۰ تتر فی ۱۰۳۲۰۰ میفروشم"...
 * Returns null for text that is not an attempt at one (no buy or sell word),
 * { ok: true, side, base, price, quantity } when it reads fully, and
 * { ok: false, side, base } when something is missing. `prices` (Toman per
 * coin) settles which of two bare numbers is the price.
 */
export function parseOffer(text, { prices = {} } = {}) {
  const s = normalize(text);

  const buy = /می ?خرم|می ?خریم|خریدارم|خریداریم/.test(s);
  const sell = /می ?فروشم|می ?فروشیم|فروشنده ?ام|فروشنده ?ایم/.test(s);
  let side = buy && !sell ? 'buy' : sell && !buy ? 'sell' : null;
  if (!side && !buy && !sell) {
    const b = /(^|\s)خرید/.test(s);
    const se = /(^|\s)فروش/.test(s);
    side = b && !se ? 'buy' : se && !b ? 'sell' : null;
    if (!b && !se) return null;
  }
  const base = ALIASES.find(([, re]) => re.test(s))?.[0] ?? 'USDT';
  const coin = ALIASES.find(([b]) => b === base)[1];

  const numbers = [];
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(هزار|میلیون|k(?![a-z])|m(?![a-z]))?/g)) {
    const mult = m[2] === 'هزار' || m[2] === 'k' ? 1e3 : m[2] === 'میلیون' || m[2] === 'm' ? 1e6 : 1;
    const before = s.slice(Math.max(0, m.index - 14), m.index);
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 12);
    numbers.push({
      value: mult === 1 ? m[1] : String(+(Number(m[1]) * mult).toFixed(8)),
      price: /(قیمت|فی|نرخ|@)\s*:?\s*$/.test(before) || /^\s*(تومان|تومن)/.test(after),
      volume: /(حجم|مقدار|تعداد)\s*:?\s*$/.test(before) || /^\s*(تا(\s|$)|عدد|واحد)/.test(after) || coin.test(after.trimStart().slice(0, 8)),
    });
  }
  let price = numbers.find((n) => n.price && !n.volume);
  let volume = numbers.find((n) => n.volume && !n.price && n !== price);
  const rest = numbers.filter((n) => n !== price && n !== volume && !n.price && !n.volume);
  if (!price && volume && rest.length === 1) price = rest[0];
  else if (price && !volume && rest.length === 1) volume = rest[0];
  else if (!price && !volume && rest.length === 2) {
    const [a, b] = rest.map((n) => Number(n.value));
    const market = prices[base];
    const aIsPrice = market ? Math.abs(Math.log(a / market)) <= Math.abs(Math.log(b / market)) : a >= b;
    [price, volume] = aIsPrice ? rest : [rest[1], rest[0]];
  }

  const p = asciiAmount(price?.value);
  const q = asciiAmount(volume?.value);
  if (!side || !p || !q) return { ok: false, side, base };
  return { ok: true, side, base, price: p, quantity: q };
}

export class AuctionChat {
  /**
   * @param {{ pg: import('pg').Pool, auction: import('./auction.js').Auction, wallets?: import('./wallets.js').Wallets,
   *           trading?: import('./trading.js').Trading, appUrl: (screen?: string) => string }} deps
   */
  constructor({ pg, auction, wallets, trading, appUrl }) {
    this.pg = pg;
    this.auction = auction;
    this.wallets = wallets;
    this.trading = trading;
    this.appUrl = appUrl;
    this.states = new Map();
    this.drafts = new Map();
  }

  // ---- What a chat is in the middle of --------------------------------------

  #setState(chatId, state) {
    this.states.set(chatId, { ...state, expires: Date.now() + STATE_TTL_MS });
  }

  #state(chatId) {
    const st = this.states.get(chatId);
    if (st && st.expires > Date.now()) return st;
    this.states.delete(chatId);
    return null;
  }

  #draft(id) {
    const d = this.drafts.get(id);
    if (d && d.expires > Date.now()) return d;
    this.drafts.delete(id);
    return null;
  }

  #prune() {
    const now = Date.now();
    for (const [k, v] of this.states) if (v.expires <= now) this.states.delete(k);
    for (const [k, v] of this.drafts) if (v.expires <= now) this.drafts.delete(k);
  }

  // ---- Lookups --------------------------------------------------------------

  /** The exchange account behind a Telegram user: { id } or { error: 'blocked' | 'no_account' }. */
  async account(telegramId) {
    const { rows } = await this.pg.query('SELECT exchange_user_id, blocked_at FROM miniapp_users WHERE telegram_id = $1', [telegramId]);
    const u = rows[0];
    if (u?.blocked_at) return { error: 'blocked' };
    if (!u?.exchange_user_id) return { error: 'no_account' };
    return { id: u.exchange_user_id };
  }

  async #available(userId, asset) {
    if (!this.wallets) return 0;
    const balances = await this.wallets.balances(userId);
    return Number(balances.find((b) => b.asset === asset)?.available ?? 0);
  }

  #symbols() {
    const list = this.trading?.symbols?.() ?? [];
    return list.length ? list : [DEFAULT_SYMBOL];
  }

  #accountCard(error) {
    if (error === 'blocked') return { text: 'حساب شما مسدود شده است. برای پیگیری با پشتیبانی تماس بگیرید.', reply_markup: { inline_keyboard: [] } };
    return {
      text: 'برای معامله در مزایده اول حساب‌تان را فعال کنید: مارکت‌بات را باز کنید و با شمارهٔ موبایل ثبت‌نام کنید.',
      reply_markup: { inline_keyboard: [[{ text: 'ثبت‌نام در مارکت‌بات', web_app: { url: this.appUrl() } }]] },
    };
  }

  #back(symbol) {
    return [{ text: `↩︎ آگهی‌های ${nameOf(baseOf(symbol))}`, callback_data: `a:b:${symbol}:a:0` }];
  }

  // ---- Cards ----------------------------------------------------------------

  /** The board: a page of open offers, newest at the bottom, each with its button. */
  async board(telegramId, symbol = DEFAULT_SYMBOL, filter = 'a', page = 0) {
    const base = baseOf(symbol);
    const [offers, me] = await Promise.all([this.auction.offers(symbol), this.account(telegramId)]);
    const mine = me.id ? new Set((await this.auction.orders(me.id, { symbol, scope: 'open' })).map((o) => o.id)) : new Set();
    const list = offers.filter((o) => filter === 'a' || o.side === (filter === 'b' ? 'buy' : 'sell'));
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    const at = Math.min(Math.max(0, page), pages - 1);
    const shown = list.slice(at * PAGE, at * PAGE + PAGE).reverse();
    const qd = qtyDigits(base);

    const lines = [`<b>مزایدهٔ ${nameOf(base)}</b>`, '<i>آگهی‌های خرید و فروش کاربران؛ جدیدترین پایین.</i>', ''];
    if (!shown.length) lines.push(filter === 'a' ? 'هنوز آگهی‌ای نیست؛ اولین آگهی را شما بگذارید.' : 'آگهی‌ای با این فیلتر نیست.', '');
    const rows = [];
    shown.forEach((o, i) => {
      const n = faInt(i + 1);
      const who = mine.has(o.id) ? 'آگهی شما' : o.side === 'buy' ? 'خریدار' : 'فروشنده';
      const partial = Number(o.remaining) < Number(o.quantity) ? ` · <i>باقی‌مانده از ${fa(o.quantity, qd)}</i>` : '';
      lines.push(`${n}. ${o.side === 'buy' ? '🟢' : '🔴'} ${who} · ${clock(o.created_at)}${partial}`);
      lines.push(sentence({ side: o.side, base, price: o.price, quantity: o.remaining }), ...note(o.description), '');
      const figures = `${fa(o.remaining, qd)} × ${fa(o.price, priceDigits(Number(o.price)))}`;
      rows.push([mine.has(o.id)
        ? { text: `${n}. حذف آگهی من · ${figures}`, callback_data: `a:x:${o.id}` }
        : { text: `${n}. ${o.side === 'buy' ? 'به او می‌فروشم' : 'از او می‌خرم'} · ${figures}`, callback_data: `a:t:${o.id}` }]);
    });
    const now = new Date().toLocaleTimeString('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    lines.push(`<i>${pages > 1 ? `صفحهٔ ${faInt(at + 1)} از ${faInt(pages)} · ` : ''}به‌روز شده ${now}</i>`);

    const tab = (f, label) => ({ text: f === filter ? `• ${label}` : label, callback_data: `a:b:${symbol}:${f}:0` });
    rows.push([tab('a', 'همه'), tab('b', 'خریدارها'), tab('s', 'فروشنده‌ها')]);
    if (pages > 1) {
      const nav = [];
      if (at < pages - 1) nav.push({ text: '‹ قدیمی‌تر', callback_data: `a:b:${symbol}:${filter}:${at + 1}` });
      if (at > 0) nav.push({ text: 'جدیدتر ›', callback_data: `a:b:${symbol}:${filter}:${at - 1}` });
      rows.push(nav);
    }
    rows.push([
      { text: '➕ ثبت آگهی', style: 'primary', callback_data: `a:post:${symbol}` },
      { text: '↻ تازه‌سازی', callback_data: `a:b:${symbol}:${filter}:${at}` },
    ]);
    rows.push([
      { text: `بازار: ${nameOf(base)} ▾`, callback_data: 'a:pairs' },
      { text: 'در مینی‌اپ', web_app: { url: this.appUrl('auction') } },
    ]);
    return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
  }

  pairs() {
    const syms = this.#symbols();
    const rows = [];
    for (let i = 0; i < syms.length; i += 3) {
      rows.push(syms.slice(i, i + 3).map((s) => ({ text: nameOf(baseOf(s)), callback_data: `a:b:${s}:a:0` })));
    }
    return { text: '<b>بازار مزایده را انتخاب کنید</b>', reply_markup: { inline_keyboard: rows } };
  }

  /** Answering an offer: how much of it, as buttons or typed. */
  async takeCard(chatId, telegramId, offerId) {
    const me = await this.account(telegramId);
    if (me.error) return this.#accountCard(me.error);
    const offer = await this.auction.offer(offerId);
    if (!offer?.open) return { error: 'offer_gone' };
    if (offer.owner === me.id) return { error: 'own_offer' };

    const base = baseOf(offer.symbol);
    const qd = qtyDigits(base);
    const side = offer.side === 'buy' ? 'sell' : 'buy';
    const price = Number(offer.price);
    const remaining = Number(offer.remaining);
    const available = await this.#available(me.id, side === 'buy' ? 'IRT' : base);
    const affordable = side === 'buy' ? available / price : available;

    const options = [];
    for (const [pct, label] of [[25, '۲۵٪'], [50, '۵۰٪'], [75, '۷۵٪'], [100, 'همه']]) {
      const q = floorAmount((remaining * pct) / 100, qd);
      if (q && Number(q) <= affordable + 1e-12 && !options.some((o) => o.q === q)) options.push({ q, label });
    }
    const max = floorAmount(Math.min(affordable, remaining), qd);
    if (max && Number(max) < remaining && !options.some((o) => o.q === max)) options.push({ q: max, label: 'حداکثر' });

    this.#setState(chatId, { kind: 'amount', offerId });
    const have = side === 'buy' ? `${faInt(Math.floor(available))} تومان` : `${fa(available, qd)} ${nameOf(base)}`;
    const text = [
      `<b>${side === 'buy' ? `خرید ${nameOf(base)} از این فروشنده` : `فروش ${nameOf(base)} به این خریدار`}</b>`,
      '',
      `«${sentence({ side: offer.side, base, price: offer.price, quantity: offer.remaining })}»`,
      ...note(offer.description),
      '',
      `موجودی شما: ${have}`,
      options.length
        ? `<b>${side === 'buy' ? 'چقدر می‌خرید؟' : 'چقدر می‌فروشید؟'}</b> یکی را بزنید یا مقدار را بنویسید (مثلاً ${fa(options[0].q, qd)}).`
        : '<b>موجودی شما برای این آگهی کافی نیست.</b>',
    ].join('\n');
    const rows = [];
    for (let i = 0; i < options.length; i += 2) {
      rows.push(options.slice(i, i + 2).map((o) => ({ text: `${o.label} · ${fa(o.q, qd)}`, callback_data: `a:q:${offerId}:${o.q}` })));
    }
    if (!options.length && side === 'buy') rows.push([{ text: 'شارژ کیف پول', web_app: { url: this.appUrl('charge') } }]);
    rows.push(this.#back(offer.symbol));
    return { text, reply_markup: { inline_keyboard: rows } };
  }

  /** The last step before taking: the figures and one button to confirm. */
  async confirmTakeCard(telegramId, offerId, quantity) {
    const me = await this.account(telegramId);
    if (me.error) return this.#accountCard(me.error);
    const offer = await this.auction.offer(offerId);
    if (!offer?.open) return { error: 'offer_gone' };
    const base = baseOf(offer.symbol);
    const qd = qtyDigits(base);
    const back = this.#back(offer.symbol);
    const q = asciiAmount(quantity);
    if (!q || q.split('.')[1]?.length > qd) return { text: `مقدار را درست وارد کنید (حداکثر ${faInt(qd)} رقم اعشار).`, reply_markup: { inline_keyboard: [back] } };
    if (Number(q) > Number(offer.remaining) + 1e-12) {
      return {
        text: `از این آگهی فقط ${fa(offer.remaining, qd)} ${nameOf(base)} مانده است؛ مقدار کمتری بنویسید.`,
        reply_markup: { inline_keyboard: [[{ text: 'انتخاب دوبارهٔ مقدار', callback_data: `a:te:${offerId}` }], back] },
      };
    }
    const side = offer.side === 'buy' ? 'sell' : 'buy';
    const total = Number(q) * Number(offer.price);
    const text = [
      `<b>${side === 'buy' ? 'تأیید خرید' : 'تأیید فروش'}</b>`,
      '',
      `${fa(q, qd)} ${nameOf(base)} به قیمت ${fa(offer.price, priceDigits(Number(offer.price)))} تومان`,
      `${side === 'buy' ? 'مبلغ کل' : 'دریافتی'}: <b>${faInt(Math.round(total))} تومان</b>`,
      '',
      '<i>معامله فوراً با قیمت همین آگهی انجام می‌شود و تومان و ارز در کیف پول‌ها جابه‌جا می‌شود.</i>',
    ].join('\n');
    return {
      text,
      reply_markup: {
        inline_keyboard: [
          [{ text: side === 'buy' ? '✓ تأیید خرید' : '✓ تأیید فروش', style: side === 'buy' ? 'success' : 'danger', callback_data: `a:c:${offerId}:${q}` }],
          [{ text: 'انصراف', callback_data: `a:te:${offerId}` }],
        ],
      },
    };
  }

  async take(chatId, telegramId, offerId, quantity) {
    const me = await this.account(telegramId);
    if (me.error) return this.#accountCard(me.error);
    const offer = await this.auction.offer(offerId);
    const symbol = offer?.symbol ?? DEFAULT_SYMBOL;
    const back = this.#back(symbol);
    try {
      const { order } = await this.auction.take(me.id, offerId, { quantity }, { actor: `bot:${telegramId}` });
      this.states.delete(chatId);
      const base = baseOf(order.symbol);
      const total = Number(order.filled_quote || Number(order.filled_quantity) * Number(order.price));
      const bought = order.side === 'buy';
      return {
        text: [
          `<b>✓ ${bought ? 'خرید' : 'فروش'} انجام شد</b>`,
          '',
          `${fa(order.filled_quantity, qtyDigits(base))} ${nameOf(base)} به قیمت ${fa(order.price, priceDigits(Number(order.price)))} تومان ${bought ? 'خریدید' : 'فروختید'}.`,
          `${bought ? 'پرداختی' : 'دریافتی'}: ${faInt(Math.round(total))} تومان`,
        ].join('\n'),
        reply_markup: { inline_keyboard: [[...back, { text: 'موجودی من', callback_data: 'balance' }]] },
      };
    } catch (err) {
      return { text: errorText(err), reply_markup: { inline_keyboard: [back] } };
    }
  }

  // ---- Posting an offer, step by step ---------------------------------------
  //
  // A draft goes side -> price -> volume -> description -> review, one message
  // edited in place; each step has buttons for the likely answers and takes a
  // typed one. From the review any step can be changed, and comes back to it.

  /** A new draft; returns its id. */
  #newDraft(symbol, fields = {}) {
    const id = randomBytes(6).toString('base64url');
    this.drafts.set(id, {
      symbol, side: null, price: null, quantity: null, description: '', step: 'side', editing: false, msg: null,
      ...fields, expires: Date.now() + STATE_TTL_MS,
    });
    return id;
  }

  /** The step after `from`: the next one, or back to the review when a step was opened from it. */
  #after(d, from) {
    if (d.editing) {
      d.editing = false;
      return 'review';
    }
    return STEPS[STEPS.indexOf(from) + 1] ?? 'review';
  }

  #expired() {
    return { text: 'این آگهی منقضی شده است؛ دوباره «ثبت آگهی» را بزنید.', reply_markup: { inline_keyboard: [this.#back(DEFAULT_SYMBOL)] } };
  }

  /** The draft's current step as a message; `error` says why a typed answer was not taken. */
  async step(telegramId, draftId, { error = '', lead = '' } = {}) {
    const d = this.#draft(draftId);
    if (!d) return this.#expired();
    const me = await this.account(telegramId);
    if (me.error) return this.#accountCard(me.error);
    d.expires = Date.now() + STATE_TTL_MS;
    const card = d.step === 'review' ? await this.#review(me, draftId, d)
      : d.step === 'price' ? await this.#priceStep(me, draftId, d)
        : d.step === 'qty' ? await this.#qtyStep(me, draftId, d)
          : d.step === 'note' ? this.#noteStep(draftId, d)
            : this.#sideStep(draftId, d);
    const pre = [lead && `<b>${lead}</b>`, error && `⚠️ ${error}`].filter(Boolean);
    return pre.length ? { ...card, text: `${pre.join('\n')}\n\n${card.text}` } : card;
  }

  /** A step's frame: title, progress, the offer as filled in so far, then the step's own lines and buttons. */
  #frame(draftId, d, body, rows) {
    const base = baseOf(d.symbol);
    const n = STEPS.indexOf(d.step) + 1;
    const kind = d.side === 'buy' ? 'خرید' : d.side === 'sell' ? 'فروش' : 'جدید';
    const blank = '<code>…</code>';
    const pd = priceDigits(Number(d.price));
    const draft = `من ${nameOf(base)} را به قیمت ${d.price ? `<b>${fa(d.price, pd)}</b>` : blank} تومان`
      + ` با حجم ${d.quantity ? `<b>${fa(d.quantity, qtyDigits(base))}</b>` : blank}`
      + ` ${d.side ? `<b>${d.side === 'buy' ? 'می‌خرم' : 'می‌فروشم'}</b>` : blank}`;
    const prev = d.editing ? 'review' : STEPS[n - 2];
    const nav = [];
    if (prev) nav.push({ text: '‹ قبلی', callback_data: `a:w:${draftId}:go:${prev}` });
    nav.push({ text: 'انصراف', callback_data: `a:w:${draftId}:x` });
    return {
      text: [
        `<b>➕ آگهی ${kind} ${nameOf(base)}</b>  <i>مرحلهٔ ${faInt(n)} از ${faInt(STEPS.length)}</i>`,
        `${'●'.repeat(n)}${'○'.repeat(STEPS.length - n)}`,
        '',
        `«${draft}»`,
        ...note(d.description),
        '',
        ...body,
      ].join('\n'),
      reply_markup: { inline_keyboard: [...rows, nav] },
    };
  }

  #sideStep(draftId, d) {
    const name = nameOf(baseOf(d.symbol));
    return this.#frame(draftId, d, [
      `<b>می‌خواهید ${name} بخرید یا بفروشید؟</b>`,
      '',
      `<i>نکته: کل آگهی را یک‌جا هم می‌توانید بنویسید، مثلاً «من ${name} را به قیمت ۱۰۲۵۰۰ تومان با حجم ۱۰۰ میخرم».</i>`,
    ], [
      [
        { text: '🟢 می‌خرم', callback_data: `a:w:${draftId}:side:buy` },
        { text: '🔴 می‌فروشم', callback_data: `a:w:${draftId}:side:sell` },
      ],
      [{ text: `بازار: ${name} ▾`, callback_data: `a:w:${draftId}:mk` }],
    ]);
  }

  #marketStep(draftId) {
    const syms = this.#symbols();
    const rows = [];
    for (let i = 0; i < syms.length; i += 3) {
      rows.push(syms.slice(i, i + 3).map((s) => ({ text: nameOf(baseOf(s)), callback_data: `a:w:${draftId}:s:${s}` })));
    }
    rows.push([{ text: '‹ قبلی', callback_data: `a:w:${draftId}:go:side` }]);
    return { text: '<b>آگهی برای کدام بازار؟</b>', reply_markup: { inline_keyboard: rows } };
  }

  /** The best price other users offer on each side, and the exchange's price. */
  async #references(me, symbol) {
    const [offers, mineList] = await Promise.all([this.auction.offers(symbol), this.auction.orders(me.id, { symbol, scope: 'open' })]);
    const mine = new Set(mineList.map((o) => o.id));
    const others = offers.filter((o) => !mine.has(o.id));
    const prices = (side) => others.filter((o) => o.side === side).map((o) => Number(o.price));
    return {
      others,
      bestBuy: Math.max(0, ...prices('buy')),
      bestSell: Math.min(Infinity, ...prices('sell')),
      market: Number(this.trading?.tomanPrices?.()?.[baseOf(symbol)] ?? 0),
    };
  }

  async #priceStep(me, draftId, d) {
    const { bestBuy, bestSell, market } = await this.#references(me, d.symbol);
    const hasSell = Number.isFinite(bestSell);
    const ref = market || bestBuy || (hasSell ? bestSell : 0);
    const pd = priceDigits(ref);
    const tick = ref ? 10 ** (Math.floor(Math.log10(ref)) - 4) : 0;
    const at = (p) => asciiAmount(String(Number(p.toFixed(pd))));

    // What to post at: just better than the best of the same side, level with it,
    // the exchange's price, or right at the other side to trade at once.
    const ideas = d.side === 'buy'
      ? [[bestBuy && bestBuy + tick, 'کمی بالاتر از بهترین خریدار'], [bestBuy, 'هم‌قیمت بهترین خریدار'],
        [market, 'قیمت بازار'], [hasSell && bestSell, '⚡ خرید فوری از بهترین فروشنده']]
      : [[hasSell && bestSell - tick, 'کمی پایین‌تر از بهترین فروشنده'], [hasSell && bestSell, 'هم‌قیمت بهترین فروشنده'],
        [market, 'قیمت بازار'], [bestBuy, '⚡ فروش فوری به بهترین خریدار']];
    const rows = [];
    for (const [p, label] of ideas) {
      const v = p > 0 ? at(p) : null;
      if (!v || rows.some((r) => r[0].callback_data.endsWith(`:p:${v}`))) continue;
      rows.push([{ text: `${fa(v, pd)} · ${label}`, callback_data: `a:w:${draftId}:p:${v}` }]);
    }

    const refs = [
      bestBuy ? `بهترین خریدار: ${fa(bestBuy, pd)}` : '',
      hasSell ? `بهترین فروشنده: ${fa(bestSell, pd)}` : '',
      market ? `قیمت بازار: ${fa(market, pd)}` : '',
    ].filter(Boolean);
    return this.#frame(draftId, d, [
      `<b>به چه قیمتی ${d.side === 'buy' ? 'می‌خرید' : 'می‌فروشید'}؟</b> (تومان برای هر ${nameOf(baseOf(d.symbol))})`,
      ...(refs.length ? ['', ...refs.map((r) => `<i>${r}</i>`)] : []),
      '',
      rows.length ? 'یکی را بزنید یا قیمت را بنویسید (مثلاً <code>۱۰۲٬۵۰۰</code> یا <code>۱۰۲ هزار</code>).' : 'قیمت را به تومان بنویسید (مثلاً <code>۱۰۲٬۵۰۰</code>).',
    ], rows);
  }

  async #qtyStep(me, draftId, d) {
    const base = baseOf(d.symbol);
    const qd = qtyDigits(base);
    const price = Number(d.price);
    const available = await this.#available(me.id, d.side === 'buy' ? 'IRT' : base);
    const affordable = d.side === 'buy' ? available / price : available;
    const options = [];
    for (const [pct, label] of [[25, '۲۵٪'], [50, '۵۰٪'], [75, '۷۵٪'], [100, 'همه']]) {
      const q = floorAmount((affordable * pct) / 100, qd);
      if (q && !options.some((o) => o.q === q)) options.push({ q, label });
    }
    const rows = [];
    for (let i = 0; i < options.length; i += 2) {
      rows.push(options.slice(i, i + 2).map((o) => ({ text: `${o.label} · ${fa(o.q, qd)}`, callback_data: `a:w:${draftId}:q:${o.q}` })));
    }
    if (!options.length) rows.push([{ text: d.side === 'buy' ? 'شارژ کیف پول' : 'کیف پول', web_app: { url: this.appUrl(d.side === 'buy' ? 'charge' : 'wallet') } }]);

    const have = d.side === 'buy'
      ? `${faInt(Math.floor(available))} تومان${options.length ? ` · با این قیمت تا ${fa(floorAmount(affordable, qd), qd)} ${nameOf(base)}` : ''}`
      : `${fa(available, qd)} ${nameOf(base)}`;
    return this.#frame(draftId, d, [
      `<b>چه مقدار ${d.side === 'buy' ? 'می‌خرید' : 'می‌فروشید'}؟</b> (${nameOf(base)})`,
      '',
      `<i>موجودی شما: ${have}</i>`,
      '',
      options.length
        ? `یکی را بزنید یا مقدار را بنویسید (مثلاً <code>${fa(options[0].q, qd)}</code>)؛ مبلغ به تومان هم می‌شود (<code>۵ میلیون تومان</code>).`
        : '<b>موجودی شما برای این آگهی کافی نیست.</b> اول کیف پول را شارژ کنید.',
    ], rows);
  }

  #noteStep(draftId, d) {
    const rows = d.description
      ? [[{ text: '✓ همین بماند', callback_data: `a:w:${draftId}:n:keep` }, { text: 'حذف توضیحات', callback_data: `a:w:${draftId}:n:clear` }]]
      : [[{ text: 'بدون توضیحات ›', callback_data: `a:w:${draftId}:n:skip` }]];
    return this.#frame(draftId, d, [
      '<b>توضیحی دارید؟</b> (اختیاری)',
      '',
      `هر چه طرف معامله باید بداند را بنویسید، تا ${faInt(DESCRIPTION_MAX)} حرف؛ مثلاً <code>حداقل ۲۰ تا</code>.`,
    ], rows);
  }

  /** The last step: the offer in full, what it freezes, warnings, Post, and a button to change each part. */
  async #review(me, draftId, d) {
    const base = baseOf(d.symbol);
    const qd = qtyDigits(base);
    const total = Number(d.price) * Number(d.quantity);
    const available = await this.#available(me.id, d.side === 'buy' ? 'IRT' : base);
    const short = d.side === 'buy' ? total > available + 1e-9 : Number(d.quantity) > available + 1e-12;

    const { others, market } = await this.#references(me, d.symbol);
    const crossing = others.filter((o) => o.side !== d.side
      && (d.side === 'buy' ? Number(o.price) <= Number(d.price) : Number(o.price) >= Number(d.price)));
    const off = market ? (Number(d.price) / market - 1) * 100 : 0;

    const text = [
      '<b>مرور و ارسال آگهی</b>  <i>مرحلهٔ آخر</i>',
      '●'.repeat(STEPS.length),
      '',
      `«من ${sentence({ side: d.side, base, price: d.price, quantity: d.quantity })}»`,
      ...(d.description ? note(d.description) : ['<i>بدون توضیحات</i>']),
      '',
      `${d.side === 'buy' ? 'مبلغ کل' : 'دریافتی در صورت فروش'}: <b>${faInt(Math.round(total))} تومان</b>`,
      `موجودی شما: ${d.side === 'buy' ? `${faInt(Math.floor(available))} تومان` : `${fa(available, qd)} ${nameOf(base)}`}`,
      ...(short ? ['', '<b>موجودی شما برای این آگهی کافی نیست.</b> حجم را کم کنید یا کیف پول را شارژ کنید.'] : []),
      ...(Math.abs(off) >= 10
        ? ['', `⚠️ این قیمت ${faInt(Math.round(Math.abs(off)))}٪ ${off > 0 ? 'بالاتر' : 'پایین‌تر'} از قیمت بازار (${fa(market, priceDigits(market))} تومان) است.`]
        : []),
      ...(crossing.length ? ['', `<i>⚡ با این قیمت، بلافاصله با ${faInt(crossing.length)} آگهی ${d.side === 'buy' ? 'فروش' : 'خرید'} موجود معامله می‌شود.</i>`] : []),
      '',
      `<i>${d.side === 'buy' ? 'تومانِ' : `${nameOf(base)}ِ`} آگهی تا انجام یا حذف آن مسدود می‌ماند.</i>`,
    ].join('\n');
    const w = (action) => `a:w:${draftId}:${action}`;
    const rows = [];
    if (!short) {
      rows.push([{ text: d.side === 'buy' ? '✓ ارسال آگهی خرید' : '✓ ارسال آگهی فروش', style: d.side === 'buy' ? 'success' : 'danger', callback_data: w('ok') }]);
    } else if (d.side === 'buy') {
      rows.push([{ text: 'شارژ کیف پول', web_app: { url: this.appUrl('charge') } }]);
    }
    rows.push([
      { text: '✎ قیمت', callback_data: w('e:price') },
      { text: '✎ حجم', callback_data: w('e:qty') },
      { text: d.description ? '✎ توضیحات' : '+ توضیحات', callback_data: w('e:note') },
    ]);
    rows.push([
      { text: d.side === 'buy' ? '⇄ تبدیل به فروش' : '⇄ تبدیل به خرید', callback_data: w('flip') },
      { text: 'انصراف', callback_data: w('x') },
    ]);
    return { text, reply_markup: { inline_keyboard: rows } };
  }

  /** A typed answer to the draft's current step: the next step, or the same one saying what was wrong. */
  async #typed(telegramId, draftId, d, text) {
    const base = baseOf(d.symbol);
    const amount = readAmount(text);
    switch (d.step) {
      case 'side': {
        const parsed = parseOffer(text);
        if (!parsed?.side) return this.step(telegramId, draftId, { error: 'یکی از دو دکمهٔ «می‌خرم» یا «می‌فروشم» را بزنید.' });
        d.side = parsed.side;
        d.step = this.#after(d, 'side');
        return this.step(telegramId, draftId);
      }
      case 'price': {
        if (!amount) return this.step(telegramId, draftId, { error: 'قیمت را فقط به عدد بنویسید، مثلاً ۱۰۲۵۰۰.' });
        d.price = amount.value;
        d.step = this.#after(d, 'price');
        return this.step(telegramId, draftId);
      }
      case 'qty': {
        if (!amount) return this.step(telegramId, draftId, { error: `مقدار را به عدد بنویسید، مثلاً ۱۰ (${nameOf(base)}) یا ۵ میلیون تومان.` });
        const q = amount.toman ? floorAmount(Number(amount.value) / Number(d.price), qtyDigits(base)) : amount.value;
        if (!q) return this.step(telegramId, draftId, { error: 'با این مبلغ چیزی خریده نمی‌شود؛ مبلغ بیشتری بنویسید.' });
        if (q.split('.')[1]?.length > qtyDigits(base)) {
          return this.step(telegramId, draftId, { error: `حداکثر ${faInt(qtyDigits(base))} رقم اعشار برای ${nameOf(base)}.` });
        }
        d.quantity = q;
        d.step = this.#after(d, 'qty');
        return this.step(telegramId, draftId);
      }
      case 'note': {
        const description = cleanDescription(text);
        const length = charCount(description);
        if (length > DESCRIPTION_MAX) {
          return this.step(telegramId, draftId, { error: `توضیحات ${faInt(length)} حرف است؛ حداکثر ${faInt(DESCRIPTION_MAX)} حرف. کوتاه‌ترش کنید.` });
        }
        d.description = description;
        d.step = this.#after(d, 'note');
        return this.step(telegramId, draftId);
      }
      default:
        return null;
    }
  }

  async post(chatId, telegramId, draftId) {
    const d = this.#draft(draftId);
    if (!d) return this.#expired();
    const me = await this.account(telegramId);
    if (me.error) return this.#accountCard(me.error);
    const back = this.#back(d.symbol);
    try {
      const { order } = await this.auction.place(
        me.id,
        { symbol: d.symbol, side: d.side, price: d.price, quantity: d.quantity, description: d.description },
        { actor: `bot:${telegramId}` },
      );
      this.drafts.delete(draftId);
      this.states.delete(chatId);
      const base = baseOf(d.symbol);
      const qd = qtyDigits(base);
      const filled = Number(order.filled_quantity);
      const head = order.status === 'filled'
        ? `<b>✓ ${fa(filled, qd)} ${nameOf(base)} ${d.side === 'buy' ? 'خریدید' : 'فروختید'}</b>`
        : filled > 0
          ? `<b>✓ ${fa(filled, qd)} ${nameOf(base)} همین حالا انجام شد</b>\nباقی‌مانده روی تابلو رفت.`
          : '<b>✓ آگهی شما روی تابلو رفت</b>';
      return {
        text: [head, '', `«من ${sentence({ side: d.side, base, price: d.price, quantity: d.quantity })}»`, ...note(d.description), '', '<i>هر وقت کسی آن را بردارد، همین‌جا خبرتان می‌کنیم.</i>'].join('\n'),
        reply_markup: { inline_keyboard: [back] },
      };
    } catch (err) {
      return { text: errorText(err), reply_markup: { inline_keyboard: [back] } };
    }
  }

  // ---- Updates --------------------------------------------------------------

  /**
   * A text message: the answer to an offer's step, an amount for the offer
   * being answered, or a whole offer typed at once. Null if it is none of these.
   */
  async onText(chatId, telegramId, text) {
    this.#prune();
    const send = (card) => [{ method: 'sendMessage', chat_id: chatId, parse_mode: 'HTML', ...card }];
    const st = this.#state(chatId);
    if (st?.kind === 'wizard') {
      const d = this.#draft(st.draftId);
      // A whole offer typed mid-way starts over from it, below; any other text answers the step.
      const whole = d && d.step !== 'note' && parseOffer(String(text).split('\n')[0])?.ok;
      if (d && d.step !== 'review' && !whole) {
        const card = await this.#typed(telegramId, st.draftId, d, text);
        // The step moves on in a new message under the user's; the old one loses its buttons.
        const old = d.msg ? [{ method: 'editMessageReplyMarkup', chat_id: chatId, message_id: d.msg, reply_markup: { inline_keyboard: [] } }] : [];
        d.msg = null;
        return [...send(card), ...old];
      }
    }
    if (st?.kind === 'amount') {
      const q = asciiAmount(text);
      if (q) {
        const card = await this.confirmTakeCard(telegramId, st.offerId, q);
        return send(card.error ? { text: ERRORS[card.error], reply_markup: { inline_keyboard: [this.#back(DEFAULT_SYMBOL)] } } : card);
      }
    }

    // The offer is the first line; whatever follows it is the description.
    const prices = { prices: this.trading?.tomanPrices?.() ?? {} };
    const [first, ...more] = String(text).split('\n');
    const firstParsed = more.length ? parseOffer(first, prices) : null;
    const [parsed, offerText, description] = firstParsed?.ok
      ? [firstParsed, first, cleanDescription(more.join('\n'))]
      : [parseOffer(text, prices), String(text), ''];
    const current = st?.kind === 'wizard' ? this.#draft(st.draftId) : null;
    const named = ALIASES.some(([, re]) => re.test(normalize(offerText)));
    if (parsed?.ok) {
      const symbol = current && !named ? current.symbol : `${parsed.base}_IRT`;
      if (!isSymbol(symbol)) return null;
      const long = charCount(description) > DESCRIPTION_MAX;
      const id = this.#newDraft(symbol, {
        side: parsed.side, price: parsed.price, quantity: parsed.quantity, description: long ? '' : description, step: long ? 'note' : 'review',
      });
      this.#setState(chatId, { kind: 'wizard', draftId: id });
      return send(await this.step(telegramId, id, long ? { error: `توضیحات ${faInt(charCount(description))} حرف است؛ حداکثر ${faInt(DESCRIPTION_MAX)} حرف.` } : {}));
    }
    if (parsed) {
      // Buy or sell is clear but not the rest: carry on from there, step by step.
      const symbol = isSymbol(`${parsed.base}_IRT`) ? `${parsed.base}_IRT` : DEFAULT_SYMBOL;
      const id = this.#newDraft(symbol, { side: parsed.side, step: parsed.side ? 'price' : 'side' });
      this.#setState(chatId, { kind: 'wizard', draftId: id });
      return send(await this.step(telegramId, id, { lead: 'آگهی‌تان را کامل متوجه نشدم؛ قدم‌به‌قدم کاملش کنیم.' }));
    }
    return null;
  }

  /** A button under one of this module's messages (callback data "a:..."). */
  async onCallback(cq) {
    const chatId = cq.message.chat.id;
    const tg = cq.from.id;
    const [, kind, ...args] = cq.data.split(':');
    const edit = (card) => ({ method: 'editMessageText', chat_id: chatId, message_id: cq.message.message_id, parse_mode: 'HTML', ...card });
    const send = (card) => ({ method: 'sendMessage', chat_id: chatId, parse_mode: 'HTML', ...card });
    const done = (text) => ({ method: 'answerCallbackQuery', callback_query_id: cq.id, ...(text ? { text, show_alert: true } : {}) });
    // A card that came back as { error } is a short alert over the chat, not a message.
    const show = (card, how) => (card.error ? [done(ERRORS[card.error])] : [how(card), done()]);

    switch (kind) {
      case 'b': {
        const [symbol, filter = 'a', page = '0'] = args;
        if (!isSymbol(symbol)) return [done()];
        return [edit(await this.board(tg, symbol, ['a', 'b', 's'].includes(filter) ? filter : 'a', Number(page) || 0)), done()];
      }
      case 'pairs':
        return [edit(this.pairs()), done()];
      case 't':
        return show(await this.takeCard(chatId, tg, args[0]), send);
      case 'te':
        return show(await this.takeCard(chatId, tg, args[0]), edit);
      case 'q':
        return show(await this.confirmTakeCard(tg, args[0], args[1]), edit);
      case 'c':
        return [edit(await this.take(chatId, tg, args[0], args[1])), done()];
      case 'x': {
        const me = await this.account(tg);
        if (me.error) return [done('حساب شما فعال نیست.')];
        try {
          const { order } = await this.auction.cancel(me.id, args[0], { actor: `bot:${tg}` });
          return [edit(await this.board(tg, order.symbol)), done('آگهی حذف شد و مبلغ آن آزاد شد.')];
        } catch (err) {
          return [done(errorText(err))];
        }
      }
      case 'post': {
        const symbol = isSymbol(args[0]) ? args[0] : DEFAULT_SYMBOL;
        const me = await this.account(tg);
        if (me.error) return [send(this.#accountCard(me.error)), done()];
        const id = this.#newDraft(symbol);
        this.#setState(chatId, { kind: 'wizard', draftId: id });
        return [send(await this.step(tg, id)), done()];
      }
      case 'w':
        return [...(await this.#wizard(cq, args, edit)), done()];
      default:
        return [done()];
    }
  }

  /** A button on an offer being put together ("a:w:<draft>:<action>[:<value>]"). */
  async #wizard(cq, [draftId, action, value], edit) {
    const chatId = cq.message.chat.id;
    const tg = cq.from.id;
    const d = this.#draft(draftId);
    if (!d) return [edit(this.#expired())];
    d.msg = cq.message.message_id;
    this.#setState(chatId, { kind: 'wizard', draftId });

    switch (action) {
      case 'side':
        if (value === 'buy' || value === 'sell') {
          d.side = value;
          d.step = this.#after(d, 'side');
        }
        break;
      case 'p': {
        const p = asciiAmount(value);
        if (p) {
          d.price = p;
          d.step = this.#after(d, 'price');
        }
        break;
      }
      case 'q': {
        const q = asciiAmount(value);
        if (q) {
          d.quantity = q;
          d.step = this.#after(d, 'qty');
        }
        break;
      }
      case 'n':
        if (value !== 'keep') d.description = '';
        d.step = this.#after(d, 'note');
        break;
      case 'go':
        if (STEPS.includes(value)) d.step = value;
        if (value === 'review' && d.side && d.price && d.quantity) {
          d.step = 'review';
          d.editing = false;
        }
        break;
      case 'e':
        if (STEPS.includes(value)) {
          d.step = value;
          d.editing = true;
        }
        break;
      case 'flip':
        d.side = d.side === 'buy' ? 'sell' : 'buy';
        break;
      case 'mk':
        return [edit(this.#marketStep(draftId))];
      case 's':
        if (isSymbol(value) && value !== d.symbol) Object.assign(d, { symbol: value, price: null, quantity: null });
        d.step = 'side';
        break;
      case 'ok':
        return [edit(await this.post(chatId, tg, draftId))];
      case 'x':
        this.drafts.delete(draftId);
        this.states.delete(chatId);
        return [edit({ text: 'آگهی ثبت نشد.', reply_markup: { inline_keyboard: [this.#back(d.symbol)] } })];
      default:
        break;
    }
    return [edit(await this.step(tg, draftId))];
  }

  /**
   * Messages for whoever posted the offers a change filled: "your offer was
   * taken". Called on every auction change; the taker already has its answer.
   */
  async notifications({ symbol, trades }) {
    const out = [];
    const base = baseOf(symbol);
    for (const t of trades) {
      const makerSide = t.taker_side === 'buy' ? 'sell' : 'buy';
      const makerId = makerSide === 'buy' ? t.buy_user_id : t.sell_user_id;
      if (!makerId) continue;
      const { rows } = await this.pg.query('SELECT telegram_id FROM miniapp_users WHERE exchange_user_id = $1 AND blocked_at IS NULL', [makerId]);
      const total = Number(t.price) * Number(t.quantity);
      for (const { telegram_id: chatId } of rows) {
        out.push({
          method: 'sendMessage',
          chat_id: Number(chatId),
          parse_mode: 'HTML',
          text: [
            '<b>🔔 آگهی شما معامله شد</b>',
            '',
            `${fa(t.quantity, qtyDigits(base))} ${nameOf(base)} به قیمت ${fa(t.price, priceDigits(Number(t.price)))} تومان ${makerSide === 'buy' ? 'خریدید' : 'فروختید'}.`,
            `${makerSide === 'buy' ? 'پرداختی' : 'دریافتی'}: ${faInt(Math.round(total))} تومان`,
          ].join('\n'),
          reply_markup: { inline_keyboard: [[...this.#back(symbol), { text: 'موجودی من', callback_data: 'balance' }]] },
        });
      }
    }
    return out;
  }
}
