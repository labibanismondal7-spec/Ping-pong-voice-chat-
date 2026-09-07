// ============================================================
// 001_migrate_users.js — STATICALLY VERIFIED, NOT executed
// v2 — wallet migration REMOVED from this script. Wallet opening
// balances are Module 4's job: use the pre-existing
// scripts/wallet-opening-balance-migration.js +
// integration_update/module4_wallet_ledger/migrations/001_*.sql
// per WALLET_CUTOVER_PLAN.md Stage 2. Running both this script's old
// wallet insert AND Module 4's own migration would double-seed
// opening balances — exactly the duplicate-authority problem being
// fixed. This script now migrates users.json ONLY (identity/profile
// fields, no diamonds/coins).
//
// Safe to re-run: INSERT ... ON CONFLICT (user_id) DO UPDATE.
//
// Per Rule 3 / spec section 4: this script never deletes users.json.
// It only reads it and writes to Postgres. Deleting the legacy JSON
// file is a separate, later, manual step — only after the app has
// been running fully on Postgres reads and been verified.
// ============================================================

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const DATA_FOLDER = process.env.DATA_FOLDER || path.join(__dirname, "..", "..", "data");
const USERS_FILE = path.join(DATA_FOLDER, "users.json");

function loadJson(file, fallback) {
    if (!fs.existsSync(file)) return fallback;
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
        throw new Error(`Failed to parse ${file}: ${err.message}. Refusing to continue — fix the file or restore from backup.`);
    }
}

async function main() {
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is not set. Refusing to run against no database — this must be a real Railway Postgres connection string, not a placeholder.");
    }

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
    });

    const users = loadJson(USERS_FILE, null);
    if (!users) {
        console.log(`No ${USERS_FILE} found — nothing to migrate. Exiting cleanly (not an error).`);
        await pool.end();
        return;
    }

    const userIds = Object.keys(users);
    console.log(`Loaded ${userIds.length} users. (Wallet balances/transactions are NOT handled by ` +
                `this script — see scripts/wallet-opening-balance-migration.js + Module 4's own ` +
                `migration per WALLET_CUTOVER_PLAN.md Stage 2.)`);

    let migratedUsers = 0;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        for (const userId of userIds) {
            const u = users[userId];

            // Preserve existing user_id verbatim — do NOT regenerate IDs
            // (spec section 4: "existing IDs preserve করার চেষ্টা করবে").
            await client.query(
                `INSERT INTO users (user_id, mobile, display_name, country_code, verified, banned,
                                     is_host, is_coin_center, vip_level, svip_level, svip_wealth,
                                     svip_membership_type, svip_expire_at, agency_id, profile_extra)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
                 ON CONFLICT (user_id) DO UPDATE SET
                    mobile = EXCLUDED.mobile,
                    display_name = EXCLUDED.display_name,
                    updated_at = now()`,
                [
                    userId,
                    u.mobile || null,
                    u.name || u.displayName || null,
                    u.country || null,
                    !!u.verified,
                    !!u.banned,
                    !!u.isHost,
                    !!u.isCoinCenter,
                    u.vipLevel || 0,
                    u.svipLevel || 0,
                    u.svipWealth || 0,
                    u.svipMembershipType || "permanent",
                    u.svipExpireAt || null,
                    u.agencyId || null,
                    JSON.stringify(sanitizeExtra(u)),
                ]
            );
            migratedUsers++;
        }

        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Migration failed and was rolled back. No partial writes committed. Legacy JSON files untouched.");
        throw err;
    } finally {
        client.release();
        await pool.end();
    }

    console.log(`Done. users upserted: ${migratedUsers}.`);
}

// Long-tail cosmetic/inventory fields go into users.profile_extra as-is;
// see the comment on that column in schema.sql for why.
function sanitizeExtra(u) {
    const { mobile, name, displayName, country, verified, banned, isHost, isCoinCenter,
            vipLevel, svipLevel, svipWealth, svipMembershipType, svipExpireAt, agencyId,
            diamonds, coins, ...rest } = u;
    return rest;
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
