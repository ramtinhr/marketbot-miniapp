// Fans the exchange's Kafka stream out to the app's WebSockets (ported from
// marketbot-api's ExchangeHub). Each client watches one pair, and - once it
// has authenticated with a verified session - its own exchange account: it
// gets the pair's book and trades, and its own orders, trades and balances.

const OPEN = 1; // WebSocket.OPEN
// A burst of fills touches the same balances many times; one read covers them.
const BALANCE_DEBOUNCE_MS = 150;

const publicTrade = ({ buy_user_id: _b, sell_user_id: _s, buy_order_id: _bo, sell_order_id: _so, venue_order_id: _v, ...t }) => t;

export class Hub {
  /**
   * @param {{ exchange: import('events').EventEmitter & { depth(symbol: string): object|null, status(): object },
   *           pg: import('pg').Pool, log: object }} deps
   */
  constructor({ exchange, pg, log }) {
    this.exchange = exchange;
    this.pg = pg;
    this.log = log;
    this.clients = new Set();
    this.balanceTimers = new Map();

    this.onDepth = (depth) => {
      for (const c of this.clients) if (c.symbol === depth.symbol) this.send(c, { type: 'depth', depth });
    };
    this.onEvent = (event) => this.#event(event);
    this.onStatus = (status) => {
      for (const c of this.clients) this.send(c, { type: 'status', connected: status.connected });
    };
    exchange.on('depth', this.onDepth);
    exchange.on('event', this.onEvent);
    exchange.on('status', this.onStatus);
  }

  add(client) {
    this.clients.add(client);
  }

  remove(client) {
    this.clients.delete(client);
  }

  send(client, message) {
    if (client.socket.readyState !== OPEN) return;
    try {
      client.socket.send(JSON.stringify(message));
    } catch (err) {
      this.log.debug({ err: { message: err.message } }, 'hub: websocket send failed');
    }
  }

  /** What a client needs straight after subscribing: the current book and its balances. */
  snapshot(client) {
    if (client.symbol) this.send(client, { type: 'depth', depth: this.exchange.depth(client.symbol) });
    if (client.userId) this.refreshBalances(client.userId, 0);
  }

  #event(event) {
    if (event.rejected_reason) return; // answered over HTTP to whoever sent it

    if (event.trades.length) {
      const trades = event.trades.map(publicTrade);
      for (const c of this.clients) if (c.symbol === event.symbol) this.send(c, { type: 'trades', symbol: event.symbol, trades });
    }

    const touched = new Set();
    for (const o of event.orders) touched.add(o.user_id);
    for (const t of event.trades) {
      if (t.buy_user_id) touched.add(t.buy_user_id);
      if (t.sell_user_id) touched.add(t.sell_user_id);
    }
    for (const c of this.clients) {
      if (!c.userId || !touched.has(c.userId)) continue;
      this.send(c, {
        type: 'user',
        symbol: event.symbol,
        orders: event.orders.filter((o) => o.user_id === c.userId),
        trades: event.trades
          .filter((t) => t.buy_user_id === c.userId || t.sell_user_id === c.userId)
          .map((t) => ({ ...publicTrade(t), side: t.buy_user_id === c.userId ? 'buy' : 'sell' })),
      });
    }
    for (const userId of touched) this.refreshBalances(userId, BALANCE_DEBOUNCE_MS);
  }

  /** Reads and pushes a user's balances to their sockets, e.g. after a fill or a payment. */
  refreshBalances(userId, delayMs = 0) {
    if (![...this.clients].some((c) => c.userId === userId)) return;
    clearTimeout(this.balanceTimers.get(userId));
    this.balanceTimers.set(
      userId,
      setTimeout(async () => {
        this.balanceTimers.delete(userId);
        try {
          const { rows } = await this.pg.query(
            'SELECT asset, status, available, frozen, locked FROM exchange.wallets WHERE user_id = $1 ORDER BY asset',
            [userId],
          );
          for (const c of this.clients) if (c.userId === userId) this.send(c, { type: 'balances', balances: rows });
        } catch (err) {
          this.log.warn({ err: { message: err.message } }, 'hub: reading balances failed');
        }
      }, delayMs),
    );
  }

  close() {
    this.exchange.off('depth', this.onDepth);
    this.exchange.off('event', this.onEvent);
    this.exchange.off('status', this.onStatus);
    for (const t of this.balanceTimers.values()) clearTimeout(t);
    for (const c of this.clients) c.socket.close?.();
    this.clients.clear();
  }
}
