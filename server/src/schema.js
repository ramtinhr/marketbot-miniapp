// The mini app's own tables, in the bot's Postgres under miniapp_*. Applied on
// first use, so it must stay idempotent: a change to a table is a new
// ALTER ... IF NOT EXISTS, never an edit to a CREATE that has already run.
//
// Money itself is not here: balances and their ledger are the exchange's
// (exchange.wallets, exchange.wallet_entries, owned by marketbot-engine). The
// tables here only reference them, without foreign keys, so the app starts
// whether or not the engine has created its schema yet.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS miniapp_users (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT NOT NULL UNIQUE,
  phone         TEXT UNIQUE,
  first_name    TEXT,
  last_name     TEXT,
  username      TEXT,
  language_code TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  blocked_at    TIMESTAMPTZ
);
-- The exchange account that holds this user's wallets and orders, linked the
-- first time the user proves the phone number by SMS.
ALTER TABLE miniapp_users ADD COLUMN IF NOT EXISTS exchange_user_id UUID UNIQUE;
ALTER TABLE miniapp_users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS miniapp_sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES miniapp_users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS miniapp_sessions_user_idx ON miniapp_sessions (user_id);
-- Every session confirms a code sent by SMS before it can touch money.
ALTER TABLE miniapp_sessions ADD COLUMN IF NOT EXISTS otp_verified_at TIMESTAMPTZ;

-- One-time codes. Only an HMAC of the code is kept.
CREATE TABLE IF NOT EXISTS miniapp_otps (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES miniapp_users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('login', 'withdraw')),
  phone       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  attempts    INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS miniapp_otps_user_idx ON miniapp_otps (user_id, purpose, created_at DESC);

-- Wallet top-ups through a payment gateway. Credited to the exchange wallet
-- once, when the gateway confirms the payment.
CREATE TABLE IF NOT EXISTS miniapp_payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          BIGINT NOT NULL REFERENCES miniapp_users(id),
  exchange_user_id UUID NOT NULL,
  provider         TEXT NOT NULL,
  amount_toman     BIGINT NOT NULL CHECK (amount_toman > 0),
  authority        TEXT UNIQUE,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'cancelled')),
  ref_id           TEXT,
  card_pan         TEXT,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS miniapp_payments_user_idx ON miniapp_payments (user_id, created_at DESC);

-- Withdrawal requests. The amount is frozen in the wallet when requested; an
-- operator pays it out (debit from frozen) or rejects it (unfreeze).
CREATE TABLE IF NOT EXISTS miniapp_withdrawals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          BIGINT NOT NULL REFERENCES miniapp_users(id),
  exchange_user_id UUID NOT NULL,
  asset            TEXT NOT NULL,
  amount           NUMERIC(36,18) NOT NULL CHECK (amount > 0),
  network          TEXT,
  destination      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'paid', 'rejected', 'cancelled')),
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS miniapp_withdrawals_user_idx ON miniapp_withdrawals (user_id, created_at DESC);
`;

/** Applies SCHEMA once per pool; a failure is retried on the next call. */
export function schemaReady(pg) {
  if (!pg.__miniappSchema) {
    pg.__miniappSchema = pg.query(SCHEMA).catch((err) => {
      pg.__miniappSchema = null;
      throw err;
    });
  }
  return pg.__miniappSchema;
}
