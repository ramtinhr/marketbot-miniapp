import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseOffer } from '../src/bot-auction.js';
import { Bot } from '../src/bot.js';

const SELL = '11111111-1111-4111-8111-111111111111';
const BUY = '22222222-2222-4222-8222-222222222222';
const MINE = '33333333-3333-4333-8333-333333333333';

test('typed offers read as the groups write them', () => {
  const prices = { USDT: 102_000 };
  assert.deepEqual(parseOffer('من تتر را به قیمت ۱۰۲٬۵۰۰ تومن با حجم ۱۰۰ میخرم', { prices }),
    { ok: true, side: 'buy', base: 'USDT', price: '102500', quantity: '100' });
  assert.deepEqual(parseOffer('۵۰ تتر فی 103,200 می‌فروشم', { prices }),
    { ok: true, side: 'sell', base: 'USDT', price: '103200', quantity: '50' });
  assert.deepEqual(parseOffer('فروش ۲۰۰ تا ۱۰۳ هزار', { prices }),
    { ok: true, side: 'sell', base: 'USDT', price: '103000', quantity: '200' });
  // Two bare numbers: the one nearer the market price is the price.
  assert.deepEqual(parseOffer('میخرم 300 102300', { prices }),
    { ok: true, side: 'buy', base: 'USDT', price: '102300', quantity: '300' });
  assert.equal(parseOffer('میخرم ۰٫۰۱ بیت کوین قیمت ۶٬۹۰۰٬۰۰۰٬۰۰۰ تومان').base, 'BTC');
  assert.equal(parseOffer('میخرم ۰٫۰۱ بیت کوین قیمت ۶٬۹۰۰٬۰۰۰٬۰۰۰ تومان').quantity, '0.01');
});

test('text that is not an offer is left alone; an unfinished one says what is missing', () => {
  assert.equal(parseOffer('سلام'), null);
  assert.equal(parseOffer('1000'), null);
  assert.deepEqual(parseOffer('تتر میخرم'), { ok: false, side: 'buy', base: 'USDT' });
});

/** User 42 (exchange u-42) has 10,000,000 Toman and 5 USDT, one open offer of its own; 50 (u-50) posted the others. */
function makeBot() {
  const calls = [];
  const offers = [
    { id: MINE, side: 'buy', price: '101000', quantity: '10', remaining: '10', created_at: '2026-10-04T11:00:00Z' },
    { id: BUY, side: 'buy', price: '101500', quantity: '40', remaining: '30', created_at: '2026-10-04T10:30:00Z' },
    { id: SELL, side: 'sell', price: '102700', quantity: '25', remaining: '25', description: 'فقط تسویه فوری <کارت>', created_at: '2026-10-04T10:00:00Z' },
  ];
  const owners = { [MINE]: 'u-42', [BUY]: 'u-50', [SELL]: 'u-50' };
  const auction = {
    offers: async () => offers,
    orders: async (id) => (id === 'u-42' ? [{ id: MINE }] : []),
    offer: async (id) => {
      const o = offers.find((x) => x.id === id);
      return o ? { ...o, symbol: 'USDT_IRT', owner: owners[id], open: true } : null;
    },
    take: async (user, id, body, opts) => {
      calls.push(['take', user, id, body.quantity, opts.actor]);
      const o = offers.find((x) => x.id === id);
      const side = o.side === 'buy' ? 'sell' : 'buy';
      return { order: { symbol: 'USDT_IRT', side, price: o.price, filled_quantity: body.quantity, filled_quote: String(Number(body.quantity) * Number(o.price)), status: 'filled' }, trades: [] };
    },
    place: async (user, body, opts) => {
      calls.push(['place', user, body, opts.actor]);
      return { order: { ...body, filled_quantity: '0', status: 'open' }, trades: [] };
    },
    cancel: async (user, id) => {
      calls.push(['cancel', user, id]);
      return { order: { id, symbol: 'USDT_IRT', status: 'cancelled' } };
    },
  };
  const pg = {
    async query(sql, [key]) {
      if (sql.includes('WHERE telegram_id')) return { rows: key === 42 ? [{ exchange_user_id: 'u-42', blocked_at: null }] : [] };
      if (sql.includes('WHERE exchange_user_id')) return { rows: key === 'u-50' ? [{ telegram_id: '50' }] : [] };
      return { rows: [] };
    },
  };
  const wallets = {
    balances: async () => [{ asset: 'IRT', available: '10000000', frozen: '0' }, { asset: 'USDT', available: '5', frozen: '0' }],
  };
  const trading = { symbols: () => ['USDT_IRT', 'BTC_IRT'], tomanPrices: () => ({ USDT: 102_000 }) };
  const bot = new Bot({ botToken: 'TOKEN', publicUrl: 'https://app.example', mode: 'webhook', pg, wallets, trading, auction });
  return { bot, calls };
}

const message = (text, from = 42) => ({ update_id: 1, message: { message_id: 5, text, chat: { id: from, type: 'private' }, from: { id: from, first_name: 'Ramtin' } } });
const press = (data, from = 42) => ({
  update_id: 2,
  callback_query: { id: 'cq', data, from: { id: from, first_name: 'Ramtin' }, message: { message_id: 9, chat: { id: from, type: 'private' } } },
});
const buttons = (action) => action.reply_markup.inline_keyboard.flat();

test('the auction key shows the board in the chat: offers as sentences, newest last, a button each', async () => {
  const { bot } = makeBot();
  const [board] = await bot.handle(message('🔨 مزایده'));
  assert.equal(board.method, 'sendMessage');
  assert.match(board.text, /مزایدهٔ تتر/);
  assert.match(board.text, /تتر را به قیمت <b>۱۰۲٬۷۰۰<\/b> تومان با حجم <b>۲۵<\/b> <b>می‌فروشم<\/b>/);
  assert.match(board.text, /باقی‌مانده از ۴۰/);
  assert.match(board.text, /<b>می‌فروشم<\/b>\n💬 <i>فقط تسویه فوری &lt;کارت&gt;<\/i>/, 'the description sits under its offer, escaped');
  assert.ok(board.text.indexOf('۱۰۲٬۷۰۰') < board.text.indexOf('۱۰۱٬۰۰۰'), 'oldest first, newest at the bottom');
  const b = buttons(board);
  assert.equal(b[0].callback_data, `a:t:${SELL}`);
  assert.match(b[0].text, /از او می‌خرم/);
  assert.match(b[1].text, /به او می‌فروشم/);
  assert.equal(b[2].callback_data, `a:x:${MINE}`, 'the user\'s own offer can be withdrawn, not taken');
  assert.ok(b.some((x) => x.callback_data === 'a:post:USDT_IRT'));
  assert.ok(b.every((x) => !x.callback_data || Buffer.byteLength(x.callback_data) <= 64));
});

test('answering an offer: how much, confirm, taken at that offer', async () => {
  const { bot, calls } = makeBot();
  const [card, done] = await bot.handle(press(`a:t:${SELL}`));
  assert.equal(card.method, 'sendMessage');
  assert.match(card.text, /خرید تتر از این فروشنده/);
  assert.equal(done.method, 'answerCallbackQuery');
  // 25 USDT left; 10,000,000 Toman buys about 97 at 102,700, so every share of it is affordable.
  assert.deepEqual(buttons(card).filter((x) => x.callback_data.startsWith('a:q:')).map((x) => x.callback_data.split(':')[3]), ['6.25', '12.5', '18.75', '25']);

  // A typed amount works as well as a button.
  const [typed] = await bot.handle(message('۱۰'));
  assert.match(typed.text, /تأیید خرید/);
  const confirm = buttons(typed)[0];
  assert.equal(confirm.callback_data, `a:c:${SELL}:10`);
  assert.equal(confirm.style, 'success');

  const [result] = await bot.handle(press(confirm.callback_data));
  assert.equal(result.method, 'editMessageText');
  assert.match(result.text, /خرید انجام شد/);
  assert.match(result.text, /۱٬۰۲۷٬۰۰۰ تومان/);
  assert.deepEqual(calls, [['take', 'u-42', SELL, '10', 'bot:42']]);
});

test('more than the offer has left is refused before it reaches the auction', async () => {
  const { bot, calls } = makeBot();
  const [card] = await bot.handle(press(`a:q:${SELL}:30`));
  assert.match(card.text, /فقط ۲۵ تتر مانده/);
  assert.equal(calls.length, 0);
});

test('a typed offer is shown back as a preview, and posted on confirm', async () => {
  const { bot, calls } = makeBot();
  const [preview] = await bot.handle(message('من تتر را به قیمت ۱۰۲۵۰۰ تومان با حجم ۲۰ میخرم'));
  assert.match(preview.text, /پیش‌نمایش آگهی/);
  assert.match(preview.text, /۲٬۰۵۰٬۰۰۰ تومان/);
  assert.doesNotMatch(preview.text, /بلافاصله/, 'the only sell, at 102,700, is above this buy');
  const post = buttons(preview)[0];
  assert.match(post.callback_data, /^a:pc:/);
  assert.equal(post.style, 'success');

  const [posted] = await bot.handle(press(post.callback_data));
  assert.match(posted.text, /آگهی شما روی تابلو رفت/);
  assert.deepEqual(calls, [['place', 'u-42', { symbol: 'USDT_IRT', side: 'buy', price: '102500', quantity: '20', description: '' }, 'bot:42']]);
  const [again] = await bot.handle(press(post.callback_data));
  assert.match(again.text, /منقضی/, 'a preview posts once');
});

test('the lines after a typed offer are its description', async () => {
  const { bot, calls } = makeBot();
  const [preview] = await bot.handle(message('من تتر را به قیمت ۱۰۲۵۰۰ تومان با حجم ۲۰ میخرم\nفقط تسویه فوری،\nحداقل ۵ تا'));
  assert.match(preview.text, /پیش‌نمایش آگهی/);
  assert.match(preview.text, /حجم <b>۲۰<\/b>/, 'numbers in the description do not change the offer');
  assert.match(preview.text, /💬 <i>فقط تسویه فوری، حداقل ۵ تا<\/i>/);
  await bot.handle(press(buttons(preview)[0].callback_data));
  assert.equal(calls[0][2].description, 'فقط تسویه فوری، حداقل ۵ تا');
});

test('a description added, refused when too long, and removed from the preview', async () => {
  const { bot, calls } = makeBot();
  const [preview] = await bot.handle(message('من تتر را به قیمت ۱۰۲۵۰۰ تومان با حجم ۲۰ میخرم'));
  assert.match(preview.text, /بدون توضیحات/);
  const add = buttons(preview).find((x) => x.callback_data.startsWith('a:pn:'));
  assert.match(add.text, /افزودن توضیحات/);
  const [ask] = await bot.handle(press(add.callback_data));
  assert.match(ask.text, /حداکثر ۱۲۰ حرف/);

  const [long] = await bot.handle(message('ا'.repeat(121)));
  assert.match(long.text, /۱۲۱ حرف است/);
  const [withNote] = await bot.handle(message('فقط شبا'));
  assert.match(withNote.text, /💬 <i>فقط شبا<\/i>/);
  const edit = buttons(withNote).find((x) => x.callback_data.startsWith('a:pn:'));
  assert.match(edit.text, /ویرایش توضیحات/);

  const [editing] = await bot.handle(press(edit.callback_data));
  const remove = buttons(editing).find((x) => x.callback_data.startsWith('a:pr:'));
  const [cleared] = await bot.handle(press(remove.callback_data));
  assert.match(cleared.text, /بدون توضیحات/);
  await bot.handle(press(buttons(cleared)[0].callback_data));
  assert.equal(calls[0][2].description, '');
});

test('a preview can be flipped to the other side, and warns when it crosses', async () => {
  const { bot } = makeBot();
  const [preview] = await bot.handle(message('میخرم ۲ تتر فی ۱۰۱۰۰۰'));
  const flip = buttons(preview).find((x) => x.callback_data.startsWith('a:ps:'));
  const [flipped] = await bot.handle(press(flip.callback_data));
  assert.match(flipped.text, /می‌فروشم/);
  assert.match(flipped.text, /بلافاصله با ۱ آگهی خرید/, 'the other user\'s buy at 101,500 crosses a sell at 101,000; the user\'s own does not count');
});

test('withdrawing an own offer from the board, and the board needs no account to read', async () => {
  const { bot, calls } = makeBot();
  const [board, done] = await bot.handle(press(`a:x:${MINE}`));
  assert.equal(board.method, 'editMessageText');
  assert.match(done.text, /حذف شد/);
  assert.deepEqual(calls, [['cancel', 'u-42', MINE]]);

  const [stranger] = await bot.handle(message('/auction', 77));
  assert.match(stranger.text, /مزایدهٔ تتر/);
  const [take] = await bot.handle(press(`a:t:${SELL}`, 77));
  assert.match(take.text, /ثبت‌نام/);
});

test('whoever posted an offer hears when it is taken', async () => {
  const { bot } = makeBot();
  const notes = await bot.auction.notifications({
    symbol: 'USDT_IRT',
    trades: [{ price: '102700', quantity: '10', taker_side: 'buy', buy_user_id: 'u-42', sell_user_id: 'u-50' }],
  });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].chat_id, 50);
  assert.match(notes[0].text, /آگهی شما معامله شد/);
  assert.match(notes[0].text, /فروختید/);
});
