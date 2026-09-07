# POSTGRESQL_PERSISTENCE_AUDIT_FINAL.md

**Objective of this pass:** production-safe PostgreSQL persistence + verified Stage-2 readiness —
**not** wallet cutover. Nothing in this pass touches `server.js`, any of the 25/27 wallet mutation
sites, or `MODULE4_WALLET_ENABLED`. No JSON file was deleted or modified. No destructive operation
was run against any database (this sandbox has none to run against, and production would be refused
regardless).

---

## 1. Data persistence audit (7-point check per category)

Legend: **JSON-only** = no Postgres involvement yet · **Blob-mirrored** = `perf/dbPersistence.js`
whole-file mirror to `app_json_store` (survives redeploy, not queryable/relational) · **Schema-designed** =
a real table exists in `db/schema.sql` (this package) but nothing migrates into it yet · **Module 4** =
covered by the separate, already-tested wallet ledger.

| Data | (1) Written where now | (2) JSON primary? | (3) PG mirror? | (4) PG schema exists? | (5) Restorable from PG? | (6) Survives Railway redeploy? | (7) Migration complete? |
|---|---|---|---|---|---|---|---|
| Users (identity/profile) | `data/users.json` | Yes | Yes, if `DATABASE_URL` set | Yes (`users` table, this package) | Yes, either way (blob or table) | Yes, if `DATABASE_URL` set (blob mirror) or after §4 migration runs | **No** — schema exists, migration script exists, neither has been run against real Postgres |
| Coins / Diamonds (balances) | `user.coins`/`user.diamonds` fields in `users.json` | Yes | Yes (as part of the users.json blob) | Yes — but in **Module 4's** schema (`module4_wallet_balances`), not this package's `users` table (intentionally) | Blob: yes. Ledger: yes, once seeded | Blob: yes if `DATABASE_URL` set. Real authority: not yet — legacy path still live | **No** — Stage 2 (opening balance seed + reconcile) not yet run against real Postgres |
| Wallet transactions | `data/transactions.json`, `coinLedger.json`, `rechargeTransactions.json`, `transactions_archive.json` | Yes | Yes (blob) | Yes — Module 4's `module4_wallet_ledger`, append-only | Blob: yes | Blob: yes if configured | **No** — legacy files keep growing; Module 4 ledger only gets opening-balance rows until Stage 3 |
| Rooms | `data/rooms.json` | Yes | Yes (blob) | Yes (`rooms`, `room_members`, `room_seats`, this package) | Blob: yes | Blob: yes if configured | **No** |
| Room members/seats | embedded in `rooms.json` | Yes | Yes (blob, whole-file) | Yes (this package) | Blob: yes | Blob: yes if configured | **No** |
| Gifts (catalog) | `data/gifts_catalog.json` | Yes | Yes (blob) | Yes (`gifts_catalog`, this package) | Blob: yes | Blob: yes if configured | **No** |
| Gift transactions/logs | `data/gift_log.json`, `gift_history.json` | Yes | Yes (blob) | Yes (`gift_transactions`, this package — references Module 4 `txn_id` by convention) | Blob: yes | Blob: yes if configured | **No** |
| Messages | `data/messages.json` | Yes | Yes (blob) | **No** — not modeled in this pass | Blob: yes | Blob: yes if configured | **No, not yet designed** |
| Agencies | `agencies.json`, `agency_invites.json`, `agency_requests.json` | Yes | Yes (blob) | **No** — not modeled | Blob: yes | Blob: yes if configured | **No, not yet designed** |
| Frames (catalog + per-user inventory) | `frame_catalog.json` (catalog); `user.frameInventory` (per-user, inside `users.json`) | Yes | Yes (blob) | Catalog: no. Per-user: covered generically by `users.profile_extra JSONB` (this package) | Blob: yes | Blob: yes if configured | **No** |
| Rankings | **Not persisted at all** — `rankings/ranking.service.js` computes leaderboards on the fly from gift-history entries + live room data, in memory, on each request | No | N/A | N/A — derived data, no store to migrate | N/A | N/A (recomputed from gift transactions + rooms, which do need to migrate) | **N/A — nothing to migrate here; correctness depends on gift/room migration instead** |
| Admin accounts | `data/admin_accounts.json` | Yes | Yes (blob) | Yes (`admin_accounts`, this package) | Blob: yes | Blob: yes if configured | **No** |
| Admin logs | `data/admin_logs.json` | Yes | Yes (blob) | Yes (`admin_logs`, this package) | Blob: yes | Blob: yes if configured | **No** |
| Bans | `data/bans.json` | Yes | Yes (blob) | Yes (`bans`, this package) | Blob: yes | Blob: yes if configured | **No** |
| OTP | `data/otpStore.json`, via `security/otpService.js` | Yes | Yes (blob) | Yes (`otp_codes`, this package) | Blob: yes | Blob: yes if configured | **No** — also short-lived data, low migration priority |
| Announcements | `data/announcements.json` | Yes | Yes (blob) | **No** — not modeled | Blob: yes | Blob: yes if configured | **No, not yet designed** |
| VIP/SVIP | `vip_memberships.json`, `svip_*.json` | Yes | Yes (blob) | Partial — queryable fields (`vip_level`, `svip_*`) are columns on `users`; full detail not modeled | Blob: yes | Blob: yes if configured | **Partial** |
| Countries | referenced by code in `users.json` | Yes | Yes (blob, indirectly) | Yes (`countries`, this package) | Blob: yes | Blob: yes if configured | **No** |
| Clubs | `clubs.json` + related (all near-empty — feature looks unlaunched) | Yes | Yes (blob) | **No** — deferred, low priority | Blob: yes | Blob: yes if configured | **Deferred** |
| Call hosting | `callhosting_*.json` | Yes | Yes (blob) | **No** — not modeled | Blob: yes | Blob: yes if configured | **No, not yet designed** |
| **Runtime state** (live sockets, LiveKit participants, live seat occupancy) | In-memory only | N/A | N/A — must never be persisted | N/A | N/A | N/A — rebuilt from `rooms`/`room_members`/`room_seats` on reconnect once those migrate | **N/A by design** |

**Bottom line answer to (6) for the project as a whole:** if `DATABASE_URL` is set today (unchanged
from before this pass), `perf/dbPersistence.js`'s existing blob mirror means **no data is lost** on a
Railway redeploy/container replacement right now — every JSON file gets restored from its
`app_json_store` blob at boot. What's still missing is **queryability and relational integrity**
(the reason to migrate at all), not basic durability — that's a separate, already-solved problem in
this codebase (Phase 12), described accurately, not something this pass needed to fix.

---

## 2. PostgreSQL persistence readiness

Schema, repository pattern, and idempotent migration script prepared for: `users`, `rooms`,
`room_members`, `room_seats`, `gifts_catalog`, `gift_transactions`, `countries`, `otp_codes`,
`admin_accounts`, `admin_logs`, `bans` (all in `db/schema.sql` + `db/migrations/001_migrate_users.js`,
carried over unchanged from the previous pass). **Not modeled yet:** messages, agencies, frames catalog,
announcements, call hosting, clubs — flagged, not designed, per the instruction to scan/report rather
than rewrite blind. No live code was changed to read from these tables — they exist only as schema +
a migration script for `users`, ready to run in staging.

---

## 3. Module 4 Wallet — Stage 2 readiness (this pass's main deliverable)

- **Existing per-user tooling** (`scripts/wallet-opening-balance-migration.js`, pre-existing, not
  modified) already does: dry-run by default, `--execute` gate, idempotent (`getTransaction()` check
  before seeding), per-user `reconcileBalance()` call, mismatch warnings, timestamped JSON report,
  non-zero exit code on any mismatch or error. This was read and verified line-by-line, not assumed —
  it satisfies most of what was asked without needing changes.
- **New this pass:** `scripts/wallet-aggregate-reconciliation.js` — adds the totals-level check that
  wasn't there before: total legacy users, total legacy coins, total legacy diamonds vs. Module 4
  ledger's summed `module4_wallet_balances`, with a hard failure (non-zero exit) on any mismatch. Purely
  read-only against Postgres (SELECT/SUM only) and against `users.json` (never writes to either).
- **New this pass:** `WALLET_CALL_SITE_MAPPING_VERIFIED.md` — re-ran the original plan's own trace
  methodology against the current codebase and found `server.js`'s line numbers in
  `WALLET_CUTOVER_PLAN.md` are **stale** (file grew from 6,697 to 8,056 lines since the plan was
  written). Produced corrected line numbers for all 18 `server.js` sites; confirmed the other 7 sites
  (in `coinCenter.js`, `diamondSeller.js`, `callHosting.js`, `rechargeWithdrawApproval.js`) are
  unchanged. Total is still 25 real sites — none appeared or disappeared, they just moved. Each row
  maps to the exact Module 4 function (`credit`/`debit`/`transferBetweenUsers`) it should use in Stage 3.
- **Idempotency:** verified by reading the code, not assumed — `transferBetweenUsers()` uses
  `ON CONFLICT (txn_id) DO NOTHING` plus a replay path that returns the original result if the same
  `txnId` is submitted twice. The opening-balance script's `txnId` scheme
  (`opening-balance:<userId>:<currency>`) is deterministic, so re-running it is safe by construction.
- **Duplicate-balance prevention:** covered by the same `txnId` uniqueness — a second run either skips
  (per-user script's `getTransaction()` check) or no-ops (ledger's own `ON CONFLICT`).

**Stage 2 readiness status: tooling-ready, not execution-verified.** Both scripts require a real
`MODULE4_WALLET_DATABASE_URL` pointing at staging Postgres, which this sandbox cannot provide. Next
real step: run both scripts against a staging copy of `data/users.json` in Claude Code.

---

## 4. Rollback / recovery procedure

- **Migration rollback:** every script here (`001_migrate_users.js`, the pre-existing opening-balance
  script, the new aggregate reconciliation script) is additive-only against Postgres and read-only
  against JSON. Rollback = stop the app from reading Postgres (nothing currently does, by design) and/or
  `DROP TABLE`/`TRUNCATE` the specific new tables in staging — the legacy JSON files are untouched
  throughout, so there is no "restore" needed for them; they were never at risk.
- **Wallet-specific rollback:** `MODULE4_WALLET_ENABLED` stays `false` throughout this pass (unchanged).
  If Stage 3 is later attempted and something looks wrong, the flag flips back to `false` and the app
  reverts to the legacy `user.coins`/`user.diamonds` path instantly — no data migration reversal needed
  because the legacy path was never turned off.
- **Postgres-level:** Railway's Postgres plugin backup/point-in-time-restore (dashboard-configured,
  same as flagged in the previous pass) is the safety net for anything written to Postgres itself.

---

## 5. Stage 3 readiness

**Not started, correctly.** `server.js` and all 25/27 call sites are byte-for-byte unchanged from your
upload. What Stage 3 needs before it can begin (per your own ordering): Stage 2's aggregate +
per-user reconciliation both passing clean on real staging Postgres. `WALLET_CALL_SITE_MAPPING_VERIFIED.md`
(this pass) is prep work for Stage 3 — the mapping is now current, but no code was written into
`server.js` from it.

---

## 6. Railway environment variables needed

| Variable | Purpose | Notes |
|---|---|---|
| `DATABASE_URL` | Main app Postgres connection (`perf/dbPersistence.js`, this package's `db/schema.sql` tables) | Provisioned by Railway's Postgres plugin |
| `MODULE4_WALLET_DATABASE_URL` | Module 4's wallet ledger connection (falls back to `DATABASE_URL` if unset, per `wallet/db.js`) | Can point at the same instance or a separate one — your call |
| `MODULE4_WALLET_ENABLED` | Feature flag for Stage 3 cutover | **Must stay `false`/unset until Stage 3 is explicitly approved** |
| `PGSSL` | Set to `"false"` only if your Postgres doesn't need TLS (rare on Railway) | Both `dbPersistence.js` and Module 4's `db.js` default to requiring SSL |

No values for any of these were created or guessed in this pass — only the variable names, read from
the source. No `.env` file with real values exists anywhere in this project (`.env.example` and
`.env.production.example` only — confirmed by listing).

---

## 7. Migration & reconciliation commands (for Claude Code + real staging Postgres)

```bash
# 1. Apply non-wallet schema
psql "$DATABASE_URL" -f db/schema.sql

# 2. Apply Module 4's own wallet schema (pre-existing, unchanged)
psql "$MODULE4_WALLET_DATABASE_URL" -f integration_update/module4_wallet_ledger/wallet/schema.sql

# 3. Migrate user identity fields (dry nothing to check first — INSERT ON CONFLICT is safe to re-run)
node db/migrations/001_migrate_users.js

# 4. Stage 2, dry run first (default, no writes)
node scripts/wallet-opening-balance-migration.js

# 5. Stage 2, execute against STAGING only
MODULE4_WALLET_DATABASE_URL=... node scripts/wallet-opening-balance-migration.js --execute

# 6. Stage 2, aggregate totals check (new, this pass)
MODULE4_WALLET_DATABASE_URL=... node scripts/wallet-aggregate-reconciliation.js

# 7. Re-verify per-user reconciliation any time, read-only
MODULE4_WALLET_DATABASE_URL=... node scripts/wallet-opening-balance-migration.js --execute --verify-only
```

Both reconciliation commands (5 and 6) must show zero mismatches before Stage 3 is even considered.

---

## 8. Remaining risks

- **`server.js` line-number drift is ongoing** — it's an actively edited 8,056-line file; the mapping
  in this pass is accurate as of this audit, but should be re-verified again immediately before Stage 3
  actually starts, not assumed still current.
- **Gift economics assumption unconfirmed** (flagged in the mapping table, row 6): whether coins spent
  by a sender map 1:1 to diamonds received, or go through a house/platform cut, wasn't verified against
  business logic — needs a product/finance confirmation before wiring `transferBetweenUsers` for gifts.
- **Six data domains have no Postgres schema yet** (messages, agencies, frame catalog, announcements,
  call hosting, clubs) — currently protected only by the blob mirror, not queryable/relational.
- **No live test has been run against real Postgres in this project by me** — everything in this and
  the two prior passes is STATICALLY VERIFIED (matches real source) but NOT VERIFIED by execution.
- **`clampCoinBalance`/`clampDiamondBalance` business logic** (referenced throughout the mutation
  sites) wasn't reviewed in this pass — Stage 3's `wallet.credit`/`debit` calls will need to preserve
  whatever clamping/limits that logic currently enforces, or those safeguards get silently dropped.

---

## Explicit compliance with the final rule

This project is **not** described as "fully PostgreSQL migrated" anywhere in this document. Per the
six conditions you listed, none have been met yet: no real staging migration has run, no reconciliation
has executed, Module 4's ledger hasn't been seeded or verified against real data, Stage 3 hasn't
started, no regression tests have run, and there has been no production cutover. Current honest status:
**schema + tooling + verified mapping ready for Stage 2, pending a real Railway staging Postgres
connection.**
