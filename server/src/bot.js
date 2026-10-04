// The bot's chat: /start (Telegram's Start button) answers with a welcome and a
// reply keyboard - open the Mini App, the auction, the wallet's balances shown
// right in the chat, charging the wallet. The chat's menu button opens the Mini
// App directly; the empty chat shows the bot's description above Start.
//
// Updates come by webhook (POST /api/v1/telegram/webhook), answered in the
// response body, so replying needs no call out to Telegram - which is blocked
// from the server. The webhook, menu button and commands are registered once,
// with `npm run bot:setup` (src/bot-setup.js), not at every start. Other calls
// (stopping a button's spinner) go through the relay in TELEGRAM_PROXY_URL, the
// same one the bot's alerts use. Polling is for development: it removes the
// webhook, so never point it at the production bot.

import { createHmac, timingSafeEqual } from 'node:crypto';

const API = 'https://api.telegram.org';

const COMMANDS = [
  { command: 'start', description: 'منوی اصلی' },
  { command: 'balance', description: 'موجودی کیف پول' },
  { command: 'auction', description: 'مزایده' },
];

// The reply keyboard under the text field. Plain text buttons: a Mini App
// opened from a keyboard button gets no launch parameters, and the app signs
// in with them, so "open" answers with an inline button (or the menu button).
const KEYS = {
  open: 'باز کردن مارکت‌بات',
  auction: 'مزایده',
  balance: 'موجودی من',
  charge: 'شارژ کیف پول',
};

// style: "primary" blue, "success" green, "danger" red; none is the app's own.
const KEYBOARD = {
  keyboard: [
    [{ text: `🚀 ${KEYS.open}`, style: 'primary' }],
    [{ text: `🔨 ${KEYS.auction}`, style: 'success' }, { text: `💰 ${KEYS.balance}` }],
    [{ text: `💳 ${KEYS.charge}`, style: 'primary' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: 'یکی از گزینه‌ها را انتخاب کنید',
};

// What the empty chat shows above Telegram's Start button, and the profile's line.
const DESCRIPTION = [
  'مارکت‌بات؛ خرید و فروش ارز دیجیتال با تومان، همین‌جا در تلگرام.',
  '',
  '• معامله با سفارش بازار و محدود',
  '• مزایده: پیشنهاد قیمت به کاربران دیگر',
  '• شارژ آنلاین کیف پول و برداشت',
  '',
  'برای شروع دکمهٔ «Start» را بزنید.',
].join('\n');
const SHORT_DESCRIPTION = 'خرید و فروش ارز دیجیتال با تومان در تلگرام؛ بازار، محدود و مزایده.';

const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

const fa = (n, digits = 0) => Number(n).toLocaleString('fa-IR', { maximumFractionDigits: digits });

/** How many decimals an amount of `asset` is worth showing. */
function digitsFor(asset, price) {
  if (asset === 'IRT') return 0;
  if (!price) return 8;
  return Math.min(8, Math.max(2, Math.ceil(Math.log10(price)) + 1));
}

export class Bot {
  /**
   * @param {{ botToken: string, publicUrl: string, proxyUrl?: string, proxyKey?: string, mode?: 'webhook'|'polling'|'off',
   *           pg: import('pg').Pool, wallets?: import('./wallets.js').Wallets, trading?: import('./trading.js').Trading,
   *           timeoutMs?: number, log?: object }} opts
   */
  constructor({ botToken, publicUrl, proxyUrl = '', proxyKey = '', mode = 'off', pg, wallets, trading, timeoutMs = 15_000, log }) {
    this.botToken = botToken;
    this.publicUrl = publicUrl.replace(/\/+$/, '');
    this.proxyUrl = proxyUrl.replace(/\/+$/, '');
    this.proxyKey = proxyKey;
    this.mode = botToken && this.publicUrl ? mode : 'off';
    this.pg = pg;
    this.wallets = wallets;
    this.trading = trading;
    this.timeoutMs = timeoutMs;
    this.log = log;
    // Telegram echoes it in a header on every webhook call; derived, so there is nothing more to configure.
    this.webhookSecret = botToken ? createHmac('sha256', botToken).update('telegram-webhook').digest('hex') : '';
    this.polling = false;
  }

  /** Whether a webhook call carries this bot's secret. */
  verifyWebhook(header) {
    if (!this.webhookSecret || typeof header !== 'string') return false;
    const a = Buffer.from(header);
    const b = Buffer.from(this.webhookSecret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** The Mini App, opened on `screen` (see launchScreen in the web app). */
  appUrl(screen) {
    return screen ? `${this.publicUrl}/?screen=${screen}` : `${this.publicUrl}/`;
  }

  // ---- Bot API ------------------------------------------------------------

  async call(method, params = {}) {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) query.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    const url = `${API}/bot${this.botToken}/${method}?${query}`;
    const signal = AbortSignal.timeout(method === 'getUpdates' ? this.timeoutMs + 30_000 : this.timeoutMs);
    let res;
    if (this.proxyUrl) {
      const headers = { 'content-type': 'application/json' };
      if (this.proxyKey) headers['x-api-key'] = this.proxyKey;
      res = await fetch(`${this.proxyUrl}/request`, { method: 'POST', headers, body: JSON.stringify({ method: 'GET', url }), signal });
    } else {
      res = await fetch(url, { signal });
    }
    const body = await res.json().catch(() => null);
    if (!body?.ok) throw new Error(`telegram ${method}: ${body?.description || `HTTP ${res.status}`}`);
    return body.result;
  }

  #warn(err, msg) {
    this.log?.warn({ err: { message: String(err.message).replaceAll(this.botToken, '<token>') } }, msg);
  }

  /** Runs one of the actions `handle` returns. */
  run({ method, ...params }) {
    return this.call(method, params);
  }

  get webhookUrl() {
    return `${this.publicUrl}/api/v1/telegram/webhook`;
  }

  /**
   * One-off: the descriptions, the menu button, the commands and the webhook.
   * Telegram keeps them, so this runs again only when they, PUBLIC_URL or the
   * token change. Throws on the first call Telegram refuses.
   */
  async setup() {
    if (!this.botToken || !this.publicUrl) throw new Error('set BOT_TOKEN and PUBLIC_URL');
    await this.call('setMyDescription', { description: DESCRIPTION });
    await this.call('setMyShortDescription', { short_description: SHORT_DESCRIPTION });
    await this.call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'مارکت‌بات', web_app: { url: this.appUrl() } } });
    await this.call('setMyCommands', { commands: COMMANDS });
    await this.call('setWebhook', { url: this.webhookUrl, secret_token: this.webhookSecret, allowed_updates: ['message', 'callback_query'] });
    return this.call('getWebhookInfo');
  }

  /** Development: long-polls for updates until `stop()`. Removes the webhook first. */
  async poll() {
    this.polling = true;
    await this.call('deleteWebhook').catch((err) => this.#warn(err, 'bot: deleteWebhook failed'));
    let offset = 0;
    while (this.polling) {
      try {
        const updates = await this.call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
        for (const update of updates) {
          offset = update.update_id + 1;
          for (const action of await this.handle(update)) await this.run(action).catch((err) => this.#warn(err, 'bot reply failed'));
        }
      } catch (err) {
        if (!this.polling) break;
        this.#warn(err, 'bot polling failed');
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }

  stop() {
    this.polling = false;
  }

  // ---- Conversation -------------------------------------------------------

  /**
   * What to do about one update: Bot API calls as `{method, ...params}`. The
   * first is the reply (the webhook's response body); the rest are extras.
   */
  async handle(update) {
    const msg = update.message;
    if (msg?.chat?.type === 'private' && typeof msg.text === 'string') {
      const text = msg.text.trim();
      const chatId = msg.chat.id;
      // A key's text, without the emoji in front of it.
      switch (text.replace(/^[^\p{L}/]+/u, '')) {
        case KEYS.open: return [this.openMessage(chatId)];
        case KEYS.auction: return [this.auctionMessage(chatId)];
        case KEYS.balance: return [await this.balanceMessage(chatId, msg.from.id)];
        case KEYS.charge: return [this.openMessage(chatId, 'charge')];
      }
      const [command, payload] = text.split(/\s+/);
      switch (command.replace(/@\w+$/, '')) {
        case '/balance':
          return [await this.balanceMessage(chatId, msg.from.id)];
        case '/auction':
          return [this.auctionMessage(chatId)];
        case '/start':
          if (payload === 'balance') return [await this.balanceMessage(chatId, msg.from.id)];
          if (payload === 'auction') return [this.auctionMessage(chatId)];
          return [this.welcome(chatId, msg.from)];
        default:
          return [this.welcome(chatId, msg.from)];
      }
    }

    const cq = update.callback_query;
    if (cq?.message?.chat?.type === 'private') {
      const done = { method: 'answerCallbackQuery', callback_query_id: cq.id };
      const chatId = cq.message.chat.id;
      if (cq.data === 'balance') return [await this.balanceMessage(chatId, cq.from.id), done];
      if (cq.data === 'balance:refresh') {
        return [{ ...(await this.balanceMessage(chatId, cq.from.id)), method: 'editMessageText', message_id: cq.message.message_id }, done];
      }
      if (cq.data === 'menu') return [this.welcome(chatId, cq.from), done];
      return [done];
    }
    return [];
  }

  welcome(chatId, from) {
    const name = escapeHtml(from?.first_name || 'دوست');
    return {
      method: 'sendMessage',
      chat_id: chatId,
      parse_mode: 'HTML',
      text: [
        `سلام ${name}!`,
        'به <b>مارکت‌بات</b> خوش آمدید؛ خرید و فروش ارز دیجیتال با تومان، همین‌جا در تلگرام.',
        '',
        '• <b>بازار و محدود:</b> معامله با دفتر سفارش زنده',
        '• <b>مزایده:</b> پیشنهاد قیمت خود را به کاربران دیگر بدهید',
        '• <b>کیف پول:</b> شارژ آنلاین، موجودی و برداشت',
        '',
        'از دکمه‌های پایین صفحه استفاده کنید؛ دکمهٔ «مارکت‌بات» کنار کادر پیام هم برنامه را باز می‌کند.',
      ].join('\n'),
      reply_markup: KEYBOARD,
    };
  }

  /** An inline button into the Mini App, on `screen`: the reply keyboard's buttons cannot open it themselves. */
  openMessage(chatId, screen) {
    const charge = screen === 'charge';
    return {
      method: 'sendMessage',
      chat_id: chatId,
      text: charge ? 'برای شارژ کیف پول دکمهٔ زیر را بزنید.' : 'برای باز کردن مارکت‌بات دکمهٔ زیر را بزنید.',
      reply_markup: { inline_keyboard: [[{ text: charge ? '💳 شارژ کیف پول' : '🚀 باز کردن مارکت‌بات', style: 'primary', web_app: { url: this.appUrl(screen) } }]] },
    };
  }

  auctionMessage(chatId) {
    return {
      method: 'sendMessage',
      chat_id: chatId,
      parse_mode: 'HTML',
      text: [
        '<b>مزایده</b>',
        'قیمت و مقداری را که می‌خواهید بخرید یا بفروشید پیشنهاد دهید؛ سفارش شما فقط با پیشنهاد کاربران دیگر در دفتر مزایده معامله می‌شود و مبلغ آن تا انجام یا لغو مسدود می‌ماند.',
      ].join('\n\n'),
      reply_markup: { inline_keyboard: [[{ text: '🔨 ورود به مزایده', style: 'success', web_app: { url: this.appUrl('auction') } }]] },
    };
  }

  /** The user's balances, or how to get some: their exchange account comes with the first SMS code. */
  async balanceMessage(chatId, telegramId) {
    const reply = (text, keyboard) => ({ method: 'sendMessage', chat_id: chatId, parse_mode: 'HTML', text, reply_markup: { inline_keyboard: keyboard } });
    const openApp = [{ text: '🚀 باز کردن مارکت‌بات', style: 'primary', web_app: { url: this.appUrl() } }];

    const { rows } = await this.pg.query('SELECT exchange_user_id, blocked_at FROM miniapp_users WHERE telegram_id = $1', [telegramId]);
    const user = rows[0];
    if (user?.blocked_at) return reply('حساب شما مسدود شده است. برای پیگیری با پشتیبانی تماس بگیرید.', []);
    if (!user?.exchange_user_id || !this.wallets) {
      return reply('هنوز حساب شما فعال نشده است. مارکت‌بات را باز کنید و با شمارهٔ موبایل خود ثبت‌نام کنید.', [openApp]);
    }

    const balances = await this.wallets.balances(user.exchange_user_id);
    const prices = this.trading ? this.trading.tomanPrices() : {};
    const held = balances.filter((b) => Number(b.available) > 0 || Number(b.frozen) > 0);
    held.sort((a, b) => (a.asset === 'IRT' ? -1 : b.asset === 'IRT' ? 1 : a.asset.localeCompare(b.asset)));

    let total = 0;
    const lines = held.map((b) => {
      const price = b.asset === 'IRT' ? 1 : prices[b.asset] || 0;
      const digits = digitsFor(b.asset, prices[b.asset]);
      const amount = Number(b.available) + Number(b.frozen);
      total += amount * price;
      const name = b.asset === 'IRT' ? 'تومان' : b.asset;
      const frozen = Number(b.frozen) > 0 ? ` <i>(مسدود: ${fa(b.frozen, digits)})</i>` : '';
      return `<b>${name}:</b> ${fa(b.available, digits)}${frozen}`;
    });
    const time = new Date().toLocaleTimeString('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' });
    const text = [
      '<b>موجودی کیف پول</b>',
      '',
      ...(lines.length ? lines : ['کیف پول شما خالی است.']),
      ...(total > 0 ? ['', `ارزش کل: حدود ${fa(Math.round(total))} تومان`] : []),
      '',
      `<i>به‌روز شده در ${time}</i>`,
    ].join('\n');
    return reply(text, [
      [{ text: '🔄 به‌روزرسانی', callback_data: 'balance:refresh' }, { text: '👛 کیف پول', web_app: { url: this.appUrl('wallet') } }],
      [{ text: '💳 شارژ کیف پول', style: 'primary', web_app: { url: this.appUrl('charge') } }],
    ]);
  }
}
