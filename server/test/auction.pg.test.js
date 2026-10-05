// The auction against a real Postgres. Skipped unless TEST_DB_PORT is set, e.g.:
//   docker run -d --rm --name miniapp-pg -e POSTGRES_USER=marketbot -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:17-alpine
//   TEST_DB_PORT=55432 TEST_DB_PASSWORD=test npm test
// It drops and recreates the exchange schema and the auction tables: never point it at a real database.
// Only the auction's tables are applied here: store.pg.test.js drops and recreates the others at the same time.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { Auction } from '../src/auction.js';
import { createPool } from '../src/db.js';
import { AUCTION_SCHEMA } from '../src/schema.js';
import { Wallets, withTransaction } from '../src/wallets.js';

const port = Number(process.env.TEST_DB_PORT || 0);
const skip = !port && 'TEST_DB_PORT not set';

// The part of marketbot-engine's exchange schema the wallets use.
const EXCHANGE = `
DROP SCHEMA IF EXISTS exchange CASCADE;
CREATE SCHEMA exchange;
CREATE TABLE exchange.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended', 'closed'))
);
CREATE TABLE exchange.wallets (
  id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  user_id uuid NOT NULL REFERENCES exchange.users (id),
  asset text NOT NULL,
  available numeric(36,18) NOT NULL DEFAULT 0 CHECK (available >= 0),
  frozen numeric(36,18) NOT NULL DEFAULT 0 CHECK (frozen >= 0),
  locked numeric(36,18) NOT NULL DEFAULT 0 CHECK (locked >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'closed')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, asset)
);
CREATE TABLE exchange.wallet_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wallet_id uuid NOT NULL REFERENCES exchange.wallets (id),
  user_id uuid NOT NULL REFERENCES exchange.users (id),
  asset text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('opening', 'credit', 'debit', 'freeze', 'unfreeze', 'lock', 'unlock', 'trade')),
  amount numeric(36,18) NOT NULL CHECK (amount >= 0),
  available_delta numeric(36,18) NOT NULL DEFAULT 0,
  frozen_delta numeric(36,18) NOT NULL DEFAULT 0,
  locked_delta numeric(36,18) NOT NULL DEFAULT 0,
  available_after numeric(36,18) NOT NULL,
  frozen_after numeric(36,18) NOT NULL,
  locked_after numeric(36,18) NOT NULL,
  reference_type text,
  reference_id text,
  reason text,
  actor text NOT NULL,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
DROP TABLE IF EXISTS miniapp_auction_orders, miniapp_auction_trades;
`;

let pg;
let wallets;
let auction;
const users = {};
const opts = { actor: 'test' };

async function balance(user, asset) {
  const { rows } = await pg.query('SELECT available::float8, frozen::float8 FROM exchange.wallets WHERE user_id = $1 AND asset = $2', [users[user], asset]);
  return rows[0] ?? { available: 0, frozen: 0 };
}

before(async () => {
  if (!port) return;
  pg = createPool({
    host: process.env.TEST_DB_HOST || '127.0.0.1',
    port,
    user: process.env.TEST_DB_USER || 'marketbot',
    password: process.env.TEST_DB_PASSWORD || 'test',
    database: process.env.TEST_DB_NAME || 'marketbot',
    ssl: false,
  });
  await pg.query(EXCHANGE);
  await pg.query(AUCTION_SCHEMA);
  wallets = new Wallets(pg);
  auction = new Auction({ pg, wallets });
  for (const name of ['seller', 'buyer', 'broke', 'racer1', 'racer2']) {
    const { rows } = await pg.query('INSERT INTO exchange.users (username, display_name) VALUES ($1, $1) RETURNING id', [name]);
    users[name] = rows[0].id;
  }
  const credit = (user, asset, amount) =>
    withTransaction(pg, (c) => wallets.move(c, 'credit', users[user], asset, amount, { referenceType: 'test', actor: 'test' }));
  await credit('seller', 'USDT', '100');
  await credit('seller', 'TRX', '20');
  await credit('buyer', 'IRT', '10000000');
  await credit('racer1', 'IRT', '5000000');
  await credit('racer2', 'IRT', '5000000');
});

after(async () => {
  await pg?.end();
});

test('a resting sell holds the coin; a crossing buy fills at the sell price and gets its limit difference back', { skip }, async () => {
  const sell = await auction.place(users.seller, { symbol: 'USDT_IRT', side: 'sell', price: '100000', quantity: '30' }, opts);
  assert.equal(sell.order.status, 'open');
  assert.deepEqual(await balance('seller', 'USDT'), { available: 70, frozen: 30 });

  const buy = await auction.place(users.buyer, { symbol: 'USDT_IRT', side: 'buy', price: '101000', quantity: '50' }, opts);
  assert.equal(buy.order.status, 'partial');
  assert.equal(buy.order.filled_quantity, '30');
  assert.deepEqual(buy.trades.map((t) => [t.price, t.quantity, t.taker_side]), [['100000', '30', 'buy']]);

  // Held 50 x 101,000; paid 30 x 100,000; 30 x 1,000 back; 20 x 101,000 still held.
  assert.deepEqual(await balance('buyer', 'IRT'), { available: 4_980_000, frozen: 2_020_000 });
  assert.deepEqual(await balance('buyer', 'USDT'), { available: 30, frozen: 0 });
  assert.deepEqual(await balance('seller', 'IRT'), { available: 3_000_000, frozen: 0 });
  assert.deepEqual(await balance('seller', 'USDT'), { available: 70, frozen: 0 });

  const book = await auction.book('USDT_IRT');
  assert.deepEqual(book.bids, [{ price: '101000', quantity: '20', orders: 1 }]);
  assert.deepEqual(book.asks, []);
  assert.equal(book.last_price, '100000');

  const cancelled = await auction.cancel(users.buyer, buy.order.id, opts);
  assert.equal(cancelled.order.status, 'cancelled');
  assert.deepEqual(await balance('buyer', 'IRT'), { available: 7_000_000, frozen: 0 });
  await assert.rejects(auction.cancel(users.buyer, buy.order.id, opts), { code: 'order_closed' });
  assert.deepEqual((await auction.book('USDT_IRT')).bids, []);
});

test('an order the wallet cannot pay for leaves nothing behind', { skip }, async () => {
  await assert.rejects(
    auction.place(users.broke, { symbol: 'USDT_IRT', side: 'buy', price: '100000', quantity: '1' }, opts),
    { code: 'insufficient_balance' },
  );
  const { rows } = await pg.query('SELECT count(*)::int AS n FROM miniapp_auction_orders WHERE exchange_user_id = $1', [users.broke]);
  assert.equal(rows[0].n, 0);
});

test('two buys at once cannot both take the same resting sell', { skip }, async () => {
  await auction.place(users.seller, { symbol: 'USDT_IRT', side: 'sell', price: '100000', quantity: '10' }, opts);
  const [a, b] = await Promise.all([
    auction.place(users.racer1, { symbol: 'USDT_IRT', side: 'buy', price: '100000', quantity: '10' }, opts),
    auction.place(users.racer2, { symbol: 'USDT_IRT', side: 'buy', price: '100000', quantity: '10' }, opts),
  ]);
  assert.deepEqual([a.order.status, b.order.status].sort(), ['filled', 'open']);
  const { rows } = await pg.query("SELECT COALESCE(SUM(quantity), 0)::float8 AS q FROM miniapp_auction_trades WHERE buy_user_id = ANY($1)", [[users.racer1, users.racer2]]);
  assert.equal(rows[0].q, 10);
});

test('taking an offer fills that offer alone, at its price, and leaves nothing on the book', { skip }, async () => {
  const cheap = await auction.place(users.seller, { symbol: 'TRX_IRT', side: 'sell', price: '25000', quantity: '10' }, opts);
  const dear = await auction.place(users.seller, { symbol: 'TRX_IRT', side: 'sell', price: '26000', quantity: '10', description: 'فقط تسویه فوری' }, opts);
  assert.equal(dear.order.description, 'فقط تسویه فوری');

  const offers = await auction.offers('TRX_IRT');
  assert.deepEqual(offers.map((o) => [o.id, o.remaining, o.description]), [[dear.order.id, '10', 'فقط تسویه فوری'], [cheap.order.id, '10', '']], 'newest first, no owner');
  assert.equal('user_id' in offers[0], false);

  const before = await balance('buyer', 'IRT');
  const taken = await auction.take(users.buyer, dear.order.id, { quantity: '4' }, opts);
  assert.equal(taken.order.status, 'filled');
  assert.equal(taken.order.side, 'buy');
  assert.deepEqual(taken.trades.map((t) => [t.price, t.quantity]), [['26000', '4']], 'the chosen offer, not the cheaper one');
  assert.deepEqual(await balance('buyer', 'IRT'), { available: before.available - 104_000, frozen: before.frozen });

  const left = await auction.offers('TRX_IRT');
  assert.deepEqual(left.map((o) => [o.id, o.remaining]), [[dear.order.id, '6'], [cheap.order.id, '10']]);
  assert.equal((await auction.book('TRX_IRT')).bids.length, 0);

  await assert.rejects(auction.take(users.buyer, dear.order.id, { quantity: '7' }, opts), { code: 'offer_short' });
  await assert.rejects(auction.take(users.seller, dear.order.id, { quantity: '1' }, opts), { code: 'own_offer' });
  await auction.cancel(users.seller, cheap.order.id, opts);
  await assert.rejects(auction.take(users.buyer, cheap.order.id, { quantity: '1' }, opts), { code: 'offer_gone' });
});

test('every wallet still equals the sum of its ledger', { skip }, async () => {
  const { rows } = await pg.query(`
    SELECT w.user_id, w.asset, w.available, w.frozen, COALESCE(SUM(e.available_delta), 0) AS a, COALESCE(SUM(e.frozen_delta), 0) AS f
      FROM exchange.wallets w LEFT JOIN exchange.wallet_entries e ON e.wallet_id = w.id
     GROUP BY w.user_id, w.asset, w.available, w.frozen
    HAVING w.available <> COALESCE(SUM(e.available_delta), 0) OR w.frozen <> COALESCE(SUM(e.frozen_delta), 0)`);
  assert.deepEqual(rows, []);
});
