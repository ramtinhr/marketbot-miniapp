import { buildApp } from './app.js';
import { config } from './config.js';
import { createPool } from './db.js';
import { UserStore } from './store.js';

const pg = createPool(config.db);
const users = new UserStore(pg, config.auth);

const app = await buildApp({ users, logger: { level: config.logLevel } });

if (!users.configured) app.log.warn('BOT_TOKEN is not set - every sign-in will answer 503');

// Tables up front, so a database problem shows in the log at deploy time. Not
// fatal: the first request retries it.
users.ready().catch((err) => app.log.error({ err: { message: err.message } }, 'could not prepare the miniapp tables'));

pg.on('error', (err) => app.log.error({ err }, 'postgres pool error'));

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await pg.end();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`miniapp api: http://localhost:${config.port}/api/v1`);
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}
