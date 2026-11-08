// PostgreSQL notifications are delivered after commit, including Mini App writes.
// Keep a dedicated listener connection; reconnect and reconcile after failures.
export function watchAuction(hub) {
  let closed = false;
  let connection;
  let retry;
  const pending = new Set();
  const refresh = async (symbol) => {
    if (
      !hub.auction ||
      !/^[A-Z0-9]{2,15}_IRT$/.test(symbol) ||
      pending.has(symbol)
    )
      return;
    pending.add(symbol);
    try {
      const watching = [...hub.clients].filter((c) => c.symbol === symbol);
      const [book, offers, trades] = await Promise.all([
        hub.auction.book(symbol),
        hub.auction.offers(symbol),
        hub.auction.trades(symbol),
      ]);
      for (const c of watching) {
        hub.send(c, { type: "auction_book", book });
        hub.send(c, { type: "auction_offers", symbol, offers });
        hub.send(c, { type: "auction_trades", symbol, trades });
      }
      const users = new Set(
        [...hub.clients].map((c) => c.userId).filter(Boolean),
      );
      for (const userId of users) {
        const orders = await hub.auction.orders(userId, {
          symbol,
          scope: "all",
        });
        for (const c of hub.clients)
          if (c.userId === userId)
            hub.send(c, { type: "auction_user", symbol, orders, trades: [] });
        hub.refreshBalances(userId, 0);
      }
    } catch (err) {
      hub.log.warn({ err }, "auction reconciliation failed");
    } finally {
      pending.delete(symbol);
    }
  };
  const start = async () => {
    if (closed || !hub.pg.connect) return;
    let c;
    try {
      c = await hub.pg.connect();
      if (closed || !c.on) {
        c.release();
        return;
      }
      connection = c;
      const lost = () => {
        if (connection !== c) return;
        connection = null;
        c.release(true);
        if (!closed) retry = setTimeout(start, 3000);
      };
      c.on("error", lost);
      c.on("end", lost);
      c.on("notification", (msg) => {
        if (msg.channel === "marketbot_auction_changed")
          void refresh(msg.payload);
      });
      await c.query("LISTEN marketbot_auction_changed");
      for (const symbol of new Set(
        [...hub.clients].map((c) => c.symbol).filter(Boolean),
      ))
        void refresh(symbol);
    } catch (err) {
      if (connection === c) {
        connection = null;
        c.release(true);
      }
      hub.log.warn({ err }, "auction listener unavailable");
      if (!closed) retry = setTimeout(start, 3000);
    }
  };
  void start();
  return () => {
    closed = true;
    clearTimeout(retry);
    const c = connection;
    connection = null;
    c?.release(true);
  };
}
