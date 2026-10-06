import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseOffer } from '../src/bot-auction.js';
import { Bot } from '../src/bot.js';

const SELL = '11111111-1111-4111-8111-111111111111';
const BUY = '22222222-2222-4222-8222-222222222222';
const MINE = '33333333-3333-4333-8333-333333333333';
const MINE_BTC = '44444444-4444-4444-8444-444444444444';

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
  // User 42's open orders on every pair, newest first: the USDT buy on the board and a part-filled BTC sell.
  let own = [
    { id: MINE, symbol: 'USDT_IRT', side: 'buy', price: '101000', quantity: '10', filled_quantity: '0', status: 'open', description: '', created_at: new Date().toISOString() },
    { id: MINE_BTC, symbol: 'BTC_IRT', side: 'sell', price: '7000000000', quantity: '0.02', filled_quantity: '0.005', status: 'partial', description: 'فقط شبا', created_at: '2026-10-01T08:00:00Z' },
  ];
  const auction = {
    offers: async () => offers,
    orders: async (id) => (id === 'u-42' ? own : []),
    cancelAll: async (user, filter, opts) => {
      calls.push(['cancelAll', user, filter, opts.actor]);
      const orders = own.map((o) => ({ ...o, status: 'cancelled' }));
      own = [];
      return { orders };
    },
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

test('posting step by step: side, a suggested price, a typed volume, no description, review, post', async () => {
  const { bot, calls } = makeBot();
  const [side] = await bot.handle(press('a:post:USDT_IRT'));
  assert.equal(side.method, 'sendMessage');
  assert.match(side.text, /مرحلهٔ ۱ از ۴/);
  assert.match(side.text, /بخرید یا بفروشید/);
  const id = buttons(side)[0].callback_data.split(':')[2];
  assert.deepEqual(buttons(side).map((b) => b.callback_data), [
    `a:w:${id}:side:buy`, `a:w:${id}:side:sell`, `a:w:${id}:mk`, `a:w:${id}:x`,
  ]);

  const [price] = await bot.handle(press(`a:w:${id}:side:buy`));
  assert.equal(price.method, 'editMessageText', 'the steps go on in the same message');
  assert.match(price.text, /مرحلهٔ ۲ از ۴/);
  assert.match(price.text, /بهترین خریدار: ۱۰۱٬۵۰۰/, 'the user\'s own buy at 101,000 is not the best buyer');
  // Just above the best other buyer, level with it, the exchange's price, and the best seller to trade at once.
  assert.deepEqual(buttons(price).filter((b) => b.callback_data.includes(':p:')).map((b) => b.callback_data.split(':')[4]),
    ['101510', '101500', '102000', '102700']);
  assert.match(buttons(price).at(-2).text, /قبلی/);

  const [qty] = await bot.handle(press(`a:w:${id}:p:101500`));
  assert.match(qty.text, /مرحلهٔ ۳ از ۴/);
  assert.match(qty.text, /قیمت <b>۱۰۱٬۵۰۰<\/b>/, 'the offer fills in as it goes');
  // 10,000,000 Toman buys 98.52 USDT at 101,500.
  assert.deepEqual(buttons(qty).filter((b) => b.callback_data.includes(':q:')).map((b) => b.callback_data.split(':')[4]),
    ['24.63', '49.26', '73.89', '98.52']);

  const typed = await bot.handle(message('۲۰'));
  assert.equal(typed[0].method, 'sendMessage');
  assert.match(typed[0].text, /مرحلهٔ ۴ از ۴/);
  assert.deepEqual(typed[1], { method: 'editMessageReplyMarkup', chat_id: 42, message_id: 9, reply_markup: { inline_keyboard: [] } },
    'the step answered by typing loses its buttons');

  const [review] = await bot.handle(press(`a:w:${id}:n:skip`));
  assert.match(review.text, /مرور و ارسال/);
  assert.match(review.text, /۲٬۰۳۰٬۰۰۰ تومان/);
  const post = buttons(review)[0];
  assert.equal(post.callback_data, `a:w:${id}:ok`);
  assert.equal(post.style, 'success');
  assert.ok([side, price, qty, review].every((m) => buttons(m).every((b) => !b.callback_data || Buffer.byteLength(b.callback_data) <= 64)));

  await bot.handle(press(post.callback_data));
  assert.deepEqual(calls, [['place', 'u-42', { symbol: 'USDT_IRT', side: 'buy', price: '101500', quantity: '20', description: '' }, 'bot:42']]);
});

test('typed answers: prices with هزار, a volume as a Toman sum, and what is wrong said on the same step', async () => {
  const { bot } = makeBot();
  const [side] = await bot.handle(press('a:post:USDT_IRT'));
  const id = buttons(side)[0].callback_data.split(':')[2];
  await bot.handle(press(`a:w:${id}:side:sell`));
  const [bad] = await bot.handle(message('ارزان'));
  assert.match(bad.text, /⚠️ قیمت را فقط به عدد بنویسید/);
  assert.match(bad.text, /مرحلهٔ ۲ از ۴/);
  const [qty] = await bot.handle(message('۱۰۲ هزار'));
  assert.match(qty.text, /قیمت <b>۱۰۲٬۰۰۰<\/b>/);
  assert.match(qty.text, /موجودی شما: ۵ تتر/);
  const [note] = await bot.handle(message('۲۰۴ هزار تومان'));
  assert.match(note.text, /حجم <b>۲<\/b>/, '204,000 Toman at 102,000 is 2 USDT');
  const [long] = await bot.handle(message('ا'.repeat(121)));
  assert.match(long.text, /۱۲۱ حرف است/);
  const [review] = await bot.handle(message('حداقل ۱ تا'));
  assert.match(review.text, /مرور و ارسال/);
  assert.match(review.text, /💬 <i>حداقل ۱ تا<\/i>/);
});

test('from the review a part is changed and the review comes back', async () => {
  const { bot } = makeBot();
  const [review] = await bot.handle(message('من تتر را به قیمت ۱۰۲۵۰۰ تومان با حجم ۲۰ میخرم'));
  const edit = buttons(review).find((b) => b.callback_data.endsWith(':e:qty'));
  const [qty] = await bot.handle(press(edit.callback_data));
  assert.match(qty.text, /چه مقدار/);
  assert.ok(buttons(qty).some((b) => b.text === '‹ قبلی' && b.callback_data.endsWith(':go:review')));
  const [back] = await bot.handle(message('۳'));
  assert.match(back.text, /مرور و ارسال/, 'straight back to the review, not on to the description');
  assert.match(back.text, /حجم <b>۳<\/b>/);
});

test('a bare "I buy" starts the steps from the price', async () => {
  const { bot } = makeBot();
  const [card] = await bot.handle(message('تتر میخرم'));
  assert.match(card.text, /کامل متوجه نشدم/);
  assert.match(card.text, /به چه قیمتی می‌خرید/);
});

test('a typed offer goes straight to the review, and is posted on confirm', async () => {
  const { bot, calls } = makeBot();
  const [preview] = await bot.handle(message('من تتر را به قیمت ۱۰۲۵۰۰ تومان با حجم ۲۰ میخرم'));
  assert.match(preview.text, /مرور و ارسال/);
  assert.match(preview.text, /۲٬۰۵۰٬۰۰۰ تومان/);
  assert.doesNotMatch(preview.text, /بلافاصله/, 'the only sell, at 102,700, is above this buy');
  const post = buttons(preview)[0];
  assert.match(post.callback_data, /^a:w:.+:ok$/);
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
  assert.match(preview.text, /مرور و ارسال/);
  assert.match(preview.text, /حجم <b>۲۰<\/b>/, 'numbers in the description do not change the offer');
  assert.match(preview.text, /💬 <i>فقط تسویه فوری، حداقل ۵ تا<\/i>/);
  await bot.handle(press(buttons(preview)[0].callback_data));
  assert.equal(calls[0][2].description, 'فقط تسویه فوری، حداقل ۵ تا');
});

test('a description added from the review, then removed', async () => {
  const { bot, calls } = makeBot();
  const [preview] = await bot.handle(message('من تتر را به قیمت ۱۰۲۵۰۰ تومان با حجم ۲۰ میخرم'));
  assert.match(preview.text, /بدون توضیحات/);
  const add = buttons(preview).find((x) => x.callback_data.endsWith(':e:note'));
  assert.equal(add.text, '+ توضیحات');
  const [ask] = await bot.handle(press(add.callback_data));
  assert.match(ask.text, /تا ۱۲۰ حرف/);

  const [withNote] = await bot.handle(message('فقط شبا'));
  assert.match(withNote.text, /مرور و ارسال/);
  assert.match(withNote.text, /💬 <i>فقط شبا<\/i>/);
  const edit = buttons(withNote).find((x) => x.callback_data.endsWith(':e:note'));
  assert.equal(edit.text, '✎ توضیحات');

  const [editing] = await bot.handle(press(edit.callback_data));
  const remove = buttons(editing).find((x) => x.callback_data.endsWith(':n:clear'));
  const [cleared] = await bot.handle(press(remove.callback_data));
  assert.match(cleared.text, /بدون توضیحات/);
  await bot.handle(press(buttons(cleared)[0].callback_data));
  assert.equal(calls[0][2].description, '');
});

test('a review can be flipped to the other side, and warns when it crosses', async () => {
  const { bot } = makeBot();
  const [preview] = await bot.handle(message('میخرم ۲ تتر فی ۱۰۱۰۰۰'));
  const flip = buttons(preview).find((x) => x.callback_data.endsWith(':flip'));
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

test('my offers: every pair, newest first, what they hold, a button to withdraw each', async () => {
  const { bot, calls } = makeBot();
  const [board] = await bot.handle(message('/auction'));
  const link = buttons(board).find((b) => b.callback_data === 'a:m:0');
  assert.match(link.text, /آگهی‌های من \(۲\)/, 'the board counts the user\'s offers on every pair');

  const [card] = await bot.handle(message('/myoffers'));
  assert.match(card.text, /۲ آگهی باز · مسدود: ۱٬۰۱۰٬۰۰۰ تومان و ۰٫۰۱۵ بیت‌کوین/);
  assert.match(card.text, /۱\. 🟢 خرید تتر/);
  assert.match(card.text, /۲\. 🔴 فروش بیت‌کوین · \S+ مهر/, 'an older offer shows its day');
  assert.match(card.text, /۲۵٪ انجام شده/);
  assert.match(card.text, /حجم <b>۰٫۰۱۵<\/b>/, 'what is left of it, not what was posted');
  assert.match(card.text, /💬 <i>فقط شبا<\/i>/);
  const b = buttons(card);
  assert.deepEqual(b.filter((x) => x.callback_data?.startsWith('a:mx:')).map((x) => x.callback_data), [`a:mx:${MINE}:0`, `a:mx:${MINE_BTC}:0`]);
  assert.ok(b.some((x) => x.callback_data === 'a:ma'));
  assert.equal(b.find((x) => x.web_app).web_app.url, 'https://app.example/?screen=myoffers');
  assert.ok(b.every((x) => !x.callback_data || Buffer.byteLength(x.callback_data) <= 64));

  const [after, done] = await bot.handle(press(`a:mx:${MINE_BTC}:0`));
  assert.equal(after.method, 'editMessageText');
  assert.match(done.text, /حذف شد/);
  assert.deepEqual(calls, [['cancel', 'u-42', MINE_BTC]]);
});

test('withdrawing all my offers asks first, says what it releases, then withdraws them all', async () => {
  const { bot, calls } = makeBot();
  const [ask] = await bot.handle(press('a:ma'));
  assert.match(ask.text, /همهٔ آگهی‌های شما حذف شود؟/);
  assert.match(ask.text, /• ۱٬۰۱۰٬۰۰۰ تومان\n• ۰٫۰۱۵ بیت‌کوین/);
  assert.equal(calls.length, 0, 'nothing is withdrawn before the confirmation');
  const yes = buttons(ask)[0];
  assert.equal(yes.callback_data, 'a:mac');
  assert.equal(yes.style, 'danger');
  assert.equal(buttons(ask)[1].callback_data, 'a:m:0', 'cancel goes back to the list');

  const [result] = await bot.handle(press('a:mac'));
  assert.match(result.text, /۲ آگهی حذف شد/);
  assert.match(result.text, /آزاد شد: ۱٬۰۱۰٬۰۰۰ تومان و ۰٫۰۱۵ بیت‌کوین/);
  assert.deepEqual(calls, [['cancelAll', 'u-42', {}, 'bot:42']]);

  const [empty] = await bot.handle(press('a:m:0'));
  assert.match(empty.text, /آگهی بازی در مزایده ندارید/);
  const [board] = await bot.handle(message('/auction'));
  assert.ok(!buttons(board).some((x) => x.callback_data === 'a:m:0'), 'no link to an empty list');
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
