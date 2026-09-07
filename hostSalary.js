// ==================================================
// HOST SALARY / BEANS PAYOUT ENGINE
// ==================================================
// Server-authoritative salary calculation for Agency Hosts.
//
// Policy source: the two supplied Host Diamond Target / Host Beans Reward
// sheets. The reward is tier based: the highest completed diamond target in
// the selected period determines the beans reward. The payout itself is
// always credited to the separate `beans` wallet; diamonds are never moved.
//
// Important safety properties:
//   - Owner-only permission (host-salary:manage).
//   - Only users who are currently Hosts AND members of an Agency qualify.
//   - Gift history is the source of truth for earned diamonds.
//   - Same host + same period + automatic method is idempotent.
//   - Manual host/agency bean grants remain separate from automatic salary.
//   - Every payout is permanently recorded and audit logged.

const path = require("path");
const crypto = require("crypto");

const LEVELS = [
    [1, 200000, 240000],
    [2, 500000, 600000],
    [3, 1200000, 1440000],
    [4, 2000000, 2400000],
    [5, 2800000, 3360000],
    [6, 3600000, 4320000],
    [7, 4500000, 5400000],
    [8, 6000000, 7200000],
    [9, 8500000, 10200000],
    [10, 11000000, 13200000],
    [11, 27500000, 33000000],
    [12, 35000000, 42000000],
    [13, 50000000, 60000000],
    [14, 70000000, 84000000],
    [15, 85000000, 102000000],
    [16, 100000000, 120000000],
    [17, 125000000, 150000000],
    [18, 150000000, 180000000],
    [19, 170000000, 204000000],
    [20, 200000000, 240000000]
].map(([level, targetDiamonds, rewardBeans]) => ({ level, targetDiamonds, rewardBeans }));

const DEFAULT_POLICY = {
    version: 1,
    periodType: "monthly",
    rewardMultiplier: 1.2,
    beansPerUsd: 200000,
    exchangeRate: 0.30,
    countries: {
        BD: { name: "Bangladesh", currency: "BDT", usdLocalRate: 120 },
        IN: { name: "India", currency: "INR", usdLocalRate: 90 },
        DEFAULT: { name: "Other Countries", currency: "LOCAL", usdLocalRate: 1 }
    },
    levels: LEVELS
};

function initHostSalary(deps) {
    const {
        app, DATA_FOLDER, safeRead, safeWrite, users, findUserByUserId,
        saveUsers, agencies, giftHistory, registerGiftRecordedHook,
        emitToUser, logTransaction, pushWalletUpdate, clampBeansBalance,
        sendSystemMessage, rbac, requireAdmin, requirePermission, actorCanAccessCountry,
        countryDeniedResponse, reqUserAgent
    } = deps;

    const POLICY_FILE = path.join(DATA_FOLDER, "host_salary_policy.json");
    const PAYOUTS_FILE = path.join(DATA_FOLDER, "host_salary_payouts.json");

    const loadedPolicy = safeRead(POLICY_FILE, null);
    let policy = normalizePolicy(loadedPolicy || DEFAULT_POLICY);
    let payouts = safeRead(PAYOUTS_FILE, []);
    if (!Array.isArray(payouts)) payouts = [];
    // Post-salary cycle markers. A successful salary closes the old target
    // immediately; subsequent gifts start a fresh target cycle even if an
    // operator previews the same date range again.
    const cycleResets = safeRead(path.join(DATA_FOLDER, "host_salary_cycle_resets.json"), {});
    function saveCycleResets(){ safeWrite(path.join(DATA_FOLDER, "host_salary_cycle_resets.json"), cycleResets, { immediate:true }); }


    // In-memory host gift index; it is derived from the existing permanent
    // gift history and does not create a second persistent gift store.
    const giftByHost = Object.create(null);
    for (const entry of giftHistory) indexGift(entry);
    registerGiftRecordedHook((entry) => indexGift(entry));

    function indexGift(entry) {
        if (!entry || !entry.hostId || !entry.agencyId) return;
        if (!giftByHost[entry.hostId]) giftByHost[entry.hostId] = [];
        giftByHost[entry.hostId].push(entry);
    }

    function savePolicy() { safeWrite(POLICY_FILE, policy, { immediate: true }); }
    function savePayouts() { safeWrite(PAYOUTS_FILE, payouts, { immediate: true }); }

    // Seed the policy file once. It is intentionally a separate data file so
    // the Owner can change country conversion settings without touching code.
    if (!loadedPolicy) savePolicy();

    function normalizePolicy(raw) {
        const src = raw && typeof raw === "object" ? raw : DEFAULT_POLICY;
        const countries = { ...DEFAULT_POLICY.countries, ...(src.countries || {}) };
        const levels = Array.isArray(src.levels) && src.levels.length ? src.levels : DEFAULT_POLICY.levels;
        const cleanLevels = levels.map((l, i) => ({
            level: Math.max(1, Math.floor(Number(l.level) || i + 1)),
            targetDiamonds: Math.max(0, Math.floor(Number(l.targetDiamonds) || 0)),
            rewardBeans: Math.max(0, Math.floor(Number(l.rewardBeans) || 0))
        })).sort((a, b) => a.targetDiamonds - b.targetDiamonds || a.level - b.level);
        return {
            version: Number(src.version) || 1,
            periodType: src.periodType === "monthly" ? "monthly" : "monthly",
            rewardMultiplier: Number.isFinite(Number(src.rewardMultiplier)) && Number(src.rewardMultiplier) > 0 ? Number(src.rewardMultiplier) : 1.2,
            beansPerUsd: Math.max(1, Math.floor(Number(src.beansPerUsd) || 200000)),
            exchangeRate: Math.min(1, Math.max(0, Number(src.exchangeRate) || 0.30)),
            countries,
            levels: cleanLevels
        };
    }

    function countryForUser(user) {
        const real = String(user && user.country || "").toUpperCase();
        if (policy.countries[real]) return real;
        const region = String(user && user.countryId || "").toUpperCase();
        if (policy.countries[region]) return region;
        return "DEFAULT";
    }

    function countryPolicy(user) {
        const id = countryForUser(user);
        return { id, ...(policy.countries[id] || policy.countries.DEFAULT) };
    }

    function periodBounds(start, end) {
        const now = new Date();
        let from = start ? new Date(start) : new Date(now.getFullYear(), now.getMonth(), 1);
        let to = end ? new Date(end) : new Date(now.getTime());
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
        // Treat date-only end values as inclusive through 23:59:59.999 local/UTC
        // by moving the exclusive boundary to the next day.
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(end || ""))) to = new Date(to.getTime() + 86400000 - 1);
        if (from > to) return null;
        return { start: from.toISOString(), end: to.toISOString() };
    }

    function periodKey(bounds) { return `${bounds.start}|${bounds.end}`; }

    function diamondsForHost(hostId, agencyId, bounds) {
        const start = Date.parse(bounds.start), end = Date.parse(bounds.end);
        let total = 0;
        for (const e of (giftByHost[hostId] || [])) {
            if (e.agencyId !== agencyId) continue;
            const t = Date.parse(e.timestamp);
            if (!Number.isFinite(t) || t < start || t > end) continue;
            const resetAt = cycleResets[`${hostId}|${agencyId}`];
            if (resetAt && t <= Date.parse(resetAt)) continue;
            const amount = Math.floor(Number(e.diamondAmount) || 0);
            if (amount > 0) total += amount;
        }
        return total;
    }

    function tierForDiamonds(diamonds) {
        let best = null;
        for (const level of policy.levels) {
            if (diamonds >= level.targetDiamonds) best = level;
            else break;
        }
        return best;
    }

    function cashEstimate(rewardBeans, user) {
        const cp = countryPolicy(user);
        const usd = rewardBeans / policy.beansPerUsd;
        return {
            usd: Number(usd.toFixed(6)),
            local: Number((usd * cp.usdLocalRate * policy.exchangeRate).toFixed(2)),
            currency: cp.currency,
            exchangeRate: policy.exchangeRate,
            usdLocalRate: cp.usdLocalRate
        };
    }

    function hostCandidates(bounds, country) {
        const result = [];
        for (const u of Object.values(users)) {
            if (!u || !u.userId || !u.isHost || !u.agencyId) continue;
            const agency = agencies[u.agencyId];
            if (!agency || !Array.isArray(agency.hostIds) || !agency.hostIds.includes(u.userId)) continue;
            if (country && !actorCountryMatches(u, country)) continue;
            const diamonds = diamondsForHost(u.userId, u.agencyId, bounds);
            const tier = tierForDiamonds(diamonds);
            const cp = countryPolicy(u);
            const autoPaid = payouts.some((p) => p.method === "automatic" && p.userId === u.userId && p.agencyId === u.agencyId && p.periodKey === periodKey(bounds) && p.status === "completed");
            result.push({
                userId: u.userId,
                name: u.name || "User",
                agencyId: u.agencyId,
                agencyName: agency.name || u.agencyId,
                countryId: u.countryId || "OTHERS",
                country: cp.name,
                diamonds,
                level: tier ? tier.level : null,
                targetDiamonds: tier ? tier.targetDiamonds : null,
                rewardBeans: tier ? tier.rewardBeans : 0,
                cashEstimate: tier ? cashEstimate(tier.rewardBeans, u) : cashEstimate(0, u),
                eligible: !!tier,
                alreadyPaid: autoPaid,
                payoutStatus: autoPaid ? "paid" : tier ? "eligible" : "not_eligible"
            });
        }
        return result;
    }

    function actorCountryMatches(user, country) {
        const c = String(country).toUpperCase();
        return String(user.country || "").toUpperCase() === c || String(user.countryId || "").toUpperCase() === c;
    }

    function ownerOnly(req, res, next) {
        if (!req.adminAccount || req.adminAccount.role !== rbac.ROLES.OWNER) {
            return res.status(403).json({ success: false, message: "Host Salary is Owner-only" });
        }
        next();
    }

    function makePayoutId(prefix = "salary") {
        return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
    }

    function completeBeanCredit({ userId, amount, note, payoutId, actor, notifyLabel = "Beans Received" }) {
        const found = findUserByUserId(userId);
        const creditAmount = Math.floor(Number(amount));
        if (!found) return { success: false, message: "User not found" };
        if (!Number.isSafeInteger(creditAmount) || creditAmount <= 0) return { success: false, message: "Invalid beans amount" };

        const user = found.user;
        const before = Math.max(0, Math.floor(Number(user.beans) || 0));
        const next = clampBeansBalance(userId, before + creditAmount, "host-salary");
        if (!Number.isSafeInteger(next) || next <= before) return { success: false, message: "Invalid beans amount" };

        // The user object is the authoritative wallet record. Persist it before
        // publishing the live update so refresh/re-login can never observe a
        // notification for a credit that was not written to users.json.
        user.beans = next;
        saveUsers({ immediate: true });
        logTransaction(userId, "beans", creditAmount, `${note} [${payoutId}]`);
        pushWalletUpdate(userId);

        // Notification is deliberately after the wallet mutation. A failed
        // notification must never roll back or invalidate a successful credit.
        if (typeof sendSystemMessage === "function") {
            const label = String(notifyLabel || "Beans Received").trim() || "Beans Received";
            sendSystemMessage(userId, `${label} — ${creditAmount.toLocaleString()} Beans credited to your account.`);
        }

        return { success: true, before, after: next };
    }

    function recordPayout(entry) {
        payouts.push(entry);
        // Keep a long audit history but avoid pathological growth.
        if (payouts.length > 100000) payouts.splice(0, payouts.length - 100000);
        savePayouts();
    }

    function payoutAutomatic(item, bounds, req) {
        const pKey = periodKey(bounds);
        if (payouts.some((p) => p.method === "automatic" && p.userId === item.userId && p.agencyId === item.agencyId && p.periodKey === pKey && p.status === "completed")) {
            return { success: false, skipped: true, message: "Already paid for this period" };
        }
        const userFound = findUserByUserId(item.userId);
        const currentAgency = userFound && userFound.user.agencyId ? agencies[userFound.user.agencyId] : null;
        if (!userFound || !userFound.user.isHost || !userFound.user.agencyId || userFound.user.agencyId !== item.agencyId || !currentAgency || !Array.isArray(currentAgency.hostIds) || !currentAgency.hostIds.includes(item.userId)) {
            return { success: false, skipped: true, message: "Host is no longer an eligible agency member" };
        }
        const payoutId = makePayoutId();
        const entry = {
            payoutId, method: "automatic", status: "pending",
            userId: item.userId, agencyId: item.agencyId,
            countryId: userFound.user.countryId || "OTHERS",
            periodKey: pKey, periodStart: bounds.start, periodEnd: bounds.end,
            diamonds: item.diamonds, level: item.level,
            targetDiamonds: item.targetDiamonds, beans: item.rewardBeans,
            createdAt: new Date().toISOString(),
            adminId: req.adminAccount.id, adminUsername: req.adminAccount.username
        };
        // A pending entry makes concurrent requests converge on the same
        // period/user pair. It is upgraded to completed only after the
        // actual wallet mutation and transaction log succeed.
        recordPayout(entry);
        const credit = completeBeanCredit({ userId: item.userId, amount: item.rewardBeans, note: `Host salary level ${item.level}`, payoutId, actor: req.adminAccount, notifyLabel: "Salary Received" });
        if (!credit.success) {
            entry.status = "failed"; entry.failureReason = credit.message; entry.updatedAt = new Date().toISOString(); savePayouts();
            return { success: false, message: credit.message };
        }
        entry.status = "completed"; entry.beansBefore = credit.before; entry.beansAfter = credit.after; entry.completedAt = new Date().toISOString();
        entry.targetResetAt = entry.completedAt;
        cycleResets[`${item.userId}|${item.agencyId}`] = entry.completedAt;
        saveCycleResets();
        savePayouts();
        rbac.logAction({ admin: req.adminAccount, action: "host-salary-auto-send", module: "host-salary", targetType: "user", targetId: item.userId, after: entry, ip: req.ip, userAgent: reqUserAgent(req) });
        return { success: true, payout: entry };
    }

    // ==================================================
    // ADMIN API
    // ==================================================
    const requireSalary = [requireAdmin, requirePermission("host-salary:manage"), ownerOnly];

    app.get("/api/admin/host-salary/policy", ...requireSalary, (req, res) => {
        res.json({ success: true, policy });
    });

    app.put("/api/admin/host-salary/policy", ...requireSalary, (req, res) => {
        const next = normalizePolicy({ ...policy, ...(req.body || {}), countries: { ...policy.countries, ...((req.body || {}).countries || {}) } });
        const before = policy;
        policy = next; savePolicy();
        rbac.logAction({ admin: req.adminAccount, action: "host-salary-policy-update", module: "host-salary", before, after: next, ip: req.ip, userAgent: reqUserAgent(req) });
        res.json({ success: true, policy });
    });

    app.get("/api/admin/host-salary/preview", ...requireSalary, (req, res) => {
        const bounds = periodBounds(req.query.from, req.query.to);
        if (!bounds) return res.status(400).json({ success: false, message: "Invalid period" });
        const country = req.query.country ? String(req.query.country).toUpperCase() : null;
        if (country && !rbac.COUNTRY_IDS.includes(country) && !policy.countries[country]) return res.status(400).json({ success: false, message: "Unknown country" });
        const rows = hostCandidates(bounds, country);
        const eligible = rows.filter((r) => r.eligible && !r.alreadyPaid);
        res.json({ success: true, period: bounds, periodKey: periodKey(bounds), rows, eligibleCount: eligible.length, totalBeans: eligible.reduce((s, r) => s + r.rewardBeans, 0) });
    });

    app.post("/api/admin/host-salary/send-all", ...requireSalary, (req, res) => {
        const bounds = periodBounds(req.body && req.body.from, req.body && req.body.to);
        if (!bounds) return res.status(400).json({ success: false, message: "Invalid period" });
        const country = req.body && req.body.country ? String(req.body.country).toUpperCase() : null;
        if (country && !rbac.COUNTRY_IDS.includes(country) && !policy.countries[country]) return res.status(400).json({ success: false, message: "Unknown country" });
        const rows = hostCandidates(bounds, country).filter((r) => r.eligible && !r.alreadyPaid);
        const results = [];
        for (const item of rows) results.push(payoutAutomatic(item, bounds, req));
        const sent = results.filter((r) => r.success);
        const failed = results.filter((r) => !r.success && !r.skipped);
        rbac.logAction({ admin: req.adminAccount, action: "host-salary-auto-batch", module: "host-salary", targetType: "batch", targetId: periodKey(bounds), meta: { country, eligible: rows.length, sent: sent.length, failed: failed.length, beans: sent.reduce((s, r) => s + r.payout.beans, 0) }, ip: req.ip, userAgent: reqUserAgent(req), result: failed.length ? "failed" : "success", failureReason: failed.length ? "one or more payouts failed" : null });
        res.json({ success: true, period: bounds, eligible: rows.length, sent: sent.length, failed: failed.length, skipped: results.filter((r) => r.skipped).length, payouts: sent.map((r) => r.payout), failures: failed });
    });

    app.post("/api/admin/host-salary/manual-host", ...requireSalary, (req, res) => {
        const userId = String(req.body && req.body.userId || "").trim();
        const amount = Math.floor(Number(req.body && req.body.beans));
        const reason = String(req.body && req.body.reason || "Manual host salary").trim().slice(0, 300) || "Manual host salary";
        if (!userId || !Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, message: "Valid User ID and positive Beans amount are required" });
        const found = findUserByUserId(userId);
        const hostAgency = found && found.user.agencyId ? agencies[found.user.agencyId] : null;
        if (!found || !found.user.isHost || !found.user.agencyId || !hostAgency || !Array.isArray(hostAgency.hostIds) || !hostAgency.hostIds.includes(userId)) return res.status(400).json({ success: false, message: "User must be an Agency Host" });
        const payoutId = makePayoutId("manual");
        const credit = completeBeanCredit({ userId, amount, note: reason, payoutId, actor: req.adminAccount, notifyLabel: "Beans Received" });
        if (!credit.success) return res.status(400).json(credit);
        const entry = { payoutId, method: "manual-host", status: "completed", userId, agencyId: found.user.agencyId, countryId: found.user.countryId || "OTHERS", beans: amount, beansBefore: credit.before, beansAfter: credit.after, reason, createdAt: new Date().toISOString(), targetResetAt:new Date().toISOString(), adminId: req.adminAccount.id, adminUsername: req.adminAccount.username };
        cycleResets[`${userId}|${found.user.agencyId}`] = entry.targetResetAt;
        saveCycleResets();
        recordPayout(entry);
        rbac.logAction({ admin: req.adminAccount, action: "host-salary-manual-host", module: "host-salary", targetType: "user", targetId: userId, after: entry, ip: req.ip, userAgent: reqUserAgent(req) });
        res.json({ success: true, payout: entry });
    });

    app.post("/api/admin/host-salary/manual-agency", ...requireSalary, (req, res) => {
        const agencyId = String(req.body && req.body.agencyId || "").trim();
        const amount = Math.floor(Number(req.body && req.body.beans));
        const reason = String(req.body && req.body.reason || "Manual agency salary").trim().slice(0, 300) || "Manual agency salary";
        if (!agencyId || !Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, message: "Valid Agency ID and positive Beans amount are required" });
        const agency = agencies[agencyId];
        if (!agency) return res.status(404).json({ success: false, message: "Agency not found" });
        const owner = findUserByUserId(agency.ownerUserId);
        if (!owner) return res.status(404).json({ success: false, message: "Agency owner user not found" });
        const payoutId = makePayoutId("agency");
        const credit = completeBeanCredit({ userId: owner.user.userId, amount, note: reason, payoutId, actor: req.adminAccount, notifyLabel: "Agency Beans Received" });
        if (!credit.success) return res.status(400).json(credit);
        const entry = { payoutId, method: "manual-agency", status: "completed", agencyId, userId: owner.user.userId, countryId: agency.countryId || owner.user.countryId || "OTHERS", beans: amount, beansBefore: credit.before, beansAfter: credit.after, reason, createdAt: new Date().toISOString(), adminId: req.adminAccount.id, adminUsername: req.adminAccount.username };
        recordPayout(entry);
        rbac.logAction({ admin: req.adminAccount, action: "host-salary-manual-agency", module: "host-salary", targetType: "agency", targetId: agencyId, after: entry, ip: req.ip, userAgent: reqUserAgent(req) });
        res.json({ success: true, payout: entry });
    });

    app.get("/api/admin/host-salary/payouts", ...requireSalary, (req, res) => {
        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
        const list = payouts.slice().reverse().slice(0, limit);
        res.json({ success: true, payouts: list });
    });

    return { getPolicy: () => policy, getPayouts: () => payouts };
}

module.exports = { initHostSalary, DEFAULT_POLICY, LEVELS };
