import Fastify from 'fastify';

import { httpError } from './errors.js';
import { AUTHORITY_PATTERN, callbackParams } from './payments.js';
import { isSymbol } from './trading.js';
import { NETWORKS } from './withdrawals.js';

const NO_CACHE = 'no-store';

export function bearerToken(header) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(header || ''));
  return m ? m[1] : null;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A small Persian page for the browser tab the payment gateway runs in. */
function page(title, body) {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f0f2f5;color:#0f1419;font:16px/1.8 Vazirmatn,system-ui,sans-serif}
@media (prefers-color-scheme:dark){body{background:#0e1621;color:#f5f7fa}.card{background:#17212b!important}}
.card{background:#fff;border-radius:22px;padding:32px 24px;max-width:360px;width:calc(100% - 32px);text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.08)}
h1{font-size:1.3rem;margin:.5rem 0}p{margin:.25rem 0;opacity:.75}.big{font-size:2.6rem}
a,button{display:block;width:100%;margin-top:12px;padding:14px;border:0;border-radius:14px;font:inherit;font-weight:700;text-decoration:none;cursor:pointer}
.primary{background:#2a82da;color:#fff}.secondary{background:rgba(127,127,127,.14);color:inherit}
</style></head><body><div class="card">${body}</div></body></html>`;
}

/**
 * Builds the server around already-made services, so tests can pass fakes and
 * the entrypoint owns the connections. Only `users` is required; the wallet
 * and trading routes exist when their services are given.
 *
 * Every route lives under /api/v1 and is reached through the web app's own
 * origin (its nginx, or Vite in development), so there is no CORS.
 *
 * @param {{ users: import('./store.js').UserStore, otp?: import('./otp.js').OtpService,
 *           wallets?: import('./wallets.js').Wallets, payments?: import('./payments.js').Payments,
 *           withdrawals?: import('./withdrawals.js').Withdrawals, trading?: import('./trading.js').Trading,
 *           auction?: import('./auction.js').Auction, hub?: import('./hub.js').Hub, photos?: import('./photos.js').TelegramPhotos,
 *           bot?: import('./bot.js').Bot, botUsername?: string, logger?: object|boolean }} deps
 */
export async function buildApp({ users, otp, wallets, payments, withdrawals, trading, auction, hub, photos, bot, botUsername = '', logger = true }) {
  const app = Fastify({
    logger,
    // Reached only through nginx on loopback, which sets X-Forwarded-For.
    trustProxy: 'loopback',
    bodyLimit: 64 * 1024,
  });

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err, url: req.url }, 'request failed');
    // Only errors made on purpose (httpError, Fastify's own) say what went wrong.
    const known = Boolean(err.statusCode);
    const code = known && typeof err.code === 'string' && !err.code.startsWith('FST_') ? err.code : status >= 500 ? 'internal' : 'bad_request';
    if (err.extra?.retry_after) reply.header('retry-after', String(err.extra.retry_after));
    reply.code(status).send({ error: known ? err.message : 'internal error', code, ...err.extra });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: `${req.method} ${req.url} not found`, code: 'not_found' }));

  app.get('/health', async () => ({ status: 'ok' }));

  // What the deploy waits for. Not under /api, so the web app's nginx never
  // serves it to the internet; it names the failing dependency and its error.
  app.get('/health/ready', async (req, reply) => {
    const checks = {};
    try {
      await users.ready();
      checks.database = 'ok';
    } catch (err) {
      checks.database = err.message;
    }
    try {
      // The engine's schema, as the routes use it - stale until the engine has started once.
      await users.pg.query('SELECT phone, status FROM exchange.users LIMIT 0');
      checks.exchange_schema = 'ok';
    } catch (err) {
      checks.exchange_schema = err.message;
    }
    if (trading) {
      const kafka = trading.exchange.status();
      checks.kafka = kafka.connected ? 'ok' : kafka.error || 'connecting';
    }
    const ready = Object.values(checks).every((v) => v === 'ok');
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
  });

  if (hub) await app.register(import('@fastify/websocket'));

  await app.register(
    async (api) => {
      api.addHook('onSend', async (req, reply) => {
        if (!reply.hasHeader('cache-control')) reply.header('cache-control', NO_CACHE);
      });
      api.addHook('onRequest', async (req, reply) => {
        if (!users.configured) {
          return reply.code(503).send({ error: 'the mini app is not configured (BOT_TOKEN)', code: 'not_configured' });
        }
      });

      const meta = (req) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

      const requireUser = async (req, reply) => {
        const auth = await users.authenticate(bearerToken(req.headers.authorization));
        if (!auth) return reply.code(401).send({ error: 'not signed in', code: 'unauthorized' });
        req.user = auth.user;
        req.session = auth.session;
      };

      // Money needs a session that has confirmed an SMS code, and the exchange
      // account that confirming links.
      const requireVerified = async (req, reply) => {
        await requireUser(req, reply);
        if (reply.sent) return;
        if (!req.session.verified || !req.session.exchangeUserId) {
          return reply.code(403).send({ error: 'confirm the code sent by SMS first', code: 'otp_required' });
        }
      };

      // ---- Sign-in ---------------------------------------------------------

      // Opening the app: `phone_required` until this Telegram account has
      // shared an Iranian number once, a session from then on.
      api.post('/auth/telegram', async (req) => {
        const { init_data: initData } = req.body || {};
        const session = await users.loginExisting(initData, meta(req));
        if (!session) return { status: 'phone_required' };
        req.log.info({ user: session.user.id }, 'sign-in');
        return { status: 'ok', ...session };
      });

      // `contact` is the signed string `WebApp.requestContact()` gave the app.
      api.post('/auth/phone', async (req) => {
        const { init_data: initData, contact } = req.body || {};
        const session = await users.loginWithContact(initData, contact, meta(req));
        req.log.info({ user: session.user.id }, 'sign-in with a shared phone number');
        return { status: 'ok', ...session };
      });

      api.post('/auth/logout', async (req, reply) => {
        await users.logout(bearerToken(req.headers.authorization));
        return reply.code(204).send();
      });

      api.get('/me', { preHandler: requireUser }, async (req) => ({ user: req.user, verified: Boolean(req.session?.verified) }));

      if (photos) {
        api.get('/me/photo', { preHandler: requireUser }, async (req, reply) => {
          let photo;
          try {
            photo = await photos.photo(req.user.telegram_id);
          } catch {
            throw httpError(502, 'telegram_unavailable', 'could not reach Telegram for the profile photo');
          }
          if (!photo) throw httpError(404, 'no_photo', 'this account has no profile photo, or hides it');
          return reply.header('cache-control', 'private, max-age=3600').type(photo.type).send(photo.data);
        });
      }

      if (otp) {
        api.post('/auth/otp/send', { preHandler: requireUser }, async (req) => {
          const sent = await otp.send(req.user, 'login');
          req.log.info({ user: req.user.id }, 'login code sent');
          return sent;
        });

        api.post('/auth/otp/verify', { preHandler: requireUser }, async (req) => {
          await otp.verify(req.user, 'login', req.body?.code);
          await users.verifySession(req.session.tokenHash, req.user);
          req.log.info({ user: req.user.id }, 'session verified by SMS');
          return { verified: true };
        });
      }

      // ---- Wallet ----------------------------------------------------------

      if (wallets) {
        api.get('/wallet', { preHandler: requireVerified }, async (req) => {
          const balances = await wallets.balances(req.session.exchangeUserId);
          const symbols = trading ? trading.symbols() : [];
          const prices = trading ? trading.tomanPrices() : {};
          const assets = ['IRT', ...symbols.map((s) => s.split('_')[0])];
          return { balances, assets: [...new Set([...assets, ...balances.map((b) => b.asset)])], prices };
        });

        api.get('/wallet/entries', { preHandler: requireVerified }, async (req) => {
          const asset = req.query.asset ? String(req.query.asset).toUpperCase() : null;
          if (asset && !/^[A-Z0-9]{2,15}$/.test(asset)) throw httpError(400, 'bad_request', 'unknown asset');
          const before = req.query.before ? Number(req.query.before) : null;
          return wallets.entries(req.session.exchangeUserId, { asset, before: Number.isSafeInteger(before) ? before : null });
        });
      }

      if (payments) {
        api.get('/wallet/charge', { preHandler: requireVerified }, async (req) => ({
          ...payments.limits(),
          payments: await payments.list(req.user.id),
        }));

        api.post('/wallet/charge', { preHandler: requireVerified }, async (req) => {
          const started = await payments.start(req.user, req.session.exchangeUserId, req.body?.amount);
          req.log.info({ user: req.user.id, payment: started.payment_id, amount: req.body?.amount }, 'wallet charge started');
          return started;
        });

        api.get('/wallet/payments/:id', { preHandler: requireVerified }, async (req) => {
          const p = /^[0-9a-f-]{36}$/i.test(req.params.id) ? await payments.get(req.user.id, req.params.id) : null;
          if (!p) throw httpError(404, 'not_found', 'no such payment');
          return { payment: p };
        });

        // The gateway sends the user's browser back here, by GET or by a form
        // POST; no session. The path names the payment, which is then verified
        // with the gateway - whatever else the request says is not trusted.
        await api.register(async (callback) => {
          callback.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
            done(null, Object.fromEntries(new URLSearchParams(body)));
          });

          const returned = async (req, reply) => {
            const { authority } = req.params;
            let p = null;
            let failed = false;
            try {
              p = await payments.complete(authority, callbackParams(req.query, req.body));
            } catch (err) {
              failed = true;
              req.log.error({ authority, err: { message: err.message } }, 'payment verification failed - left pending');
            }
            if (p?.status === 'paid') {
              req.log.info({ payment: p.id, ref: p.ref_id }, 'wallet charged');
              hub?.refreshBalances(p.exchange_user_id);
            } else if (p) {
              req.log.info({ payment: p.id, status: p.status }, 'payment returned unpaid');
            }
            const back = botUsername ? `<a class="primary" href="https://t.me/${escapeHtml(botUsername)}">بازگشت به تلگرام</a>` : '';
            reply.type('text/html; charset=utf-8');
            if (p?.status === 'paid') {
              return page(
                'پرداخت موفق',
                `<div class="big">✅</div><h1>کیف پول شما شارژ شد</h1><p>${Number(p.amount_toman).toLocaleString('fa-IR')} تومان</p><p>کد پیگیری: ${escapeHtml(p.ref_id)}</p>${back}`,
              );
            }
            if (failed || p?.status === 'pending') {
              const again = AUTHORITY_PATTERN.test(authority) ? `<a class="secondary" href="/api/v1/payments/callback/${escapeHtml(authority)}">بررسی دوباره</a>` : '';
              return page(
                'در حال بررسی پرداخت',
                `<div class="big">⏳</div><h1>پرداخت در حال بررسی است</h1><p>نتیجه به‌زودی در کیف پول شما نمایش داده می‌شود. اگر مبلغی از حساب شما کم شده، یا کیف پول شارژ می‌شود یا مبلغ حداکثر تا ۷۲ ساعت بازمی‌گردد.</p>${again}${back}`,
              );
            }
            return page(
              'پرداخت ناموفق',
              `<div class="big">❌</div><h1>پرداخت انجام نشد</h1><p>اگر مبلغی از حساب شما کم شده، حداکثر تا ۷۲ ساعت بازمی‌گردد.</p>${back}`,
            );
          };
          callback.get('/payments/callback/:authority', returned);
          callback.post('/payments/callback/:authority', returned);
        });

        if (payments.gateway.name === 'fake') {
          api.get('/payments/fake/:authority', async (req, reply) => {
            if (!AUTHORITY_PATTERN.test(req.params.authority)) throw httpError(404, 'not_found', 'no such payment');
            const to = (status) => `/api/v1/payments/callback/${req.params.authority}?Status=${status}`;
            reply.type('text/html; charset=utf-8');
            return page(
              'درگاه آزمایشی',
              `<div class="big">💳</div><h1>درگاه پرداخت آزمایشی</h1><p>این درگاه فقط برای نمایش است و پولی جابه‌جا نمی‌شود.</p>
               <a class="primary" href="${to('OK')}">پرداخت موفق</a><a class="secondary" href="${to('NOK')}">انصراف</a>`,
            );
          });
        }
      }

      if (withdrawals && otp) {
        api.get('/wallet/withdrawals', { preHandler: requireVerified }, async (req) => ({
          networks: NETWORKS,
          withdrawals: await withdrawals.list(req.user.id),
        }));

        api.post('/wallet/withdrawals/otp', { preHandler: requireVerified }, async (req) => otp.send(req.user, 'withdraw'));

        api.post('/wallet/withdrawals', { preHandler: requireVerified }, async (req) => {
          // Checked before the code, so a typo in the address does not use it up.
          const w = withdrawals.normalize(req.body);
          const otpId = await otp.check(req.user, 'withdraw', req.body?.code);
          // The code is spent only if the amount is frozen, so a short balance can be fixed and retried.
          const withdrawal = await withdrawals.request(req.user, req.session.exchangeUserId, w, (c) => otp.consume(c, otpId));
          req.log.info({ user: req.user.id, withdrawal: withdrawal.id, asset: w.asset, amount: w.amount }, 'withdrawal requested');
          hub?.refreshBalances(req.session.exchangeUserId);
          return { withdrawal };
        });

        api.post('/wallet/withdrawals/:id/cancel', { preHandler: requireVerified }, async (req) => {
          if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw httpError(404, 'not_found', 'no such withdrawal');
          const withdrawal = await withdrawals.cancel(req.user, req.params.id);
          hub?.refreshBalances(req.session.exchangeUserId);
          return { withdrawal };
        });
      }

      // ---- Market and orders -------------------------------------------------

      if (trading) {
        api.get('/market/symbols', async () => ({ symbols: trading.symbols() }));

        // Everything the trade page needs to draw a pair; live changes come over the socket.
        api.get('/market/:symbol', async (req) => {
          const { symbol } = req.params;
          if (!isSymbol(symbol)) throw httpError(404, 'not_found', 'unknown symbol');
          const [summary, trades] = await Promise.all([trading.summary(symbol), trading.marketTrades(symbol).catch(() => [])]);
          return { symbol, depth: trading.depth(symbol), summary, trades };
        });

        api.get('/orders', { preHandler: requireVerified }, async (req) => {
          const symbol = req.query.symbol && isSymbol(req.query.symbol) ? req.query.symbol : null;
          const scope = ['open', 'history', 'all'].includes(req.query.scope) ? req.query.scope : 'open';
          return { orders: await trading.orders(req.session.exchangeUserId, { symbol, scope }) };
        });

        api.get('/trades', { preHandler: requireVerified }, async (req) => {
          const symbol = req.query.symbol && isSymbol(req.query.symbol) ? req.query.symbol : null;
          return { trades: await trading.myTrades(req.session.exchangeUserId, { symbol }) };
        });

        api.post('/orders', { preHandler: requireVerified }, async (req, reply) => {
          const placed = await trading.place(req.session.exchangeUserId, req.body);
          req.log.info({ user: req.user.id, order: placed.order?.id, type: placed.type, status: placed.order?.status }, 'order placed');
          return reply.code(201).send(placed);
        });

        api.post('/orders/:id/cancel', { preHandler: requireVerified }, async (req) => trading.cancel(req.session.exchangeUserId, req.params.id));
      }

      // ---- Auction: users' own book, matched with each other only ------------

      if (auction) {
        api.get('/auction/orders', { preHandler: requireVerified }, async (req) => {
          const symbol = req.query.symbol && isSymbol(req.query.symbol) ? req.query.symbol : null;
          const scope = ['open', 'history', 'all'].includes(req.query.scope) ? req.query.scope : 'open';
          return { orders: await auction.orders(req.session.exchangeUserId, { symbol, scope }) };
        });

        api.post('/auction/orders', { preHandler: requireVerified }, async (req, reply) => {
          const placed = await auction.place(req.session.exchangeUserId, req.body, { actor: `miniapp:${req.user.id}` });
          req.log.info({ user: req.user.id, order: placed.order.id, status: placed.order.status, fills: placed.trades.length }, 'auction order placed');
          return reply.code(201).send(placed);
        });

        api.post('/auction/orders/:id/cancel', { preHandler: requireVerified }, async (req) =>
          auction.cancel(req.session.exchangeUserId, req.params.id, { actor: `miniapp:${req.user.id}` }));

        api.post('/auction/offers/:id/take', { preHandler: requireVerified }, async (req, reply) => {
          const taken = await auction.take(req.session.exchangeUserId, req.params.id, req.body, { actor: `miniapp:${req.user.id}` });
          req.log.info({ user: req.user.id, offer: req.params.id, order: taken.order.id }, 'auction offer taken');
          return reply.code(201).send(taken);
        });

        api.get('/auction/:symbol', async (req) => {
          const { symbol } = req.params;
          if (!isSymbol(symbol)) throw httpError(404, 'not_found', 'unknown symbol');
          const [book, offers, trades] = await Promise.all([auction.book(symbol), auction.offers(symbol), auction.trades(symbol)]);
          return { symbol, book, offers, trades };
        });
      }

      // ---- The bot's chat -----------------------------------------------------

      // Telegram posts every update here; the reply rides back in the response
      // body, so it needs no call out to Telegram. Always 200 to a genuine
      // call, or Telegram retries the update over and over.
      if (bot) {
        api.post('/telegram/webhook', async (req, reply) => {
          if (!bot.verifyWebhook(req.headers['x-telegram-bot-api-secret-token'])) {
            return reply.code(401).send({ error: 'bad secret', code: 'unauthorized' });
          }
          let actions = [];
          try {
            actions = await bot.handle(req.body || {});
          } catch (err) {
            req.log.error({ err: { message: err.message } }, 'bot update failed');
            const chatId = req.body?.message?.chat?.id ?? req.body?.callback_query?.message?.chat?.id;
            if (chatId) actions = [{ method: 'sendMessage', chat_id: chatId, text: 'مشکلی پیش آمد؛ چند لحظه بعد دوباره تلاش کنید.' }];
          }
          const [first, ...rest] = actions;
          for (const action of rest) bot.run(action).catch(() => {});
          return first ?? {};
        });
      }

      // Client -> server: {"type":"auth","token":"..."} (optional, for the
      // user's own orders and balances) and {"type":"subscribe","symbol":"USDT_IRT"},
      // sent again to switch pairs. Server -> client: "status", "depth",
      // "trades", "user" and "balances". The token goes in a message rather
      // than the URL, which proxies log.
      if (hub) {
        api.get('/market/ws', { websocket: true }, (socket) => {
          const client = { socket, symbol: null, userId: null };
          hub.add(client);
          // Proxies (Cloudflare: 100s) close a connection that says nothing.
          const ping = setInterval(() => socket.ping(), 30_000);
          socket.on('close', () => {
            clearInterval(ping);
            hub.remove(client);
          });
          socket.on('message', async (raw) => {
            let msg;
            try {
              msg = JSON.parse(String(raw));
            } catch {
              return;
            }
            if (msg?.type === 'auth') {
              const auth = await users.authenticate(typeof msg.token === 'string' ? msg.token : null).catch(() => null);
              client.userId = auth?.session.verified ? auth.session.exchangeUserId : null;
              hub.send(client, { type: 'auth', ok: Boolean(client.userId) });
              if (client.userId) hub.refreshBalances(client.userId);
            } else if (msg?.type === 'subscribe') {
              client.symbol = isSymbol(msg.symbol) ? msg.symbol : null;
              hub.snapshot(client);
            }
          });
          hub.send(client, { type: 'status', connected: trading?.exchange.status().connected ?? false });
        });
      }
    },
    { prefix: '/api/v1' },
  );

  return app;
}
