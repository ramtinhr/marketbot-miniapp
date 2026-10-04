import { buildApp } from './app.js';
import { Auction } from './auction.js';
import { Bot } from './bot.js';
import { config } from './config.js';
import { createPool } from './db.js';
import { ExchangeBridge } from './exchange.js';
import { Hub } from './hub.js';
import { OtpService } from './otp.js';
import { Payments, createGateway } from './payments.js';
import { TelegramPhotos } from './photos.js';
import { createSms } from './sms.js';
import { UserStore } from './store.js';
import { Trading } from './trading.js';
import { Wallets } from './wallets.js';
import { Withdrawals } from './withdrawals.js';

if (config.production) {
  const required = {
    BOT_TOKEN: config.auth.botToken,
    PUBLIC_URL: config.publicUrl,
    DB_PASSWORD: process.env.DB_PASSWORD,
    KAFKA_BROKERS: config.exchange.brokers.join(','),
    ...(config.sms.provider === 'kavenegar' && {
      KAVENEGAR_API_KEY: config.sms.kavenegarApiKey,
      KAVENEGAR_OTP_TEMPLATE: config.sms.kavenegarTemplate,
    }),
    ...(config.payments.provider === 'zarinpal' && { ZARINPAL_MERCHANT_ID: config.payments.zarinpalMerchantId }),
  };
  const problems = [];
  const missing = Object.keys(required).filter((k) => !required[k]);
  if (missing.length) problems.push(`set ${missing.join(', ')}`);
  // Codes in the log would let anyone who reads it sign in as anyone, and the
  // fake gateway credits wallets without money.
  if (config.sms.provider !== 'kavenegar') problems.push(`SMS_PROVIDER must be kavenegar, not "${config.sms.provider}"`);
  if (config.payments.provider !== 'zarinpal') problems.push(`PAYMENT_PROVIDER must be zarinpal, not "${config.payments.provider}"`);
  if (problems.length) {
    process.stderr.write(`${JSON.stringify({ level: 'error', time: Date.now(), msg: `NODE_ENV=production: ${problems.join('; ')} - in .env (MINIAPP_ENV)` })}\n`);
    process.exit(1);
  }
}

const pg = createPool(config.db);
const users = new UserStore(pg, config.auth);

// The services are built before Fastify and its logger; theirs writes the same
// one-JSON-object-per-line shape, pino-style: (fields, message) or (message).
const line = (level, stream) => (fields, msg) => {
  const entry = typeof fields === 'string' ? { msg: fields } : { ...fields, msg };
  stream.write(`${JSON.stringify({ level, time: Date.now(), ...entry })}\n`);
};
const bootLog = { info: line('info', process.stdout), warn: line('warn', process.stdout), error: line('error', process.stderr), debug() {} };

const sms = createSms(config.sms, { production: config.production, log: bootLog });
const otp = new OtpService(pg, sms, { secret: config.auth.botToken, ...config.otp });
const wallets = new Wallets(pg);
const payments = new Payments(pg, wallets, createGateway(config.payments, config), {
  publicUrl: config.publicUrl,
  minToman: config.payments.minToman,
  maxToman: config.payments.maxToman,
});
const withdrawals = new Withdrawals(pg, wallets);
const exchange = new ExchangeBridge({ brokers: config.exchange.brokers, clientId: config.exchange.clientId, log: bootLog });
const trading = new Trading({ pg, exchange, slippageBps: config.exchange.marketSlippageBps, log: bootLog });
const auction = new Auction({ pg, wallets, log: bootLog });
const hub = new Hub({ exchange, auction, pg, log: bootLog });
const photos = new TelegramPhotos({ botToken: config.auth.botToken, ...config.telegram, log: bootLog });
const bot = new Bot({
  botToken: config.auth.botToken,
  publicUrl: config.publicUrl,
  ...config.telegram,
  mode: config.botUpdates,
  pg,
  wallets,
  trading,
  auction,
  log: bootLog,
});
auction.on('change', (change) => void bot.notifyAuction(change));

const app = await buildApp({
  users,
  otp,
  wallets,
  payments,
  withdrawals,
  trading,
  auction,
  hub,
  photos,
  bot,
  botUsername: config.botUsername,
  logger: { level: config.logLevel },
});

if (!users.configured) app.log.warn('BOT_TOKEN is not set - every sign-in will answer 503');
if (config.sms.provider === 'console') app.log.warn('SMS_PROVIDER=console - one-time codes are written to this log, not sent');
if (config.payments.provider === 'fake') app.log.warn('PAYMENT_PROVIDER=fake - wallet charges go through a demo gateway and credit real wallets');

// Tables up front, so a database problem shows in the log at deploy time. Not
// fatal: the first request retries it.
users.ready().catch((err) => app.log.error({ err: { message: err.message } }, 'could not prepare the miniapp tables'));
// Kafka connects in the background and keeps retrying; the app serves without it.
exchange.start();

pg.on('error', (err) => app.log.error({ err }, 'postgres pool error'));

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  try {
    bot.stop();
    hub.close();
    await app.close();
    await exchange.close();
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
  if (bot.mode === 'polling') bot.poll();
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}
