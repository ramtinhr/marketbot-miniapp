// Charging the Toman wallet through a payment gateway.
//
// A charge is a miniapp_payments row. The user pays on the gateway's page and
// is sent back to /api/v1/payments/callback; the payment is then verified with
// the gateway server-to-server, and only a verified payment credits the
// wallet - once, keyed by the payment's id, however often the callback comes.

import crypto from 'node:crypto';

import { httpError } from './errors.js';
import { schemaReady } from './schema.js';
import { withTransaction } from './wallets.js';

/**
 * Zarinpal, API v4. Amounts are sent in Rial, the gateway's default unit, so
 * the request and the verification can never disagree about the currency.
 */
export class Zarinpal {
  constructor({ merchantId, sandbox = false, fetchImpl = fetch }) {
    this.name = 'zarinpal';
    this.merchantId = merchantId;
    this.base = sandbox ? 'https://sandbox.zarinpal.com' : 'https://payment.zarinpal.com';
    this.fetch = fetchImpl;
  }

  get configured() {
    return Boolean(this.merchantId);
  }

  async #post(path, body) {
    let res;
    try {
      res = await this.fetch(`${this.base}/pg/v4/payment/${path}.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ merchant_id: this.merchantId, ...body }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw httpError(502, 'gateway_unavailable', `zarinpal unreachable: ${err.message}`);
    }
    return res.json().catch(() => ({}));
  }

  async request({ amountToman, description, callbackUrl, mobile }) {
    const body = await this.#post('request', {
      amount: amountToman * 10,
      description,
      callback_url: callbackUrl,
      metadata: { mobile },
    });
    if (body?.data?.code !== 100 || !body.data.authority) {
      throw httpError(502, 'gateway_failed', `zarinpal refused the payment: ${JSON.stringify(body?.errors ?? body)}`);
    }
    return { authority: body.data.authority, url: `${this.base}/pg/StartPay/${body.data.authority}` };
  }

  async verify({ authority, amountToman }) {
    const body = await this.#post('verify', { amount: amountToman * 10, authority });
    const code = body?.data?.code;
    if (code === 100 || code === 101) return { refId: String(body.data.ref_id), cardPan: body.data.card_pan ?? null };
    return null;
  }
}

/** A stand-in gateway served by this app itself (see the routes), for demos. Never in production. */
export class FakeGateway {
  constructor() {
    this.name = 'fake';
  }

  get configured() {
    return true;
  }

  async request() {
    const authority = `FAKE${crypto.randomBytes(12).toString('hex')}`;
    // Relative: the app opens it against its own origin.
    return { authority, url: `/api/v1/payments/fake/${authority}` };
  }

  async verify({ authority }) {
    return { refId: authority.slice(4, 14), cardPan: '6037-99**-****-1234' };
  }
}

export function createGateway({ provider, zarinpalMerchantId, zarinpalSandbox }, { production }) {
  if (provider === 'fake') {
    if (production) throw new Error('PAYMENT_PROVIDER=fake is not allowed with NODE_ENV=production');
    return new FakeGateway();
  }
  if (provider === 'zarinpal') return new Zarinpal({ merchantId: zarinpalMerchantId, sandbox: zarinpalSandbox });
  throw new Error(`unknown PAYMENT_PROVIDER "${provider}" - use zarinpal or fake`);
}

const PAYMENT_COLUMNS = 'id, provider, amount_toman, status, ref_id, card_pan, created_at, paid_at';

export class Payments {
  /**
   * @param {import('pg').Pool} pg
   * @param {import('./wallets.js').Wallets} wallets
   * @param {{ name: string, configured: boolean, request: Function, verify: Function }} gateway
   * @param {{ publicUrl?: string, minToman: number, maxToman: number }} opts
   */
  constructor(pg, wallets, gateway, { publicUrl = '', minToman, maxToman }) {
    this.pg = pg;
    this.wallets = wallets;
    this.gateway = gateway;
    this.publicUrl = publicUrl;
    this.minToman = minToman;
    this.maxToman = maxToman;
  }

  limits() {
    return { min_toman: this.minToman, max_toman: this.maxToman, provider: this.gateway.name };
  }

  /** Starts a charge; resolves with the gateway page the user pays on. */
  async start(user, exchangeUserId, rawAmount) {
    const amount = Number(rawAmount);
    if (!Number.isSafeInteger(amount) || amount < this.minToman || amount > this.maxToman) {
      throw httpError(400, 'amount_out_of_range', `the amount must be a whole number of Toman from ${this.minToman} to ${this.maxToman}`, this.limits());
    }
    if (!this.gateway.configured) throw httpError(503, 'gateway_unavailable', 'the payment gateway is not configured');
    if (this.gateway.name !== 'fake' && !this.publicUrl) {
      throw httpError(503, 'gateway_unavailable', 'PUBLIC_URL is not set, so the gateway has nowhere to send the user back to');
    }
    await schemaReady(this.pg);
    const { rows } = await this.pg.query(
      `INSERT INTO miniapp_payments (user_id, exchange_user_id, provider, amount_toman) VALUES ($1, $2, $3, $4) RETURNING id`,
      [user.id, exchangeUserId, this.gateway.name, amount],
    );
    const id = rows[0].id;
    try {
      const { authority, url } = await this.gateway.request({
        amountToman: amount,
        description: `شارژ کیف پول مارکت‌بات - ${amount} تومان`,
        callbackUrl: `${this.publicUrl}/api/v1/payments/callback`,
        mobile: user.phone.replace(/^\+98/, '0'),
      });
      await this.pg.query('UPDATE miniapp_payments SET authority = $2, updated_at = now() WHERE id = $1', [id, authority]);
      return { payment_id: id, url };
    } catch (err) {
      await this.pg.query("UPDATE miniapp_payments SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [id, err.message]);
      throw err;
    }
  }

  /**
   * The gateway sent the user back. Verifies and credits a successful payment;
   * resolves with the payment as it now stands, or null for an unknown one.
   */
  async complete(authority, gatewayStatus) {
    if (!authority) return null;
    await schemaReady(this.pg);
    return withTransaction(this.pg, async (c) => {
      const { rows } = await c.query(
        `SELECT id, user_id, exchange_user_id, amount_toman, status FROM miniapp_payments WHERE authority = $1 FOR UPDATE`,
        [authority],
      );
      const p = rows[0];
      if (!p) return null;
      if (p.status !== 'pending') return this.#public(c, p.id);

      const verified = gatewayStatus === 'OK' ? await this.gateway.verify({ authority, amountToman: Number(p.amount_toman) }) : null;
      if (!verified) {
        await c.query(
          `UPDATE miniapp_payments SET status = $2, updated_at = now() WHERE id = $1`,
          [p.id, gatewayStatus === 'OK' ? 'failed' : 'cancelled'],
        );
        return this.#public(c, p.id);
      }
      await this.wallets.move(c, 'credit', p.exchange_user_id, 'IRT', String(p.amount_toman), {
        referenceType: 'deposit',
        referenceId: p.id,
        reason: `wallet charge via ${this.gateway.name}, ref ${verified.refId}`,
        actor: `gateway:${this.gateway.name}`,
        idempotencyKey: `miniapp-payment:${p.id}`,
      });
      await c.query(
        `UPDATE miniapp_payments SET status = 'paid', ref_id = $2, card_pan = $3, paid_at = now(), updated_at = now() WHERE id = $1`,
        [p.id, verified.refId, verified.cardPan],
      );
      return this.#public(c, p.id);
    });
  }

  async #public(c, id) {
    const { rows } = await c.query(`SELECT ${PAYMENT_COLUMNS}, exchange_user_id FROM miniapp_payments WHERE id = $1`, [id]);
    return rows[0];
  }

  async list(userId, limit = 20) {
    await schemaReady(this.pg);
    const { rows } = await this.pg.query(
      `SELECT ${PAYMENT_COLUMNS} FROM miniapp_payments WHERE user_id = $1 AND authority IS NOT NULL ORDER BY created_at DESC LIMIT $2`,
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
