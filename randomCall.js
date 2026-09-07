// randomCall.js
// ==================================================
// HOST-ONLY RANDOM VIDEO CALL — matching layer only
// ==================================================
// Purely additive, same pattern as callSignaling.js/callHosting.js: one
// init function wired into server.js's single io.on("connection", ...)
// block. This module does exactly one job: pick a random *eligible* Call
// Host and retry the next one on decline/timeout/offline/busy. It creates
// no new WebRTC, no new billing, and no new host-status system — every
// call it starts goes through callHosting.js's existing attemptInvite(),
// which is the exact same code path (eligibility, Diamond billing, ring
// timer, WebRTC signaling) the paid direct "Call a Host" feature already
// uses. If that pricing/eligibility model ever changes, this module needs
// no changes.
//
// Server authority: the eligible pool, the random pick, and every retry
// decision happen here on the server. The client only ever receives
// "searching" / "incoming" / "connected" / "ended" updates — it never
// tells the server who is eligible or who won the random pick.

const crypto = require("crypto");

const RANDOM_CALL_RING_TIMEOUT_MS = 15000; // shorter than direct-call's 45s, per spec
const MAX_ATTEMPTS_PER_SESSION = 25;       // hard ceiling — never loop forever even with a huge pool
const START_RATE_LIMIT = { windowMs: 30000, max: 6 }; // abuse protection (reuses existing rate limiter)

function initRandomCall({ io, callHosting, findUserByUserId, isRateLimited, socketsByUserId }) {
    const { attemptInvite, getEligibleHostIds, endCallByParticipant } = callHosting;

    // sessionId -> session record. One active session per caller at a time
    // (sessionsByCaller enforces that), so there's never ambiguity about
    // which session a given hostcall belongs to.
    const sessions = new Map();
    const sessionsByCaller = new Map(); // callerId -> sessionId

    function socketFor(userId) {
        const sid = socketsByUserId && socketsByUserId[userId];
        return sid ? io.sockets.sockets.get(sid) : null;
    }

    function publicHostInfo(hostId) {
        const found = findUserByUserId(hostId);
        if (!found) return { userId: hostId };
        return { userId: hostId, userName: found.user.name || found.user.username, userPhoto: found.user.photo || found.user.avatar || null };
    }

    function endSession(session, reason, extra = {}) {
        if (!session || session.ended) return;
        session.ended = true;
        sessions.delete(session.sessionId);
        if (sessionsByCaller.get(session.callerId) === session.sessionId) sessionsByCaller.delete(session.callerId);
        const callerSocket = socketFor(session.callerId);
        if (callerSocket) callerSocket.emit("random-call:end", { sessionId: session.sessionId, reason, ...extra });
    }

    // The core retry loop. Tries one candidate host at a time; on any
    // transient failure (busy/offline/declined/no-answer) it marks that
    // host attempted and immediately tries the next one, until the pool
    // is exhausted or MAX_ATTEMPTS_PER_SESSION is hit (infinite-loop guard,
    // requirement #31).
    function tryNextHost(session) {
        if (session.ended) return;
        const callerSocket = socketFor(session.callerId);
        if (!callerSocket) { endSession(session, "caller-offline"); return; }

        if (session.attemptedHostIds.size >= MAX_ATTEMPTS_PER_SESSION) {
            endSession(session, "no-host");
            return;
        }

        const eligible = getEligibleHostIds(session.callerId).filter((id) => !session.attemptedHostIds.has(id));
        if (!eligible.length) {
            endSession(session, "no-host");
            return;
        }

        const hostId = eligible[Math.floor(Math.random() * eligible.length)];
        session.attemptedHostIds.add(hostId);
        session.currentHostId = hostId;

        callerSocket.emit("random-call:searching", { sessionId: session.sessionId, host: publicHostInfo(hostId) });

        const result = attemptInvite(session.callerId, hostId, session.callType, callerSocket, {
            ringTimeoutMs: RANDOM_CALL_RING_TIMEOUT_MS,
            meta: { source: "random-call", randomCallSessionId: session.sessionId },
            hooks: {
                onAccepted: (call) => {
                    if (session.ended) return;
                    session.status = "connected";
                    session.currentCallId = call.callId;
                    callerSocket.emit("random-call:connected", {
                        sessionId: session.sessionId, callId: call.callId, host: publicHostInfo(hostId)
                    });
                },
                onEnded: (reason) => {
                    if (session.ended) return;
                    if (session.status === "connected") {
                        // The underlying hostcall was live and ended normally
                        // (hangup, insufficient balance, max duration, etc.) —
                        // that's the end of the random-call session too, not
                        // a reason to matchmake again.
                        endSession(session, reason);
                        return;
                    }
                    // Still pre-connect (declined / no-answer / host went
                    // offline mid-ring) — try the next eligible host.
                    callerSocket.emit("random-call:next-host", { sessionId: session.sessionId, reason });
                    tryNextHost(session);
                }
            }
        });

        if (!result.ok) {
            // Permanent, non-host-specific failures stop the whole session
            // instead of burning through the pool.
            if (["already-in-call", "insufficient-balance", "call-hosting-disabled", "caller-not-found"].includes(result.code)) {
                endSession(session, result.code, { minBalance: result.minBalance });
                return;
            }
            // host-busy / host-offline / not-a-host (stale pool entry) —
            // skip this host, try the next one immediately.
            callerSocket.emit("random-call:next-host", { sessionId: session.sessionId, reason: result.code });
            tryNextHost(session);
        }
    }

    function registerSocketHandlers(socket) {
        socket.on("random-call:start", ({ callType }) => {
            const callerId = socket.userId;
            if (!callerId) return;
            if (!["audio", "video"].includes(callType)) return;

            if (isRateLimited && isRateLimited(`random-call:${callerId}`, START_RATE_LIMIT)) {
                socket.emit("random-call:end", { reason: "rate-limited" });
                return;
            }
            if (sessionsByCaller.has(callerId)) {
                socket.emit("random-call:end", { reason: "already-searching" });
                return;
            }

            const sessionId = "rcall_" + Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex");
            const session = {
                sessionId, callerId, callType, status: "searching",
                attemptedHostIds: new Set(), currentHostId: null, currentCallId: null,
                startedAt: new Date().toISOString(), ended: false
            };
            sessions.set(sessionId, session);
            sessionsByCaller.set(callerId, sessionId);
            socket.emit("random-call:start", { sessionId });
            tryNextHost(session);
        });

        socket.on("random-call:cancel", ({ sessionId }) => {
            const session = sessions.get(sessionId);
            if (!session || session.callerId !== socket.userId) return;
            // Mark the session ended FIRST so the onEnded hook (fired
            // synchronously by endCallByParticipant below) sees session.ended
            // and does not try to matchmake a next host during cancellation.
            const currentCallId = session.currentCallId;
            endSession(session, "cancelled");
            if (currentCallId) endCallByParticipant(currentCallId, socket.userId);
        });
    }

    // Called from server.js's existing disconnect handler, same as the
    // other call modules — cleans up a session if the caller drops mid-
    // search (the underlying hostcall, if any, is already cleaned up by
    // callHosting.js's own handleDisconnect; this just clears our session).
    function handleDisconnect(userId) {
        const sessionId = sessionsByCaller.get(userId);
        if (!sessionId) return;
        const session = sessions.get(sessionId);
        if (session) endSession(session, "caller-offline");
    }

    return { registerSocketHandlers, handleDisconnect };
}

module.exports = { initRandomCall };
