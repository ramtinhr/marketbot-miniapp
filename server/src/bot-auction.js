// The auction in the bot's chat, the way the Mini App's board shows it and the
// way Telegram's USDT groups trade: a message lists the open offers - "USDT at
// X Toman, Y of it, I buy" - each with a button to answer it ("I sell to
// them" / "I buy from them"); answering asks how much, then to confirm. A new
// offer is typed as it would be posted in a group ("من تتر را به قیمت ۱۰۲۵۰۰
// تومان با حجم ۱۰۰ میخرم"), shown back as a preview, and posted on confirm.
// Whoever posted an offer hears in the chat when it is taken.
//
// Everything is answered with Bot API actions ({method, ...params}), like the
// rest of the bot. What a chat is in the middle of (an amount to type for an
// offer, a preview to confirm) is kept in memory for a few minutes: after a
// restart the user just taps again.

import { randomBytes } from 'node:crypto';

import { asciiAmount, isSymbol } from './trading.js';

const DEFAULT_SYMBOL = 'USDT_IRT';
const PAGE = 6;
const STATE_TTL_MS = 10 * 60_000;

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

/** The offer as a group would word it: "USDT at X Toman, Y of it, I buy". */
function sentence({ side, base, price, quantity }) {
  const pd = priceDigits(Number(price));
  return `${nameOf(base)} را به قیمت <b>${fa(price, pd)}</b> تومان با حجم <b>${fa(quantity, qtyDigits(base))}</b> <b>${side === 'buy' ? 'می‌خرم' : 'می‌فروشم'}</b>`;
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
  const s = String(text ?? '')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u200c\u200f\u200e]/g, '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/(\d)[,٬](?=\d{3}(?!\d))/g, '$1')
    .replace(/(\d)[٫/](?=\d)/g, '$1.')
    .toLowerCase();

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
      lines.push(sentence({ side: o.side, base, price: o.price, quantity: o.remaining }), '');
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

  postHelp(symbol) {
    const name = nameOf(baseOf(symbol));
    return {
      text: [
        `<b>➕ ثبت آگهی ${name}</b>`,
        '',
        'آگهی‌تان را همان‌طور که در گروه‌ها می‌نویسید بفرستید، مثلاً:',
        '',
        `<code>من ${name} را به قیمت ۱۰۲۵۰۰ تومان با حجم ۱۰۰ میخرم</code>`,
        `<code>۵۰ ${name} فی ۱۰۳٬۲۰۰ میفروشم</code>`,
        '',
        '<i>قبل از ثبت، پیش‌نمایش آگهی را می‌بینید و تأیید می‌کنید.</i>',
      ].join('\n'),
      reply_markup: { inline_keyboard: [this.#back(symbol)] },
    };
  }

  /** A typed offer read back before it is posted: the sentence, what it freezes, and Post / Cancel. */
  async preview(telegramId, draftId) {
    const d = this.#draft(draftId);
    if (!d) return { text: 'این پیش‌نمایش منقضی شده است؛ آگهی را دوباره بنویسید.', reply_markup: { inline_keyboard: [this.#back(DEFAULT_SYMBOL)] } };
    const me = await this.account(telegramId);
    if (me.error) return this.#accountCard(me.error);
    const base = baseOf(d.symbol);
    const qd = qtyDigits(base);
    const total = Number(d.price) * Number(d.quantity);
    const available = await this.#available(me.id, d.side === 'buy' ? 'IRT' : base);
    const short = d.side === 'buy' ? total > available + 1e-9 : Number(d.quantity) > available + 1e-12;

    const [offers, mineList] = await Promise.all([this.auction.offers(d.symbol), this.auction.orders(me.id, { symbol: d.symbol, scope: 'open' })]);
    const mine = new Set(mineList.map((o) => o.id));
    const crossing = offers.filter((o) => !mine.has(o.id) && o.side !== d.side
      && (d.side === 'buy' ? Number(o.price) <= Number(d.price) : Number(o.price) >= Number(d.price)));

    const text = [
      '<b>پیش‌نمایش آگهی</b>',
      '',
      `«من ${sentence({ side: d.side, base, price: d.price, quantity: d.quantity })}»`,
      '',
      `${d.side === 'buy' ? 'مبلغ کل' : 'دریافتی در صورت فروش'}: <b>${faInt(Math.round(total))} تومان</b>`,
      `موجودی شما: ${d.side === 'buy' ? `${faInt(Math.floor(available))} تومان` : `${fa(available, qd)} ${nameOf(base)}`}`,
      ...(short ? ['', '<b>موجودی شما برای این آگهی کافی نیست.</b>'] : []),
      ...(crossing.length ? ['', `<i>با این قیمت، بلافاصله با ${faInt(crossing.length)} آگهی ${d.side === 'buy' ? 'فروش' : 'خرید'} موجود معامله می‌شود.</i>`] : []),
      '',
      `<i>${d.side === 'buy' ? 'تومانِ' : `${nameOf(base)}ِ`} آگهی تا انجام یا حذف آن مسدود می‌ماند.</i>`,
    ].join('\n');
    const rows = [];
    if (!short) {
      rows.push([{ text: d.side === 'buy' ? '✓ ارسال آگهی خرید' : '✓ ارسال آگهی فروش', style: d.side === 'buy' ? 'success' : 'danger', callback_data: `a:pc:${draftId}` }]);
    } else if (d.side === 'buy') {
      rows.push([{ text: 'شارژ کیف پول', web_app: { url: this.appUrl('charge') } }]);
    }
    rows.push([
      { text: d.side === 'buy' ? '⇄ می‌فروشم' : '⇄ می‌خرم', callback_data: `a:ps:${draftId}` },
      { text: 'انصراف', callback_data: `a:pd:${draftId}` },
    ]);
    return { text, reply_markup: { inline_keyboard: rows } };
  }

  async post(chatId, telegramId, draftId) {
    const d = this.#draft(draftId);
    if (!d) return { text: 'این پیش‌نمایش منقضی شده است؛ آگهی را دوباره بنویسید.', reply_markup: { inline_keyboard: [this.#back(DEFAULT_SYMBOL)] } };
    const me = await this.account(telegramId);
    if (me.error) return this.#accountCard(me.error);
    const back = this.#back(d.symbol);
    try {
      const { order } = await this.auction.place(me.id, { symbol: d.symbol, side: d.side, price: d.price, quantity: d.quantity }, { actor: `bot:${telegramId}` });
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
        text: [head, '', `«من ${sentence({ side: d.side, base, price: d.price, quantity: d.quantity })}»`, '', '<i>هر وقت کسی آن را بردارد، همین‌جا خبرتان می‌کنیم.</i>'].join('\n'),
        reply_markup: { inline_keyboard: [back] },
      };
    } catch (err) {
      return { text: errorText(err), reply_markup: { inline_keyboard: [back] } };
    }
  }

  // ---- Updates --------------------------------------------------------------

  /** A text message: an amount for the offer being answered, or a typed offer. Null if it is neither. */
  async onText(chatId, telegramId, text) {
    this.#prune();
    const send = (card) => [{ method: 'sendMessage', chat_id: chatId, parse_mode: 'HTML', ...card }];
    const st = this.#state(chatId);
    if (st?.kind === 'amount') {
      const q = asciiAmount(text);
      if (q) {
        const card = await this.confirmTakeCard(telegramId, st.offerId, q);
        return send(card.error ? { text: ERRORS[card.error], reply_markup: { inline_keyboard: [this.#back(DEFAULT_SYMBOL)] } } : card);
      }
    }

    const parsed = parseOffer(text, { prices: this.trading?.tomanPrices?.() ?? {} });
    if (parsed?.ok) {
      const symbol = st?.kind === 'post' && !ALIASES.some(([, re]) => re.test(String(text).toLowerCase())) ? st.symbol : `${parsed.base}_IRT`;
      if (!isSymbol(symbol)) return null;
      const id = randomBytes(6).toString('base64url');
      this.drafts.set(id, { symbol, side: parsed.side, price: parsed.price, quantity: parsed.quantity, expires: Date.now() + STATE_TTL_MS });
      return send(await this.preview(telegramId, id));
    }
    if (parsed || st?.kind === 'post') {
      const symbol = st?.symbol ?? `${parsed?.base ?? 'USDT'}_IRT`;
      const help = this.postHelp(isSymbol(symbol) ? symbol : DEFAULT_SYMBOL);
      const missing = !parsed?.side ? 'نوشتید می‌خرید یا می‌فروشید؟' : 'قیمت (به تومان) و حجم را هر دو بنویسید.';
      return send({ ...help, text: `<b>آگهی‌تان را کامل متوجه نشدم.</b> ${missing}\n\n${help.text}` });
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
        this.#setState(chatId, { kind: 'post', symbol });
        return [send(this.postHelp(symbol)), done()];
      }
      case 'ps': {
        const d = this.#draft(args[0]);
        if (d) d.side = d.side === 'buy' ? 'sell' : 'buy';
        return [edit(await this.preview(tg, args[0])), done()];
      }
      case 'pc':
        return [edit(await this.post(chatId, tg, args[0])), done()];
      case 'pd':
        this.drafts.delete(args[0]);
        return [edit({ text: 'آگهی ارسال نشد.', reply_markup: { inline_keyboard: [this.#back(DEFAULT_SYMBOL)] } }), done()];
      default:
        return [done()];
    }
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
