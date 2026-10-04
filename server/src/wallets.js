// The user's wallets, which are the exchange's: exchange.wallets and its
// ledger exchange.wallet_entries (owned by marketbot-engine; marketbot-api
// moves the same rows for operators). A wallet's money is in three places:
//   available - free to trade or withdraw
//   frozen    - held, e.g. for a pending withdrawal
//   locked    - held by open orders; only the engine moves it
//
// Every movement is one conditional UPDATE (a balance never goes negative) and
// one ledger row in the same transaction, as marketbot-api makes them, so a
// wallet always equals the sum of its entries.

import { exchangeDbError, httpError } from './errors.js';

// `kind` is what the ledger calls the movement, when it differs from its name here.
const MOVES = {
  credit: { set: 'available = available + $3', where: "status <> 'closed'", deltas: { available: 1 } },
  freeze: { set: 'available = available - $3, frozen = frozen + $3', where: "status = 'active' AND available >= $3", deltas: { available: -1, frozen: 1 } },
  unfreeze: { set: 'frozen = frozen - $3, available = available + $3', where: "status <> 'closed' AND frozen >= $3", deltas: { available: 1, frozen: -1 } },
  // An auction fill: the payer's side leaves frozen, the receiver's arrives in available.
  settle: { kind: 'trade', set: 'frozen = frozen - $3', where: "status <> 'closed' AND frozen >= $3", deltas: { frozen: -1 } },
  receive: { kind: 'trade', set: 'available = available + $3', where: "status <> 'closed'", deltas: { available: 1 }, creates: true },
};

const BALANCE_COLUMNS = 'asset, status, available, frozen, locked, updated_at';
const ENTRY_COLUMNS = `id, asset, kind, amount, available_delta, frozen_delta, locked_delta, available_after,
  reference_type, reference_id, reason, created_at`;

export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export class Wallets {
  /** @param {import('pg').Pool} pg */
  constructor(pg) {
    this.pg = pg;
  }

  async #run(fn) {
    try {
      return await fn();
    } catch (err) {
      throw exchangeDbError(err);
    }
  }

  /** Every wallet the user has, by asset. Amounts are decimal strings. */
  balances(exchangeUserId) {
    return this.#run(async () => {
      const { rows } = await this.pg.query(
        `SELECT ${BALANCE_COLUMNS} FROM exchange.wallets WHERE user_id = $1 ORDER BY asset`,
        [exchangeUserId],
      );
      return rows;
    });
  }

  /** The ledger, newest first; `before` is an entry id, for the next page. */
  entries(exchangeUserId, { asset = null, before = null, limit = 30 } = {}) {
    return this.#run(async () => {
      const params = [exchangeUserId];
      let where = 'user_id = $1';
      if (asset) where += ` AND asset = $${params.push(asset)}`;
      if (before) where += ` AND id < $${params.push(before)}`;
      const { rows } = await this.pg.query(
        `SELECT ${ENTRY_COLUMNS} FROM exchange.wallet_entries WHERE ${where} ORDER BY id DESC LIMIT $${params.push(limit + 1)}`,
        params,
      );
      const more = rows.length > limit;
      const page = more ? rows.slice(0, limit) : rows;
      return { entries: page, next_before: more ? Number(page.at(-1).id) : null };
    });
  }

  /**
   * One movement, inside the caller's transaction `c`. With an idempotency
   * key, a repeat answers with the entry the first one made and moves nothing.
   */
  async move(c, kind, exchangeUserId, asset, amount, { referenceType, referenceId, reason, actor, idempotencyKey = null }) {
    const move = MOVES[kind];
    if (!move) throw new Error(`unknown wallet movement ${kind}`);
    return this.#run(async () => {
      if (idempotencyKey) {
        const prior = await c.query('SELECT id FROM exchange.wallet_entries WHERE idempotency_key = $1', [idempotencyKey]);
        if (prior.rows.length) return { entryId: Number(prior.rows[0].id), replayed: true };
      }
      const user = await c.query('SELECT status FROM exchange.users WHERE id = $1 FOR SHARE', [exchangeUserId]);
      if (!user.rows.length) throw httpError(409, 'unknown_user', 'no such exchange user');
      if (user.rows[0].status === 'closed') throw httpError(409, 'user_inactive', 'the exchange account is closed');
      if (kind === 'credit' || move.creates) {
        await c.query('INSERT INTO exchange.wallets (user_id, asset) VALUES ($1, $2) ON CONFLICT (user_id, asset) DO NOTHING', [
          exchangeUserId,
          asset,
        ]);
      }
      const moved = await c.query(
        `UPDATE exchange.wallets SET ${move.set}, updated_at = now()
          WHERE user_id = $1 AND asset = $2 AND ${move.where}
          RETURNING id, available, frozen, locked`,
        [exchangeUserId, asset, amount],
      );
      if (!moved.rows.length) {
        const w = await c.query('SELECT status FROM exchange.wallets WHERE user_id = $1 AND asset = $2', [exchangeUserId, asset]);
        if (w.rows.length && w.rows[0].status !== 'active') throw httpError(409, 'wallet_inactive', `the ${asset} wallet is ${w.rows[0].status}`);
        throw httpError(409, 'insufficient_balance', `insufficient ${asset} for this`);
      }
      const w = moved.rows[0];
      const delta = (sign) => (sign ? (sign > 0 ? amount : `-${amount}`) : '0');
      const { rows } = await c.query(
        `INSERT INTO exchange.wallet_entries
           (wallet_id, user_id, asset, kind, amount, available_delta, frozen_delta, locked_delta,
            available_after, frozen_after, locked_after, reference_type, reference_id, reason, actor, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING id`,
        [
          w.id, exchangeUserId, asset, move.kind ?? kind, amount, delta(move.deltas.available), delta(move.deltas.frozen),
          w.available, w.frozen, w.locked, referenceType, referenceId, reason, actor, idempotencyKey,
        ],
      );
      return { entryId: Number(rows[0].id), replayed: false };
    });
  }
}
