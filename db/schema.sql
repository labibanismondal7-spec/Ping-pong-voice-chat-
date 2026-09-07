-- ============================================================
-- PingPong — Production Relational Schema (PostgreSQL / Railway)
-- v2 — REVISED after discovering the pre-existing Module 4 Wallet
-- Ledger (integration_update/module4_wallet_ledger/). Wallet tables
-- are intentionally NOT defined here — Module 4 owns wallet schema
-- (module4_wallet_ledger, module4_wallet_balances, see its own
-- wallet/schema.sql). This file covers everything else.
-- STATUS: STATICALLY VERIFIED (designed against actual source,
-- never executed — no network/Postgres access in this sandbox)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------- Reference data ----------
CREATE TABLE IF NOT EXISTS countries (
    code            TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Users ----------
-- NOTE: no diamonds/coins columns here on purpose. Live balance is
-- Module 4's module4_wallet_balances table once cutover completes;
-- until then the legacy user.diamonds/user.coins fields in users.json
-- remain authoritative (see WALLET_CUTOVER_PLAN.md). Do not add wallet
-- columns to this table — that would recreate the duplicate-authority
-- problem this revision fixes.
CREATE TABLE IF NOT EXISTS users (
    user_id         TEXT PRIMARY KEY,
    mobile          TEXT UNIQUE,
    display_name    TEXT,
    country_code    TEXT REFERENCES countries(code),
    verified        BOOLEAN NOT NULL DEFAULT false,
    banned          BOOLEAN NOT NULL DEFAULT false,
    is_host         BOOLEAN NOT NULL DEFAULT false,
    is_coin_center  BOOLEAN NOT NULL DEFAULT false,
    vip_level       INTEGER NOT NULL DEFAULT 0,
    svip_level      INTEGER NOT NULL DEFAULT 0,
    svip_wealth     BIGINT  NOT NULL DEFAULT 0,
    svip_membership_type TEXT DEFAULT 'permanent',
    svip_expire_at  TIMESTAMPTZ,
    agency_id       TEXT,
    level           INTEGER NOT NULL DEFAULT 1,
    xp              BIGINT  NOT NULL DEFAULT 0,
    profile_extra   JSONB NOT NULL DEFAULT '{}'::jsonb,  -- cosmetics/inventory long tail — see note in v1
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_mobile ON users(mobile);
CREATE INDEX IF NOT EXISTS idx_users_agency ON users(agency_id);
CREATE INDEX IF NOT EXISTS idx_users_country ON users(country_code);

CREATE TABLE IF NOT EXISTS follows (
    follower_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    followee_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (follower_id, followee_id)
);

CREATE TABLE IF NOT EXISTS otp_codes (
    id              BIGSERIAL PRIMARY KEY,
    mobile          TEXT NOT NULL,
    code_hash       TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    expires_at      TIMESTAMPTZ NOT NULL,
    resend_cooldown_until TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_otp_mobile ON otp_codes(mobile);

-- ---------- Rooms ----------
CREATE TABLE IF NOT EXISTS rooms (
    room_id         TEXT PRIMARY KEY,
    room_number     TEXT UNIQUE,
    name            TEXT NOT NULL,
    owner_user_id   TEXT NOT NULL REFERENCES users(user_id),
    country_code    TEXT REFERENCES countries(code),
    is_locked       BOOLEAN NOT NULL DEFAULT false,
    password_hash   TEXT,
    settings        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rooms_owner ON rooms(owner_user_id);

CREATE TABLE IF NOT EXISTS room_members (
    room_id         TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'member',
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS room_seats (
    room_id         TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
    seat_index      INTEGER NOT NULL,
    locked          BOOLEAN NOT NULL DEFAULT false,
    reserved_for_user_id TEXT REFERENCES users(user_id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, seat_index)
);

-- ---------- Gifts ----------
-- gift_transactions references Module 4's txn_id (TEXT, its own PK type)
-- rather than a local wallet_transactions table — Module 4 IS the ledger.
CREATE TABLE IF NOT EXISTS gifts_catalog (
    gift_id         TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    diamond_cost    BIGINT NOT NULL,
    image_url       TEXT,
    active          BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS gift_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gift_id         TEXT NOT NULL REFERENCES gifts_catalog(gift_id),
    sender_user_id  TEXT NOT NULL REFERENCES users(user_id),
    receiver_user_id TEXT NOT NULL REFERENCES users(user_id),
    room_id         TEXT REFERENCES rooms(room_id),
    quantity        INTEGER NOT NULL DEFAULT 1,
    diamond_cost    BIGINT NOT NULL,
    sender_txn_id   TEXT,    -- FK (by convention, not FK constraint) into module4_wallet_ledger.txn_id
    receiver_txn_id TEXT,    -- FK (by convention, not FK constraint) into module4_wallet_ledger.txn_id
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gift_txn_sender ON gift_transactions(sender_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gift_txn_receiver ON gift_transactions(receiver_user_id, created_at DESC);

-- ---------- Admin / RBAC ----------
CREATE TABLE IF NOT EXISTS admin_accounts (
    admin_id        TEXT PRIMARY KEY,
    user_id         TEXT REFERENCES users(user_id),
    role            TEXT NOT NULL,
    country_code    TEXT REFERENCES countries(code),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_logs (
    id              BIGSERIAL PRIMARY KEY,
    admin_id        TEXT REFERENCES admin_accounts(admin_id),
    action          TEXT NOT NULL,
    target_user_id  TEXT REFERENCES users(user_id),
    details         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bans (
    id              BIGSERIAL PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(user_id),
    reason          TEXT,
    banned_by       TEXT REFERENCES admin_accounts(admin_id),
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bans_user ON bans(user_id);

-- ---------- Legacy JSON-store backstop (perf/dbPersistence.js, pre-existing) ----------
DO $$
BEGIN
    IF to_regclass('public.app_json_store') IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='app_json_store' AND column_name='file_key')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='app_json_store' AND column_name='key') THEN
        ALTER TABLE app_json_store RENAME COLUMN file_key TO key;
    END IF;
    IF to_regclass('public.app_json_store') IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='app_json_store' AND column_name='payload')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='app_json_store' AND column_name='value') THEN
        ALTER TABLE app_json_store RENAME COLUMN payload TO value;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS app_json_store (
    key             TEXT PRIMARY KEY,
    value           JSONB NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Wallet: intentionally NOT defined here. Run
-- integration_update/module4_wallet_ledger/wallet/schema.sql for
-- module4_wallet_ledger + module4_wallet_balances instead.
--
-- Runtime state — NOT persisted anywhere: active WebSocket
-- connections, LiveKit participant state, live seat occupancy.
-- ============================================================
