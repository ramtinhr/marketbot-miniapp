import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { buildApp } from '../src/app.js';
import { Bot } from '../src/bot.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const URL_ = 'https://app.example';

/** Telegram user 42 has an exchange account with Toman and USDT; 7 has signed up but not confirmed a code. */
function makeBot(opts = {}) {
  const pg = {
    async query(_sql, [telegramId]) {
      if (telegramId === 42) return { rows: [{ exchange_user_id: 'u-42', blocked_at: null }] };
      if (telegramId === 7) return { rows: [{ exchange_user_id: null, blocked_at: null }] };
      if (telegramId === 9) return { rows: [{ exchange_user_id: 'u-9', blocked_at: new Date() }] };
      return { rows: [] };
    },
  };
  const wallets = {
    async balances(id) {
      assert.equal(id, 'u-42');
      return [
        { asset: 'USDT', available: '10.5', frozen: '2', locked: '0' },
        { asset: 'IRT', available: '1000000', frozen: '0', locked: '0' },
        { asset: 'BTC', available: '0', frozen: '0', locked: '0' },
      ];
    },
  };
  const trading = { tomanPrices: () => ({ USDT: 100_000 }) };
  return new Bot({ botToken: 'TOKEN', publicUrl: `${URL_}/`, mode: 'webhook', pg, wallets, trading, ...opts });
}

const message = (text, from = 42) => ({ update_id: 1, message: { message_id: 5, text, chat: { id: from, type: 'private' }, from: { id: from, first_name: 'Ramtin' } } });
const press = (data, from = 42) => ({
  update_id: 2,
  callback_query: { id: 'cq', data, from: { id: from, first_name: 'Ramtin' }, message: { message_id: 9, chat: { id: from, type: 'private' } } },
});
const buttons = (action) => action.reply_markup.inline_keyboard.flat();

test('/start answers with a welcome and a reply keyboard of plain, uncoloured text buttons', async () => {
  const [reply, ...rest] = await makeBot().handle(message('/start'));
  assert.equal(rest.length, 0);
  assert.equal(reply.method, 'sendMessage');
  assert.equal(reply.chat_id, 42);
  assert.match(reply.text, /سلام Ramtin/);
  assert.deepEqual(reply.reply_markup.keyboard.map((row) => row.length), [2, 2, 1]);
  const keys = reply.reply_markup.keyboard.flat();
  assert.deepEqual(keys.map((k) => k.text), ['🔨 مزایده', '📋 آگهی‌های من', '💰 موجودی من', '💳 شارژ کیف پول', '📱 باز کردن مارکت‌بات']);
  assert.ok(keys.every((k) => !k.style));
  // A Mini App opened from a keyboard button gets no launch parameters to sign in with.
  assert.ok(keys.every((k) => !k.web_app));
  assert.equal(reply.reply_markup.resize_keyboard, true);
});

test('the keyboard\'s buttons: open and charge answer with an inline button into the app, balance shows balances', async () => {
  const [open] = await makeBot().handle(message('🚀 باز کردن مارکت‌بات'));
  assert.equal(buttons(open)[0].web_app.url, `${URL_}/`);
  const [charge] = await makeBot().handle(message('شارژ کیف پول'));
  assert.equal(buttons(charge)[0].web_app.url, `${URL_}/?screen=charge`);
  const [auction] = await makeBot().handle(message('مزایده'));
  assert.equal(buttons(auction)[0].web_app.url, `${URL_}/?screen=auction`);
  const [balance] = await makeBot().handle(message('موجودی من'));
  assert.match(balance.text, /موجودی کیف پول/);
  const [mine] = await makeBot().handle(message('📋 آگهی‌های من'));
  assert.equal(buttons(mine)[0].web_app.url, `${URL_}/?screen=myoffers`);
});

test('any other text gets the welcome too; groups are ignored', async () => {
  const [reply] = await makeBot().handle(message('hello'));
  assert.match(reply.text, /مارکت‌بات/);
  const group = message('/start');
  group.message.chat.type = 'group';
  assert.deepEqual(await makeBot().handle(group), []);
});

test('balances: available, frozen and the Toman total; empty wallets left out', async () => {
  const [reply, done] = await makeBot().handle(press('balance'));
  assert.equal(reply.method, 'sendMessage');
  assert.match(reply.text, /تومان:<\/b> ۱٬۰۰۰٬۰۰۰/);
  assert.match(reply.text, /USDT:<\/b> ۱۰٫۵ <i>\(مسدود: ۲\)<\/i>/);
  assert.doesNotMatch(reply.text, /BTC/);
  // 1,000,000 + 12.5 * 100,000
  assert.match(reply.text, /حدود ۲٬۲۵۰٬۰۰۰ تومان/);
  assert.deepEqual(done, { method: 'answerCallbackQuery', callback_query_id: 'cq' });
});

test('refresh edits the balance message in place', async () => {
  const [reply] = await makeBot().handle(press('balance:refresh'));
  assert.equal(reply.method, 'editMessageText');
  assert.equal(reply.message_id, 9);
});

test('/balance before the account exists says how to make one; a blocked account says so', async () => {
  const [unknown] = await makeBot().handle(message('/balance', 1));
  assert.match(unknown.text, /ثبت‌نام/);
  assert.equal(buttons(unknown)[0].web_app.url, `${URL_}/`);
  const [unconfirmed] = await makeBot().handle(message('/start balance', 7));
  assert.match(unconfirmed.text, /ثبت‌نام/);
  const [blocked] = await makeBot().handle(message('/balance', 9));
  assert.match(blocked.text, /مسدود/);
});

test('/auction opens the Mini App on the auction', async () => {
  const [reply] = await makeBot().handle(message('/auction'));
  assert.equal(buttons(reply)[0].web_app.url, `${URL_}/?screen=auction`);
});

test('the webhook checks the secret and answers with the reply in its body', async () => {
  const bot = makeBot();
  const ran = [];
  bot.run = async (action) => ran.push(action);
  const app = await buildApp({ users: { configured: true }, bot, logger: false });

  const denied = await app.inject({ method: 'POST', url: '/api/v1/telegram/webhook', payload: message('/start') });
  assert.equal(denied.statusCode, 401);

  const headers = { 'x-telegram-bot-api-secret-token': bot.webhookSecret };
  const res = await app.inject({ method: 'POST', url: '/api/v1/telegram/webhook', headers, payload: message('/start') });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().method, 'sendMessage');

  const pressed = await app.inject({ method: 'POST', url: '/api/v1/telegram/webhook', headers, payload: press('balance') });
  assert.equal(pressed.json().method, 'sendMessage');
  assert.deepEqual(ran, [{ method: 'answerCallbackQuery', callback_query_id: 'cq' }]);

  const other = await app.inject({ method: 'POST', url: '/api/v1/telegram/webhook', headers, payload: { update_id: 3, edited_message: {} } });
  assert.deepEqual(other.json(), {});
});

test('a failing update still gets an answer, so Telegram does not retry it', async () => {
  const bot = makeBot({ pg: { query: async () => { throw new Error('db down'); } } });
  const app = await buildApp({ users: { configured: true }, bot, logger: false });
  const res = await app.inject({
    method: 'POST', url: '/api/v1/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': bot.webhookSecret }, payload: message('/balance'),
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.json().text, /دوباره تلاش/);
});

test('setup registers the menu button, commands and webhook through the relay', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'http://relay/request');
    assert.equal(init.headers['x-api-key'], 'K');
    const target = new URL(JSON.parse(init.body).url);
    calls.push(target);
    const result = target.pathname.endsWith('/getWebhookInfo') ? { url: `${URL_}/api/v1/telegram/webhook`, pending_update_count: 0 } : true;
    return new Response(JSON.stringify({ ok: true, result }));
  };
  const bot = makeBot({ proxyUrl: 'http://relay/', proxyKey: 'K' });
  const info = await bot.setup();
  assert.equal(info.url, bot.webhookUrl);
  const method = (name) => calls.find((u) => u.pathname.endsWith(`/${name}`)).searchParams;
  assert.deepEqual(calls.map((u) => u.pathname.split('/').pop()),
    ['setMyDescription', 'setMyShortDescription', 'setChatMenuButton', 'setMyCommands', 'setWebhook', 'getWebhookInfo']);
  assert.ok(method('setMyShortDescription').get('short_description').length <= 120);
  assert.ok(method('setMyDescription').get('description').length <= 512);
  assert.equal(method('setWebhook').get('url'), `${URL_}/api/v1/telegram/webhook`);
  assert.equal(method('setWebhook').get('secret_token'), bot.webhookSecret);
  assert.equal(JSON.parse(method('setChatMenuButton').get('menu_button')).web_app.url, `${URL_}/`);
});

test('setup stops at the first call Telegram refuses, and needs a public URL', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }));
  await assert.rejects(makeBot().setup(), /setMyDescription: Unauthorized/);
  await assert.rejects(new Bot({ botToken: 'T', publicUrl: '' }).setup(), /PUBLIC_URL/);
});
