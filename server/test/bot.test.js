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

test('/start answers with a welcome, the Mini App first and shortcuts after it', async () => {
  const [reply, ...rest] = await makeBot().handle(message('/start'));
  assert.equal(rest.length, 0);
  assert.equal(reply.method, 'sendMessage');
  assert.equal(reply.chat_id, 42);
  assert.match(reply.text, /سلام Ramtin/);
  const [open, ...others] = buttons(reply);
  assert.deepEqual(open.web_app, { url: `${URL_}/` });
  assert.ok(others.some((b) => b.web_app?.url === `${URL_}/?screen=auction`));
  assert.ok(others.some((b) => b.callback_data === 'balance'));
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
    calls.push(new URL(JSON.parse(init.body).url));
    return new Response(JSON.stringify({ ok: true, result: true }));
  };
  const bot = makeBot({ proxyUrl: 'http://relay/', proxyKey: 'K' });
  await bot.setup();
  assert.deepEqual(calls.map((u) => u.pathname.split('/').pop()), ['setChatMenuButton', 'setMyCommands', 'setWebhook']);
  const hook = calls[2].searchParams;
  assert.equal(hook.get('url'), `${URL_}/api/v1/telegram/webhook`);
  assert.equal(hook.get('secret_token'), bot.webhookSecret);
  assert.equal(JSON.parse(calls[0].searchParams.get('menu_button')).web_app.url, `${URL_}/`);
});

test('without a public URL the bot stays off', async () => {
  globalThis.fetch = async () => assert.fail('no call expected');
  const bot = new Bot({ botToken: 'T', publicUrl: '', mode: 'webhook' });
  assert.equal(bot.mode, 'off');
  await bot.setup();
});
