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
-- The gateway's own reference for the charge, set once the gateway accepts it
-- (until then "authority" is only ours). Rows from before it reached their
-- gateway exactly when they got an authority, so those are copied over once.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'miniapp_payments' AND column_name = 'gateway_ref') THEN
    ALTER TABLE miniapp_payments ADD COLUMN gateway_ref TEXT;
    UPDATE miniapp_payments SET gateway_ref = authority WHERE authority IS NOT NULL;
  END IF;
END $$;
-- When the gateway confirmed the payment, which may be before the wallet was
-- credited, and what it answered (credentials stripped), for reconciliation.
ALTER TABLE miniapp_payments ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE miniapp_payments ADD COLUMN IF NOT EXISTS gateway_response JSONB;

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

export const RIAL_SCHEMA = `
-- The rial board: peer offers to have or want Toman, each with a receive
-- method (wallet / p2p / bank rail). Wallet "have" offers freeze IRT; bank and
-- p2p matches only record a trade for offline settlement.
CREATE TABLE IF NOT EXISTS miniapp_rial_offers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq              BIGSERIAL,
  exchange_user_id UUID NOT NULL,
  side             TEXT NOT NULL CHECK (side IN ('have', 'want')),
  amount           NUMERIC(36,18) NOT NULL CHECK (amount > 0),
  filled_amount    NUMERIC(36,18) NOT NULL DEFAULT 0 CHECK (filled_amount >= 0),
  held             NUMERIC(36,18) NOT NULL DEFAULT 0 CHECK (held >= 0),
  method           TEXT NOT NULL CHECK (method IN ('wallet', 'p2p', 'paya', 'satna')),
  destination      TEXT,
  description      TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 120),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partial', 'filled', 'cancelled')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS miniapp_rial_offers_open_idx ON miniapp_rial_offers (method, side, seq DESC)
  WHERE status IN ('open', 'partial');
CREATE INDEX IF NOT EXISTS miniapp_rial_offers_user_idx ON miniapp_rial_offers (exchange_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS miniapp_rial_trades (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             BIGSERIAL,
  amount          NUMERIC(36,18) NOT NULL CHECK (amount > 0),
  method          TEXT NOT NULL CHECK (method IN ('wallet', 'p2p', 'paya', 'satna')),
  status          TEXT NOT NULL CHECK (status IN ('matched', 'settled')),
  taker_side      TEXT NOT NULL CHECK (taker_side IN ('have', 'want')),
  have_offer_id   UUID NOT NULL,
  want_offer_id   UUID NOT NULL,
  have_user_id    UUID NOT NULL,
  want_user_id    UUID NOT NULL,
  destination     TEXT,
  executed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS miniapp_rial_trades_seq_idx ON miniapp_rial_trades (seq DESC);
CREATE INDEX IF NOT EXISTS miniapp_rial_trades_have_idx ON miniapp_rial_trades (have_user_id, seq DESC);
CREATE INDEX IF NOT EXISTS miniapp_rial_trades_want_idx ON miniapp_rial_trades (want_user_id, seq DESC);
-- Dropped "mellat" from the method list; tighten checks if the tables already existed with it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'miniapp_rial_offers') THEN
    ALTER TABLE miniapp_rial_offers DROP CONSTRAINT IF EXISTS miniapp_rial_offers_method_check;
    ALTER TABLE miniapp_rial_offers ADD CONSTRAINT miniapp_rial_offers_method_check
      CHECK (method IN ('wallet', 'p2p', 'paya', 'satna'));
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'miniapp_rial_trades') THEN
    ALTER TABLE miniapp_rial_trades DROP CONSTRAINT IF EXISTS miniapp_rial_trades_method_check;
    ALTER TABLE miniapp_rial_trades ADD CONSTRAINT miniapp_rial_trades_method_check
      CHECK (method IN ('wallet', 'p2p', 'paya', 'satna'));
  END IF;
END $$;
`;

export const P2P_SCHEMA = `
CREATE TABLE IF NOT EXISTS miniapp_p2p_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id UUID NOT NULL REFERENCES miniapp_rial_offers(id),
  payer_id UUID NOT NULL,
  receiver_id UUID NOT NULL,
  amount NUMERIC(36,18) NOT NULL CHECK (amount > 0),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN
    ('reserved','expired','awaiting_confirmation','admin_review','settled','rejected')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + interval '2 minutes'),
  receipt TEXT,
  receipt_reference TEXT,
  confirmation_due_at TIMESTAMPTZ,
  reviewed_by TEXT,
  review_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (payer_id <> receiver_id)
);
CREATE INDEX IF NOT EXISTS miniapp_p2p_pending_idx ON miniapp_p2p_payments(status, expires_at);
CREATE INDEX IF NOT EXISTS miniapp_p2p_payer_idx ON miniapp_p2p_payments(payer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS miniapp_p2p_receiver_idx ON miniapp_p2p_payments(receiver_id, created_at DESC);

-- Shared by the customer app and the authenticated backoffice. The caller
-- authorizes the actor; this function serializes and audits money movement.
CREATE OR REPLACE FUNCTION miniapp_p2p_resolve(payment_id UUID, decision TEXT, actor_name TEXT, reason_text TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE p miniapp_p2p_payments%ROWTYPE; w RECORD; recipient RECORD;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('miniapp_rial'));
  SELECT * INTO p FROM miniapp_p2p_payments WHERE id=payment_id FOR UPDATE;
  IF NOT FOUND OR p.status NOT IN ('awaiting_confirmation','admin_review') THEN
    RAISE EXCEPTION 'payment no longer eligible for review';
  END IF;
  IF decision NOT IN ('settled','rejected') THEN RAISE EXCEPTION 'invalid decision'; END IF;
  -- Stable wallet locking order avoids reciprocal payment deadlocks.
  PERFORM 1 FROM exchange.users WHERE id IN (p.receiver_id,p.payer_id) ORDER BY id FOR SHARE;
  IF EXISTS (SELECT 1 FROM exchange.users WHERE id IN (p.receiver_id,p.payer_id) AND status='closed') THEN
    RAISE EXCEPTION 'exchange account is closed';
  END IF;
  IF decision='settled' THEN
    INSERT INTO exchange.wallets(user_id,asset) VALUES(p.payer_id,'IRT') ON CONFLICT(user_id,asset) DO NOTHING;
  END IF;
  PERFORM 1 FROM exchange.wallets WHERE asset='IRT' AND user_id IN(p.receiver_id,p.payer_id) ORDER BY user_id FOR UPDATE;
  UPDATE exchange.wallets SET frozen=frozen-p.amount,
    available=available+CASE WHEN decision='rejected' THEN p.amount ELSE 0 END, updated_at=now()
    WHERE user_id=p.receiver_id AND asset='IRT' AND status<>'closed' AND frozen>=p.amount RETURNING * INTO w;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient frozen balance'; END IF;
  INSERT INTO exchange.wallet_entries(wallet_id,user_id,asset,kind,amount,available_delta,frozen_delta,locked_delta,
    available_after,frozen_after,locked_after,reference_type,reference_id,reason,actor)
  VALUES(w.id,p.receiver_id,'IRT',CASE WHEN decision='settled' THEN 'trade' ELSE 'unfreeze' END,p.amount,
    CASE WHEN decision='rejected' THEN p.amount ELSE 0 END,-p.amount,0,w.available,w.frozen,w.locked,
    'p2p_payment',p.id,reason_text,actor_name);
  IF decision='settled' THEN
    UPDATE exchange.wallets SET available=available+p.amount,updated_at=now()
      WHERE user_id=p.payer_id AND asset='IRT' AND status<>'closed' RETURNING * INTO recipient;
    IF NOT FOUND THEN RAISE EXCEPTION 'recipient wallet closed'; END IF;
    INSERT INTO exchange.wallet_entries(wallet_id,user_id,asset,kind,amount,available_delta,frozen_delta,locked_delta,
      available_after,frozen_after,locked_after,reference_type,reference_id,reason,actor)
    VALUES(recipient.id,p.payer_id,'IRT','trade',p.amount,p.amount,0,0,recipient.available,recipient.frozen,recipient.locked,
      'p2p_payment',p.id,reason_text,actor_name);
  END IF;
  UPDATE miniapp_rial_offers SET held=held-p.amount,updated_at=now() WHERE id=p.offer_id AND held>=p.amount;
  IF NOT FOUND THEN RAISE EXCEPTION 'offer hold inconsistent'; END IF;
  UPDATE miniapp_p2p_payments SET status=decision,reviewed_by=actor_name,review_reason=reason_text,updated_at=now() WHERE id=p.id;
END $$;
`;

export const SCHEMA = CORE_SCHEMA + AUCTION_SCHEMA + RIAL_SCHEMA + P2P_SCHEMA + `
-- Browser customers need no Telegram account. Existing identities are retained.
ALTER TABLE miniapp_users ALTER COLUMN telegram_id DROP NOT NULL;
CREATE TABLE IF NOT EXISTS miniapp_web_logins (
  id UUID PRIMARY KEY,
  phone TEXT NOT NULL,
  ip TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS miniapp_web_logins_phone_idx ON miniapp_web_logins(phone, created_at DESC);
CREATE INDEX IF NOT EXISTS miniapp_web_logins_ip_idx ON miniapp_web_logins(ip, created_at DESC);

ALTER TABLE miniapp_withdrawals ADD COLUMN IF NOT EXISTS bank_account_id UUID;
ALTER TABLE miniapp_withdrawals ADD COLUMN IF NOT EXISTS recipient_type TEXT CHECK (recipient_type IN ('saved', 'other'));
ALTER TABLE miniapp_withdrawals ADD COLUMN IF NOT EXISTS beneficiary_name TEXT;
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
