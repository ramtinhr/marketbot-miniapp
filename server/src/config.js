import 'dotenv/config';

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function str(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

const production = str('NODE_ENV', 'development') === 'production';

export const config = {
  host: str('HOST', '0.0.0.0'),
  port: int('PORT', 8090),
  logLevel: str('LOG_LEVEL', 'info'),
  production,
  // Where users reach the app (https://...), for the payment gateway's return URL.
  publicUrl: str('PUBLIC_URL', '').replace(/\/+$/, ''),
  // Without @, for the "back to Telegram" link after a payment.
  botUsername: str('BOT_USERNAME', ''),

  // The bot's database; DB_* are the bot's own variable names.
  db: {
    host: str('DB_HOST', 'localhost'),
    port: int('DB_PORT', 5432),
    user: str('DB_USER', 'marketbot'),
    password: str('DB_PASSWORD', 'marketbot123'),
    database: str('DB_NAME', 'marketbot'),
    ssl: str('DB_SSLMODE', 'disable') !== 'disable',
  },

  auth: {
    botToken: str('BOT_TOKEN', ''),
    initDataMaxAgeSeconds: int('INIT_DATA_MAX_AGE_SECONDS', 86_400),
    contactMaxAgeSeconds: int('CONTACT_MAX_AGE_SECONDS', 600),
    ttlHours: int('SESSION_TTL_HOURS', 720),
    idleMinutes: int('SESSION_IDLE_MINUTES', 10_080),
  },

  otp: {
    ttlSeconds: int('OTP_TTL_SECONDS', 120),
    resendSeconds: int('OTP_RESEND_SECONDS', 60),
    maxAttempts: int('OTP_MAX_ATTEMPTS', 5),
    maxPerHour: int('OTP_MAX_PER_HOUR', 6),
  },

  sms: {
    // "kavenegar" in production; "console" only logs the code, for development.
    provider: str('SMS_PROVIDER', production ? 'kavenegar' : 'console'),
    kavenegarApiKey: str('KAVENEGAR_API_KEY', ''),
    // A Kavenegar verify template with one %token% for the code.
    kavenegarTemplate: str('KAVENEGAR_OTP_TEMPLATE', ''),
  },

  payments: {
    // "zarinpal", or "fake" - a local stand-in gateway for demos, refused in production.
    provider: str('PAYMENT_PROVIDER', production ? 'zarinpal' : 'fake'),
    zarinpalMerchantId: str('ZARINPAL_MERCHANT_ID', ''),
    zarinpalSandbox: bool('ZARINPAL_SANDBOX', !production),
    minToman: int('CHARGE_MIN_TOMAN', 10_000),
    maxToman: int('CHARGE_MAX_TOMAN', 50_000_000),
  },

  exchange: {
    brokers: str('KAFKA_BROKERS', '')
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean),
    clientId: str('KAFKA_CLIENT_ID', 'marketbot-miniapp'),
    // How far past the deepest level a market order may reach, so a book that
    // moved while the order was on its way still fills it. In basis points.
    marketSlippageBps: int('MARKET_SLIPPAGE_BPS', 50),
  },
};
