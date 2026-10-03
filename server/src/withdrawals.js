// Withdrawal requests. Requesting freezes the amount in the wallet, so it can
// neither be traded nor withdrawn twice; an operator then pays it out (a debit
// from frozen) or rejects it (an unfreeze). The user may cancel while it is
// still pending. Every request is confirmed with a fresh SMS code (routes).

import { httpError } from './errors.js';
import { schemaReady } from './schema.js';
import { withTransaction } from './wallets.js';

/** The networks each coin can be withdrawn on. Toman goes to a bank account (Sheba). */
export const NETWORKS = {
  USDT: ['TRC20', 'ERC20', 'BEP20'],
  USDC: ['ERC20', 'BEP20'],
  BTC: ['BTC'],
  ETH: ['ERC20'],
  BNB: ['BEP20'],
  TRX: ['TRC20'],
  SOL: ['SOL'],
  XRP: ['XRP'],
  DOGE: ['DOGE'],
  ADA: ['ADA'],
  SHIB: ['ERC20'],
};

const AMOUNT_RE = /^\d{1,15}(\.\d{1,8})?$/;
const ADDRESS_RE = /^[A-Za-z0-9:_-]{20,128}$/;

/** An Iranian IBAN (Sheba): IR and 24 digits, with ISO 13616's mod-97 check. */
export function normalizeSheba(raw) {
  const s = String(raw ?? '')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\s-]/g, '')
    .toUpperCase();
  const iban = /^\d{24}$/.test(s) ? `IR${s}` : s;
  if (!/^IR\d{24}$/.test(iban)) return null;
  // I=18, R=27, moved after the account number.
  const digits = `${iban.slice(4)}1827${iban.slice(2, 4)}`;
  return BigInt(digits) % 97n === 1n ? iban : null;
}

const COLUMNS = 'id, asset, amount, network, destination, status, note, created_at, updated_at';

export class Withdrawals {
  /**
   * @param {import('pg').Pool} pg
   * @param {import('./wallets.js').Wallets} wallets
   */
  constructor(pg, wallets) {
    this.pg = pg;
    this.wallets = wallets;
  }

  /** Checks a request body; returns what to store, or throws 400. */
  normalize(body) {
    const asset = String(body?.asset ?? '').toUpperCase();
    const amount = String(body?.amount ?? '').trim();
    if (!AMOUNT_RE.test(amount) || !(Number(amount) > 0)) throw httpError(400, 'invalid_amount', 'amount must be a positive number with at most 8 decimals');
    if (asset === 'IRT') {
      if (!/^\d+$/.test(amount)) throw httpError(400, 'invalid_amount', 'Toman amounts are whole numbers');
      const sheba = normalizeSheba(body?.destination);
      if (!sheba) throw httpError(400, 'invalid_sheba', 'not a valid Sheba number (IR and 24 digits)');
      return { asset, amount, network: null, destination: sheba };
    }
    const networks = NETWORKS[asset];
    if (!networks) throw httpError(400, 'unsupported_asset', `${asset} cannot be withdrawn`);
    const network = String(body?.network ?? '').toUpperCase();
    if (!networks.includes(network)) throw httpError(400, 'invalid_network', `${asset} is withdrawn on ${networks.join(', ')}`);
    const destination = String(body?.destination ?? '').trim();
    if (!ADDRESS_RE.test(destination)) throw httpError(400, 'invalid_address', 'not a valid wallet address');
    return { asset, amount, network, destination };
  }

  /** `confirm(client)` runs first in the same transaction (spending the SMS code). */
  async request(user, exchangeUserId, w, confirm = async () => {}) {
    await schemaReady(this.pg);
    return withTransaction(this.pg, async (c) => {
      await confirm(c);
      const { rows } = await c.query(
        `INSERT INTO miniapp_withdrawals (user_id, exchange_user_id, asset, amount, network, destination)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
        [user.id, exchangeUserId, w.asset, w.amount, w.network, w.destination],
      );
      const row = rows[0];
      await this.wallets.move(c, 'freeze', exchangeUserId, w.asset, w.amount, {
        referenceType: 'withdrawal',
        referenceId: row.id,
        reason: `withdrawal to ${w.network ? `${w.network} ` : ''}${w.destination}`,
        actor: `miniapp:${user.id}`,
        idempotencyKey: `miniapp-withdrawal:${row.id}:freeze`,
      });
      return row;
    });
  }

  async list(userId, limit = 30) {
    await schemaReady(this.pg);
    const { rows } = await this.pg.query(
      `SELECT ${COLUMNS} FROM miniapp_withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit],
    );
    return rows;
  }

  async cancel(user, id) {
    await schemaReady(this.pg);
    return withTransaction(this.pg, async (c) => {
      const { rows } = await c.query(
        `SELECT id, exchange_user_id, asset, amount, status FROM miniapp_withdrawals WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [id, user.id],
      );
      const w = rows[0];
      if (!w) throw httpError(404, 'not_found', 'no such withdrawal');
      if (w.status !== 'pending') throw httpError(409, 'withdrawal_not_pending', `the withdrawal is already ${w.status}`);
      await this.wallets.move(c, 'unfreeze', w.exchange_user_id, w.asset, w.amount, {
        referenceType: 'withdrawal',
        referenceId: w.id,
        reason: 'withdrawal cancelled by the user',
        actor: `miniapp:${user.id}`,
        idempotencyKey: `miniapp-withdrawal:${w.id}:cancel`,
      });
      const updated = await c.query(
        `UPDATE miniapp_withdrawals SET status = 'cancelled', updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
        [w.id],
      );
      return updated.rows[0];
    });
  }
}
