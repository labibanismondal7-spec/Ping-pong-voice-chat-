// agora/token.js
// ==================================================
// PHASE 1 — AGORA RTC ACCESS TOKEN GENERATION (ADDITIVE)
// ==================================================
// Same "lazy require + pure functions, no module-load side effects" style
// as voice_sfu/token.js and turn-config.js. This file has exactly one job:
// turn (channelName, uid) into a short-lived Agora RTC token, server-side
// only. It is not imported by anything yet (Phase 1 only wires agora/
// index.js's own route to it) and importing it does nothing by itself —
// no env var is read and no package is required until mintRtcToken() or
// isConfigured() is actually called.
//
// TRUST BOUNDARY: this file is the ONLY place in the codebase allowed to
// read AGORA_APP_CERTIFICATE. It is read from process.env at call time,
// used locally to sign the token, and never included in any return value,
// log line, or thrown error message. Callers only ever receive the
// resulting token string.
//
// LAZY REQUIRE: the 'agora-token' package is only required() inside the
// function body, not at module load time — mirrors voice_sfu/token.js's
// livekit-server-sdk handling exactly. A deployment that hasn't run
// `npm install agora-token` yet, or hasn't set AGORA_APP_ID/
// AGORA_APP_CERTIFICATE, sees zero impact anywhere else in the app: this
// module simply reports isConfigured() === false and mintRtcToken()
// throws a scoped, catchable error. Nothing here runs automatically and
// nothing here can crash server startup or any existing voice/call path.
//
// PACKAGE CHOICE: 'agora-token' (not the older 'agora-access-token',
// which Agora's own package page marks deprecated in favor of
// 'agora-token' — same RtcTokenBuilder/RtcRole API surface, actively
// maintained). See package.json's optionalDependencies.

function isConfigured() {
    return Boolean(process.env.AGORA_APP_ID && process.env.AGORA_APP_CERTIFICATE);
}

// Mirrors voice_sfu/token.js's tokenTtlSeconds() pattern: one documented,
// overridable env var with a sane default. Matches the AGORA_TOKEN_TTL_SECONDS
// name already used in the project's migration spec / .env.example draft.
function tokenTtlSeconds() {
    const raw = parseInt(process.env.AGORA_TOKEN_TTL_SECONDS, 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 3600; // default 1h
}

// role: "publisher" (can send audio/video — seated speaker / call
// participant) or "subscriber" (listen/view only — audience). Defaults to
// publisher for Phase 1 since no caller exists yet to pass a role; Phase 2
// (room/call wiring) will pass the correct role per the same seated-vs-
// audience distinction voice_sfu/provider.js already enforces for LiveKit.
function resolveRole(role) {
    let RtcRole;
    try {
        ({ RtcRole } = require("agora-token"));
    } catch (e) {
        const err = new Error("agora-token package is not installed. Run: npm install agora-token");
        err.code = "AGORA_SDK_MISSING";
        throw err;
    }
    return role === "subscriber" ? RtcRole.SUBSCRIBER : RtcRole.PUBLISHER;
}

// channelName: Agora RTC channel name — this project should pass the same
// mapped room/call channel name convention Phase 2 defines (analogous to
// roomManager.toLiveKitRoomName() for the SFU path), never a raw, unmapped
// PingPong roomId/callId without going through that mapping. Not enforced
// here — this file only mints tokens for whatever channelName it is given
// — validation of what a given user is allowed to join belongs in the
// calling route (see agora/index.js), same separation of concerns
// voice_sfu/token.js keeps from voice_sfu/index.js's route-level checks.
//
// uid: Agora RTC numeric uid (0 lets the Agora SDK assign one client-side,
// but this project should always pass an explicit, stable per-user uid —
// Phase 2's concern, not this file's).
//
// Returns: { token, appId, channelName, uid, role, expiresAt } — never the
// certificate. expiresAt is a Unix seconds timestamp for the caller's own
// convenience (e.g. client-side "reconnect before this" logic); the
// authoritative expiry is baked into the signed token itself regardless.
function mintRtcToken({ channelName, uid, role = "publisher", ttlSeconds } = {}) {
    if (!isConfigured()) {
        const err = new Error("Agora is not configured (AGORA_APP_ID / AGORA_APP_CERTIFICATE missing)");
        err.code = "AGORA_NOT_CONFIGURED";
        throw err;
    }
    if (!channelName || typeof channelName !== "string") {
        throw new Error("mintRtcToken: channelName is required");
    }
    // Agora channel names must be < 64 bytes; defensively cap here too so
    // a malformed caller can't hand the SDK something it will reject with
    // a less clear error.
    if (Buffer.byteLength(channelName, "utf8") >= 64) {
        throw new Error("mintRtcToken: channelName must be under 64 bytes");
    }
    const numericUid = Number(uid);
    if (!Number.isInteger(numericUid) || numericUid < 0 || numericUid > 0xFFFFFFFF) {
        throw new Error("mintRtcToken: uid must be an integer in range 0..4294967295");
    }

    let RtcTokenBuilder;
    try {
        ({ RtcTokenBuilder } = require("agora-token"));
    } catch (e) {
        const err = new Error("agora-token package is not installed. Run: npm install agora-token");
        err.code = "AGORA_SDK_MISSING";
        throw err;
    }

    const resolvedRole = resolveRole(role);
    const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : tokenTtlSeconds();

    // Current agora-token API takes two separate "seconds from now" expiry
    // values: tokenExpire (when the token itself becomes unusable) and
    // privilegeExpire (when the granted channel-join privilege expires).
    // Setting both to the same TTL is the standard/recommended usage for
    // a straightforward "token good for N seconds" model — see Agora's
    // own Node token-server samples.
    const token = RtcTokenBuilder.buildTokenWithUid(
        process.env.AGORA_APP_ID,
        process.env.AGORA_APP_CERTIFICATE,
        channelName,
        numericUid,
        resolvedRole,
        ttl,
        ttl
    );

    return {
        token,
        appId: process.env.AGORA_APP_ID,
        channelName,
        uid: numericUid,
        role: role === "subscriber" ? "subscriber" : "publisher",
        expiresAt: Math.floor(Date.now() / 1000) + ttl
    };
}

module.exports = { isConfigured, tokenTtlSeconds, mintRtcToken };
