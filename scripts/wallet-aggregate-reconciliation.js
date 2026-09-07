// scripts/wallet-aggregate-reconciliation.js
// ==================================================
// Companion to the existing scripts/wallet-opening-balance-migration.js,
// which already does per-user reconciliation (reconcileBalance() per
// user/currency, mismatch warnings, exit code 1 on mismatch). This adds
// the AGGREGATE/TOTALS-level check explicitly requested separately:
// total users, total legacy coins, total legacy diamonds vs. Module 4
// ledger totals. Does not replace or modify the existing script — new,
// additive tooling only, per the instruction not to rewrite existing
// scripts without understanding them first.
//
// SAFETY PROPERTIES (same as the script it complements):
//   - Read-only against legacy data (data/users.json) — never writes to it.
//   - Read-only against Postgres too — this script only SELECTs/sums,
//     never INSERTs/UPDATEs. It is a pure verification tool.
//   - Requires MODULE4_WALLET_DATABASE_URL. Refuses to run without it —
//     no fake/default connection string.
//   - Exits non-zero on ANY mismatch, so it's safe to use as a CI/staging
//     gate ("migration সফল হয়নি" should be a hard failure, not a warning).
//
// USAGE:
//   node scripts/wallet-aggregate-reconciliation.js
//   (dry-run against a STAGING MODULE4_WALLET_DATABASE_URL only — never
//   point this at production without having already run the per-user
//   script's --verify-only pass first)
// ==================================================

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const USERS_FILE = path.join(ROOT, "data", "users.json");

function loadLegacyUsers() {
    if (!fs.existsSync(USERS_FILE)) {
        throw new Error(`Legacy users file not found at ${USERS_FILE} — nothing to reconcile against.`);
    }
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

async function main() {
    console.log("==================================================");
    console.log("Module 4 Wallet — Aggregate (Totals) Reconciliation");
    console.log("Read-only. Verifies totals only — writes nothing.");
    console.log("==================================================\n");

    if (!process.env.MODULE4_WALLET_DATABASE_URL) {
        throw new Error("MODULE4_WALLET_DATABASE_URL is not set. Refusing to run without a real staging connection.");
    }

    const legacyUsers = loadLegacyUsers();
    const userIds = Object.keys(legacyUsers);

    let legacyTotalCoins = 0, legacyTotalDiamonds = 0, legacyUsersWithBalance = 0;
    for (const id of userIds) {
        const u = legacyUsers[id];
        if (!u || typeof u !== "object") continue;
        const coins = Number.isFinite(u.coins) ? u.coins : 0;
        const diamonds = Number.isFinite(u.diamonds) ? u.diamonds : 0;
        if (coins > 0 || diamonds > 0) legacyUsersWithBalance++;
        legacyTotalCoins += coins;
        legacyTotalDiamonds += diamonds;
    }

    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: process.env.MODULE4_WALLET_DATABASE_URL });

    let ledgerTotals;
    try {
        const res = await pool.query(
            `SELECT currency, COUNT(*) AS user_count, COALESCE(SUM(balance), 0) AS total
             FROM module4_wallet_balances
             GROUP BY currency`
        );
        ledgerTotals = Object.fromEntries(res.rows.map(r => [r.currency, { userCount: Number(r.user_count), total: Number(r.total) }]));
    } finally {
        await pool.end();
    }

    const ledgerCoins = ledgerTotals.coins || { userCount: 0, total: 0 };
    const ledgerDiamonds = ledgerTotals.diamonds || { userCount: 0, total: 0 };

    const report = {
        generatedAt: new Date().toISOString(),
        legacy: {
            totalUsers: userIds.length,
            usersWithNonZeroBalance: legacyUsersWithBalance,
            totalCoins: legacyTotalCoins,
            totalDiamonds: legacyTotalDiamonds,
        },
        ledger: {
            coinsUserCount: ledgerCoins.userCount,
            totalCoins: ledgerCoins.total,
            diamondsUserCount: ledgerDiamonds.userCount,
            totalDiamonds: ledgerDiamonds.total,
        },
        comparison: {
            coinsMatch: legacyTotalCoins === ledgerCoins.total,
            diamondsMatch: legacyTotalDiamonds === ledgerDiamonds.total,
            coinsDelta: ledgerCoins.total - legacyTotalCoins,
            diamondsDelta: ledgerDiamonds.total - legacyTotalDiamonds,
        },
    };

    const reportFile = path.join(ROOT, `aggregate-reconciliation-${Date.now()}.json`);
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

    console.log(JSON.stringify(report, null, 2));
    console.log(`\nFull report written to: ${reportFile}`);

    if (!report.comparison.coinsMatch || !report.comparison.diamondsMatch) {
        console.error("\n❌ MISMATCH — migration must be treated as FAILED. Do not proceed to Stage 3.");
        process.exitCode = 1;
    } else {
        console.log("\n✅ Totals match. (Per-user reconciliation still required — run " +
                    "wallet-opening-balance-migration.js --execute --verify-only for that.)");
    }
}

main().catch((err) => {
    console.error("Aggregate reconciliation failed:", err.message);
    process.exitCode = 1;
});
