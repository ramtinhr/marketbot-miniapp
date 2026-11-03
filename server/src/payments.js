// Charging the Toman wallet through a payment gateway.
//
// A charge is a miniapp_payments row, named by its `authority` - an
// unguessable id made here and handed to the gateway. The user pays on the
// gateway's page and is sent back to /api/v1/payments/callback/<authority>;
// the payment is then verified with the gateway server-to-server, and only a
// verified payment credits the wallet - once, keyed by the payment's id,
// however often the callback comes. Nothing the callback carries is trusted:
// it only says which payment to go and ask about.

import crypto from 'node:crypto';

import { httpError } from './errors.js';
import { schemaReady } from './schema.js';
import { withTransaction } from './wallets.js';

export const AUTHORITY_PATTERN = /^MB-[0-9A-F]{16}$/;

const newAuthority = () => `MB-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;

export { createGateway } from './gateways/index.js';
export { FakeGateway } from './gateways/fake.js';

const PAYMENT_COLUMNS = 'id, provider, amount_toman, status, ref_id, card_pan, created_at, paid_at';

/** The callback's query and body, as flat strings - all a gateway may read from it. */
export function callbackParams(...sources) {
  const out = {};
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === 'string' && v.length <= 512 && k.length <= 64) out[k] = v;
      else if (typeof v === 'boolean' || typeof v === 'number') out[k] = String(v);
    }
  }
  return out;
}

export class Payments {
  /**
   * @param {import('pg').Pool} pg
   * @param {import('./wallets.js').Wallets} wallets
   * @param {{ name: string, configured: boolean, request: Function, verify: Function }} gateway
   * @param {{ publicUrl?: string, minToman: number, maxToman: number, log?: object, gatewayFor?: Function }} opts
   */
  constructor(pg, wallets, gateway, { publicUrl = '', minToman, maxToman, log, gatewayFor }) {
    this.pg = pg;
    this.wallets = wallets;
    this.gateway = gateway;
    this.gatewayFor = gatewayFor;
    this.publicUrl = publicUrl;
    this.minToman = minToman;
    this.maxToman = maxToman;
    this.log = log;
  }

  limits() {
    return { min_toman: this.minToman, max_toman: this.maxToman, provider: this.gateway.name };
  }

  /** Starts a charge; resolves with the gateway page the user pays on. */
  async start(user, exchangeUserId, rawAmount) {
    const amount = typeof rawAmount === 'number' ? rawAmount : typeof rawAmount === 'string' && /^\d{1,15}$/.test(rawAmount) ? Number(rawAmount) : NaN;
    if (!Number.isSafeInteger(amount) || amount < this.minToman || amount > this.maxToman) {
      throw httpError(400, 'amount_out_of_range', `the amount must be a whole number of Toman from ${this.minToman} to ${this.maxToman}`, this.limits());
    }
    if (!this.gateway.configured) throw httpError(503, 'gateway_unavailable', 'the payment gateway is not configured');
    if (this.gateway.name !== 'fake' && !this.publicUrl) {
      throw httpError(503, 'gateway_unavailable', 'PUBLIC_URL is not set, so the gateway has nowhere to send the user back to');
    }
    await schemaReady(this.pg);
    const authority = newAuthority();
    const { rows } = await this.pg.query(
      `INSERT INTO miniapp_payments (user_id, exchange_user_id, provider, amount_toman, authority) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [user.id, exchangeUserId, this.gateway.name, amount, authority],
    );
    const id = rows[0].id;
    try {
      const { ref, url } = await this.gateway.request({
        authority,
        amountToman: amount,
        description: `شارژ کیف پول مارکت‌بات - ${amount} تومان`,
        callbackUrl: `${this.publicUrl}/api/v1/payments/callback/${authority}`,
        mobile: user.phone?.replace(/^\+98/, '0'),
      });
      await this.pg.query('UPDATE miniapp_payments SET gateway_ref = $2, updated_at = now() WHERE id = $1', [id, ref]);
      return { payment_id: id, url };
    } catch (err) {
      await this.pg.query("UPDATE miniapp_payments SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [id, err.message]);
      throw err;
    }
  }

  /**
   * The gateway sent the user back. Verifies and credits a successful payment;
   * resolves with the payment as it now stands, or null for an unknown one.
   * Throws when the gateway could not be asked; the payment then stays
   * pending and the next callback asks again.
   */
  async complete(authority, params = {}) {
    if (!AUTHORITY_PATTERN.test(authority)) return null;
    await schemaReady(this.pg);
    return withTransaction(this.pg, async (c) => {
      // Held across the gateway call, so one payment is never verified twice at once.
      const { rows } = await c.query(
        `SELECT id, provider, exchange_user_id, amount_toman, status, gateway_ref, verified_at, ref_id, card_pan
           FROM miniapp_payments WHERE authority = $1 FOR UPDATE`,
        [authority],
      );
      const p = rows[0];
      if (!p) return null;
      if (p.status !== 'pending') return this.#public(c, p.id);
      const gateway = !p.provider || p.provider === this.gateway.name ? this.gateway : this.gatewayFor?.(p.provider);
      if (!gateway) throw httpError(503, 'gateway_unavailable', 'the stored payment provider is unavailable');
      if (!p.gateway_ref) {
        // The gateway never accepted the charge, so there is nothing that could have been paid.
        await c.query("UPDATE miniapp_payments SET status = 'failed', updated_at = now() WHERE id = $1", [p.id]);
        return this.#public(c, p.id);
      }

      // Verified on an earlier callback whose credit failed: credit it now, without asking again.
      let verified = p.verified_at ? { refId: p.ref_id, cardPan: p.card_pan } : null;
      if (!verified) {
        const outcome = await gateway.verify({ authority, ref: p.gateway_ref, amountToman: Number(p.amount_toman), params });
        const raw = outcome.raw ? JSON.stringify(outcome.raw) : null;
        if (outcome.unclear) {
          this.log?.error({ payment: p.id, reason: outcome.reason }, 'payment verification unclear - check it with the gateway');
          await c.query('UPDATE miniapp_payments SET error = $2, gateway_response = $3, updated_at = now() WHERE id = $1', [p.id, outcome.reason, raw]);
          return this.#public(c, p.id);
        }
        if (!outcome.paid) {
          await c.query('UPDATE miniapp_payments SET status = $2, error = $3, gateway_response = $4, updated_at = now() WHERE id = $1', [
            p.id,
            outcome.cancelled ? 'cancelled' : 'failed',
            outcome.reason ?? null,
            raw,
          ]);
          return this.#public(c, p.id);
        }
        verified = { refId: outcome.refId, cardPan: outcome.cardPan ?? null };
        await c.query(
          'UPDATE miniapp_payments SET verified_at = now(), ref_id = $2, card_pan = $3, gateway_response = $4, updated_at = now() WHERE id = $1',
          [p.id, verified.refId, verified.cardPan, raw],
        );
      }

      // A failed credit must not undo the record of the verification above.
      await c.query('SAVEPOINT credit');
      try {
        await this.wallets.move(c, 'credit', p.exchange_user_id, 'IRT', String(p.amount_toman), {
          referenceType: 'deposit',
          referenceId: p.id,
          reason: `wallet charge via ${gateway.name}, ref ${verified.refId}`,
          actor: `gateway:${gateway.name}`,
          idempotencyKey: `miniapp-payment:${p.id}`,
        });
        await c.query(
          "UPDATE miniapp_payments SET status = 'paid', error = NULL, paid_at = now(), updated_at = now() WHERE id = $1",
          [p.id],
        );
      } catch (err) {
        await c.query('ROLLBACK TO SAVEPOINT credit');
        this.log?.error({ payment: p.id, err: { message: err.message } }, 'payment verified but the wallet credit failed - it is retried on the next callback');
        await c.query('UPDATE miniapp_payments SET error = $2, updated_at = now() WHERE id = $1', [p.id, `credit failed: ${err.message}`]);
      }
      return this.#public(c, p.id);
    });
  }

  /** A webhook is a notification to reconcile, never proof that funds arrived. */
  async notifyIntent(intentId) {
    if (typeof intentId !== 'string' || !intentId || intentId.length > 200) {
      throw httpError(400, 'bad_request', 'paymentIntentId is required');
    }
    await schemaReady(this.pg);
    const { rows } = await this.pg.query(
      "SELECT authority FROM miniapp_payments WHERE provider = 'payment_intents' AND gateway_ref = $1",
      [intentId],
    );
    if (!rows.length) throw httpError(404, 'not_found', 'unknown payment intent');
    return this.complete(rows[0].authority);
  }

  async #public(c, id) {
    const { rows } = await c.query(`SELECT ${PAYMENT_COLUMNS}, verified_at, exchange_user_id FROM miniapp_payments WHERE id = $1`, [id]);
    return rows[0];
  }

  async list(userId, limit = 20) {
    await schemaReady(this.pg);
    const { rows } = await this.pg.query(
      `SELECT ${PAYMENT_COLUMNS} FROM miniapp_payments WHERE user_id = $1 AND gateway_ref IS NOT NULL ORDER BY created_at DESC LIMIT $2`,
      [userId, limit],
    );
    return rows;
  }

  async get(userId, id) {
    await schemaReady(this.pg);
    const { rows } = await this.pg.query(`SELECT ${PAYMENT_COLUMNS} FROM miniapp_payments WHERE user_id = $1 AND id = $2`, [userId, id]);
    return rows[0] ?? null;
  }
}
