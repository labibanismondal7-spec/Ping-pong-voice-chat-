# PingPong — Railway PostgreSQL Migration: Static Package

**Scope of this pass:** produced from `PingPong-PRODUCTION-READY-2026-08-24-FINAL.zip`, in a sandbox
with **no network access and no Postgres/node_modules available**. Every item below is
**STATICALLY VERIFIED** (designed/reviewed against the real source) or **NOT VERIFIED**
(would need a real `DATABASE_URL` to check) — nothing here is LOCALLY or LIVE VERIFIED yet.
That step needs Claude Code against your actual repo + Railway environment.

---

## 1. Data Storage Audit

Found via `_FILE = path.join(...)` constants + `safeRead`/`safeWrite` call sites (39 files use them).
`server.js` alone is 8,056 lines and owns most of the core entities.

| Data | Current Storage | Required Storage | Migration Required? |
|---|---|---|---|
| Users, profile, followers/following | `data/users.json` (in-memory `let users = safeRead(...)`, `server.js`) | `users` table + `follows` table | **Yes** |
| Mobile/auth identity | fields inside `users.json` | `users.mobile` (unique) | **Yes** |
| OTP codes | `data/otpStore.json` via `security/otpService.js` | `otp_codes` table (hashed codes) | **Yes** |
| Rooms, room ID, name, owner | `data/rooms.json` | `rooms` table | **Yes** |
| Room membership | embedded in `rooms.json` | `room_members` table | **Yes** |
| Room seats/settings | embedded in `rooms.json` | `room_seats` table | **Yes** |
| Wallet balance (diamonds/coins) | `user.diamonds` field inside `users.json`, mutated directly (`user.diamonds -= amount`, `t.diamonds += e.diamondAmount`) | `wallets` table, mutated only via atomic repo function | **Yes — highest risk, see §6** |
| Wallet transaction history | `data/transactions.json`, `data/coinLedger.json`, `data/rechargeTransactions.json`, `data/transactions_archive.json` | `wallet_transactions` table (immutable, idempotency-keyed) | **Yes** |
| Gifts catalog | `data/gifts_catalog.json` | `gifts_catalog` table | **Yes** |
| Gift send/receive history | `data/gift_log.json`, `data/gift_history.json` | `gift_transactions` table | **Yes** |
| Countries | referenced by code inside `users.json`/RBAC | `countries` table | **Yes** |
| Admin accounts | `data/admin_accounts.json` | `admin_accounts` table | **Yes** |
| Admin action logs | `data/admin_logs.json` | `admin_logs` table | **Yes** |
| Bans | `data/bans.json` (`banManagement.js`) | `bans` table | **Yes** |
| User level/XP | fields inside `users.json` + `data/level_config.json` (`idLevel.js`) | `users.level`, `users.xp` columns; `level_config.json` stays as config, not per-user data | **Yes** (per-user fields only) |
| VIP/SVIP membership, wealth, themes | `data/vip_memberships.json`, `svip_config.json`, `svip_history.json`, `svip_resource.json`, `svip_wealth_history.json`, `level_themes.json` | `users.vip_level`/`svip_*` columns for the queryable fields; rest via `app_json_store` blob mirror short-term | **Partial now, full later** — see §7 |
| Agencies / Coin Center | `agencies.json`, `agency_invites.json`, `agency_requests.json`, `coin_center.json`, `coin_sellers.json`, `diamond_sellers.json` | own tables (not modeled in this pass — flagged, not designed) | **Yes, not yet designed** |
| Call hosting | `callhosting_hosts.json`, `_rates.json`, `_targets.json`, `_revenue.json`, `callHistory.json`, `callhosting_history.json` | own tables (not modeled in this pass) | **Yes, not yet designed** |
| Frames/vehicles/badges cosmetics | `frame_catalog.json`, `vehicle_catalog.json`, `vehicle_assignments.json`, `badgeSizes.json`, `badgeTransactions.json` | low-risk — candidate to stay JSONB/`app_json_store` indefinitely | **Optional** |
| Trust & safety (blocks/reports) | `userBlocks.json`, `userReports.json` (`TRUST_DIR`) | own tables (not modeled in this pass) | **Yes, not yet designed** |
| Clubs | `clubs.json`, `club_members.json`, `club_contributions.json`, `club_invites.json` (all currently near-empty — feature looks unlaunched) | own tables when the feature is live | **Defer** |
| Payment settings | `paymentSettings.json` | config table or env — low change frequency | **Low priority** |
| AI logs | `ai_logs.jsonl`, `fruit_wheel_audit.jsonl` | append-only log — fine to leave as file/log sink, not core app data | **No** |
| **Active WebSocket/session, LiveKit participant state, live seat occupancy** | in-memory (Socket.IO, LiveKit SDK) | **stays runtime/Redis** — must NOT be persisted to Postgres | **No — explicitly out of scope (Rule 6)** |

**Already in the codebase, worth knowing about:**
- `perf/dbPersistence.js` — an existing Postgres "durability backstop" (Phase 12) that mirrors each
  JSON file whole into one `app_json_store` table on write, and rehydrates it to disk at boot
  (`scripts/hydrate-from-db.js`). It's inert unless `DATABASE_URL` is set. This is a blob mirror,
  not a relational schema — it solves "don't lose the file" but not queryability, FKs, or wallet
  atomicity. **Recommend keeping it running in parallel during the migration** as a safety net for
  every domain not yet promoted to a real table (see schema.sql's `app_json_store` table).
- `scripts/coin-to-diamond-migration.js` and `scripts/wallet-opening-balance-migration.js` — two prior
  one-off JSON→JSON migrations for wallet fields. Worth reading before writing the real Postgres
  migration for those fields, since they encode business rules about the coin→diamond conversion.

---

## 2. Railway PostgreSQL

Not inspected — no network access in this sandbox, and no `DATABASE_URL` was provided (correctly,
per Rule 1: **no fake credentials were created**). This is flagged as:

**INFRASTRUCTURE REQUIRED** — a Railway PostgreSQL plugin must be provisioned on your Railway
project, and its `DATABASE_URL` supplied as an environment variable to the app service. This has to
happen in Railway's dashboard/CLI directly.

---

## 3. Database Architecture

See **`schema.sql`** (attached) — `users`, `countries`, `follows`, `otp_codes`, `rooms`,
`room_members`, `room_seats`, `wallets`, `wallet_transactions`, `gifts_catalog`, `gift_transactions`,
`admin_accounts`, `admin_logs`, `bans`, plus a retained `app_json_store` blob-mirror table for
everything not yet promoted (agencies, VIP/SVIP detail, call hosting, cosmetics, trust & safety).

Design choice worth flagging: the ~15+ cosmetic/inventory fields on the user object (`activeFrame`,
`frameInventory`, `customTag`, `nameEffect`, `recentRooms`, `groups`, etc.) are stored in a
`users.profile_extra JSONB` column rather than as individual columns — they change often, carry low
risk, and don't need relational integrity. Tell me if any of them should be promoted to real columns
(e.g. if you query/filter on `nameEffect` somewhere).

**STATICALLY VERIFIED** — every table maps to an actual field/file I found in the source; not run
against a real database yet.

---

## 4. Existing JSON Data Migration

See **`migrations/001_migrate_users_and_wallets.js`** (attached) — covers `users.json` +
`transactions.json` as the highest-value, highest-risk pair. It:
- upserts users by existing `user_id` (never regenerates IDs),
- creates wallet rows with `ON CONFLICT DO NOTHING` (never clobbers a live balance on re-run),
- inserts transactions with a `legacy:<original-id>` idempotency key (`ON CONFLICT DO NOTHING`, so
  re-running is a safe no-op),
- wraps everything in one DB transaction — a failure rolls back cleanly, never leaves partial rows,
- never touches/deletes the source JSON files (Rule 3).

**Not yet written**: equivalent scripts for rooms, gifts, admin/bans, OTP. Same pattern, straightforward
to extend — proposing to do this in the Claude Code phase once schema is confirmed, rather than
writing 5 more untested scripts blind.

**STATICALLY VERIFIED** (code reviewed for correctness against the real `users.json`/`transactions.json`
shapes) — **NOT VERIFIED** by execution.

---

## 5. Application Code Migration

Not yet done — this is the largest part of the work (39 files touch `safeRead`/`safeWrite`, with
`server.js` alone at 8,056 lines). See **`wallet.repository.js`** (attached) as the reference pattern
for the most sensitive slice: atomic, race-safe, idempotent wallet mutation, meant to replace direct
`user.diamonds -= amount` mutations. The plan for the rest, in dependency order:

1. Users + wallets (repo layer done in this pass — `wallet.repository.js`)
2. Rooms + membership + seats
3. Gifts (built on the wallet repo)
4. Admin/RBAC/bans
5. Everything else, left on the `app_json_store` blob mirror until scheduled

Each call site swap should be done and tested individually rather than in one big rewrite, given how
much this app leans on synchronous in-memory reads (`let users = safeRead(...)` at boot, mutated
directly all over `server.js`) — that's a structural change (sync→async), not just a storage swap.

**NOT VERIFIED / NOT YET DONE.**

---

## 6. Wallet & Financial Data

Handled with real care in the design, per Rule 4 (don't break existing wallet security fixes):
- **Atomicity**: `applyWalletTxn()` / `transferGift()` do balance update + ledger insert inside one
  `BEGIN`/`COMMIT`, with `SELECT ... FOR UPDATE` row locking to prevent concurrent-request races.
- **No double-credit**: every wallet mutation requires a caller-supplied `idempotencyKey`, enforced by
  a `UNIQUE` constraint on `wallet_transactions.idempotency_key`; a retried request is detected and
  returned as a no-op instead of applying twice.
- **Immutable history**: the repo layer only ever `INSERT`s into `wallet_transactions`, never
  `UPDATE`/`DELETE`s a completed row; corrections would be new offsetting rows.
- I have **not** located or reviewed the specific "existing wallet security fixes" mentioned in the
  spec (they're presumably in `rechargeWithdrawApproval.js` / `approvalEngine.js` / the wallet ledger
  under `integration_update/module4_wallet_ledger/`) — before wiring this repo layer in for real,
  those files need a read-through to make sure nothing they enforce gets dropped.

**STATICALLY VERIFIED** design — **NOT VERIFIED** by any concurrent-load test (needs real Postgres).

---

## 7. Room Persistence

Schema supports it (`rooms`, `room_members`, `room_seats` survive restart by construction — they're
just table rows). Not yet wired into `server.js`'s actual room-creation/lookup code paths. Live
WebRTC/LiveKit connection state is deliberately excluded, matching the spec: on reconnect, the room
is recovered from the DB row, not assumed still "live."

**NOT VERIFIED / NOT YET DONE.**

---

## 8. Railway Deployment Configuration

- App must read `DATABASE_URL` from the environment — the existing `perf/dbPersistence.js` already
  does this correctly (`process.env.DATABASE_URL`, no hardcoding).
- No secrets were created or hardcoded anywhere in this deliverable.
- Add to `.env.example` (not written yet, small change): a `DATABASE_URL=` placeholder line with a
  comment pointing at Railway's Postgres plugin — I'd rather add this alongside the real `.env.example`
  file in the Claude Code phase than guess its current contents blind.

**INFRASTRUCTURE REQUIRED** for the actual provisioning; the app-side env var contract is
**STATICALLY VERIFIED**.

---

## 9. Database Migration System

Not yet chosen/set up. Given `pg` (not an ORM) is the only DB dependency in `package.json`, plain
numbered SQL files run in order (like `migrations/001_...`) with a `schema_migrations` tracking table
is the lowest-friction fit — avoids adding Prisma/Knex as a new dependency to a project that doesn't
have one. Open to Knex if you'd prefer a proper migration runner; flagging as a decision, not making
it unilaterally.

**NOT VERIFIED / NOT YET DONE.**

---

## 10. Backup and Recovery

**INFRASTRUCTURE REQUIRED** — Railway's Postgres plugin has built-in daily backups/point-in-time
restore in its dashboard; this needs to be enabled and confirmed there, not something configurable
from this sandbox. Rollback strategy for the migration itself: every migration script here is
idempotent and additive-only against JSON, so the safe rollback is "stop reading from Postgres,
fall back to JSON reads" — possible only as long as the JSON files are kept (Rule 3/5 already require
this).

---

## 11. Concurrency / Multi-Instance

Currently single-instance by construction (`let users = safeRead(...)` loaded once into a module-level
JS object at boot, mutated in place). After this migration:
- Wallet/room state moves to Postgres → safe across multiple instances (row-level locking handles it).
- **Still memory-only after migration**: live Socket.IO room presence, WebRTC/LiveKit participant
  state — the app already depends on `ioredis` + `@socket.io/redis-adapter` (both in `package.json`),
  suggesting shared presence via Redis was anticipated but I did not find it wired up in `server.js`.
  Running >1 Railway instance today would very likely split socket state across instances with no
  cross-instance awareness — flagging as a real risk, not introducing Redis unprompted (per your
  instruction not to add it unless needed).

**STATICALLY VERIFIED** (read from source) — this is an honest risk report, not a fix.

---

## 12. Testing

**None of the 16 requested tests have been run.** No Postgres, no `node_modules`, no network in this
sandbox — running any of them here would either fail immediately or require me to fabricate output,
which I won't do (per your Rule 2 and the "don't label PASS what infra prevents" instruction). All 16
are **INFRASTRUCTURE REQUIRED / NOT VERIFIED** until run in Claude Code against a real
`DATABASE_URL`, where I can actually execute them.

---

## Data Persistence Guarantee (§H)

None of these can be claimed yet — they all depend on code not yet wired in and infrastructure not
yet provisioned:

- Server restart → data survives? **Not yet — pending §5 (code migration) and real DB.**
- Railway redeploy → data survives? **Not yet.**
- Application crash → persistent data survives? **Not yet.**
- New instance → existing users/rooms load? **Not yet.**

---

## Honest Summary

What's real and reviewable right now: **§1 audit** (based on actually scanning your 176-file source),
**§3 schema** (`schema.sql`), **§4 migration script** for the highest-value pair
(`migrations/001_migrate_users_and_wallets.js`), and **§6 wallet repo pattern**
(`wallet.repository.js`). Everything else — the other 5 entity domains' migration scripts, rewiring
the 39 call sites in `server.js` and friends, and all 16 tests — needs a real Postgres connection to
do honestly, which this sandbox cannot provide. That's the Claude Code phase.
