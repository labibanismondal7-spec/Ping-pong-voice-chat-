# PingPong — Final PostgreSQL Migration Plan (v2, consolidated)

**Supersedes** the earlier `MIGRATION_REPORT.md` on the wallet question only. Everything else in
that report (rooms, gifts non-wallet parts, admin, OTP, the "60+ JSON files" audit, the honest
STATICALLY VERIFIED / NOT VERIFIED labeling) still stands — read it for full context. This document
exists to fix one specific mistake: the first pass built a second, competing wallet schema
(`wallets`/`wallet_transactions`/`wallet.repository.js`) without discovering that the project already
has a complete one. That duplicate is now removed. This is the corrected, single source of truth.

## The one decision this plan enforces

**Module 4 Wallet Ledger (`integration_update/module4_wallet_ledger/`) is the only wallet authority.**
Nothing else defines a `wallets`, `wallet_transactions`, or equivalent balance table. Module 4 already
has: a tested schema (`wallet/schema.sql` → `module4_wallet_ledger`, `module4_wallet_balances`), an
idempotent atomic API (`credit`, `debit`, `transferBetweenUsers`, `getBalance`, `reconcileBalance`),
unit tests against a mock Postgres, and its own staged cutover plan (`WALLET_CUTOVER_PLAN.md`) that
already traced all **25 real wallet mutation sites**. None of that is being rebuilt.

## What changed from v1

| | v1 (first pass) | v2 (this plan) |
|---|---|---|
| Wallet schema | New `wallets`/`wallet_transactions` tables in `schema.sql` | **Removed.** Module 4's existing schema is authority. |
| Wallet code | New `wallet.repository.js` (untested, competing) | **Removed.** See `CALL_SITE_PATTERN_EXAMPLE.js` — a reference for wiring the 25 sites to Module 4's real API instead. |
| Wallet migration | `001_migrate_users_and_wallets.js` seeded wallet balances too | Split: `001_migrate_users.js` now migrates **identity/profile fields only**; wallet opening balances stay with the pre-existing `scripts/wallet-opening-balance-migration.js`, run per Module 4's own Stage 2 |
| Non-wallet schema (`users`, `rooms`, `room_members`, `room_seats`, `gifts_catalog`, `gift_transactions`, `countries`, `otp_codes`, `admin_accounts`, `admin_logs`, `bans`) | designed | **unchanged, still valid** — `gift_transactions.sender_txn_id`/`receiver_txn_id` now reference Module 4's `txn_id` by convention instead of a local table |

## Execution order (staging, before any production cutover)

This is Module 4's own `WALLET_CUTOVER_PLAN.md` Stage 2–4, plus where the non-wallet schema slots in:

1. **Provision Railway PostgreSQL**, set `DATABASE_URL` (infrastructure — must happen in Railway's
   dashboard, not from any sandbox).
2. Run `db/schema.sql` (v2, this package) — creates `users`, `rooms`, `room_members`, `room_seats`,
   `gifts_catalog`, `gift_transactions`, `countries`, `otp_codes`, `admin_accounts`, `admin_logs`,
   `bans`, and the pre-existing `app_json_store` backstop.
3. Run Module 4's own `integration_update/module4_wallet_ledger/migrations/001_module4_wallet_extension.sql`
   (or `wallet/schema.sql`, same content) — creates `module4_wallet_ledger`, `module4_wallet_balances`.
4. Run `db/migrations/001_migrate_users.js` against staging — migrates user identity fields.
5. **Stage 2 (Module 4's plan, unchanged):** run `scripts/wallet-opening-balance-migration.js --execute`
   against a **staging copy** of `data/users.json`. Every entry in the generated
   `migration-report-*.json` must show `status: "reconciled"` and `matches: true` before proceeding.
   Do not skip this — it's the check that opening balances actually match the legacy JSON.
6. **Stage 3 (Module 4's plan, unchanged):** rewrite the 25 traced call sites in `server.js`,
   `coinCenter.js`, `diamondSeller.js`, `callHosting.js`, `rechargeWithdrawApproval.js` one at a time,
   each behind `MODULE4_WALLET_ENABLED` — see `CALL_SITE_PATTERN_EXAMPLE.js` in this package for the
   exact shape, using Module 4's `credit`/`debit`/`transferBetweenUsers`, not a custom repository.
7. Test each rewritten site in staging with the flag on; keep the flag off in production until all 25
   are done and verified.
8. **Reconcile** balances (`reconcileBalance()`, already built into Module 4) before flipping
   `MODULE4_WALLET_ENABLED=true` in production.
9. Only after production cutover is stable: retire the legacy `user.coins`/`user.diamonds` JSON path
   and the `app_json_store` blob mirror for wallet-adjacent files, per Rule 5 (verify before removing).

## What this package contains

- `schema.sql` — non-wallet relational schema (v2, wallet tables removed)
- `migrations/001_migrate_users.js` — user identity migration only (wallet split out)
- `CALL_SITE_PATTERN_EXAMPLE.js` — one of the 25 call sites rewritten using Module 4's real API, as
  the pattern for the other 24 (not applied to `server.js` — that's Stage 3, staging-gated)

## What this package deliberately does NOT do

- Does not touch `server.js` or any of the other 24 call sites yet — Stage 3 requires Stage 2's
  reconciliation to pass first, on real staging Postgres, which no sandbox here can run.
- Does not flip `MODULE4_WALLET_ENABLED`.
- Does not migrate rooms/gifts/admin data yet — same reasoning as before: safer to do incrementally,
  with each step's script verified against real Postgres in Claude Code rather than five more
  untested scripts written blind in one pass.

## Status

Everything in this package is **STATICALLY VERIFIED** (matches the real source, including Module 4's
actual function signatures — `transferBetweenUsers({fromUserId, toUserId, currency, amount, txnId,
reason, context})` was read directly from `wallet/index.js`, not guessed) and **NOT VERIFIED** by
execution. The next real milestone is Stage 2 above, on a real Railway staging Postgres, in Claude
Code.
