// The rial board against a real Postgres. Skipped unless TEST_DB_PORT is set.
// It drops and recreates the exchange schema and the rial tables: never point
// it at a real database.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createPool } from '../src/db.js';
import { Rial } from '../src/rial.js';
import { RIAL_SCHEMA } from '../src/schema.js';
import { Wallets, withTransaction } from '../src/wallets.js';

const port = Number(process.env.TEST_DB_PORT || 0);
const skip = !port && 'TEST_DB_PORT not set';

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
DROP TABLE IF EXISTS miniapp_rial_offers, miniapp_rial_trades;
`;

let pg;
let wallets;
let rial;
const users = {};
const opts = { actor: 'test' };
const SHEBA = 'IR820540102680020817909002';

async function balance(user, asset = 'IRT') {
  const { rows } = await pg.query(
    'SELECT available::float8, frozen::float8 FROM exchange.wallets WHERE user_id = $1 AND asset = $2',
    [users[user], asset],
  );
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
  await pg.query(RIAL_SCHEMA);
  wallets = new Wallets(pg);
  rial = new Rial({ pg, wallets });
  for (const name of ['haver', 'wanter', 'broke']) {
    const { rows } = await pg.query('INSERT INTO exchange.users (username, display_name) VALUES ($1, $1) RETURNING id', [name]);
    users[name] = rows[0].id;
  }
  const credit = (user, amount) =>
    withTransaction(pg, (c) => wallets.move(c, 'credit', users[user], 'IRT', amount, { referenceType: 'test', actor: 'test' }));
  await credit('haver', '10000000');
  await credit('wanter', '100000');
});

after(async () => {
  await pg?.end();
});

test('a wallet "have" freezes IRT; taking it settles to the wanter', { skip }, async () => {
  const placed = await rial.place(users.haver, { side: 'have', method: 'wallet', amount: '500000' }, opts);
  assert.equal(placed.order.status, 'open');
  assert.deepEqual(await balance('haver'), { available: 9_500_000, frozen: 500_000 });

  const offers = await rial.offers();
  assert.ok(offers.some((o) => o.id === placed.order.id && o.remaining === '500000'));

  const taken = await rial.take(users.wanter, placed.order.id, { amount: '200000' }, opts);
  assert.equal(taken.order.status, 'filled');
  assert.equal(taken.order.side, 'want');
  assert.equal(taken.trades[0].status, 'settled');
  assert.deepEqual(await balance('haver'), { available: 9_500_000, frozen: 300_000 });
  assert.deepEqual(await balance('wanter'), { available: 300_000, frozen: 0 });

  const left = (await rial.offers()).find((o) => o.id === placed.order.id);
  assert.equal(left.remaining, '300000');

  await assert.rejects(rial.take(users.haver, placed.order.id, { amount: '1' }, opts), { code: 'own_offer' });
  await assert.rejects(rial.take(users.wanter, placed.order.id, { amount: '400000' }, opts), { code: 'offer_short' });

  const cancelled = await rial.cancel(users.haver, placed.order.id, opts);
  assert.equal(cancelled.order.status, 'cancelled');
  assert.deepEqual(await balance('haver'), { available: 9_800_000, frozen: 0 });
});

test('taking a wallet "want" freezes the taker and pays the poster', { skip }, async () => {
  const want = await rial.place(users.wanter, { side: 'want', method: 'wallet', amount: '150000' }, opts);
  assert.deepEqual(await balance('wanter'), { available: 300_000, frozen: 0 }, 'a want does not freeze');

  const taken = await rial.take(users.haver, want.order.id, { amount: '150000' }, opts);
  assert.equal(taken.order.side, 'have');
  assert.equal(taken.trades[0].status, 'settled');
  assert.deepEqual(await balance('haver'), { available: 9_650_000, frozen: 0 });
  assert.deepEqual(await balance('wanter'), { available: 450_000, frozen: 0 });
  assert.equal((await rial.offers()).some((o) => o.id === want.order.id), false);
});

test('a bank match records a trade without moving wallets', { skip }, async () => {
  const beforeH = await balance('haver');
  const beforeW = await balance('wanter');
  const want = await rial.place(
    users.wanter,
    { side: 'want', method: 'paya', amount: '250000', destination: SHEBA },
    opts,
  );
  const taken = await rial.take(users.haver, want.order.id, { amount: '100000' }, opts);
  assert.equal(taken.trades[0].status, 'matched');
  assert.equal(taken.trades[0].method, 'paya');
  assert.equal(taken.trades[0].destination, SHEBA);
  assert.deepEqual(await balance('haver'), beforeH);
  assert.deepEqual(await balance('wanter'), beforeW);

  const have = await rial.place(users.haver, { side: 'have', method: 'satna', amount: '80000' }, opts);
  await assert.rejects(rial.take(users.wanter, have.order.id, { amount: '80000' }, opts), { code: 'invalid_sheba' });
  const got = await rial.take(users.wanter, have.order.id, { amount: '80000', destination: SHEBA }, opts);
  assert.equal(got.trades[0].status, 'matched');
  assert.equal(got.trades[0].destination, SHEBA);
  assert.deepEqual(await balance('haver'), beforeH);
});

test('a wallet have the balance cannot cover leaves nothing behind', { skip }, async () => {
  await assert.rejects(
    rial.place(users.broke, { side: 'have', method: 'wallet', amount: '1' }, opts),
    { code: 'insufficient_balance' },
  );
  const { rows } = await pg.query('SELECT count(*)::int AS n FROM miniapp_rial_offers WHERE exchange_user_id = $1', [users.broke]);
  assert.equal(rows[0].n, 0);
});
