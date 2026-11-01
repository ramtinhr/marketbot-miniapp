// The rial board: users post "I have X Toman" or "I want X Toman" with a
// receive method (wallet, p2p, or a bank rail). Taking an offer fills against
// that offer alone, same method and the opposite side. Wallet "have" offers
// freeze IRT; a wallet take moves IRT from the haver to the wanter. Bank and
// p2p takes only record a match for offline settlement.

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { cleanDescription, DESCRIPTION_MAX, decimal, units } from './auction.js';
import { exchangeDbError, httpError } from './errors.js';
import { asciiAmount, isUUID } from './trading.js';
import { withTransaction } from './wallets.js';
import { normalizeSheba } from './withdrawals.js';

const OPEN = ['open', 'partial'];
const BOARD_OFFERS = 100;
export const RIAL_METHODS = ['wallet', 'p2p', 'paya', 'satna'];
export const BANK_METHODS = ['paya', 'satna'];
const LOCK_KEY = 'miniapp_rial';

const COLUMNS = `id, exchange_user_id, side, amount::text, filled_amount::text, held::text,
  method, destination, description, status, created_at, updated_at`;
const TRADE_COLUMNS = `id, amount::text, method, status, taker_side, have_offer_id, want_offer_id,
  have_user_id, want_user_id, destination, executed_at`;

function stateOf(row) {
  return {
    id: row.id,
    userId: row.exchange_user_id,
    side: row.side,
    amount: units(row.amount),
    filled: units(row.filled_amount),
    held: units(row.held),
    method: row.method,
    destination: row.destination ?? null,
    description: row.description ?? '',
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function orderJson(o) {
  return {
    id: o.id,
    side: o.side,
    amount: decimal(o.amount),
    filled_amount: decimal(o.filled),
    remaining: decimal(o.amount - o.filled),
    method: o.method,
    destination: o.destination,
    status: o.status,
    description: o.description,
    held: decimal(o.held),
    created_at: o.createdAt,
    updated_at: o.updatedAt,
  };
}

/** An open offer as the board shows it: no owner, what is left of it. */
function offerJson(o) {
  return {
    id: o.id,
    side: o.side,
    amount: decimal(o.amount),
    remaining: decimal(o.amount - o.filled),
    method: o.method,
    description: o.description,
    created_at: o.createdAt,
  };
}

function tradeJson(t) {
  return {
    id: t.id,
    amount: decimal(units(t.amount)),
    method: t.method,
    status: t.status,
    taker_side: t.taker_side,
    destination: t.destination ?? null,
    executed_at: t.executed_at,
  };
}

function fillOffer(o, quantity) {
  const filled = o.filled + quantity;
  const held = o.side === 'have' && o.method === 'wallet' ? o.held - quantity : o.held;
  return {
    ...o,
    filled,
    held: held < 0n ? 0n : held,
    status: filled >= o.amount ? 'filled' : 'partial',
  };
}

/**
 * Emits 'change' ({ orders, trades }) after every committed change: orders
 * carry `user_id`, trades `have_user_id` and `want_user_id`, for the hub.
 */
export class Rial extends EventEmitter {
  /** @param {{ pg: import('pg').Pool, wallets: import('./wallets.js').Wallets, log?: object }} deps */
  constructor({ pg, wallets, log }) {
    super();
    this.pg = pg;
    this.wallets = wallets;
    this.log = log;
  }

  async #run(fn) {
    try {
      return await fn();
    } catch (err) {
      throw exchangeDbError(err);
    }
  }

  #lock(c) {
    return c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY]);
  }

  /** Open offers newest first, optionally narrowed by side or method. */
  offers({ side = null, method = null, limit = BOARD_OFFERS } = {}) {
    return this.#run(async () => {
      const params = [OPEN];
      let where = 'status = ANY($1)';
      if (side === 'have' || side === 'want') where += ` AND side = $${params.push(side)}`;
      if (RIAL_METHODS.includes(method)) where += ` AND method = $${params.push(method)}`;
      const { rows } = await this.pg.query(
        `SELECT ${COLUMNS} FROM miniapp_rial_offers WHERE ${where} ORDER BY seq DESC LIMIT $${params.push(limit)}`,
        params,
      );
      return rows.map((r) => offerJson(stateOf(r)));
    });
  }

  trades(limit = 40) {
    return this.#run(async () => {
      const { rows } = await this.pg.query(
        `SELECT ${TRADE_COLUMNS} FROM miniapp_rial_trades ORDER BY seq DESC LIMIT $1`,
        [limit],
      );
      return rows.map(tradeJson);
    });
  }

  orders(exchangeUserId, { scope = 'open', limit = 50 } = {}) {
    return this.#run(async () => {
      const params = [exchangeUserId];
      let where = 'exchange_user_id = $1';
      if (scope === 'open') where += ` AND status = ANY($${params.push(OPEN)})`;
      if (scope === 'history') where += ` AND NOT status = ANY($${params.push(OPEN)})`;
      const { rows } = await this.pg.query(
        `SELECT ${COLUMNS} FROM miniapp_rial_offers WHERE ${where} ORDER BY created_at DESC LIMIT $${params.push(limit)}`,
        params,
      );
      return rows.map((r) => orderJson(stateOf(r)));
    });
  }

  /** Checks a place body; returns what to insert, or throws 400. */
  normalize(body) {
    const b = body ?? {};
    if (b.side !== 'have' && b.side !== 'want') throw httpError(400, 'invalid_order', 'side must be have or want');
    const method = String(b.method ?? '');
    if (!RIAL_METHODS.includes(method)) {
      throw httpError(400, 'invalid_method', `method must be one of ${RIAL_METHODS.join(', ')}`);
    }
    const amount = asciiAmount(b.amount);
    if (!amount || !/^\d+$/.test(amount)) throw httpError(400, 'invalid_amount', 'amount must be a positive whole number of Toman');
    if (b.description != null && typeof b.description !== 'string') throw httpError(400, 'invalid_description', 'description must be text');
    const description = cleanDescription(b.description);
    if ([...description].length > DESCRIPTION_MAX) {
      throw httpError(400, 'invalid_description', `description must be at most ${DESCRIPTION_MAX} characters`);
    }
    let destination = null;
    if (BANK_METHODS.includes(method) && b.side === 'want') {
      destination = normalizeSheba(b.destination);
      if (!destination) throw httpError(400, 'invalid_sheba', 'not a valid Sheba number (IR and 24 digits)');
    } else if (b.destination != null && String(b.destination).trim() !== '') {
      // Have-side bank posts do not need a Sheba; refuse a junk one if sent.
      if (BANK_METHODS.includes(method)) {
        destination = normalizeSheba(b.destination);
        if (!destination) throw httpError(400, 'invalid_sheba', 'not a valid Sheba number (IR and 24 digits)');
      }
    }
    return { side: b.side, method, amount, description, destination };
  }

  /** Places an offer; wallet "have" freezes that IRT. */
  async place(exchangeUserId, body, { actor }) {
    const o = this.normalize(body);
    const order = await this.#run(() =>
      withTransaction(this.pg, async (c) => {
        await this.#lock(c);
        return this.#insert(c, exchangeUserId, o, actor);
      }),
    );
    this.#announce([order], []);
    this.log?.info({ order: order.id, side: o.side, method: o.method, amount: o.amount }, 'rial offer placed');
    return { order: orderJson(order), trades: [] };
  }

  /**
   * Takes `amount` of one offer - opposite side, same method. Wallet moves
   * IRT haver → wanter; bank/p2p only records a matched trade.
   */
  async take(exchangeUserId, offerId, body, { actor }) {
    if (!isUUID(offerId)) throw httpError(400, 'bad_request', 'offer id must be a UUID');
    const amount = asciiAmount(body?.amount);
    if (!amount || !/^\d+$/.test(amount)) throw httpError(400, 'invalid_amount', 'amount must be a positive whole number of Toman');

    let takeDestination = null;
    if (body?.destination != null && String(body.destination).trim() !== '') {
      takeDestination = normalizeSheba(body.destination);
      if (!takeDestination) throw httpError(400, 'invalid_sheba', 'not a valid Sheba number (IR and 24 digits)');
    }

    const result = await this.#run(() =>
      withTransaction(this.pg, async (c) => {
        await this.#lock(c);
        const { rows: [row] } = await c.query(`SELECT ${COLUMNS} FROM miniapp_rial_offers WHERE id = $1 FOR UPDATE`, [offerId]);
        if (!row) throw httpError(404, 'offer_gone', 'no such offer');
        const maker = stateOf(row);
        if (!OPEN.includes(maker.status)) throw httpError(409, 'offer_gone', 'the offer is already filled or cancelled');
        if (maker.userId === exchangeUserId) throw httpError(409, 'own_offer', 'an offer cannot be taken by its own poster');
        const left = maker.amount - maker.filled;
        const qty = units(amount);
        if (qty > left) throw httpError(409, 'offer_short', 'the offer has less left than asked for', { remaining: decimal(left) });

        const takerSide = maker.side === 'have' ? 'want' : 'have';
        let destination = maker.destination;
        if (BANK_METHODS.includes(maker.method)) {
          if (takerSide === 'want') {
            destination = takeDestination || maker.destination;
            if (!destination) throw httpError(400, 'invalid_sheba', 'a Sheba is required to take this offer');
          }
        }

        const taker = await this.#insert(
          c,
          exchangeUserId,
          {
            side: takerSide,
            method: maker.method,
            amount,
            description: '',
            destination: takerSide === 'want' ? destination : null,
          },
          actor,
          { resting: false },
        );

        return this.#execute(c, maker, taker, qty, destination, actor);
      }),
    );

    this.#announce([result.maker, result.taker], result.trades);
    this.log?.info({ offer: offerId, amount, method: result.maker.method }, 'rial offer taken');
    return { order: orderJson(result.taker), trades: result.trades.map(tradeJson) };
  }

  /** Cancels an open offer and releases a wallet hold. */
  async cancel(exchangeUserId, orderId, { actor }) {
    if (!isUUID(orderId)) throw httpError(400, 'bad_request', 'order id must be a UUID');
    const order = await this.#run(() =>
      withTransaction(this.pg, async (c) => {
        await this.#lock(c);
        const { rows: [row] } = await c.query(
          `SELECT ${COLUMNS} FROM miniapp_rial_offers WHERE id = $1 AND exchange_user_id = $2 FOR UPDATE`,
          [orderId, exchangeUserId],
        );
        if (!row) throw httpError(404, 'order_not_found', 'no such rial offer for this user');
        const o = stateOf(row);
        if (!OPEN.includes(o.status)) throw httpError(409, 'order_closed', 'the order is already filled or cancelled');
        return this.#close(c, o, actor);
      }),
    );
    this.#announce([order], []);
    return { order: orderJson(order) };
  }

  /**
   * @param {{ resting?: boolean }} opts - a resting post stays open; a take's
   *   counter-offer is inserted already filled. Wallet "have" always freezes.
   */
  async #insert(c, exchangeUserId, o, actor, { resting = true } = {}) {
    const needFreeze = o.method === 'wallet' && o.side === 'have';
    const hold = needFreeze ? o.amount : '0';
    const { rows: [row] } = await c.query(
      `INSERT INTO miniapp_rial_offers
         (exchange_user_id, side, amount, filled_amount, held, method, destination, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
      [
        exchangeUserId,
        o.side,
        o.amount,
        resting ? '0' : o.amount,
        hold,
        o.method,
        o.destination,
        o.description ?? '',
        resting ? 'open' : 'filled',
      ],
    );
    if (needFreeze) {
      await this.wallets.move(c, 'freeze', exchangeUserId, 'IRT', hold, {
        referenceType: 'rial_order',
        referenceId: row.id,
        reason: `rial have offer (${o.method})`,
        actor,
      });
    }
    return stateOf(row);
  }

  async #execute(c, maker, taker, quantity, destination, actor) {
    const filledMaker = fillOffer(maker, quantity);
    // Taker is already filled; clear its wallet hold after settle below.
    const filledTaker = {
      ...taker,
      filled: taker.amount,
      held: taker.method === 'wallet' && taker.side === 'have' ? 0n : taker.held,
      status: 'filled',
    };

    const [have, want] = maker.side === 'have' ? [filledMaker, filledTaker] : [filledTaker, filledMaker];
    const tradeStatus = maker.method === 'wallet' ? 'settled' : 'matched';
    const tradeId = randomUUID();

    if (maker.method === 'wallet') {
      const ref = { referenceType: 'rial_trade', referenceId: tradeId, actor };
      const why = (what) => ({ ...ref, reason: `rial wallet match: ${what}` });
      await this.wallets.move(c, 'settle', have.userId, 'IRT', decimal(quantity), why('paid'));
      await this.wallets.move(c, 'receive', want.userId, 'IRT', decimal(quantity), why('received'));
    }

    await c.query(
      `UPDATE miniapp_rial_offers SET filled_amount = $2, held = $3, status = $4, updated_at = now() WHERE id = $1`,
      [filledMaker.id, decimal(filledMaker.filled), decimal(filledMaker.held), filledMaker.status],
    );
    await c.query(
      `UPDATE miniapp_rial_offers SET filled_amount = $2, held = $3, status = $4, updated_at = now() WHERE id = $1`,
      [filledTaker.id, decimal(filledTaker.filled), decimal(filledTaker.held), filledTaker.status],
    );

    const { rows: [tr] } = await c.query(
      `INSERT INTO miniapp_rial_trades
         (id, amount, method, status, taker_side, have_offer_id, want_offer_id, have_user_id, want_user_id, destination)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${TRADE_COLUMNS}`,
      [
        tradeId,
        decimal(quantity),
        maker.method,
        tradeStatus,
        taker.side,
        have.id,
        want.id,
        have.userId,
        want.userId,
        destination,
      ],
    );
    return { maker: filledMaker, taker: filledTaker, trades: [tr] };
  }

  async #close(c, o, actor) {
    if (o.held > 0n) {
      await this.wallets.move(c, 'unfreeze', o.userId, 'IRT', decimal(o.held), {
        referenceType: 'rial_order',
        referenceId: o.id,
        reason: 'rial offer cancelled',
        actor,
      });
    }
    const { rows: [updated] } = await c.query(
      `UPDATE miniapp_rial_offers SET status = 'cancelled', held = 0, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
      [o.id],
    );
    return stateOf(updated);
  }

  #announce(orders, trades) {
    this.emit('change', {
      orders: orders.map((o) => ({ ...orderJson(o), user_id: o.userId })),
      trades: trades.map((t) => ({
        ...tradeJson(t),
        have_user_id: t.have_user_id,
        want_user_id: t.want_user_id,
      })),
    });
  }
}
