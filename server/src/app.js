import Fastify from 'fastify';

const NO_CACHE = 'no-store';

export function bearerToken(header) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(header || ''));
  return m ? m[1] : null;
}

/**
 * Builds the server around an already-made user store, so tests can pass a
 * fake one and the entrypoint owns the database connection.
 *
 * Every route lives under /api/v1 and is reached through the web app's own
 * origin (its nginx, or Vite in development), so there is no CORS.
 *
 * @param {{ users: import('./store.js').UserStore, logger?: object|boolean }} deps
 */
export async function buildApp({ users, logger = true }) {
  const app = Fastify({
    logger,
    // Reached only through nginx on loopback, which sets X-Forwarded-For.
    trustProxy: 'loopback',
    bodyLimit: 64 * 1024,
  });

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err, url: req.url }, 'request failed');
    const code = typeof err.code === 'string' && !err.code.startsWith('FST_') ? err.code : status >= 500 ? 'internal' : 'bad_request';
    reply.code(status).send({ error: status >= 500 ? 'internal error' : err.message, code });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: `${req.method} ${req.url} not found`, code: 'not_found' }));

  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(
    async (api) => {
      api.addHook('onSend', async (req, reply) => {
        reply.header('cache-control', NO_CACHE);
      });
      api.addHook('onRequest', async (req, reply) => {
        if (!users.configured) {
          return reply.code(503).send({ error: 'the mini app is not configured (BOT_TOKEN)', code: 'not_configured' });
        }
      });

      const meta = (req) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

      const requireUser = async (req, reply) => {
        const user = await users.authenticate(bearerToken(req.headers.authorization));
        if (!user) return reply.code(401).send({ error: 'not signed in', code: 'unauthorized' });
        req.user = user;
      };

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

      api.get('/me', { preHandler: requireUser }, async (req) => ({ user: req.user }));
    },
    { prefix: '/api/v1' },
  );

  return app;
}
