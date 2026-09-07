// ==================================================
// CALL HOSTING SYSTEM (additive module)
// ==================================================
// Paid voice/video calls to Admin-approved "Call Hosts". Separate from and
// does not touch callSignaling.js (the existing free private-inbox calling
// feature) — different socket event namespace ("hostcall:*" vs "call:*"),
// different data files, different in-memory maps. Both modules can be
// mid-call for the same user at once with zero interference; the only
// shared surface is the socketsByUserId map (read-only here) and the
// wallet helpers (clampDiamondBalance/logTransaction/pushWalletUpdate/
// saveUsers), which are the same functions every other coin-touching
// module in this project already calls — no wallet code is modified.
//
// Same shape as callSignaling.js / banManagement.js: one init function
// returns { registerSocketHandlers, handleDisconnect, resumeCall } for
// server.js to wire into its single existing io.on("connection", ...)
// block and its existing disconnect/identify/join-room handlers — no
// second io.on("connection") is created. REST admin routes are mounted
// on the existing `app` the same way country_permission's module does.
//
// SERVER-AUTHORITATIVE BILLING (requirement #5/#12): the client never
// computes diamonds. A per-call setInterval on the server is the only thing
// that deducts diamonds, at a fixed cadence (every 60s of connected time,
// billed one minute at a time, first minute charged at connect). Every
// tick re-checks the caller's live balance and the call's elapsed time
// against maxCallDurationSec/maxDailyMinutes before charging — never
// trusts anything the client sends. 100% of every charge goes to the
// company revenue ledger; the host balance is never touched (requirement
// #3/#11 — no auto payout, reports are for manual salary calculation).
//
// VIDEO SECURITY (requirement #7): screen-capture/recording prevention is
// inherently a client/OS-level capability (Android WebView secure flags,
// etc.) — there is no server-side mechanism that can enforce it. This
// module exposes `secureMode: true` on every video hostcall:started/
// hostcall:accepted payload as a signal for the client to apply the
// strongest available platform protection (see public/app.js
// applyHostCallSecureMode() and its doc comment for exactly what is and
// isn't achievable). The call is never blocked or degraded if the
// platform can't fully honor it, per the instruction not to disable
// video calling over this.

const path = require("path");
const crypto = require("crypto");

const DEFAULT_RATES = Object.freeze({
    diamondsPerMinute: 100,
    minBalance: 100,
    maxCallDurationSec: 3600,   // 1 hour hard cap per call
    maxDailyMinutes: null,      // null = no daily cap
    enabled: true
});

const BILL_INTERVAL_MS = 60000; // bill one minute at a time
const RING_TIMEOUT_MS = 45000;
const DISCONNECT_GRACE_MS = 15000; // mirrors callSignaling.js's reconnect grace
const HOST_STATUSES = ["pending", "approved", "rejected", "suspended", "disabled", "removed"];
const HISTORY_CAP = 5000; // per-file cap, oldest trimmed first (same spirit as TRANSACTIONS_LIVE_CAP)

function todayKey(d = new Date()) { return d.toISOString().slice(0, 10); }

function initCallHosting(deps) {
    const {
        app, io, DATA_FOLDER, safeRead, safeWrite,
        findUserByUserId, socketsByUserId, saveUsers,
        clampDiamondBalance, logTransaction, pushWalletUpdate,
        rbac, requireAdmin, requirePermission,
        actorCanAccessCountry, countryDeniedResponse, reqUserAgent
    } = deps;

    const HOSTS_FILE = path.join(DATA_FOLDER, "callhosting_hosts.json");
    const RATES_FILE = path.join(DATA_FOLDER, "callhosting_rates.json");
    const TARGETS_FILE = path.join(DATA_FOLDER, "callhosting_targets.json");
    const REVENUE_FILE = path.join(DATA_FOLDER, "callhosting_revenue.json");
    const HISTORY_FILE = path.join(DATA_FOLDER, "callhosting_history.json");

    let hosts = safeRead(HOSTS_FILE, {});           // userId -> host record
    let rates = safeRead(RATES_FILE, { ...DEFAULT_RATES });
    let targets = safeRead(TARGETS_FILE, {});        // userId -> target record
    let revenue = safeRead(REVENUE_FILE, { total: 0, byDay: {} });
    let history = safeRead(HISTORY_FILE, []);         // array of completed call records

    function saveHosts() { safeWrite(HOSTS_FILE, hosts); }
    function saveRates() { safeWrite(RATES_FILE, rates); }
    function saveTargets() { safeWrite(TARGETS_FILE, targets); }
    function saveRevenue() { safeWrite(REVENUE_FILE, revenue); }
    function saveHistory() {
        if (history.length > HISTORY_CAP) history.splice(0, history.length - HISTORY_CAP);
        safeWrite(HISTORY_FILE, history);
    }

    const activeCalls = new Map();   // callId -> call record
    const userCallState = new Map(); // userId -> callId (caller or host, busy tracking)

    // RANDOM CALL SUPPORT (additive): optional per-call event hooks, keyed
    // by callId. Nothing in the existing direct hostcall:invite path sets
    // these, so normal call behavior is completely unchanged — only calls
    // started via attemptInvite()'s `hooks` option populate this map. Used
    // by randomCall.js to know when to try the next host, without that
    // module reimplementing any billing/signaling/call-state logic here.
    const callEventHooks = new Map(); // callId -> { onAccepted?, onEnded? }
    function fireHook(callId, name, arg) {
        const hook = callEventHooks.get(callId);
        if (hook && typeof hook[name] === "function") { try { hook[name](arg); } catch (e) {} }
    }

    function hostRecord(userId) { return hosts[userId] || null; }
    function isApprovedHost(userId) {
        const h = hostRecord(userId);
        return !!h && h.status === "approved";
    }

    function socketFor(userId) {
        const sid = socketsByUserId[userId];
        return sid ? io.sockets.sockets.get(sid) : null;
    }

    // GAP #1 — same cross-instance-safe notify helper/rationale as
    // callSignaling.js's emitToUserSocket(); mirrors-tick/low-balance/
    // accepted/rejected/ended/peer-reconnecting/peer-resumed notifications
    // reach the other party regardless of which cluster instance they're
    // on. The paid-minute WebRTC relay itself and the synchronous
    // host-busy/host-offline gate below are intentionally left as the
    // local-only fast path — see the invite handler's own comment.
    function emitToUserSocket(userId, event, payload) {
        const sid = socketsByUserId[userId];
        if (sid) { io.to(sid).emit(event, payload); return; }
        try {
            const userState = require("./redis/userState.js");
            userState.getUserState(userId).then((state) => {
                if (state && state.socketId) io.to(state.socketId).emit(event, payload);
            }).catch(() => {});
        } catch (e) { /* redis/userState.js unavailable — best-effort only */ }
    }

    function publicUser(userId) {
        const found = findUserByUserId(userId);
        return found ? { userId, userName: found.user.name, userPhoto: found.user.photo || "" } : { userId, userName: "User", userPhoto: "" };
    }

    function statsFor(userId) {
        const h = hostRecord(userId);
        if (!h) return null;
        h.stats = h.stats || { totalCalls: 0, totalMinutes: 0, totalDiamonds: 0, byDay: {} };
        return h.stats;
    }

    // ---------------------------------------------------------------------
    // HOST APPROVAL (requirement #1) — assigns by existing userId, no new
    // user system. Every transition is logged to rbac's existing audit log
    // (rbac.logAction), same as every other admin module.
    // ---------------------------------------------------------------------
    function setHostStatus(userId, status, actor, req, extra) {
        const found = findUserByUserId(userId);
        if (!found) return { error: "user-not-found" };
        if (!hosts[userId]) {
            hosts[userId] = {
                userId, status: "pending", countryId: found.user.countryId || null,
                createdAt: new Date().toISOString(), history: [], stats: { totalCalls: 0, totalMinutes: 0, totalDiamonds: 0, byDay: {} }
            };
        }
        const record = hosts[userId];
        record.countryId = found.user.countryId || record.countryId || null;
        const prevStatus = record.status;
        record.status = status;
        record.updatedAt = new Date().toISOString();
        record.history.push({
            from: prevStatus, to: status, by: actor ? actor.username : "system",
            at: record.updatedAt, note: (extra && extra.note) || null
        });
        saveHosts();
        rbac.logAction({
            admin: actor, action: `call-hosting-${status}`, module: "call-hosting",
            targetType: "user", targetId: userId, meta: { from: prevStatus, to: status },
            ip: req ? req.ip : null, userAgent: req ? reqUserAgent(req) : null
        });
        // If a host is suspended/disabled/removed mid-call, end it immediately
        // (requirement #2 — "must disappear immediately", extended to an
        // in-progress call rather than just future visibility).
        if (["suspended", "disabled", "removed", "rejected"].includes(status)) {
            const activeCallId = userCallState.get(userId);
            if (activeCallId) endCall(activeCallId, "host-status-changed");
        }
        return { record };
    }

    // ---------------------------------------------------------------------
    // CALL RATE CONFIG (requirement #4) — admin-editable, no code changes
    // needed to change prices.
    // ---------------------------------------------------------------------
    function getRates() { return { ...DEFAULT_RATES, ...rates }; }

    // ---------------------------------------------------------------------
    // REVENUE + REPORTS (requirements #9/#11)
    // ---------------------------------------------------------------------
    function creditCompanyRevenue(diamonds, meta) {
        const day = todayKey();
        revenue.total = (revenue.total || 0) + diamonds;
        revenue.byDay[day] = (revenue.byDay[day] || 0) + diamonds;
        saveRevenue();
    }

    function recordMinuteBilled(call, diamonds) {
        const day = todayKey();
        const stats = statsFor(call.hostId);
        if (stats) {
            stats.totalMinutes += 1;
            stats.totalDiamonds += diamonds;
            stats.byDay[day] = stats.byDay[day] || { minutes: 0, diamonds: 0, calls: 0 };
            stats.byDay[day].minutes += 1;
            stats.byDay[day].diamonds += diamonds;
        }
        creditCompanyRevenue(diamonds, { hostId: call.hostId, callerId: call.callerId, callId: call.callId });
        saveHosts();
    }

    // ---------------------------------------------------------------------
    // CALL LIFECYCLE — mirrors callSignaling.js's invite/ring/accept/
    // reject/end shape, but adds host-approval gating, balance checks, and
    // the billing interval. Every event namespaced "hostcall:*" so it can
    // never collide with callSignaling.js's "call:*" events.
    // ---------------------------------------------------------------------
    function clearCall(callId) {
        const call = activeCalls.get(callId);
        if (!call) return;
        if (call.billTimer) clearInterval(call.billTimer);
        if (call.ringTimer) clearTimeout(call.ringTimer);
        if (call.disconnectGrace) clearTimeout(call.disconnectGrace.timer);
        activeCalls.delete(callId);
        userCallState.delete(call.callerId);
        userCallState.delete(call.hostId);
        callEventHooks.delete(callId);
    }

    function logCompletedCall(call, status) {
        const durationSec = call.connectedAt ? Math.max(0, Math.round((Date.now() - call.connectedAt) / 1000)) : 0;
        const entry = {
            callId: call.callId, callerId: call.callerId, hostId: call.hostId,
            callType: call.callType, startTime: call.startedAt, endTime: new Date().toISOString(),
            durationSec, diamondsCharged: call.diamondsCharged || 0, countryId: call.callerCountryId || null,
            status, timestamp: new Date().toISOString()
        };
        history.push(entry);
        saveHistory();
        const stats = statsFor(call.hostId);
        if (stats) { stats.totalCalls += 1; saveHosts(); }
        return entry;
    }

    function endCall(callId, reason) {
        const call = activeCalls.get(callId);
        if (!call) return;
        const entry = logCompletedCall(call, call.status === "connected" ? "completed" : "missed");
        // GAP #1 — cross-instance-safe via emitToUserSocket()
        emitToUserSocket(call.callerId, "hostcall:ended", { callId, reason, historyEntry: entry });
        emitToUserSocket(call.hostId, "hostcall:ended", { callId, reason, historyEntry: entry });
        // Fire the hook AFTER clearCall(), not before: clearCall() is what
        // frees userCallState for both participants, and randomCall.js's
        // onEnded hook immediately tries the next host — if it ran while
        // the caller was still marked busy from *this* call, every retry
        // would wrongly fail as "already-in-call".
        const hook = callEventHooks.get(callId);
        clearCall(callId);
        if (hook && typeof hook.onEnded === "function") { try { hook.onEnded(reason); } catch (e) {} }
    }

    // Bills exactly one minute if the caller can afford it and limits
    // aren't exceeded; ends the call otherwise. Called once immediately on
    // connect (first minute prepaid) and then every BILL_INTERVAL_MS.
    function billOneMinute(callId) {
        const call = activeCalls.get(callId);
        if (!call || call.status !== "connected") return;
        const rateSnapshot = getRates();
        if (!rateSnapshot.enabled) { endCall(callId, "call-hosting-disabled"); return; }

        const elapsedSec = Math.round((Date.now() - call.connectedAt) / 1000);
        if (elapsedSec >= rateSnapshot.maxCallDurationSec) { endCall(callId, "max-duration-reached"); return; }

        if (rateSnapshot.maxDailyMinutes != null) {
            const found = findUserByUserId(call.callerId);
            const day = todayKey();
            const usedToday = (found && found.user.callHostingDailyUsage && found.user.callHostingDailyUsage[day]) || 0;
            if (usedToday >= rateSnapshot.maxDailyMinutes) { endCall(callId, "daily-limit-reached"); return; }
        }

        const found = findUserByUserId(call.callerId);
        if (!found) { endCall(callId, "caller-not-found"); return; }
        const rate = call.rateSnapshot.diamondsPerMinute;
        if ((found.user.diamonds || 0) < rate) { endCall(callId, "insufficient-balance"); return; }

        found.user.diamonds = clampDiamondBalance(call.callerId, found.user.diamonds - rate, "call-hosting-billing");
        const day = todayKey();
        found.user.callHostingDailyUsage = found.user.callHostingDailyUsage || {};
        found.user.callHostingDailyUsage[day] = (found.user.callHostingDailyUsage[day] || 0) + 1;
        saveUsers();
        logTransaction(call.callerId, "diamonds", -rate, `Call Hosting — ${call.callType} call to ${call.hostId}`);
        pushWalletUpdate(call.callerId);
        call.diamondsCharged = (call.diamondsCharged || 0) + rate;
        recordMinuteBilled(call, rate);

        // GAP #1 — cross-instance-safe via emitToUserSocket()
        emitToUserSocket(call.callerId, "hostcall:tick", { callId, diamondsCharged: call.diamondsCharged, balance: found.user.diamonds, elapsedSec });
        emitToUserSocket(call.hostId, "hostcall:tick", { callId, elapsedSec });

        // Balance won't cover the *next* minute — warn now so the client
        // can show "call ending soon" rather than a call that just drops.
        if (found.user.diamonds < rate) {
            emitToUserSocket(call.callerId, "hostcall:low-balance-warning", { callId });
        }
    }

    // Core invite logic, extracted so it can be triggered two ways: the
    // existing hostcall:invite socket event below (unchanged behavior,
    // wire format, and error codes — zero regression), and randomCall.js's
    // matching loop, which calls this directly per candidate host instead
    // of duplicating any billing/eligibility/signaling logic. `opts.meta`
    // is passed through into the hostcall:incoming payload untouched (e.g.
    // so the client can label an incoming call as a Random Call); it does
    // not change any server-side eligibility or billing decision.
    function attemptInvite(callerId, toUserId, callType, callerSocket, opts = {}) {
        if (!callerId || !toUserId) return { ok: false, code: "invalid-request" };
        if (callerId === toUserId) return { ok: false, code: "invalid-request" };
        if (!["audio", "video"].includes(callType)) return { ok: false, code: "invalid-request" };
        if (userCallState.has(callerId)) return { ok: false, code: "already-in-call" };
        if (userCallState.has(toUserId)) return { ok: false, code: "host-busy" };
        if (!isApprovedHost(toUserId)) return { ok: false, code: "not-a-host" };
        const rateSnapshot = getRates();
        if (!rateSnapshot.enabled) return { ok: false, code: "call-hosting-disabled" };
        const found = findUserByUserId(callerId);
        if (!found) return { ok: false, code: "caller-not-found" };
        if ((found.user.diamonds || 0) < rateSnapshot.minBalance) {
            return { ok: false, code: "insufficient-balance", minBalance: rateSnapshot.minBalance };
        }
        const hostSocket = socketFor(toUserId);
        if (!hostSocket) return { ok: false, code: "host-offline" };

        const callId = "hcall_" + Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex");
        const call = {
            callId, callerId, hostId: toUserId, callType, status: "ringing",
            callerSocketId: callerSocket.id, hostSocketId: hostSocket.id,
            rateSnapshot, callerCountryId: found.user.countryId || null,
            startedAt: new Date().toISOString(), diamondsCharged: 0
        };
        activeCalls.set(callId, call);
        userCallState.set(callerId, callId);
        userCallState.set(toUserId, callId);
        if (opts.hooks) callEventHooks.set(callId, opts.hooks);

        hostSocket.emit("hostcall:incoming", {
            callId, callType, from: publicUser(callerId), secureMode: callType === "video",
            ...(opts.meta || {})
        });
        callerSocket.emit("hostcall:ringing", { callId, host: publicUser(toUserId) });

        const ringTimeoutMs = opts.ringTimeoutMs || RING_TIMEOUT_MS;
        call.ringTimer = setTimeout(() => {
            const c = activeCalls.get(callId);
            if (!c || c.status !== "ringing") return;
            callerSocket.emit("hostcall:ended", { callId, reason: "no-answer" });
            // BUGFIX 2026-08-30: the host side was never told the ring timed
            // out — only the caller got "hostcall:ended". For Random Call in
            // particular, this left the host's "Incoming video call..."
            // overlay open indefinitely (and userCallState still marked them
            // busy until their own client eventually reconnected/disconnected),
            // silently shrinking the eligible pool for every subsequent
            // random-call attempt. Mirrors the existing "declined" and
            // "host-offline" cases below, which already notify the right side.
            emitToUserSocket(c.hostId, "hostcall:ended", { callId, reason: "no-answer" });
            logCompletedCall(c, "missed");
            const hook = callEventHooks.get(callId);
            clearCall(callId);
            if (hook && typeof hook.onEnded === "function") { try { hook.onEnded("no-answer"); } catch (e) {} }
        }, ringTimeoutMs);

        return { ok: true, callId };
    }

    // Server-authoritative pool for Random Call (requirement: reuse
    // existing eligibility, never let the client declare host status).
    // "Eligible" mirrors exactly what attemptInvite would accept for this
    // host: approved, has a live socket, and not already on a call.
    function getEligibleHostIds(excludeUserId) {
        return Object.keys(hosts).filter((userId) => (
            userId !== excludeUserId &&
            isApprovedHost(userId) &&
            !!socketFor(userId) &&
            !userCallState.has(userId)
        ));
    }

    // Shared by the hostcall:end socket handler and randomCall.js's
    // cancel path — a participant (caller or host) ending their own call.
    // No-op if the call is already gone (e.g. it already ended naturally
    // a moment earlier) so callers of this never need to check first.
    function endCallByParticipant(callId, userId) {
        const call = activeCalls.get(callId);
        if (!call) return;
        if (call.callerId !== userId && call.hostId !== userId) return;
        endCall(callId, "ended-by-user");
    }

    function registerSocketHandlers(socket) {
        // hostcall:invite — caller requests a paid call with an approved host.
        socket.on("hostcall:invite", ({ toUserId, callType }) => {
            const callerId = socket.userId;
            if (!callerId) return;
            const result = attemptInvite(callerId, toUserId, callType, socket);
            if (!result.ok) {
                socket.emit("hostcall:error", { code: result.code, minBalance: result.minBalance });
            }
        });

        socket.on("hostcall:accept", ({ callId }) => {
            const call = activeCalls.get(callId);
            if (!call || call.hostId !== socket.userId || call.status !== "ringing") return;
            if (call.ringTimer) clearTimeout(call.ringTimer);
            call.status = "connected";
            call.connectedAt = Date.now();
            const payload = { callId, secureMode: call.callType === "video", rate: call.rateSnapshot.diamondsPerMinute };
            // GAP #1 — cross-instance-safe via emitToUserSocket()
            emitToUserSocket(call.callerId, "hostcall:accepted", { ...payload, host: publicUser(call.hostId) });
            emitToUserSocket(call.hostId, "hostcall:accepted", { ...payload, caller: publicUser(call.callerId) });
            fireHook(callId, "onAccepted", call);
            billOneMinute(callId); // first minute prepaid at connect
            call.billTimer = setInterval(() => billOneMinute(callId), BILL_INTERVAL_MS);
        });

        socket.on("hostcall:reject", ({ callId }) => {
            const call = activeCalls.get(callId);
            if (!call || call.hostId !== socket.userId || call.status !== "ringing") return;
            emitToUserSocket(call.callerId, "hostcall:ended", { callId, reason: "rejected" }); // GAP #1 — cross-instance-safe
            logCompletedCall(call, "rejected");
            const hook = callEventHooks.get(callId);
            clearCall(callId);
            if (hook && typeof hook.onEnded === "function") { try { hook.onEnded("rejected"); } catch (e) {} }
        });

        socket.on("hostcall:end", ({ callId }) => endCallByParticipant(callId, socket.userId));

        // Opaque SDP/ICE relay — same trust model as callSignaling.js:
        // only relayed to the two socket ids recorded on the call, never
        // routed by a userId the client claims in the payload.
        ["hostcall:offer", "hostcall:answer", "hostcall:ice-candidate"].forEach((evt) => {
            socket.on(evt, ({ callId, data }) => {
                const call = activeCalls.get(callId);
                if (!call) return;
                if (socket.userId !== call.callerId && socket.userId !== call.hostId) return;
                const otherId = socket.userId === call.callerId ? call.hostId : call.callerId;
                const otherSocket = socketFor(otherId);
                if (otherSocket) otherSocket.emit(evt, { callId, data });
            });
        });
    }

    function handleDisconnect(userId, socketId) {
        const callId = userCallState.get(userId);
        if (!callId) return;
        const call = activeCalls.get(callId);
        if (!call) return;

        if (call.status === "ringing") {
            if (userId === call.callerId) {
                emitToUserSocket(call.hostId, "hostcall:ended", { callId, reason: "cancelled" }); // GAP #1 — cross-instance-safe
                logCompletedCall(call, "missed");
                const hook = callEventHooks.get(callId);
                clearCall(callId);
                if (hook && typeof hook.onEnded === "function") { try { hook.onEnded("cancelled"); } catch (e) {} }
            } else {
                // host disconnected while ringing — same outcome as if they
                // never picked up; let the caller (and randomCall.js) move on.
                emitToUserSocket(call.callerId, "hostcall:ended", { callId, reason: "host-offline" });
                logCompletedCall(call, "missed");
                const hook = callEventHooks.get(callId);
                clearCall(callId);
                if (hook && typeof hook.onEnded === "function") { try { hook.onEnded("host-offline"); } catch (e) {} }
            }
            return;
        }

        const mySocketId = userId === call.callerId ? call.callerSocketId : call.hostSocketId;
        if (socketId && mySocketId && socketId !== mySocketId) return; // stale/duplicate tab
        if (call.disconnectGrace) return;

        if (call.billTimer) { clearInterval(call.billTimer); call.billTimer = null; } // pause billing during grace
        const otherId = userId === call.callerId ? call.hostId : call.callerId;
        emitToUserSocket(otherId, "hostcall:peer-reconnecting", { callId }); // GAP #1 — cross-instance-safe
        call.disconnectGrace = {
            userId,
            timer: setTimeout(() => endCall(callId, "peer-disconnected"), DISCONNECT_GRACE_MS)
        };
    }

    function resumeCall(userId, newSocketId) {
        const callId = userCallState.get(userId);
        if (!callId) return;
        const call = activeCalls.get(callId);
        if (!call || !call.disconnectGrace || call.disconnectGrace.userId !== userId) return;
        clearTimeout(call.disconnectGrace.timer);
        call.disconnectGrace = null;
        if (call.callerId === userId) call.callerSocketId = newSocketId;
        else call.hostSocketId = newSocketId;
        if (call.status === "connected" && !call.billTimer) {
            call.billTimer = setInterval(() => billOneMinute(callId), BILL_INTERVAL_MS);
        }
        const otherId = userId === call.callerId ? call.hostId : call.callerId;
        // GAP #1 — cross-instance-safe via emitToUserSocket()
        emitToUserSocket(otherId, "hostcall:peer-resumed", { callId });
        emitToUserSocket(userId, "hostcall:peer-resumed", { callId, self: true });
    }

    // =======================================================================
    // REST — public: call-button visibility (requirement #2). Safe to expose
    // with no auth: only reveals whether a userId is an approved host.
    // =======================================================================
    app.get("/api/call-hosting/status/:userId", (req, res) => {
        const h = hostRecord(req.params.userId);
        res.json({ success: true, isHost: !!h && h.status === "approved", enabled: getRates().enabled });
    });

    // =======================================================================
    // REST — admin (requirement #15). All require callhosting:manage,
    // mounted the same way country_permission's routes were: reusing the
    // existing requireAdmin/requirePermission/rbac untouched.
    // =======================================================================
    const requireCH = [requireAdmin, requirePermission("callhosting:manage")];

    app.get("/api/admin/call-hosting/hosts", ...requireCH, (req, res) => {
        const { status, country, search } = req.query;
        let list = Object.values(hosts);
        if (status) list = list.filter((h) => h.status === status);
        if (country) {
            if (!actorCanAccessCountry(req.adminAccount, country)) return countryDeniedResponse(res);
            list = list.filter((h) => h.countryId === country);
        } else if (req.adminAccount.role !== "owner") {
            list = list.filter((h) => actorCanAccessCountry(req.adminAccount, h.countryId));
        }
        if (search) {
            const s = String(search).toLowerCase();
            list = list.filter((h) => {
                const u = findUserByUserId(h.userId);
                return h.userId.toLowerCase().includes(s) || (u && u.user.name && u.user.name.toLowerCase().includes(s));
            });
        }
        res.json({ success: true, hosts: list.map((h) => ({ ...h, user: publicUser(h.userId) })) });
    });

    ["approve", "reject", "suspend", "disable", "remove"].forEach((action) => {
        const statusMap = { approve: "approved", reject: "rejected", suspend: "suspended", disable: "disabled", remove: "removed" };
        app.post(`/api/admin/call-hosting/hosts/:userId/${action}`, ...requireCH, (req, res) => {
            const target = findUserByUserId(req.params.userId);
            if (target && !actorCanAccessCountry(req.adminAccount, target.user.countryId)) return countryDeniedResponse(res);
            const result = setHostStatus(req.params.userId, statusMap[action], req.adminAccount, req, { note: req.body && req.body.note });
            if (result.error) return res.status(404).json({ success: false, error: result.error });
            res.json({ success: true, host: result.record });
        });
    });

    app.get("/api/admin/call-hosting/rates", ...requireCH, (req, res) => res.json({ success: true, rates: getRates() }));

    app.put("/api/admin/call-hosting/rates", ...requireCH, (req, res) => {
        const b = req.body || {};
        const next = { ...getRates() };
        if (b.diamondsPerMinute != null) { const v = Math.floor(Number(b.diamondsPerMinute)); if (Number.isFinite(v) && v > 0) next.diamondsPerMinute = v; }
        if (b.minBalance != null) { const v = Math.floor(Number(b.minBalance)); if (Number.isFinite(v) && v >= 0) next.minBalance = v; }
        if (b.maxCallDurationSec != null) { const v = Math.floor(Number(b.maxCallDurationSec)); if (Number.isFinite(v) && v > 0) next.maxCallDurationSec = v; }
        if (b.maxDailyMinutes !== undefined) { next.maxDailyMinutes = b.maxDailyMinutes === null ? null : Math.max(0, Math.floor(Number(b.maxDailyMinutes)) || 0); }
        if (typeof b.enabled === "boolean") next.enabled = b.enabled;
        rates = next;
        saveRates();
        rbac.logAction({ admin: req.adminAccount, action: "call-hosting-rates-update", module: "call-hosting", meta: next, ip: req.ip, userAgent: reqUserAgent(req) });
        res.json({ success: true, rates: next });
    });

    app.get("/api/admin/call-hosting/active-calls", ...requireCH, (req, res) => {
        const list = Array.from(activeCalls.values()).map((c) => ({
            callId: c.callId, callerId: c.callerId, hostId: c.hostId, callType: c.callType,
            status: c.status, startedAt: c.startedAt, diamondsCharged: c.diamondsCharged,
            elapsedSec: c.connectedAt ? Math.round((Date.now() - c.connectedAt) / 1000) : 0
        }));
        res.json({ success: true, activeCalls: list });
    });

    app.get("/api/admin/call-hosting/history", ...requireCH, (req, res) => {
        const { hostId, callerId, country, status, from, to, page } = req.query;
        let list = history;
        if (hostId) list = list.filter((e) => e.hostId === hostId);
        if (callerId) list = list.filter((e) => e.callerId === callerId);
        if (status) list = list.filter((e) => e.status === status);
        if (country) {
            if (!actorCanAccessCountry(req.adminAccount, country)) return countryDeniedResponse(res);
            list = list.filter((e) => e.countryId === country);
        }
        if (from) list = list.filter((e) => e.timestamp >= from);
        if (to) list = list.filter((e) => e.timestamp <= to);
        const pageSize = 50;
        const p = Math.max(1, parseInt(page) || 1);
        const start = (p - 1) * pageSize;
        res.json({ success: true, total: list.length, page: p, calls: list.slice().reverse().slice(start, start + pageSize) });
    });

    // requirement #9 — per-host reports with daily/weekly/monthly rollups,
    // filterable by country/date/host/status.
    app.get("/api/admin/call-hosting/reports", ...requireCH, (req, res) => {
        const { hostId, country } = req.query;
        let list = Object.values(hosts);
        if (hostId) list = list.filter((h) => h.userId === hostId);
        if (country) {
            if (!actorCanAccessCountry(req.adminAccount, country)) return countryDeniedResponse(res);
            list = list.filter((h) => h.countryId === country);
        } else if (req.adminAccount.role !== "owner") {
            list = list.filter((h) => actorCanAccessCountry(req.adminAccount, h.countryId));
        }
        const now = new Date();
        const dayKeys = (n) => Array.from({ length: n }, (_, i) => todayKey(new Date(now - i * 86400000)));
        const last7 = dayKeys(7), last30 = dayKeys(30);
        const sumDays = (byDay, keys) => keys.reduce((sum, k) => sum + ((byDay[k] && byDay[k].diamonds) || 0), 0);

        const reports = list.map((h) => {
            const stats = h.stats || { totalCalls: 0, totalMinutes: 0, totalDiamonds: 0, byDay: {} };
            const hostHistory = history.filter((e) => e.hostId === h.userId);
            const lastCall = hostHistory[hostHistory.length - 1] || null;
            const target = targets[h.userId] || null;
            const weeklyDiamonds = sumDays(stats.byDay, last7);
            return {
                userId: h.userId, user: publicUser(h.userId), status: h.status, countryId: h.countryId,
                totalCalls: stats.totalCalls, totalMinutes: stats.totalMinutes, totalDiamonds: stats.totalDiamonds,
                dailyDiamonds: stats.byDay[todayKey()] ? stats.byDay[todayKey()].diamonds : 0,
                weeklyDiamonds, monthlyDiamonds: sumDays(stats.byDay, last30),
                callerCount: new Set(hostHistory.map((e) => e.callerId)).size,
                avgCallDurationSec: hostHistory.length ? Math.round(hostHistory.reduce((s, e) => s + e.durationSec, 0) / hostHistory.length) : 0,
                lastCall: lastCall ? lastCall.timestamp : null,
                lastActive: socketFor(h.userId) ? "online" : (h.updatedAt || h.createdAt),
                onlineStatus: !!socketFor(h.userId),
                target: target ? { targetDiamonds: target.targetDiamonds, periodStart: target.periodStart, periodEnd: target.periodEnd,
                    progressDiamonds: weeklyDiamonds, progressPct: target.targetDiamonds ? Math.min(100, Math.round((weeklyDiamonds / target.targetDiamonds) * 100)) : 0,
                    remaining: Math.max(0, target.targetDiamonds - weeklyDiamonds) } : null
            };
        });
        res.json({ success: true, reports });
    });

    app.get("/api/admin/call-hosting/revenue", ...requireCH, (req, res) => {
        const { from, to } = req.query;
        let byDay = revenue.byDay;
        if (from || to) {
            byDay = Object.fromEntries(Object.entries(byDay).filter(([day]) => (!from || day >= from) && (!to || day <= to)));
        }
        res.json({ success: true, total: revenue.total, byDay });
    });

    // requirement #8 — individual 7-day target per host.
    app.get("/api/admin/call-hosting/targets", ...requireCH, (req, res) => res.json({ success: true, targets }));

    app.put("/api/admin/call-hosting/targets/:userId", ...requireCH, (req, res) => {
        if (!hosts[req.params.userId]) return res.status(404).json({ success: false, error: "host-not-found" });
        const targetDiamonds = Math.max(0, Math.floor(Number(req.body && req.body.targetDiamonds)) || 0);
        const periodDays = Math.max(1, Math.floor(Number(req.body && req.body.periodDays)) || 7);
        const periodStart = new Date().toISOString();
        const periodEnd = new Date(Date.now() + periodDays * 86400000).toISOString();
        targets[req.params.userId] = { userId: req.params.userId, targetDiamonds, periodStart, periodEnd, setBy: req.adminAccount.username, setAt: periodStart };
        saveTargets();
        rbac.logAction({ admin: req.adminAccount, action: "call-hosting-target-set", module: "call-hosting", targetType: "user", targetId: req.params.userId, meta: { targetDiamonds, periodDays }, ip: req.ip, userAgent: reqUserAgent(req) });
        res.json({ success: true, target: targets[req.params.userId] });
    });

    return {
        registerSocketHandlers, handleDisconnect, resumeCall,
        // Exposed for randomCall.js only — reuses this module's existing
        // eligibility/billing/signaling instead of duplicating any of it.
        attemptInvite, getEligibleHostIds, isApprovedHost, endCallByParticipant
    };
}

module.exports = { initCallHosting };
