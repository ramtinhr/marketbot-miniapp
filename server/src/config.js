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

export const config = {
  host: str('HOST', '0.0.0.0'),
  port: int('PORT', 8090),
  logLevel: str('LOG_LEVEL', 'info'),

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
};
