
DROP SCHEMA IF EXISTS exchange CASCADE;
CREATE SCHEMA exchange;
CREATE TABLE exchange.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended', 'closed'))
);
CREATE TABLE exchange.wallets (
  id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  user_id uuid NOT NULL REFERENCES exchange.users (id),
  asset text NOT NULL,
  available numeric(36,18) NOT NULL DEFAULT 0 CHECK (available >= 0),
  frozen numeric(36,18) NOT NULL DEFAULT 0 CHECK (frozen >= 0),
  locked numeric(36,18) NOT NULL DEFAULT 0 CHECK (locked >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'closed')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, asset)
);
CREATE TABLE exchange.wallet_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wallet_id uuid NOT NULL REFERENCES exchange.wallets (id),
  user_id uuid NOT NULL REFERENCES exchange.users (id),
  asset text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('opening', 'credit', 'debit', 'freeze', 'unfreeze', 'lock', 'unlock', 'trade')),
  amount numeric(36,18) NOT NULL CHECK (amount >= 0),
  available_delta numeric(36,18) NOT NULL DEFAULT 0,
  frozen_delta numeric(36,18) NOT NULL DEFAULT 0,
  locked_delta numeric(36,18) NOT NULL DEFAULT 0,
  available_after numeric(36,18) NOT NULL,
  frozen_after numeric(36,18) NOT NULL,
  locked_after numeric(36,18) NOT NULL,
  reference_type text,
  reference_id text,
  reason text,
  actor text NOT NULL,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
DROP TABLE IF EXISTS miniapp_p2p_payments, miniapp_rial_offers, miniapp_rial_trades;
