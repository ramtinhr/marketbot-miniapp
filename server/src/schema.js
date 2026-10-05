// The mini app's own tables, in the bot's Postgres under miniapp_*. Applied on
// first use, so it must stay idempotent: a change to a table is a new
// ALTER ... IF NOT EXISTS, never an edit to a CREATE that has already run.
//
// Money itself is not here: balances and their ledger are the exchange's
// (exchange.wallets, exchange.wallet_entries, owned by marketbot-engine). The
// tables here only reference them, without foreign keys, so the app starts
// whether or not the engine has created its schema yet.

const CORE_SCHEMA = `
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

export const AUCTION_SCHEMA = `
-- The auction: users' limit orders on a book of their own, matched only with
-- each other, never with venue liquidity or the engine's book. What an open
-- order still holds (Toman at its limit for a buy, the coin for a sell) is
-- frozen in the exchange wallet and tracked in "held".
CREATE TABLE IF NOT EXISTS miniapp_auction_orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq              BIGSERIAL,
  exchange_user_id UUID NOT NULL,
  symbol           TEXT NOT NULL,
  side             TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  price            NUMERIC(36,18) NOT NULL CHECK (price > 0),
  quantity         NUMERIC(36,18) NOT NULL CHECK (quantity > 0),
  filled_quantity  NUMERIC(36,18) NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
  filled_quote     NUMERIC(36,18) NOT NULL DEFAULT 0 CHECK (filled_quote >= 0),
  held             NUMERIC(36,18) NOT NULL DEFAULT 0 CHECK (held >= 0),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partial', 'filled', 'cancelled')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS miniapp_auction_orders_book_idx ON miniapp_auction_orders (symbol, side, price, seq)
  WHERE status IN ('open', 'partial');
CREATE INDEX IF NOT EXISTS miniapp_auction_orders_user_idx ON miniapp_auction_orders (exchange_user_id, created_at DESC);
-- What the poster adds to an offer, shown with it on the board.
ALTER TABLE miniapp_auction_orders ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 120);

CREATE TABLE IF NOT EXISTS miniapp_auction_trades (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq           BIGSERIAL,
  symbol        TEXT NOT NULL,
  price         NUMERIC(36,18) NOT NULL CHECK (price > 0),
  quantity      NUMERIC(36,18) NOT NULL CHECK (quantity > 0),
  taker_side    TEXT NOT NULL CHECK (taker_side IN ('buy', 'sell')),
  buy_order_id  UUID NOT NULL,
  sell_order_id UUID NOT NULL,
  buy_user_id   UUID NOT NULL,
  sell_user_id  UUID NOT NULL,
  executed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS miniapp_auction_trades_symbol_idx ON miniapp_auction_trades (symbol, seq DESC);
CREATE INDEX IF NOT EXISTS miniapp_auction_trades_buyer_idx ON miniapp_auction_trades (buy_user_id, seq DESC);
CREATE INDEX IF NOT EXISTS miniapp_auction_trades_seller_idx ON miniapp_auction_trades (sell_user_id, seq DESC);
`;

export const SCHEMA = CORE_SCHEMA + AUCTION_SCHEMA;

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
