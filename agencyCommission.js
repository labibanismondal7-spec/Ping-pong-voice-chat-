// ==================================================
// AGENCY WEEKLY TARGET + COMMISSION / SALARY
// ==================================================
// Additive production module. The existing Host Salary engine remains
// completely separate. Agency salary is calculated only from the Agency's
// weekly target achievement value (confirmed agency gift Diamonds), never
// from coins, Beans, random wallet activity, or the Agency's configured
// target when the actual achievement is lower.
//
// Persistence:
//   data/agency_commission_policy.json
//   data/agency_salary_periods.json
//
// The period key is a deterministic 7-day bucket aligned with the existing
// server periodStart("weekly") convention. Historical period snapshots are
// never deleted or overwritten after payment.

const path = require("path");
const crypto = require("crypto");

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SAFE_VALUE = Number.MAX_SAFE_INTEGER;

const DEFAULT_POLICY = {
    version: 1,
    tiers: [
        { id: "tier-1", minTargetValue: 0, commissionPercent: 10, enabled: true },
        { id: "tier-2", minTargetValue: 5000000, commissionPercent: 30, enabled: true },
        { id: "tier-3", minTargetValue: 500000000, commissionPercent: 40, enabled: true }
    ]
};

function finiteNonNegativeInteger(value, field, { allowZero = true } = {}) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0 || (!allowZero && n <= 0)) {
        throw new Error(`${field} must be a valid non-negative integer`);
    }
    return n;
}

function normalizePolicy(raw) {
    const src = raw && typeof raw === "object" ? raw : DEFAULT_POLICY;
    const incoming = Array.isArray(src.tiers) ? src.tiers : DEFAULT_POLICY.tiers;
    const tiers = incoming.map((tier, index) => {
        const minTargetValue = finiteNonNegativeInteger(tier && tier.minTargetValue, `Tier ${index + 1} minimum target`);
        const pct = Number(tier && tier.commissionPercent);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
            throw new Error(`Tier ${index + 1} commission must be between 0 and 100`);
        }
        return {
            id: String((tier && tier.id) || `tier-${index + 1}`).trim().slice(0, 80) || `tier-${index + 1}`,
            minTargetValue,
            commissionPercent: Number(pct.toFixed(6)),
            enabled: tier && tier.enabled !== false
        };
    }).sort((a, b) => a.minTargetValue - b.minTargetValue || a.id.localeCompare(b.id));

    if (!tiers.length) throw new Error("At least one commission tier is required");
    if (tiers[0].minTargetValue !== 0) throw new Error("The lowest commission tier must start at 0");
    for (let i = 1; i < tiers.length; i++) {
        if (tiers[i].minTargetValue === tiers[i - 1].minTargetValue) {
            throw new Error("Commission tiers cannot have duplicate minimum target values");
        }
    }
    if (!tiers.some((t) => t.enabled && t.minTargetValue === 0)) {
        throw new Error("At least one enabled tier must start at 0");
    }
    return { version: Number(src.version) || 1, tiers };
}

function weeklyPeriod(now = new Date()) {
    const ms = now instanceof Date ? now.getTime() : new Date(now).getTime();
    if (!Number.isFinite(ms)) throw new Error("Invalid period date");
    const startMs = Math.floor(ms / WEEK_MS) * WEEK_MS;
    const endMs = startMs + WEEK_MS - 1;
    return {
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        key: `${new Date(startMs).toISOString()}|${new Date(endMs).toISOString()}`,
        startMs,
        endMs,
        closed: Date.now() > endMs
    };
}

function periodFromInput(start, end) {
    const s = new Date(start);
    const e = new Date(end);
    if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime()) || e.getTime() < s.getTime()) return null;
    const duration = e.getTime() - s.getTime() + 1;
    if (duration !== WEEK_MS) return null;
    return {
        start: s.toISOString(),
        end: e.toISOString(),
        key: `${s.toISOString()}|${e.toISOString()}`,
        startMs: s.getTime(),
        endMs: e.getTime(),
        closed: Date.now() > e.getTime()
    };
}

function calculateCommission(actualAchieved, policy) {
    const achieved = finiteNonNegativeInteger(actualAchieved, "Actual achieved target");
    const normalized = normalizePolicy(policy);
    let applicable = null;
    for (const tier of normalized.tiers) {
        if (!tier.enabled) continue;
        if (achieved >= tier.minTargetValue) applicable = tier;
        else break;
    }
    if (!applicable) throw new Error("No enabled commission tier applies to this achievement");
    const salary = Math.floor((achieved * applicable.commissionPercent) / 100);
    if (!Number.isSafeInteger(salary)) throw new Error("Calculated salary exceeds safe numeric range");
    return { tier: applicable, commissionPercent: applicable.commissionPercent, salary };
}

function initAgencyCommission(deps) {
    const {
        app, DATA_FOLDER, safeRead, safeWrite,
        users, findUserByUserId, saveUsers,
        agencies, saveAgencies,
        giftHistory, registerGiftRecordedHook,
        logTransaction, getTransactions, pushWalletUpdate, clampBeansBalance,
        sendSystemMessage,
        rbac, requireAdmin, requirePermission,
        actorCanAccessCountry, countryDeniedResponse, reqUserAgent
    } = deps;

    const POLICY_FILE = path.join(DATA_FOLDER, "agency_commission_policy.json");
    const PERIODS_FILE = path.join(DATA_FOLDER, "agency_salary_periods.json");

    let policyRaw = safeRead(POLICY_FILE, null);
    let policy;
    try { policy = normalizePolicy(policyRaw || DEFAULT_POLICY); }
    catch (err) { console.error("❌ [agency-commission] Invalid policy, using defaults:", err.message); policy = normalizePolicy(DEFAULT_POLICY); }
    let periods = safeRead(PERIODS_FILE, {});
    if (!periods || typeof periods !== "object" || Array.isArray(periods)) periods = {};
    // Post-salary target reset markers. Gifts after the marker belong to the
    // next agency target cycle, even when an operator previews an old window.
    const cycleResets = safeRead(path.join(DATA_FOLDER, "agency_salary_cycle_resets.json"), {});
    function saveCycleResets(){ safeWrite(path.join(DATA_FOLDER, "agency_salary_cycle_resets.json"), cycleResets, { immediate:true }); }
    if (!policyRaw) safeWrite(POLICY_FILE, policy, { immediate: true });

    // One in-memory index of the existing permanent gift history. No second
    // gift store is created. The record's agencyId is the authoritative
    // attribution captured at successful gift time.
    const giftsByAgency = Object.create(null);
    function indexGift(entry) {
        if (!entry || !entry.agencyId) return;
        if (!giftsByAgency[entry.agencyId]) giftsByAgency[entry.agencyId] = [];
        giftsByAgency[entry.agencyId].push(entry);
    }
    for (const entry of (giftHistory || [])) indexGift(entry);
    if (typeof registerGiftRecordedHook === "function") registerGiftRecordedHook(indexGift);

    // Process-local lock prevents two simultaneous Pay requests from both
    // passing the duplicate check before either writes the payout snapshot.
    const payoutLocks = new Set();

    function savePolicy() { safeWrite(POLICY_FILE, policy, { immediate: true }); }
    function savePeriods() { safeWrite(PERIODS_FILE, periods, { immediate: true }); }

    function isAuthorized(actor) {
        return !!(actor && rbac && rbac.hasPermission(actor, "agency-salary:manage"));
    }

    function snapshot(obj) { return obj ? JSON.parse(JSON.stringify(obj)) : null; }

    function agencyCountry(agency) { return agency && (agency.countryId || "OTHERS"); }

    function ensureAgencyScope(req, res, agency) {
        if (!agency) { res.status(404).json({ success: false, message: "Agency not found" }); return false; }
        if (!actorCanAccessCountry(req.adminAccount, agencyCountry(agency))) {
            countryDeniedResponse(res); return false;
        }
        return true;
    }

    function actualAchievedForAgency(agencyId, period) {
        let total = 0;
        for (const e of (giftsByAgency[agencyId] || [])) {
            if (!e || String(e.agencyId) !== String(agencyId)) continue;
            const status = String(e.status || "confirmed").toLowerCase();
            if (!["confirmed", "success", "completed"].includes(status)) continue;
            const t = Date.parse(e.timestamp || e.time || "");
            if (!Number.isFinite(t) || t < period.startMs || t > period.endMs) continue;
            const resetAt = cycleResets[String(agencyId)];
            if (resetAt && t <= Date.parse(resetAt)) continue;
            const amount = Number(e.diamondAmount);
            if (!Number.isSafeInteger(amount) || amount <= 0) continue;
            total += amount;
            if (!Number.isSafeInteger(total)) throw new Error("Agency achievement exceeds safe numeric range");
        }
        return total;
    }

    function periodRecordFor(agency, period, { create = true } = {}) {
        const key = `${agency.agencyId}|${period.key}`;
        let record = periods[key];
        if (record && record.periodStart === period.start && record.periodEnd === period.end) return record;
        if (!create) return null;

        const targetHistory = agency.weeklyTargetHistory && typeof agency.weeklyTargetHistory === "object" ? agency.weeklyTargetHistory : {};
        const historicalTarget = targetHistory[period.key];
        const configured = historicalTarget != null
            ? finiteNonNegativeInteger(historicalTarget, "Weekly target")
            : (agency.weeklyTargetValue == null ? 0 : finiteNonNegativeInteger(agency.weeklyTargetValue, "Weekly target"));
        record = {
            periodId: "agency-period_" + crypto.randomBytes(8).toString("hex"),
            agencyId: agency.agencyId,
            agencyName: agency.name || agency.agencyId,
            agencyOwnerUserId: agency.ownerUserId,
            countryId: agencyCountry(agency),
            periodStart: period.start,
            periodEnd: period.end,
            weeklyTarget: configured,
            actualAchieved: 0,
            achievementPercent: 0,
            commissionTier: null,
            commissionPercent: 0,
            calculatedSalary: 0,
            status: "pending",
            paidAmount: 0,
            payoutId: null,
            transactionId: null,
            paidAt: null,
            periodKey: period.key,
            payerAdminId: null,
            payerAdminUsername: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        periods[key] = record;
        savePeriods();
        return record;
    }

    function calculateRecord(agency, period, { persist = true } = {}) {
        const record = periodRecordFor(agency, period, { create: true });
        // A paid period is a historical accounting snapshot. Never recalculate
        // or overwrite it from later gift-history changes.
        if (record.status === "paid") return record;
        const actual = actualAchievedForAgency(agency.agencyId, period);
        const target = finiteNonNegativeInteger(record.weeklyTarget, "Weekly target");
        const result = calculateCommission(actual, policy);
        const achievementPercent = target > 0 ? Number(((actual / target) * 100).toFixed(4)) : 0;
        record.agencyName = agency.name || record.agencyName;
        record.agencyOwnerUserId = agency.ownerUserId;
        record.countryId = agencyCountry(agency);
        record.actualAchieved = actual;
        record.achievementPercent = achievementPercent;
        record.commissionTier = result.tier.id;
        record.commissionPercent = result.commissionPercent;
        record.calculatedSalary = result.salary;
        if (record.status !== "paid") record.status = "pending";
        record.updatedAt = new Date().toISOString();
        if (persist) savePeriods();
        return record;
    }

    function publicRecord(record) {
        if (!record) return null;
        return {
            ...record,
            remainingTarget: Math.max(0, Number(record.weeklyTarget) - Number(record.actualAchieved)),
            periodClosed: Date.now() > Date.parse(record.periodEnd),
            paid: record.status === "paid"
        };
    }

    function listAgenciesForActor(actor) {
        return Object.values(agencies).filter((a) => actorCanAccessCountry(actor, agencyCountry(a)));
    }

    function makePayoutId() {
        return `agency_salary_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
    }

    function findExistingPayout(agencyId, periodKey) {
        return Object.values(periods).find((p) => p && p.agencyId === agencyId && (p.periodKey === periodKey || p.periodStart + "|" + p.periodEnd === periodKey) && p.status === "paid");
    }

    function reconcileProcessingRecords() {
        let changed = false;
        for (const record of Object.values(periods)) {
            if (!record || record.status !== "processing") continue;
            const ownerFound = findUserByUserId(record.agencyOwnerUserId);
            const owner = ownerFound && ownerFound.user;
            const marker = owner && owner.lastAgencySalaryPayout;
            const markerMatches = marker && marker.payoutId === record.payoutId && marker.periodKey === record.periodKey && Number(marker.amount) === Number(record.calculatedSalary);
            const txs = typeof getTransactions === "function" ? getTransactions() : [];
            const tx = Array.isArray(txs) ? txs.slice().reverse().find((t) => t && t.userId === record.agencyOwnerUserId && t.currency === "beans" && String(t.note || "").includes(`[${record.payoutId}]`)) : null;
            if (markerMatches || tx) {
                record.status = "paid";
                record.paidAmount = Number(record.calculatedSalary) || 0;
                record.paidAt = record.paidAt || new Date().toISOString();
                record.transactionId = tx ? tx.id : (record.transactionId || null);
                record.updatedAt = new Date().toISOString();
                changed = true;
            } else {
                // No wallet marker/transaction means the durable wallet credit
                // was not completed. Return it to pending so an admin can
                // safely retry instead of leaving the period permanently stuck.
                record.status = "pending";
                record.failureReason = "Previous payout attempt did not complete";
                record.updatedAt = new Date().toISOString();
                changed = true;
            }
        }
        if (changed) savePeriods();
    }

    function payOne(agency, period, req) {
        const lockKey = `${agency.agencyId}|${period.key}|agency_salary`;
        if (payoutLocks.has(lockKey)) return { success: false, skipped: true, message: "Payout is already in progress" };
        payoutLocks.add(lockKey);
        try {
            let record = periodRecordFor(agency, period, { create: true });
            if (record.status === "paid" || findExistingPayout(agency.agencyId, period.key)) {
                return { success: false, skipped: true, message: "Agency salary already paid for this weekly period" };
            }
            if (!period.closed) return { success: false, skipped: true, message: "The weekly period is still active; salary can be paid after it closes" };

            record = calculateRecord(agency, period, { persist: true });
            if (record.actualAchieved <= 0 || record.calculatedSalary <= 0) {
                return { success: false, skipped: true, message: "No payable Agency salary for this period" };
            }

            const ownerFound = findUserByUserId(agency.ownerUserId);
            if (!ownerFound) return { success: false, message: "Agency Owner not found" };
            if (!Number.isSafeInteger(record.calculatedSalary) || record.calculatedSalary <= 0) return { success: false, message: "Invalid calculated salary" };

            // Persist a processing snapshot before wallet mutation. This makes
            // the payout key durable and blocks a second request immediately.
            const payoutId = makePayoutId();
            record.payoutId = payoutId;
            record.status = "processing";
            record.payerAdminId = req.adminAccount.id;
            record.payerAdminUsername = req.adminAccount.username;
            record.updatedAt = new Date().toISOString();
            savePeriods();

            const user = ownerFound.user;
            const before = Math.max(0, Math.floor(Number(user.beans) || 0));
            const after = clampBeansBalance(agency.ownerUserId, before + record.calculatedSalary, "agency-salary");
            if (!Number.isSafeInteger(after) || after <= before) {
                record.status = "failed";
                record.failureReason = "Wallet balance validation failed";
                record.updatedAt = new Date().toISOString();
                savePeriods();
                return { success: false, message: record.failureReason };
            }

            user.beans = after;
            // Durable idempotency marker travels with the same users.json
            // wallet snapshot. It lets startup recovery distinguish a wallet
            // credit that completed from a processing record left by a crash.
            user.lastAgencySalaryPayout = { payoutId, periodKey: period.key, amount: record.calculatedSalary, appliedAt: new Date().toISOString() };
            record.beansBefore = before;
            record.beansAfter = after;
            saveUsers({ immediate: true });
            logTransaction(agency.ownerUserId, "beans", record.calculatedSalary, `Agency salary ${agency.agencyId} ${period.key} [${payoutId}]`);
            pushWalletUpdate(agency.ownerUserId);

            record.status = "paid";
            record.paidAmount = record.calculatedSalary;
            record.targetResetAt = new Date().toISOString();
            cycleResets[String(agency.agencyId)] = record.targetResetAt;
            saveCycleResets();
            record.paidAt = new Date().toISOString();
            record.updatedAt = record.paidAt;
            // The existing logTransaction() creates the actual transaction ID;
            // retrieve it by the unique payout marker so the report can expose
            // it without introducing another transaction implementation.
            const txSource = (typeof deps.getTransactions === "function" ? deps.getTransactions() : []);
            const tx = Array.isArray(txSource) ? txSource.slice().reverse().find((t) => t && t.userId === agency.ownerUserId && t.currency === "beans" && String(t.note || "").includes(`[${payoutId}]`)) : null;
            record.transactionId = tx ? tx.id : null;
            savePeriods();

            // Notification is strictly after successful wallet mutation and
            // transaction recording. A notification failure never turns a
            // successful payment into a failure.
            if (typeof sendSystemMessage === "function") {
                try { sendSystemMessage(agency.ownerUserId, `Agency Salary Received — ${record.paidAmount.toLocaleString()} Beans credited to your account.`); }
                catch (err) { console.error("[agency-commission] notification failed:", err.message); }
            }

            rbac.logAction({
                admin: req.adminAccount,
                action: "agency-salary-paid",
                module: "agency-commission",
                targetType: "agency",
                targetId: agency.agencyId,
                before: snapshot(record),
                after: snapshot(record),
                meta: { periodKey: period.key, payoutId, transactionId: record.transactionId, paidAmount: record.paidAmount },
                ip: req.ip,
                userAgent: reqUserAgent(req)
            });
            return { success: true, payout: publicRecord(record) };
        } finally {
            payoutLocks.delete(lockKey);
        }
    }

    reconcileProcessingRecords();

    // ---------------- ADMIN API ----------------
    const gate = [requireAdmin, requirePermission("agency-salary:manage")];

    app.get("/api/admin/agency-commission/policy", ...gate, (req, res) => {
        res.json({ success: true, policy });
    });

    app.put("/api/admin/agency-commission/policy", ...gate, (req, res) => {
        try {
            const before = snapshot(policy);
            const next = normalizePolicy(req.body || {});
            policy = next;
            savePolicy();
            rbac.logAction({ admin: req.adminAccount, action: "agency-commission-policy-update", module: "agency-commission", targetType: "policy", targetId: "agency-commission", before, after: next, ip: req.ip, userAgent: reqUserAgent(req) });
            res.json({ success: true, policy });
        } catch (err) {
            rbac.logAction({ admin: req.adminAccount, action: "agency-commission-policy-update", module: "agency-commission", targetType: "policy", targetId: "agency-commission", ip: req.ip, userAgent: reqUserAgent(req), result: "failed", failureReason: err.message });
            res.status(400).json({ success: false, message: err.message });
        }
    });

    app.get("/api/admin/agency-commission/agencies", ...gate, (req, res) => {
        const period = weeklyPeriod();
        const rows = listAgenciesForActor(req.adminAccount).map((agency) => publicRecord(calculateRecord(agency, period)));
        res.json({ success: true, period, agencies: rows });
    });

    app.put("/api/admin/agency-commission/agencies/:agencyId/target", ...gate, (req, res) => {
        const agency = agencies[req.params.agencyId];
        if (!ensureAgencyScope(req, res, agency)) return;
        try {
            const target = finiteNonNegativeInteger(req.body && req.body.weeklyTarget, "Weekly target");
            const period = weeklyPeriod();
            const record = periodRecordFor(agency, period, { create: true });
            if (record.status === "paid") return res.status(409).json({ success: false, message: "This weekly period is already paid and cannot be modified" });
            const before = snapshot(record);
            agency.weeklyTargetValue = target;
            if (!agency.weeklyTargetHistory || typeof agency.weeklyTargetHistory !== "object") agency.weeklyTargetHistory = {};
            agency.weeklyTargetHistory[period.key] = target;
            // Keep the target snapshot bounded. Historical salary records hold
            // their own immutable target once a period is materialized.
            const historyKeys = Object.keys(agency.weeklyTargetHistory).sort();
            if (historyKeys.length > 104) delete agency.weeklyTargetHistory[historyKeys[0]];
            record.weeklyTarget = target;
            record.updatedAt = new Date().toISOString();
            saveAgencies();
            savePeriods();
            rbac.logAction({ admin: req.adminAccount, action: "agency-weekly-target-update", module: "agency-commission", targetType: "agency", targetId: agency.agencyId, before, after: snapshot(record), ip: req.ip, userAgent: reqUserAgent(req) });
            res.json({ success: true, agency, period: publicRecord(calculateRecord(agency, period)) });
        } catch (err) {
            res.status(400).json({ success: false, message: err.message });
        }
    });

    app.get("/api/admin/agency-commission/preview", ...gate, (req, res) => {
        const period = req.query.periodStart && req.query.periodEnd
            ? periodFromInput(req.query.periodStart, req.query.periodEnd)
            : weeklyPeriod();
        if (!period) return res.status(400).json({ success: false, message: "Invalid 7-day period" });
        const rows = listAgenciesForActor(req.adminAccount).map((agency) => publicRecord(calculateRecord(agency, period)));
        const summary = {
            totalAgencies: rows.length,
            totalTarget: rows.reduce((s, r) => s + Number(r.weeklyTarget || 0), 0),
            totalAchieved: rows.reduce((s, r) => s + Number(r.actualAchieved || 0), 0),
            agenciesAchievingTarget: rows.filter((r) => Number(r.weeklyTarget) > 0 && Number(r.actualAchieved) >= Number(r.weeklyTarget)).length,
            agenciesBelowTarget: rows.filter((r) => Number(r.weeklyTarget) <= 0 || Number(r.actualAchieved) < Number(r.weeklyTarget)).length,
            totalCommission: rows.reduce((s, r) => s + Number(r.calculatedSalary || 0), 0),
            totalSalaryPaid: rows.filter((r) => r.status === "paid").reduce((s, r) => s + Number(r.paidAmount || 0), 0),
            totalPendingSalary: rows.filter((r) => r.status !== "paid").reduce((s, r) => s + Number(r.calculatedSalary || 0), 0)
        };
        res.json({ success: true, period, rows, summary });
    });

    app.get("/api/admin/agency-commission/history", ...gate, (req, res) => {
        const list = Object.values(periods)
            .filter((p) => actorCanAccessCountry(req.adminAccount, p.countryId || "OTHERS"))
            .sort((a, b) => new Date(b.periodStart) - new Date(a.periodStart) || String(a.agencyName).localeCompare(String(b.agencyName)));
        res.json({ success: true, periods: list.map(publicRecord) });
    });

    app.post("/api/admin/agency-commission/pay", ...gate, (req, res) => {
        const agency = agencies[String(req.body && req.body.agencyId || "")];
        if (!ensureAgencyScope(req, res, agency)) return;
        const period = periodFromInput(req.body && req.body.periodStart, req.body && req.body.periodEnd);
        if (!period) return res.status(400).json({ success: false, message: "Invalid 7-day period" });
        const result = payOne(agency, period, req);
        if (!result.success && !result.skipped) return res.status(500).json(result);
        if (!result.success) return res.status(409).json(result);
        res.json(result);
    });

    app.post("/api/admin/agency-commission/pay-all", ...gate, (req, res) => {
        const period = periodFromInput(req.body && req.body.periodStart, req.body && req.body.periodEnd);
        if (!period) return res.status(400).json({ success: false, message: "Invalid 7-day period" });
        if (!period.closed) return res.status(409).json({ success: false, message: "The weekly period is still active; salary can be paid after it closes" });
        const agenciesInScope = listAgenciesForActor(req.adminAccount);
        const results = [];
        for (const agency of agenciesInScope) {
            try { results.push({ agencyId: agency.agencyId, ...(payOne(agency, period, req)) }); }
            catch (err) { results.push({ agencyId: agency.agencyId, success: false, message: err.message }); }
        }
        const sent = results.filter((r) => r.success);
        const failed = results.filter((r) => !r.success && !r.skipped);
        rbac.logAction({ admin: req.adminAccount, action: "agency-salary-pay-all", module: "agency-commission", targetType: "period", targetId: period.key, meta: { total: results.length, sent: sent.length, failed: failed.length }, ip: req.ip, userAgent: reqUserAgent(req), result: failed.length ? "failed" : "success", failureReason: failed.length ? "one or more agency payouts failed" : null });
        res.json({ success: true, period, total: results.length, sent: sent.length, failed: failed.length, skipped: results.filter((r) => r.skipped).length, results });
    });

    app.get("/api/admin/agency-commission/pdf", ...gate, (req, res) => {
        const agency = agencies[String(req.query.agencyId || "")];
        if (!ensureAgencyScope(req, res, agency)) return;
        const period = periodFromInput(req.query.periodStart, req.query.periodEnd);
        if (!period) return res.status(400).json({ success: false, message: "Invalid 7-day period" });
        const record = periodRecordFor(agency, period, { create: false });
        if (!record || record.status !== "paid") return res.status(409).json({ success: false, message: "A paid Agency salary record is required before generating the PDF" });
        const pdf = buildSalaryPdf(record);
        const safeAgency = String(agency.name || agency.agencyId).replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "agency";
        res.set("Content-Type", "application/pdf");
        res.set("Content-Disposition", `attachment; filename="PINGPONG-AGENCY-SALARY-${safeAgency}-${record.payoutId || record.periodId}.pdf"`);
        res.set("Cache-Control", "no-store");
        res.send(pdf);
    });

    return {
        getPolicy: () => policy,
        calculateCommission,
        weeklyPeriod,
        normalizePolicy,
        getPeriods: () => periods
    };
}

// Tiny dependency-free PDF writer. This intentionally avoids adding a second
// PDF runtime/dependency to the application. It emits a readable one-page
// official proof with a simple professional layout.
function buildSalaryPdf(record) {
    const esc = (value) => String(value == null ? "" : value)
        .replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
        .replace(/[^\x20-\x7E]/g, "?");
    const money = Number(record.paidAmount || record.calculatedSalary || 0).toLocaleString("en-US");
    const lines = [
        ["PINGPONG", 770, 22],
        ["AGENCY SALARY REPORT", 738, 17],
        ["", 712, 10],
        [`Agency Name: ${record.agencyName}`, 682, 11],
        [`Agency Owner: ${record.agencyOwnerUserId}`, 658, 11],
        [`Weekly Period: ${record.periodStart}  to  ${record.periodEnd}`, 634, 10],
        [`Weekly Target: ${Number(record.weeklyTarget || 0).toLocaleString("en-US")}`, 610, 11],
        [`Achieved Target: ${Number(record.actualAchieved || 0).toLocaleString("en-US")}`, 586, 11],
        [`Achievement: ${Number(record.achievementPercent || 0).toLocaleString("en-US")}%`, 562, 11],
        [`Commission Tier: ${record.commissionTier || "-"}`, 538, 11],
        [`Commission: ${Number(record.commissionPercent || 0).toLocaleString("en-US")}%`, 514, 11],
        [`Calculated Salary: ${money} Beans`, 490, 12],
        [`Paid Amount: ${money} Beans`, 466, 14],
        [`Payment Status: ${record.status === "paid" ? "PAID" : String(record.status || "PENDING").toUpperCase()}`, 430, 14],
        [`Payment Date/Time: ${record.paidAt || "-"}`, 404, 10],
        [`Payout ID: ${record.payoutId || "-"}`, 380, 10],
        [`Transaction ID: ${record.transactionId || "-"}`, 356, 10],
        ["This document is an official PingPong Agency salary payment record.", 300, 9]
    ];
    const content = ["BT", ...lines.map(([text, y, size]) => `/F1 ${size} Tf 1 0 0 1 60 ${y} Tm (${esc(text)}) Tj`), "ET"].join("\n");
    const objects = [];
    const add = (body) => { objects.push(body); return objects.length; };
    add("<< /Type /Catalog /Pages 2 0 R >>");
    add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>");
    add(`<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`);
    add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((obj, i) => {
        offsets[i + 1] = Buffer.byteLength(pdf, "ascii");
        pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    });
    const xref = Buffer.byteLength(pdf, "ascii");
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objects.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(pdf, "ascii");
}

module.exports = { initAgencyCommission, DEFAULT_POLICY, normalizePolicy, weeklyPeriod, calculateCommission, buildSalaryPdf };
