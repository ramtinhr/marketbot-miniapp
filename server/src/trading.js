// Trading on the exchange for the signed-in user: market data, and placing and
// cancelling orders through the engine (exchange.js). Orders are always for
// the session's own exchange account; the app never names a user.
//
// The engine matches limit orders only (good till cancelled). A market order
// here is a limit order priced to sweep the book: at the deepest level the
// quantity needs, plus a margin for a book that moves meanwhile. It fills at
// the resting orders' own prices - never worse than the book showed by more
// than the margin - and whatever is left unfilled is cancelled at once, so a
// market order never rests on the book.

import { exchangeDbError, httpError } from './errors.js';
import { REJECTIONS } from './exchange.js';

const SYMBOL_RE = /^[A-Z0-9]{2,15}_IRT$/;
const AMOUNT_RE = /^\d{1,15}(\.\d{1,8})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN = ['open', 'partial'];

// What the bot trades (marketbot's pricecache), shown before the engine has
// published a book for a pair.
export const DEFAULT_SYMBOLS = ['USDT_IRT', 'BTC_IRT', 'ETH_IRT', 'TRX_IRT', 'SOL_IRT', 'XRP_IRT', 'DOGE_IRT', 'BNB_IRT', 'ADA_IRT', 'SHIB_IRT', 'USDC_IRT'];

export const isSymbol = (v) => SYMBOL_RE.test(String(v ?? ''));
export const isUUID = (v) => UUID_RE.test(String(v ?? ''));

/** Persian digits, the Persian decimal mark and grouping removed: what the engine wants. */
export function asciiAmount(raw) {
  const s = String(raw ?? '')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/٫/g, '.')
    .replace(/[,٬\s]/g, '');
  return AMOUNT_RE.test(s) && Number(s) > 0 ? s : null;
}

/** A price as the engine takes it, rounded the safe way for the side: up for a buy, down for a sell. */
export function priceString(value, round) {
  const places = value >= 1000 ? 0 : 8;
  const f = 10 ** places;
  const n = round === 'up' ? Math.ceil(value * f - 1e-9) / f : Math.floor(value * f + 1e-9) / f;
  return places ? n.toFixed(places).replace(/\.?0+$/, '') : n.toFixed(0);
}

/**
 * The limit price that makes an order of `quantity` fill against `depth` now:
 * the deepest level it reaches, moved by `slippageBps` against the taker.
 * Null when the book cannot fill it all.
 */
export function marketOrderPrice(depth, side, quantity, slippageBps) {
  const levels = (side === 'buy' ? depth?.asks : depth?.bids) ?? [];
  let left = Number(quantity);
  let deepest = null;
  for (const level of levels) {
    deepest = Number(level.price);
    left -= Number(level.quantity);
    if (left <= 1e-12) break;
  }
  if (deepest === null || !(deepest > 0) || left > 1e-12) return null;
  const margin = slippageBps / 10_000;
  return side === 'buy' ? priceString(deepest * (1 + margin), 'up') : priceString(deepest * (1 - margin), 'down');
}

/** The engine's refusal as the error to answer with. */
function refused(reason) {
  return httpError(reason === 'internal_error' ? 502 : 409, reason, REJECTIONS[reason] ?? reason);
}

const ORDER_COLUMNS = 'id, symbol, side, price, quantity, filled_quantity, filled_quote, status, created_at, updated_at';
const TRADE_COLUMNS = 'id, symbol, price, quantity, taker_side, buy_user_id, sell_user_id, venue, executed_at';

// The pair's last 24 hours: price is the mid of the venues' best bid and ask
// (ticker_snapshots, as the dashboard's chart), volume is what traded here.
const DAY_SQL = `
  WITH book AS (
    SELECT floor(extract(epoch FROM observed_at) / 10) AS at, MAX(best_bid) AS bid, MIN(best_ask) AS ask
      FROM ticker_snapshots
     WHERE symbol = $1 AND observed_at >= now() - interval '24 hours' AND best_bid > 0 AND best_ask > 0
     GROUP BY 1
  ), mids AS (SELECT at, (bid + ask) / 2 AS mid FROM book)
  SELECT (array_agg(mid ORDER BY at))[1]::float8 AS open,
         MAX(mid)::float8 AS high, MIN(mid)::float8 AS low,
         (array_agg(mid ORDER BY at DESC))[1]::float8 AS close
    FROM mids`;

export class Trading {
  /**
   * @param {{ pg: import('pg').Pool, exchange: import('./exchange.js').ExchangeBridge, slippageBps?: number, log?: object }} deps
   */
  constructor({ pg, exchange, slippageBps = 50, log }) {
    this.pg = pg;
    this.exchange = exchange;
    this.slippageBps = slippageBps;
    this.log = log;
  }

  async #query(sql, params) {
    try {
      return await this.pg.query(sql, params);
    } catch (err) {
      throw exchangeDbError(err);
    }
  }

  symbols() {
    return [...new Set([...this.exchange.symbols(), ...DEFAULT_SYMBOLS])].filter(isSymbol);
  }

  depth(symbol) {
    return this.exchange.depth(symbol);
  }

  /** What a coin is worth in Toman now, by base asset: the book's best bid, what selling would get. */
  tomanPrices() {
    const prices = {};
    for (const s of this.symbols()) {
      const depth = this.depth(s);
      const bid = Number(depth?.bids?.[0]?.price) || 0;
      const ask = Number(depth?.asks?.[0]?.price) || 0;
      const price = bid || ask || Number(depth?.last_price) || 0;
      if (price) prices[s.split('_')[0]] = price;
    }
    return prices;
  }

  async summary(symbol) {
    const [day, volume] = await Promise.all([
      this.pg.query(DAY_SQL, [symbol]).catch(() => ({ rows: [] })),
      this.pg
        .query(
          `SELECT COALESCE(SUM(quantity), 0)::float8 AS volume, COALESCE(SUM(price * quantity), 0)::float8 AS quote_volume
             FROM exchange.trades WHERE symbol = $1 AND executed_at >= now() - interval '24 hours'`,
          [symbol],
        )
        .catch(() => ({ rows: [] })),
    ]);
    const d = day.rows[0];
    if (!d || d.open === null) return null;
    return {
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      change_pct: d.open ? ((d.close - d.open) / d.open) * 100 : 0,
      volume: volume.rows[0]?.volume ?? 0,
      quote_volume: volume.rows[0]?.quote_volume ?? 0,
    };
  }

  async marketTrades(symbol, limit = 40) {
    const { rows } = await this.#query(
      `SELECT ${TRADE_COLUMNS} FROM exchange.trades WHERE symbol = $1 ORDER BY seq DESC LIMIT $2`,
      [symbol, limit],
    );
    // Who traded is nobody else's business.
    return rows.map(({ buy_user_id: _b, sell_user_id: _s, ...t }) => t);
  }

  async orders(exchangeUserId, { symbol = null, scope = 'open', limit = 50 } = {}) {
    const params = [exchangeUserId];
    let where = 'user_id = $1';
    if (symbol) where += ` AND symbol = $${params.push(symbol)}`;
    if (scope === 'open') where += ` AND status = ANY($${params.push(OPEN)})`;
    if (scope === 'history') where += ` AND NOT status = ANY($${params.push(OPEN)})`;
    const { rows } = await this.#query(
      `SELECT ${ORDER_COLUMNS} FROM exchange.orders WHERE ${where} ORDER BY created_at DESC LIMIT $${params.push(limit)}`,
      params,
    );
    return rows;
  }

  async myTrades(exchangeUserId, { symbol = null, limit = 50 } = {}) {
    const params = [exchangeUserId];
    let where = '(buy_user_id = $1 OR sell_user_id = $1)';
    if (symbol) where += ` AND symbol = $${params.push(symbol)}`;
    const { rows } = await this.#query(
      `SELECT ${TRADE_COLUMNS} FROM exchange.trades WHERE ${where} ORDER BY seq DESC LIMIT $${params.push(limit)}`,
      params,
    );
    return rows.map(({ buy_user_id: buyer, sell_user_id: _s, ...t }) => ({ ...t, side: buyer === exchangeUserId ? 'buy' : 'sell' }));
  }

  /** Checks an order body; returns what to send, or throws 400. */
  normalize(body) {
    const b = body ?? {};
    const symbol = String(b.symbol ?? '').toUpperCase();
    if (!isSymbol(symbol)) throw httpError(400, 'invalid_order', 'symbol must be a Toman pair such as USDT_IRT');
    if (b.side !== 'buy' && b.side !== 'sell') throw httpError(400, 'invalid_order', 'side must be buy or sell');
    const type = b.type ?? 'limit';
    if (type !== 'limit' && type !== 'market') throw httpError(400, 'invalid_order', 'type must be limit or market');
    const quantity = asciiAmount(b.quantity);
    if (!quantity) throw httpError(400, 'invalid_quantity', 'quantity must be a positive number with at most 8 decimals');
    let price = null;
    if (type === 'limit') {
      price = asciiAmount(b.price);
      if (!price) throw httpError(400, 'invalid_price', 'price must be a positive number with at most 8 decimals');
    }
    return { symbol, side: b.side, type, quantity, price };
  }

  /** Places an order; resolves with { order, trades } as the engine left them. */
  async place(exchangeUserId, body) {
    const o = this.normalize(body);
    let price = o.price;
    if (o.type === 'market') {
      price = marketOrderPrice(this.exchange.depth(o.symbol), o.side, o.quantity, this.slippageBps);
      if (!price) throw httpError(409, 'insufficient_liquidity', 'the book cannot fill this quantity now');
    }
    const event = await this.exchange.place({ symbol: o.symbol, side: o.side, user_id: exchangeUserId, price, quantity: o.quantity });
    if (event.rejected_reason) throw refused(event.rejected_reason);

    let order = event.orders.find((x) => x.user_id === exchangeUserId) ?? event.orders[0] ?? null;
    const trades = event.trades;
    if (o.type === 'market' && order && OPEN.includes(order.status)) {
      const cancel = await this.exchange.cancel({ symbol: o.symbol, order_id: order.id, user_id: exchangeUserId });
      if (cancel.rejected_reason && cancel.rejected_reason !== 'order_closed') {
        this.log?.error({ order: order.id, reason: cancel.rejected_reason }, 'market order: cancelling the unfilled rest failed');
      }
      order = cancel.orders.find((x) => x.id === order.id) ?? order;
    }
    return { order, trades, type: o.type };
  }

  async cancel(exchangeUserId, orderId) {
    if (!isUUID(orderId)) throw httpError(400, 'bad_request', 'order id must be a UUID');
    const { rows } = await this.#query('SELECT symbol FROM exchange.orders WHERE id = $1 AND user_id = $2', [orderId, exchangeUserId]);
    if (!rows.length) throw httpError(404, 'order_not_found', REJECTIONS.order_not_found);
    const event = await this.exchange.cancel({ symbol: rows[0].symbol, order_id: orderId, user_id: exchangeUserId });
    if (event.rejected_reason) throw refused(event.rejected_reason);
    return { order: event.orders[0] ?? null };
  }
}
