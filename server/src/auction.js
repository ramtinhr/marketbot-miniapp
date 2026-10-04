// The auction: a second book per pair where users trade only with each other.
// A buy says "I will buy X at Y", a sell "I will sell X at Y"; an order that
// crosses the other side fills at once against it, best price first and
// first come first served at a price, each fill at the resting order's price.
// Whatever does not fill rests on the auction book until it fills or is
// cancelled. Nothing here reaches the engine, Kafka or a venue.
//
// An order holds what it may spend - Toman at its limit for a buy, the coin for
// a sell - frozen in the exchange wallet from the moment it is placed. Each
// fill pays out of those holds, and a buy that fills below its limit gets the
// difference back. Placing, matching and settling are one transaction, under
// a lock per pair, so two orders never match against the same resting one.
//
// The same orders are also shown one by one, as offers on a board, the way
// Telegram's trading groups post "I buy X at Y": taking an offer fills against
// that order alone, at its price, and never rests on the book.
//
// Amounts are computed as integers of 10^-18, the wallets' NUMERIC(36,18): a
// price and a quantity carry at most 8 decimals each, so every product is exact.

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { exchangeDbError, httpError } from './errors.js';
import { asciiAmount, isSymbol, isUUID } from './trading.js';
import { withTransaction } from './wallets.js';

const SCALE = 18;
const ONE = 10n ** BigInt(SCALE);
const OPEN = ['open', 'partial'];
const BOOK_LEVELS = 50;
const BOARD_OFFERS = 100;

/** A non-negative decimal string as an integer of 10^-18. */
export function units(value) {
  const [int, frac = ''] = String(value).split('.');
  return BigInt(int || '0') * ONE + BigInt(frac.padEnd(SCALE, '0').slice(0, SCALE));
}

/** An integer of 10^-18 as a decimal string, without trailing zeros. */
export function decimal(u) {
  const sign = u < 0n ? '-' : '';
  const abs = u < 0n ? -u : u;
  const frac = (abs % ONE).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${sign}${abs / ONE}${frac ? `.${frac}` : ''}`;
}

const mul = (a, b) => (a * b) / ONE;
const min = (a, b) => (a < b ? a : b);

/** What an order holds for `quantity` of it: Toman at its limit for a buy, the coin for a sell. */
const holdFor = (side, price, quantity) => (side === 'buy' ? mul(price, quantity) : quantity);

/**
 * The fills a new order makes against resting ones, without changing anything.
 * `makers` are the other side, best first; each fill is at the maker's price.
 */
export function matchAuction(taker, makers) {
  const crosses = (p) => (taker.side === 'buy' ? p <= taker.price : p >= taker.price);
  let left = taker.quantity - taker.filled;
  const fills = [];
  for (const maker of makers) {
    if (left <= 0n || !crosses(maker.price)) break;
    if (maker.userId === taker.userId) continue;
    const quantity = min(left, maker.quantity - maker.filled);
    if (quantity <= 0n) continue;
    fills.push({ maker, quantity, price: maker.price });
    left -= quantity;
  }
  return { fills, remaining: left };
}

/** An order's state after `quantity` of it filled at `price`. */
export function fillOrder(order, quantity, price) {
  const filled = order.filled + quantity;
  return {
    ...order,
    filled,
    filledQuote: order.filledQuote + mul(quantity, price),
    held: order.held - holdFor(order.side, order.price, quantity),
    status: filled >= order.quantity ? 'filled' : 'partial',
  };
}

const COLUMNS = `id, exchange_user_id, symbol, side, price::text, quantity::text, filled_quantity::text,
  filled_quote::text, held::text, status, created_at, updated_at`;
const TRADE_COLUMNS = 'id, symbol, price::text, quantity::text, taker_side, buy_user_id, sell_user_id, executed_at';

function stateOf(row) {
  return {
    id: row.id,
    userId: row.exchange_user_id,
    symbol: row.symbol,
    side: row.side,
    price: units(row.price),
    quantity: units(row.quantity),
    filled: units(row.filled_quantity),
    filledQuote: units(row.filled_quote),
    held: units(row.held),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** An order as the app gets it - the shape of an exchange order. */
function orderJson(o) {
  return {
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    price: decimal(o.price),
    quantity: decimal(o.quantity),
    filled_quantity: decimal(o.filled),
    filled_quote: decimal(o.filledQuote),
    status: o.status,
    created_at: o.createdAt,
    updated_at: o.updatedAt,
  };
}

/** An open order as the board shows it to everyone: no owner, what is left of it. */
function offerJson(o) {
  return {
    id: o.id,
    side: o.side,
    price: decimal(o.price),
    quantity: decimal(o.quantity),
    remaining: decimal(o.quantity - o.filled),
    created_at: o.createdAt,
  };
}

const tradeJson = (t) => ({
  id: t.id,
  symbol: t.symbol,
  price: decimal(units(t.price)),
  quantity: decimal(units(t.quantity)),
  taker_side: t.taker_side,
  executed_at: t.executed_at,
});

/**
 * Emits 'change' ({ symbol, orders, trades }) after every committed change:
 * orders carry `user_id`, trades `buy_user_id` and `sell_user_id`, for the hub.
 */
export class Auction extends EventEmitter {
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

  #lock(c, symbol) {
    return c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`miniapp_auction:${symbol}`]);
  }

  /** The auction book of a pair, aggregated by price: bids best (highest) first, asks best (lowest) first. */
  book(symbol) {
    return this.#run(async () => {
      const [levels, last] = await Promise.all([
        this.pg.query(
          `SELECT side, price::text, SUM(quantity - filled_quantity)::text AS quantity, COUNT(*)::int AS orders
             FROM miniapp_auction_orders
            WHERE symbol = $1 AND status = ANY($2)
            GROUP BY side, price`,
          [symbol, OPEN],
        ),
        this.pg.query('SELECT price::text FROM miniapp_auction_trades WHERE symbol = $1 ORDER BY seq DESC LIMIT 1', [symbol]),
      ]);
      const side = (name, dir) =>
        levels.rows
          .filter((l) => l.side === name)
          .map((l) => ({ u: units(l.price), level: { price: decimal(units(l.price)), quantity: decimal(units(l.quantity)), orders: l.orders } }))
          .sort((a, b) => (a.u === b.u ? 0 : (a.u < b.u ? -1 : 1) * dir))
          .slice(0, BOOK_LEVELS)
          .map((l) => l.level);
      return {
        symbol,
        bids: side('buy', -1),
        asks: side('sell', 1),
        last_price: last.rows[0] ? decimal(units(last.rows[0].price)) : '',
      };
    });
  }

  /** A pair's open orders one by one, newest first, for the board. */
  offers(symbol, limit = BOARD_OFFERS) {
    return this.#run(async () => {
      const { rows } = await this.pg.query(
        `SELECT ${COLUMNS} FROM miniapp_auction_orders WHERE symbol = $1 AND status = ANY($2) ORDER BY seq DESC LIMIT $3`,
        [symbol, OPEN, limit],
      );
      return rows.map((r) => offerJson(stateOf(r)));
    });
  }

  /** One order as the board shows it, with its pair, owner and whether it is still open; null if there is none. */
  offer(id) {
    if (!isUUID(id)) return Promise.resolve(null);
    return this.#run(async () => {
      const { rows } = await this.pg.query(`SELECT ${COLUMNS} FROM miniapp_auction_orders WHERE id = $1`, [id]);
      if (!rows.length) return null;
      const o = stateOf(rows[0]);
      return { ...offerJson(o), symbol: o.symbol, owner: o.userId, open: OPEN.includes(o.status) };
    });
  }

  trades(symbol, limit = 40) {
    return this.#run(async () => {
      const { rows } = await this.pg.query(
        `SELECT ${TRADE_COLUMNS} FROM miniapp_auction_trades WHERE symbol = $1 ORDER BY seq DESC LIMIT $2`,
        [symbol, limit],
      );
      return rows.map(tradeJson);
    });
  }

  orders(exchangeUserId, { symbol = null, scope = 'open', limit = 50 } = {}) {
    return this.#run(async () => {
      const params = [exchangeUserId];
      let where = 'exchange_user_id = $1';
      if (symbol) where += ` AND symbol = $${params.push(symbol)}`;
      if (scope === 'open') where += ` AND status = ANY($${params.push(OPEN)})`;
      if (scope === 'history') where += ` AND NOT status = ANY($${params.push(OPEN)})`;
      const { rows } = await this.pg.query(
        `SELECT ${COLUMNS} FROM miniapp_auction_orders WHERE ${where} ORDER BY created_at DESC LIMIT $${params.push(limit)}`,
        params,
      );
      return rows.map((r) => orderJson(stateOf(r)));
    });
  }

  /** Checks an order body; returns what to place, or throws 400. */
  normalize(body) {
    const b = body ?? {};
    const symbol = String(b.symbol ?? '').toUpperCase();
    if (!isSymbol(symbol)) throw httpError(400, 'invalid_order', 'symbol must be a Toman pair such as USDT_IRT');
    if (b.side !== 'buy' && b.side !== 'sell') throw httpError(400, 'invalid_order', 'side must be buy or sell');
    const quantity = asciiAmount(b.quantity);
    if (!quantity) throw httpError(400, 'invalid_quantity', 'quantity must be a positive number with at most 8 decimals');
    const price = asciiAmount(b.price);
    if (!price) throw httpError(400, 'invalid_price', 'price must be a positive number with at most 8 decimals');
    return { symbol, side: b.side, price, quantity };
  }

  /** Places an auction order and matches it; resolves with { order, trades } as committed. */
  async place(exchangeUserId, body, { actor }) {
    const o = this.normalize(body);
    const result = await this.#run(() =>
      withTransaction(this.pg, async (c) => {
        await this.#lock(c, o.symbol);
        const taker = await this.#insert(c, exchangeUserId, o, actor);
        const opposite = o.side === 'buy' ? 'sell' : 'buy';
        const { rows: resting } = await c.query(
          `SELECT ${COLUMNS} FROM miniapp_auction_orders
            WHERE symbol = $1 AND side = $2 AND status = ANY($3) AND exchange_user_id <> $4
              AND price ${o.side === 'buy' ? '<=' : '>='} $5
            ORDER BY price ${o.side === 'buy' ? 'ASC' : 'DESC'}, seq ASC
            FOR UPDATE`,
          [o.symbol, opposite, OPEN, exchangeUserId, o.price],
        );
        const { fills } = matchAuction(taker, resting.map(stateOf));
        return this.#execute(c, taker, fills, actor);
      }),
    );

    this.#announce(o.symbol, [result.taker, ...result.makers], result.trades);
    this.log?.info({ order: result.taker.id, symbol: o.symbol, side: o.side, fills: result.trades.length, status: result.taker.status }, 'auction order placed');
    return { order: orderJson(result.taker), trades: result.trades.map(tradeJson) };
  }

  /**
   * Takes `quantity` of one offer on the board - an answer to "I buy X at Y"
   * or "I sell X at Y" - at its price, all at once: an order of the other side
   * that fills against that offer alone and is never left on the book.
   */
  async take(exchangeUserId, offerId, body, { actor }) {
    if (!isUUID(offerId)) throw httpError(400, 'bad_request', 'offer id must be a UUID');
    const quantity = asciiAmount(body?.quantity);
    if (!quantity) throw httpError(400, 'invalid_quantity', 'quantity must be a positive number with at most 8 decimals');

    const result = await this.#run(async () => {
      const found = await this.pg.query('SELECT symbol FROM miniapp_auction_orders WHERE id = $1', [offerId]);
      if (!found.rows.length) throw httpError(404, 'offer_gone', 'no such offer');
      const { symbol } = found.rows[0];
      return withTransaction(this.pg, async (c) => {
        await this.#lock(c, symbol);
        const { rows: [row] } = await c.query(`SELECT ${COLUMNS} FROM miniapp_auction_orders WHERE id = $1 FOR UPDATE`, [offerId]);
        const maker = stateOf(row);
        if (!OPEN.includes(maker.status)) throw httpError(409, 'offer_gone', 'the offer is already filled or cancelled');
        if (maker.userId === exchangeUserId) throw httpError(409, 'own_offer', 'an offer cannot be taken by its own poster');
        const left = maker.quantity - maker.filled;
        if (units(quantity) > left) {
          throw httpError(409, 'offer_short', 'the offer has less left than asked for', { remaining: decimal(left) });
        }
        const side = maker.side === 'buy' ? 'sell' : 'buy';
        const taker = await this.#insert(c, exchangeUserId, { symbol, side, price: decimal(maker.price), quantity }, actor);
        return this.#execute(c, taker, [{ maker, quantity: taker.quantity, price: maker.price }], actor);
      });
    });

    this.#announce(result.taker.symbol, [result.taker, ...result.makers], result.trades);
    this.log?.info({ order: result.taker.id, offer: offerId, symbol: result.taker.symbol, side: result.taker.side }, 'auction offer taken');
    return { order: orderJson(result.taker), trades: result.trades.map(tradeJson) };
  }

  /** Records a new order and freezes what it may spend; returns its state. */
  async #insert(c, exchangeUserId, o, actor) {
    const hold = holdFor(o.side, units(o.price), units(o.quantity));
    const { rows: [row] } = await c.query(
      `INSERT INTO miniapp_auction_orders (exchange_user_id, symbol, side, price, quantity, held)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
      [exchangeUserId, o.symbol, o.side, o.price, o.quantity, decimal(hold)],
    );
    await this.wallets.move(c, 'freeze', exchangeUserId, o.side === 'buy' ? 'IRT' : o.symbol.split('_')[0], decimal(hold), {
      referenceType: 'auction_order', referenceId: row.id, reason: `auction ${o.side} order on ${o.symbol}`, actor,
    });
    return stateOf(row);
  }

  /** Settles `fills` of `taker` against resting orders and records the orders' new state and the trades. */
  async #execute(c, taker, fills, actor) {
    const base = taker.symbol.split('_')[0];
    const makers = [];
    const trades = [];
    for (const f of fills) {
      taker = fillOrder(taker, f.quantity, f.price);
      const maker = fillOrder(f.maker, f.quantity, f.price);
      makers.push(maker);
      const [buy, sell] = taker.side === 'buy' ? [taker, maker] : [maker, taker];
      const trade = { id: randomUUID(), symbol: taker.symbol, price: f.price, quantity: f.quantity, takerSide: taker.side, buy, sell };
      await this.#settle(c, trade, base, actor);
      trades.push(trade);
    }

    for (const ord of fills.length ? [taker, ...makers] : []) {
      await c.query(
        `UPDATE miniapp_auction_orders SET filled_quantity = $2, filled_quote = $3, held = $4, status = $5, updated_at = now()
          WHERE id = $1`,
        [ord.id, decimal(ord.filled), decimal(ord.filledQuote), decimal(ord.held), ord.status],
      );
    }
    const recorded = [];
    for (const t of trades) {
      const { rows: [tr] } = await c.query(
        `INSERT INTO miniapp_auction_trades (id, symbol, price, quantity, taker_side, buy_order_id, sell_order_id, buy_user_id, sell_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${TRADE_COLUMNS}`,
        [t.id, t.symbol, decimal(t.price), decimal(t.quantity), t.takerSide, t.buy.id, t.sell.id, t.buy.userId, t.sell.userId],
      );
      recorded.push(tr);
    }
    return { taker, makers, trades: recorded };
  }

  /**
   * One fill's money: the buyer pays price x quantity out of its Toman hold
   * (and gets back what its limit held beyond that), the seller pays the coin
   * out of its hold; each receives the other's into available.
   */
  async #settle(c, t, base, actor) {
    const quote = mul(t.quantity, t.price);
    const refund = mul(t.quantity, t.buy.price) - quote;
    const ref = { referenceType: 'auction_trade', referenceId: t.id, actor };
    const why = (what) => ({ ...ref, reason: `auction trade on ${t.symbol}: ${what}` });
    await this.wallets.move(c, 'settle', t.buy.userId, 'IRT', decimal(quote), why('paid'));
    if (refund > 0n) {
      await this.wallets.move(c, 'unfreeze', t.buy.userId, 'IRT', decimal(refund), { ...why('limit above the fill price released'), referenceType: 'auction_order', referenceId: t.buy.id });
    }
    await this.wallets.move(c, 'receive', t.sell.userId, 'IRT', decimal(quote), why('received'));
    await this.wallets.move(c, 'settle', t.sell.userId, base, decimal(t.quantity), why('delivered'));
    await this.wallets.move(c, 'receive', t.buy.userId, base, decimal(t.quantity), why('received'));
  }

  /** Cancels an open auction order and releases what it still holds. */
  async cancel(exchangeUserId, orderId, { actor }) {
    if (!isUUID(orderId)) throw httpError(400, 'bad_request', 'order id must be a UUID');
    const order = await this.#run(async () => {
      const found = await this.pg.query('SELECT symbol FROM miniapp_auction_orders WHERE id = $1 AND exchange_user_id = $2', [orderId, exchangeUserId]);
      if (!found.rows.length) throw httpError(404, 'order_not_found', 'no such auction order for this user');
      const { symbol } = found.rows[0];
      return withTransaction(this.pg, async (c) => {
        await this.#lock(c, symbol);
        const { rows: [row] } = await c.query(`SELECT ${COLUMNS} FROM miniapp_auction_orders WHERE id = $1 FOR UPDATE`, [orderId]);
        const o = stateOf(row);
        if (!OPEN.includes(o.status)) throw httpError(409, 'order_closed', 'the order is already filled or cancelled');
        if (o.held > 0n) {
          await this.wallets.move(c, 'unfreeze', exchangeUserId, o.side === 'buy' ? 'IRT' : symbol.split('_')[0], decimal(o.held), {
            referenceType: 'auction_order', referenceId: o.id, reason: `auction order on ${symbol} cancelled`, actor,
          });
        }
        const { rows: [updated] } = await c.query(
          `UPDATE miniapp_auction_orders SET status = 'cancelled', held = 0, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
          [orderId],
        );
        return stateOf(updated);
      });
    });
    this.#announce(order.symbol, [order], []);
    return { order: orderJson(order) };
  }

  #announce(symbol, orders, trades) {
    this.emit('change', {
      symbol,
      orders: orders.map((o) => ({ ...orderJson(o), user_id: o.userId })),
      trades: trades.map((t) => ({ ...tradeJson(t), buy_user_id: t.buy_user_id, sell_user_id: t.sell_user_id })),
    });
  }
}
