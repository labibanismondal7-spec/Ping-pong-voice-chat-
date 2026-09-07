// ==========================================================================
// BEANS -> USD -> WITHDRAWAL SYSTEM (2026-08-31, additive)
// ==========================================================================
// Additive, self-contained module — same initX({deps}) dependency-injection
// pattern as hostSalary.js / agencyCommission.js / wallet/rechargeService.js.
// Does NOT create a second Beans wallet: the existing `user.beans` field,
// clampBeansBalance(), logTransaction(), and pushWalletUpdate() (all owned
// by server.js / hostSalary.js's Beans policy) are the only things that
// ever touch a user's Beans balance. This module only ever *reads* Beans
// and, when a user chooses to convert, deducts them through the exact same
// helpers everything else uses.
//
// What this module owns instead is a brand-new, separate accounting
// balance — the user's Withdraw Balance — denominated in USD, and the KYC
// + withdrawal-request workflow that gates access to it. That balance is
// NOT diamonds, coins, or Beans; it is the converted-and-reserved USD
// value produced by convertBeans() below, per requirement #4 of the spec
// ("do not create a second competing wallet system" — Beans stays the one
// Beans wallet; Withdraw Balance is a distinct ledgered accounting value,
// not a rival Beans wallet).
//
// MONEY SAFETY (spec #35): every USD amount in this module is stored and
// computed in integer minor units (USD cents), never floats. A $10.00
// balance is stored as 1000. Beans->USD conversion is
// `Math.floor(beans * 100 / beansPerUsd)` (integer math, floor — the user
// never gets free fractional cents rounded up).
//
// HONEST SCOPE NOTE (do not remove): this module implements the KYC +
// conversion + withdrawal-request + admin-decision + ledger/audit backend
// described in the spec. It does NOT integrate any actual bank-transfer or
// payout-gateway API — exactly like wallet/rechargeService.js next to it,
// there are no payout-provider credentials anywhere in this project's
// env/config. "Mark Paid" here means "an Admin has manually paid the user
// via their own bank/UPI and is recording that fact" — the same
// manual-verification model already used for recharge. Anything claiming
// this makes real bank transfers automatically would be false.

const crypto = require("crypto");
const countryKyc = require("./countryKyc.js");
const path = require("path");

function initPayoutWithdrawal(deps) {
    const {
        app, DATA_FOLDER, safeRead, safeWrite,
        users, findUserByUserId, saveUsers,
        logTransaction, pushWalletUpdate, clampBeansBalance,
        sendSystemMessage, emitToUser,
        rbac, requireAdmin, requirePermission, reqUserAgent,
        userAuth, resolveUserKey
    } = deps;

    if (!DATA_FOLDER || !safeRead || !safeWrite || !findUserByUserId || !saveUsers ||
        !logTransaction || !pushWalletUpdate || !clampBeansBalance || !sendSystemMessage ||
        !rbac || !requireAdmin || !requirePermission || !userAuth || !resolveUserKey) {
        throw new Error("initPayoutWithdrawal requires { app, DATA_FOLDER, safeRead, safeWrite, users, findUserByUserId, saveUsers, logTransaction, pushWalletUpdate, clampBeansBalance, sendSystemMessage, emitToUser, rbac, requireAdmin, requirePermission, reqUserAgent, userAuth, resolveUserKey }");
    }
    const _emitToUser = typeof emitToUser === "function" ? emitToUser : () => {};
    const _reqUserAgent = typeof reqUserAgent === "function" ? reqUserAgent : () => null;

    const SETTINGS_FILE = path.join(DATA_FOLDER, "withdrawalSettings.json");
    const KYC_FILE = path.join(DATA_FOLDER, "kycRecords.json");
    const BALANCES_FILE = path.join(DATA_FOLDER, "withdrawBalances.json");
    const CONVERSIONS_FILE = path.join(DATA_FOLDER, "beansConversions.json");
    const WITHDRAWALS_FILE = path.join(DATA_FOLDER, "withdrawals.json");

    const KYC_STATUSES = ["NOT_SUBMITTED", "PENDING", "VERIFIED", "REJECTED"];
    const WD_STATUSES = ["PENDING", "APPROVED", "PROCESSING", "PAID", "REJECTED", "FAILED", "CANCELLED"];
    const WD_TERMINAL = ["PAID", "REJECTED", "CANCELLED"]; // FAILED is retryable, not terminal — see requestPayment below

    // ---------------------------------------------------------------
    // Settings (spec #2, #28) — server-authoritative conversion policy
    // ---------------------------------------------------------------
    function defaultSettings() {
        return {
            beansPerUsd: 200000, // 200,000 Beans = $1 — matches the existing Host Salary "Withdrawal reference" documented in hostSalary.js
            minWithdrawalCents: 10000, // $100.00
            withdrawalEnabled: true,
            rateHistory: [] // { beansPerUsd, minWithdrawalCents, changedBy, changedAt } — audit trail, never rewrites old conversions (spec #27/#28)
        };
    }
    function loadSettings() {
        const s = safeRead(SETTINGS_FILE, defaultSettings());
        if (!Number.isFinite(s.beansPerUsd) || s.beansPerUsd < 1) s.beansPerUsd = 200000;
        if (!Number.isFinite(s.minWithdrawalCents) || s.minWithdrawalCents < 0) s.minWithdrawalCents = 10000;
        if (typeof s.withdrawalEnabled !== "boolean") s.withdrawalEnabled = true;
        if (!Array.isArray(s.rateHistory)) s.rateHistory = [];
        return s;
    }
    function saveSettings(s) { safeWrite(SETTINGS_FILE, s); }
    let settings = loadSettings();

    // ---------------------------------------------------------------
    // KYC store — keyed by userId (spec #8/#9)
    // ---------------------------------------------------------------
    function loadKyc() { return safeRead(KYC_FILE, {}); }
    function saveKyc(k) { safeWrite(KYC_FILE, k); }
    let kycRecords = loadKyc();

    // ---------------------------------------------------------------
    // Withdraw Balance store — keyed by userId, integer USD cents
    // (spec #15 — available vs reserved)
    // ---------------------------------------------------------------
    function loadBalances() { return safeRead(BALANCES_FILE, {}); }
    function saveBalances(b) { safeWrite(BALANCES_FILE, b); }
    let balances = loadBalances();

    function getBalance(userId) {
        if (!balances[userId]) balances[userId] = { availableCents: 0, reservedCents: 0 };
        return balances[userId];
    }

    // ---------------------------------------------------------------
    // Conversion + withdrawal ledgers (append-only / keyed, immutable
    // once written — spec #26/#27)
    // ---------------------------------------------------------------
    function loadConversions() { return safeRead(CONVERSIONS_FILE, []); }
    function saveConversions(c) { safeWrite(CONVERSIONS_FILE, c); }
    let conversions = loadConversions();

    function loadWithdrawals() { return safeRead(WITHDRAWALS_FILE, {}); }
    function saveWithdrawals(w) { safeWrite(WITHDRAWALS_FILE, w); }
    let withdrawals = loadWithdrawals();

    // ---------------------------------------------------------------
    // Validation helpers (spec #34)
    // ---------------------------------------------------------------
    const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
    const AADHAAR_RE = /^[0-9]{12}$/;
    const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

    function maskTail(value, keep) {
        const v = String(value || "");
        if (v.length <= keep) return "X".repeat(v.length);
        return "X".repeat(v.length - keep) + v.slice(-keep);
    }
    function maskAccountNumber(v) { return maskTail(v, 4); }
    function maskIfsc(v) { // IFSC has no secrecy need for the branch part, but mask per spec #6/#10 anyway; show bank/branch prefix + tail
        const v2 = String(v || "");
        return v2 ? v2.slice(0, 4) + "0" + "X".repeat(Math.max(0, v2.length - 5)) : v2;
    }
    function maskPan(v) { return maskTail(v, 4); }
    function maskAadhaar(v) { return maskTail(v, 4); }

    function centsFromUsdInput(v) {
        // Accepts a decimal-dollar number from an admin/report filter (never
        // trusted for accounting) and converts to integer cents.
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        return Math.round(n * 100);
    }
    function usdLabel(cents) { return "$" + (Math.max(0, Math.floor(cents)) / 100).toFixed(2); }

    // ---------------------------------------------------------------
    // KYC status the user is currently allowed to see for themselves
    // (spec #10 — never leak full PAN/Aadhaar/account to the owning user
    // either; only masked values, same as everyone else who isn't an
    // authorized Admin)
    // ---------------------------------------------------------------
    function publicKycView(rec) {
        if (!rec) return { status: "NOT_SUBMITTED" };
        const docStatuses = {};
        for (const d of (rec.documents || [])) docStatuses[d.key] = d.status || "PENDING";
        return {
            status: rec.status,
            countryId: rec.countryId || "OTHERS",
            countryName: rec.countryName || null,
            documents: docStatuses,
            bankAccountMasked: rec.accountNumber ? countryKyc.mask(rec.accountNumber) : null,
            bankIdentifiers: Object.fromEntries(Object.entries(rec.bankIdentifiers || {}).map(([k,v]) => [k, countryKyc.mask(v, 4)])),
            bankName: rec.bankName || null,
            submittedAt: rec.submittedAt || null,
            rejectionReason: rec.status === "REJECTED" ? (rec.rejectionReason || null) : null
        };
    }
    function adminKycView(rec) {
        if (!rec) return null;
        return Object.assign({}, rec); // full values — route is already gated by kyc:review/payout:review below
    }

    // ==================================================================
    // USER-FACING FUNCTIONS
    // ==================================================================

    // spec #6 — Withdraw screen summary
    function getUserWithdrawState(userId) {
        const found = findUserByUserId(userId);
        const beans = found ? Math.max(0, Math.floor(Number(found.user.beans) || 0)) : 0;
        const bal = getBalance(userId);
        return {
            success: true,
            beans,
            beansPerUsd: settings.beansPerUsd,
            withdrawalEnabled: settings.withdrawalEnabled,
            minWithdrawalCents: settings.minWithdrawalCents,
            minWithdrawalLabel: usdLabel(settings.minWithdrawalCents),
            availableCents: bal.availableCents,
            availableLabel: usdLabel(bal.availableCents),
            reservedCents: bal.reservedCents,
            reservedLabel: usdLabel(bal.reservedCents),
            profileCountryId: String(found.user.country || found.user.countryId || "IN").trim().toUpperCase(),
            kyc: publicKycView(kycRecords[userId])
        };
    }

    // spec #32 — user's own withdrawal history only
    function getUserWithdrawalHistory(userId) {
        return Object.values(withdrawals)
            .filter((w) => w.userId === userId)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
            .map((w) => ({ id: w.id, amountCents: w.amountCents, amountLabel: usdLabel(w.amountCents), status: w.status, createdAt: w.createdAt, paidAt: w.paidAt || null }));
    }

    // spec #8/#34 — KYC submission (or resubmission after rejection)
    function submitKyc(userId, input) {
        const found = findUserByUserId(userId);
        if (!found) return { success: false, message: "User not found" };
        const existing = kycRecords[userId];
        if (existing && existing.status === "VERIFIED") return { success: false, message: "KYC is already verified" };
        if (existing && existing.status === "PENDING") return { success: false, message: "KYC is already under review" };

        const profileCountry = String(found.user.country || "").trim().toUpperCase();
        const requestedCountry = String((input && input.countryId) || profileCountry ||
            ((input && (input.pan || input.aadhaar || input.ifsc)) ? "IN" : (found.user.countryId || "OTHERS"))).toUpperCase();
        if (profileCountry && requestedCountry !== profileCountry) {
            return { success:false, message:"KYC country must match the country selected in your profile" };
        }
        const countryId = requestedCountry;
        const result = countryKyc.validate(countryId, input || {});
        if (!result.valid) return { success:false, message:result.errors[0], errors:result.errors };

        const rule = countryKyc.ruleFor(countryId);
        const docs = (rule.documents || []).map(d => ({ key:d.key, status:"PENDING" }));
        const bankIdentifiers = {};
        for (const b of (rule.bank.identifiers || [])) if (result.value[b.key]) bankIdentifiers[b.key]=result.value[b.key];

        kycRecords[userId] = {
            userId, countryId, countryName:rule.name, currency:rule.currency,
            documents:docs, documentValues:Object.fromEntries((rule.documents||[]).map(d=>[d.key,result.value[d.key]])),
            accountHolder:result.value.accountHolder, accountNumber:result.value.accountNumber,
            bankIdentifiers, ifsc:result.value.ifsc||null, routingNumber:result.value.routingNumber||null,
            iban:result.value.iban||null, sortCode:result.value.sortCode||null, bankName:result.value.bankName||null,
            status:"PENDING", rejectionReason:null, submittedAt:new Date().toISOString(),
            decidedAt:null, decidedBy:null
        };
        // Compatibility fields retained for older withdrawal snapshots/UI.
        kycRecords[userId].pan = result.value.pan || null;
        kycRecords[userId].aadhaar = result.value.aadhaar || null;
        kycRecords[userId].panStatus = result.value.pan ? "PENDING" : "NOT_REQUIRED";
        kycRecords[userId].aadhaarStatus = result.value.aadhaar ? "PENDING" : "NOT_REQUIRED";
        saveKyc(kycRecords);
        sendSystemMessage(userId, `Your ${rule.name} KYC has been submitted and is pending Admin review.`);
        return { success:true, kyc:publicKycView(kycRecords[userId]) };
    }
    // spec #3/#27 — convert Beans into Withdraw Balance, server-side only
    function convertBeans(userId, beansRequested) {
        const found = findUserByUserId(userId);
        if (!found) return { success: false, message: "User not found" };
        const amount = Math.floor(Number(beansRequested));
        if (!Number.isSafeInteger(amount) || amount <= 0) return { success: false, message: "Invalid Beans amount" };

        const currentBeans = Math.max(0, Math.floor(Number(found.user.beans) || 0));
        if (amount > currentBeans) return { success: false, message: "Insufficient Beans balance" };

        const rate = settings.beansPerUsd;
        const usdCents = Math.floor((amount * 100) / rate); // integer math, floor — spec #35
        if (usdCents <= 0) return { success: false, message: `At least ${rate.toLocaleString()} Beans are required to convert` };

        // Deduct Beans through the SAME helpers every other Beans mutation
        // uses (spec #4) — never a raw field write.
        const nextBeans = clampBeansBalance(userId, currentBeans - amount, "payout-withdrawal-conversion");
        if (nextBeans >= currentBeans) return { success: false, message: "Beans deduction failed" };
        found.user.beans = nextBeans;
        saveUsers();
        logTransaction(userId, "beans", -amount, "Converted to Withdraw Balance");
        pushWalletUpdate(userId);

        const bal = getBalance(userId);
        bal.availableCents += usdCents;
        saveBalances(balances);

        const conversionId = "cnv_" + Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex");
        conversions.push({
            id: conversionId, userId,
            beansConverted: amount, beansPerUsdAtConversion: rate, usdCentsCreated: usdCents,
            timestamp: new Date().toISOString()
        });
        saveConversions(conversions);

        sendSystemMessage(userId, `${amount.toLocaleString()} Beans converted to ${usdLabel(usdCents)} Withdraw Balance.`);
        _emitToUser(userId, "withdraw-balance-update", { availableCents: bal.availableCents, reservedCents: bal.reservedCents });

        return { success: true, beansDeducted: amount, usdCentsCreated: usdCents, balance: bal };
    }

    // spec #13/#14/#15 — submit a withdrawal request (reserve funds)
    function requestWithdrawal(userId, amountCentsRequested) {
        const found = findUserByUserId(userId);
        if (!found) return { success: false, message: "User not found" };
        if (!settings.withdrawalEnabled) return { success: false, message: "Withdrawals are currently disabled" };

        const kyc = kycRecords[userId];
        if (!kyc || kyc.status !== "VERIFIED") return { success: false, message: "Complete KYC to enable Withdrawal" };

        const amountCents = Math.floor(Number(amountCentsRequested));
        if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return { success: false, message: "Invalid withdrawal amount" };
        if (amountCents < settings.minWithdrawalCents) return { success: false, message: `Minimum withdrawal is ${usdLabel(settings.minWithdrawalCents)}` };

        const bal = getBalance(userId);
        if (amountCents > bal.availableCents) return { success: false, message: "Insufficient Withdraw Balance" };

        // Reserve — available -> reserved (spec #15), atomic within this
        // synchronous function (no await between the check above and the
        // mutation below).
        bal.availableCents -= amountCents;
        bal.reservedCents += amountCents;
        saveBalances(balances);

        const id = "wd_" + Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex");
        const record = {
            id, userId, amountCents,
            status: "PENDING",
            statusHistory: [{ status: "PENDING", at: new Date().toISOString(), by: "user" }],
            kycSnapshot: { // immutable snapshot — future KYC edits never alter this
                countryId: kyc.countryId || "OTHERS", countryName: kyc.countryName || null,
                status: kyc.status, documents: (kyc.documents || []).map(d => ({ key:d.key, status:d.status })),
                panStatus: kyc.panStatus || "NOT_REQUIRED", aadhaarStatus: kyc.aadhaarStatus || "NOT_REQUIRED"
            },
            bankSnapshot: {
                accountHolder: kyc.accountHolder, accountNumber: kyc.accountNumber,
                bankName: kyc.bankName || null, bankIdentifiers: Object.assign({}, kyc.bankIdentifiers || {}),
                ifsc: kyc.ifsc || null, routingNumber: kyc.routingNumber || null,
                iban: kyc.iban || null, sortCode: kyc.sortCode || null
            },
            createdAt: new Date().toISOString(),
            decidedAt: null, decidedBy: null, rejectionReason: null,
            paidAt: null, payoutTxnId: null
        };
        withdrawals[id] = record;
        saveWithdrawals(withdrawals);

        sendSystemMessage(userId, `Withdrawal request for ${usdLabel(amountCents)} submitted and is pending review.`);
        _emitToUser(userId, "withdraw-balance-update", { availableCents: bal.availableCents, reservedCents: bal.reservedCents });

        return { success: true, withdrawalId: id, status: "PENDING" };
    }

    // ==================================================================
    // ADMIN FUNCTIONS
    // ==================================================================

    function auditLog(req, action, targetType, targetId, meta, result, failureReason) {
        rbac.logAction({
            admin: req.adminAccount, action, module: "payout-withdrawal",
            targetType, targetId, meta: meta || null,
            ip: req.ip, userAgent: _reqUserAgent(req),
            result: result || "success", failureReason: failureReason || null
        });
    }

    function adminListKyc(statusFilter, countryFilter) {
        return Object.values(kycRecords)
            .filter((r) => !statusFilter || r.status === statusFilter)
            .filter((r) => !countryFilter || String(r.countryId || "OTHERS").toUpperCase() === String(countryFilter).toUpperCase())
            .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));
    }

    function adminVerifyKyc(req, userId) {
        const rec = kycRecords[userId];
        if (!rec) return { success: false, message: "No KYC submission found" };
        if (rec.status === "VERIFIED") return { success: false, message: "Already verified" };
        rec.status = "VERIFIED"; for (const d of (rec.documents || [])) d.status = "VERIFIED"; rec.panStatus = rec.pan ? "VERIFIED" : "NOT_REQUIRED"; rec.aadhaarStatus = rec.aadhaar ? "VERIFIED" : "NOT_REQUIRED";
        rec.rejectionReason = null;
        rec.decidedAt = new Date().toISOString();
        rec.decidedBy = req.adminAccount.id;
        saveKyc(kycRecords);
        sendSystemMessage(userId, "Your KYC has been verified. Withdrawal is now enabled.");
        auditLog(req, "kyc-verified", "kyc", userId, null);
        return { success: true, kyc: adminKycView(rec) };
    }

    function adminRejectKyc(req, userId, reason) {
        const rec = kycRecords[userId];
        if (!rec) return { success: false, message: "No KYC submission found" };
        if (rec.status === "VERIFIED") return { success: false, message: "Already verified" };
        rec.status = "REJECTED"; for (const d of (rec.documents || [])) d.status = "REJECTED"; rec.panStatus = rec.pan ? "REJECTED" : "NOT_REQUIRED"; rec.aadhaarStatus = rec.aadhaar ? "REJECTED" : "NOT_REQUIRED";
        rec.rejectionReason = String(reason || "").trim().slice(0, 300) || "Not specified";
        rec.decidedAt = new Date().toISOString();
        rec.decidedBy = req.adminAccount.id;
        saveKyc(kycRecords);
        sendSystemMessage(userId, `Your KYC was rejected: ${rec.rejectionReason}. You may correct and resubmit.`);
        auditLog(req, "kyc-rejected", "kyc", userId, { reason: rec.rejectionReason });
        return { success: true, kyc: adminKycView(rec) };
    }

    function adminListWithdrawals(filters) {
        filters = filters || {};
        let list = Object.values(withdrawals);
        if (filters.status) list = list.filter((w) => w.status === filters.status);
        if (filters.userId) list = list.filter((w) => w.userId === filters.userId);
        if (filters.fromDate) list = list.filter((w) => new Date(w.createdAt) >= new Date(filters.fromDate));
        if (filters.toDate) list = list.filter((w) => new Date(w.createdAt) <= new Date(filters.toDate));
        if (filters.minAmountCents != null) list = list.filter((w) => w.amountCents >= filters.minAmountCents);
        return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    function summary() {
        const list = Object.values(withdrawals);
        const sum = { pendingCents: 0, processingCents: 0, paidCents: 0, rejectedCents: 0, counts: { PENDING: 0, APPROVED: 0, PROCESSING: 0, PAID: 0, REJECTED: 0, FAILED: 0, CANCELLED: 0 } };
        for (const w of list) {
            sum.counts[w.status] = (sum.counts[w.status] || 0) + 1;
            if (w.status === "PENDING" || w.status === "APPROVED") sum.pendingCents += w.amountCents;
            else if (w.status === "PROCESSING") sum.processingCents += w.amountCents;
            else if (w.status === "PAID") sum.paidCents += w.amountCents;
            else if (w.status === "REJECTED") sum.rejectedCents += w.amountCents;
        }
        return sum;
    }

    // spec #21/#22/#23 — the only status-transition entry point, atomic
    // per-call (no await between the status guard and the write), so a
    // double-click / retried request / two admins racing can never process
    // the same withdrawal twice (spec #20).
    function adminDecideWithdrawal(req, withdrawalId, action, extra) {
        const w = withdrawals[withdrawalId];
        if (!w) return { success: false, message: "Withdrawal not found" };
        extra = extra || {};

        if (action === "approve") {
            if (w.status !== "PENDING") return { success: false, message: `Cannot approve from status ${w.status}` };
            w.status = "APPROVED";
        } else if (action === "processing") {
            if (w.status !== "APPROVED" && w.status !== "PENDING" && w.status !== "FAILED") return { success: false, message: `Cannot mark processing from status ${w.status}` };
            w.status = "PROCESSING";
        } else if (action === "reject") {
            if (WD_TERMINAL.includes(w.status)) return { success: false, message: `Cannot reject from status ${w.status}` };
            const bal = getBalance(w.userId);
            bal.reservedCents = Math.max(0, bal.reservedCents - w.amountCents);
            bal.availableCents += w.amountCents; // release reservation back to Available (spec #15)
            saveBalances(balances);
            w.status = "REJECTED";
            w.rejectionReason = String(extra.reason || "").trim().slice(0, 300) || "Not specified";
            sendSystemMessage(w.userId, `Withdrawal Rejected — ${usdLabel(w.amountCents)} was returned to your Withdraw Balance. Reason: ${w.rejectionReason}`);
            _emitToUser(w.userId, "withdraw-balance-update", { availableCents: bal.availableCents, reservedCents: bal.reservedCents });
        } else if (action === "failed") {
            // spec #22 — failure never marks PAID and never silently drops
            // the reservation; it stays RESERVED so an Admin can retry
            // (re-decide "processing" or "paid") or explicitly reject it
            // later to release funds. This is the one non-terminal status.
            if (w.status !== "PROCESSING" && w.status !== "APPROVED") return { success: false, message: `Cannot mark failed from status ${w.status}` };
            w.status = "FAILED";
        } else if (action === "paid") {
            // Duplicate-payout guard (spec #20/#23): PAID is terminal and
            // this is the only line that ever sets it. Re-checking here
            // (not just trusting the caller) means even a route bug or a
            // second concurrent call in the same tick cannot double-pay.
            if (w.status === "PAID") return { success: false, message: "Already paid — duplicate payout blocked" };
            // FAILED is retryable (spec #22) — an Admin can retry a failed
            // payment and mark it paid once it actually succeeds, without
            // needing to route back through processing first.
            if (w.status !== "PROCESSING" && w.status !== "APPROVED" && w.status !== "FAILED") return { success: false, message: `Cannot mark paid from status ${w.status}` };
            const bal = getBalance(w.userId);
            bal.reservedCents = Math.max(0, bal.reservedCents - w.amountCents); // permanently consumed, never returned to Available
            saveBalances(balances);
            w.status = "PAID";
            w.paidAt = new Date().toISOString();
            w.payoutTxnId = String(extra.payoutTxnId || "").trim().slice(0, 100) || null;
            sendSystemMessage(w.userId, `Withdrawal Paid — ${usdLabel(w.amountCents)} has been successfully processed.`);
            _emitToUser(w.userId, "withdraw-balance-update", { availableCents: bal.availableCents, reservedCents: bal.reservedCents });
        } else {
            return { success: false, message: "Unknown action" };
        }

        w.decidedAt = new Date().toISOString();
        w.decidedBy = req.adminAccount.id;
        w.statusHistory.push({ status: w.status, at: w.decidedAt, by: req.adminAccount.username || req.adminAccount.id });
        saveWithdrawals(withdrawals);
        auditLog(req, "withdrawal-" + action, "withdrawal", withdrawalId, { amountCents: w.amountCents, userId: w.userId, newStatus: w.status });
        return { success: true, withdrawal: w };
    }

    function adminUpdateSettings(req, patch) {
        const next = Object.assign({}, settings);
        let changed = false;
        if (patch.beansPerUsd !== undefined) {
            const v = Math.floor(Number(patch.beansPerUsd));
            if (!Number.isFinite(v) || v < 1) return { success: false, message: "Invalid Beans/$1 rate" };
            if (v !== next.beansPerUsd) { next.beansPerUsd = v; changed = true; }
        }
        if (patch.minWithdrawalCents !== undefined) {
            const v = Math.floor(Number(patch.minWithdrawalCents));
            if (!Number.isFinite(v) || v < 0) return { success: false, message: "Invalid minimum withdrawal" };
            if (v !== next.minWithdrawalCents) { next.minWithdrawalCents = v; changed = true; }
        }
        if (patch.withdrawalEnabled !== undefined) {
            const v = !!patch.withdrawalEnabled;
            if (v !== next.withdrawalEnabled) { next.withdrawalEnabled = v; changed = true; }
        }
        if (changed) {
            next.rateHistory = (next.rateHistory || []).concat([{
                beansPerUsd: next.beansPerUsd, minWithdrawalCents: next.minWithdrawalCents, withdrawalEnabled: next.withdrawalEnabled,
                changedBy: req.adminAccount.id, changedAt: new Date().toISOString()
            }]).slice(-200);
            settings = next;
            saveSettings(settings);
            auditLog(req, "withdrawal-settings-changed", "settings", "withdrawal", { beansPerUsd: settings.beansPerUsd, minWithdrawalCents: settings.minWithdrawalCents, withdrawalEnabled: settings.withdrawalEnabled });
        }
        // Past conversions already stored their own beansPerUsdAtConversion
        // snapshot (spec #27) — nothing here ever touches conversions[].
        return { success: true, settings };
    }

    // ==================================================================
    // ROUTES
    // ==================================================================
    if (app) {
        // ---- USER ROUTES ----
        app.get("/api/withdrawal/state", userAuth.requireUserAuth, (req, res) => {
            const u = users[resolveUserKey(req)];
            if (!u) return res.json({ success: false, message: "User not found" });
            res.json(getUserWithdrawState(u.userId));
        });
        app.get("/api/withdrawal/history", userAuth.requireUserAuth, (req, res) => {
            const u = users[resolveUserKey(req)];
            if (!u) return res.json({ success: false, message: "User not found" });
            res.json({ success: true, history: getUserWithdrawalHistory(u.userId) });
        });
        app.post("/api/withdrawal/kyc/submit", userAuth.requireUserAuth, (req, res) => {
            const u = users[resolveUserKey(req)];
            if (!u) return res.json({ success: false, message: "User not found" });
            res.json(submitKyc(u.userId, req.body || {}));
        });
        app.post("/api/withdrawal/convert", userAuth.requireUserAuth, (req, res) => {
            const u = users[resolveUserKey(req)];
            if (!u) return res.json({ success: false, message: "User not found" });
            res.json(convertBeans(u.userId, req.body && req.body.beans));
        });
        app.post("/api/withdrawal/request", userAuth.requireUserAuth, (req, res) => {
            const u = users[resolveUserKey(req)];
            if (!u) return res.json({ success: false, message: "User not found" });
            // Client sends a dollar amount for display purposes only — it is
            // immediately converted to cents and every other value used for
            // the actual decision (KYC, balance, minimum) is looked up
            // server-side above. The browser is never trusted (spec #13).
            const cents = centsFromUsdInput(req.body && req.body.amountUsd);
            res.json(requestWithdrawal(u.userId, cents));
        });

        // Country-aware KYC schema. The user client only receives field definitions,
        // never another user's KYC data.
        app.get("/api/withdrawal/kyc/countries", userAuth.requireUserAuth, (req, res) => {
            const u = users[resolveUserKey(req)];
            if (!u) return res.json({ success:false, message:"User not found" });
            // Full supported-country catalogue. submitKyc() still enforces
            // that the KYC country matches the user's selected profile country.
            const countries = Object.keys(countryKyc.RULES)
                .filter(id => id !== "OTHERS")
                .map(id => countryKyc.schema(id));
            res.json({ success:true, countries, fallback:countryKyc.schema("OTHERS") });
        });
        app.get("/api/withdrawal/kyc/schema/:countryId", userAuth.requireUserAuth, (req,res) => {
            res.json({success:true,schema:countryKyc.schema(req.params.countryId)});
        });

        // ---- ADMIN ROUTES: KYC ----
        app.get("/api/admin/kyc", requireAdmin, requirePermission("kyc:view"), (req, res) => {
            res.json({ success: true, records: adminListKyc(req.query.status, req.query.countryId).map(adminKycView) });
        });
        app.get("/api/admin/kyc/:userId", requireAdmin, requirePermission("kyc:view"), (req, res) => {
            res.json({ success: true, record: adminKycView(kycRecords[req.params.userId]) });
        });
        app.post("/api/admin/kyc/:userId/verify", requireAdmin, requirePermission("kyc:review"), (req, res) => {
            res.json(adminVerifyKyc(req, req.params.userId));
        });
        app.post("/api/admin/kyc/:userId/reject", requireAdmin, requirePermission("kyc:review"), (req, res) => {
            res.json(adminRejectKyc(req, req.params.userId, req.body && req.body.reason));
        });

        // ---- ADMIN ROUTES: WITHDRAWALS ----
        app.get("/api/admin/withdrawals/summary", requireAdmin, requirePermission("payout:view"), (req, res) => {
            res.json({ success: true, summary: summary() });
        });
        app.get("/api/admin/withdrawals", requireAdmin, requirePermission("payout:view"), (req, res) => {
            const filters = {
                status: req.query.status || null, userId: req.query.userId || null,
                fromDate: req.query.fromDate || null, toDate: req.query.toDate || null,
                minAmountCents: req.query.minAmountUsd ? centsFromUsdInput(req.query.minAmountUsd) : null
            };
            res.json({ success: true, withdrawals: adminListWithdrawals(filters) });
        });
        app.get("/api/admin/withdrawals/:id", requireAdmin, requirePermission("payout:view"), (req, res) => {
            const w = withdrawals[req.params.id];
            if (!w) return res.json({ success: false, message: "Not found" });
            res.json({ success: true, withdrawal: w });
        });
        app.post("/api/admin/withdrawals/:id/approve", requireAdmin, requirePermission("payout:review"), (req, res) => {
            res.json(adminDecideWithdrawal(req, req.params.id, "approve"));
        });
        app.post("/api/admin/withdrawals/:id/reject", requireAdmin, requirePermission("payout:review"), (req, res) => {
            res.json(adminDecideWithdrawal(req, req.params.id, "reject", { reason: req.body && req.body.reason }));
        });
        app.post("/api/admin/withdrawals/:id/processing", requireAdmin, requirePermission("payout:review"), (req, res) => {
            res.json(adminDecideWithdrawal(req, req.params.id, "processing"));
        });
        app.post("/api/admin/withdrawals/:id/failed", requireAdmin, requirePermission("payout:review"), (req, res) => {
            res.json(adminDecideWithdrawal(req, req.params.id, "failed"));
        });
        // Marking PAID is the actual money-movement confirmation — gated by
        // the higher-trust payout:approve permission (spec #21).
        app.post("/api/admin/withdrawals/:id/paid", requireAdmin, requirePermission("payout:approve"), (req, res) => {
            res.json(adminDecideWithdrawal(req, req.params.id, "paid", { payoutTxnId: req.body && req.body.payoutTxnId }));
        });

        // ---- ADMIN ROUTES: SETTINGS ----
        app.get("/api/admin/withdrawal-settings", requireAdmin, requirePermission("payout:view"), (req, res) => {
            res.json({ success: true, settings });
        });
        app.post("/api/admin/withdrawal-settings", requireAdmin, requirePermission("payout-settings:manage"), (req, res) => {
            res.json(adminUpdateSettings(req, req.body || {}));
        });
    }

    return {
        getUserWithdrawState, getUserWithdrawalHistory, submitKyc, convertBeans, requestWithdrawal,
        adminListKyc, adminVerifyKyc, adminRejectKyc,
        adminListWithdrawals, adminDecideWithdrawal, adminUpdateSettings, summary,
        _internal: { getBalance, getSettings: () => settings, KYC_STATUSES, WD_STATUSES } // exposed for tests only
    };
}

module.exports = { initPayoutWithdrawal };
