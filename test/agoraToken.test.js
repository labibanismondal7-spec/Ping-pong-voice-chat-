// test/agoraToken.test.js
// ==================================================
// PHASE 1 — AGORA TOKEN INFRASTRUCTURE — standalone verification
// ==================================================
// Same "no npm deps, no real network/sockets" style as
// test/callSignaling.test.js. 'agora-token' is an optionalDependency
// (same treatment as livekit-server-sdk), so it may not be installed in
// every environment this runs in. If it's missing, a minimal fake
// package is written to node_modules/agora-token for the duration of
// this run only (removed on exit) so agora/token.js's OWN logic —
// validation, uid handling, role mapping, error codes, and critically
// that AGORA_APP_CERTIFICATE is never present in any return value — can
// be verified without a real Agora project or network access. If the
// real package is already installed, this suite runs against it as-is.
//
// Run: node test/agoraToken.test.js  (or via npm test / test/run-all.js)

const path = require("path");
const fs = require("fs");

const nodeModulesDir = path.join(__dirname, "..", "node_modules", "agora-token");
let installedFakeForThisRun = false;
try {
    require.resolve("agora-token");
} catch (e) {
    fs.mkdirSync(nodeModulesDir, { recursive: true });
    fs.writeFileSync(path.join(nodeModulesDir, "package.json"), JSON.stringify({ name: "agora-token", version: "0.0.0-test-fake", main: "index.js" }));
    fs.writeFileSync(path.join(nodeModulesDir, "index.js"), [
        "function buildTokenWithUid(appId, appCertificate, channelName, uid, role, tokenExpire, privilegeExpire) {",
        "  if (!appId || !appCertificate) throw new Error('fake builder: missing appId/appCertificate');",
        "  return `FAKE.${appId}.${channelName}.${uid}.${role}.${tokenExpire}.${privilegeExpire}`;",
        "}",
        "module.exports = { RtcTokenBuilder: { buildTokenWithUid }, RtcRole: { PUBLISHER: 1, SUBSCRIBER: 2 } };",
        ""
    ].join("\n"));
    installedFakeForThisRun = true;
    console.log("[agoraToken.test.js] real 'agora-token' package not found — using a local test-only fake at node_modules/agora-token for this run (not a project dependency change).");
}
process.on("exit", () => {
    if (installedFakeForThisRun) { try { fs.rmSync(nodeModulesDir, { recursive: true, force: true }); } catch (e) {} }
});

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { pass++; console.log("  \u2713", msg); }
    else { fail++; console.error("  \u2717 FAIL:", msg); }
}

// ---- Section 1: agora/token.js, unconfigured (no env vars set) ----
delete process.env.AGORA_APP_ID;
delete process.env.AGORA_APP_CERTIFICATE;
delete require.resolve.cache; // no-op guard, kept for clarity that nothing is cached across sections below
delete require.cache[require.resolve("../agora/token.js")];
let tokenMod = require("../agora/token.js");

console.log("\n1. Unconfigured state (no AGORA_APP_ID/AGORA_APP_CERTIFICATE)");
assert(tokenMod.isConfigured() === false, "isConfigured() is false with no env vars set");
try {
    tokenMod.mintRtcToken({ channelName: "room1", uid: 123 });
    assert(false, "mintRtcToken should have thrown when unconfigured");
} catch (e) {
    assert(e.code === "AGORA_NOT_CONFIGURED", "mintRtcToken throws AGORA_NOT_CONFIGURED when unconfigured");
    assert(!/[0-9a-f]{16,}/i.test(e.message), "error message contains no certificate-like value");
}

// ---- Section 2: configured, real validation logic ----
process.env.AGORA_APP_ID = "test-app-id";
process.env.AGORA_APP_CERTIFICATE = "test-app-certificate-should-never-appear-in-output";
delete require.cache[require.resolve("../agora/token.js")];
tokenMod = require("../agora/token.js");

console.log("\n2. Configured state — validation");
assert(tokenMod.isConfigured() === true, "isConfigured() is true once both env vars are set");
try { tokenMod.mintRtcToken({ uid: 1 }); assert(false, "should reject missing channelName"); }
catch (e) { assert(/channelName is required/.test(e.message), "rejects missing channelName"); }

try { tokenMod.mintRtcToken({ channelName: "a".repeat(64), uid: 1 }); assert(false, "should reject 64+ byte channelName"); }
catch (e) { assert(/under 64 bytes/.test(e.message), "rejects channelName >= 64 bytes"); }

try { tokenMod.mintRtcToken({ channelName: "room1", uid: -1 }); assert(false, "should reject negative uid"); }
catch (e) { assert(/uid must be an integer/.test(e.message), "rejects negative uid"); }

try { tokenMod.mintRtcToken({ channelName: "room1", uid: "not-a-number" }); assert(false, "should reject non-numeric uid"); }
catch (e) { assert(/uid must be an integer/.test(e.message), "rejects non-numeric uid"); }

console.log("\n3. Configured state — successful mint, shape, and certificate never leaks");
const result = tokenMod.mintRtcToken({ channelName: "room1", uid: 42, role: "publisher" });
assert(typeof result.token === "string" && result.token.length > 0, "returns a non-empty token string");
assert(result.appId === "test-app-id", "returns the configured appId");
assert(result.channelName === "room1", "returns the requested channelName");
assert(result.uid === 42, "returns the requested uid");
assert(result.role === "publisher", "returns the requested role");
assert(typeof result.expiresAt === "number" && result.expiresAt > Math.floor(Date.now() / 1000), "expiresAt is a future unix timestamp");
assert(!("appCertificate" in result) && !("AGORA_APP_CERTIFICATE" in result), "return object has no certificate field");
assert(JSON.stringify(result).indexOf("test-app-certificate-should-never-appear-in-output") === -1, "certificate value does not appear anywhere in the serialized response");

const subResult = tokenMod.mintRtcToken({ channelName: "room1", uid: 42, role: "subscriber" });
assert(subResult.role === "subscriber", "subscriber role is honored and distinct from publisher");

console.log("\n4. TTL default and override");
delete process.env.AGORA_TOKEN_TTL_SECONDS;
assert(tokenMod.tokenTtlSeconds() === 3600, "default TTL is 3600s when AGORA_TOKEN_TTL_SECONDS is unset");
process.env.AGORA_TOKEN_TTL_SECONDS = "7200";
assert(tokenMod.tokenTtlSeconds() === 7200, "AGORA_TOKEN_TTL_SECONDS override is respected");
delete process.env.AGORA_TOKEN_TTL_SECONDS;

// ---- Section 3: agora/index.js route — mock req/res, real middleware bypass ----
console.log("\n5. POST /api/agora/token route wiring (mock app/req/res)");
delete require.cache[require.resolve("../agora/index.js")];
const { initAgora } = require("../agora/index.js");

let registeredHandler = null;
const mockApp = {
    post(routePath, ...handlers) {
        if (routePath === "/api/agora/token") registeredHandler = handlers[handlers.length - 1];
    }
};
// requireUserAuth stand-in: real middleware signature is (req,res,next);
// this test calls the route handler directly (skipping Express's own
// middleware chaining, which is not this suite's concern), so
// requireUserAuth itself isn't invoked here — see note below assertion
// for why that's still a faithful test of THIS module's logic.
const users = { "017...mock": { userId: "user-abc-123" } };
initAgora({
    app: mockApp,
    requireUserAuth: (req, res, next) => next(), // not exercised directly; server.js wires the REAL security/userAuth.js middleware in front of this route
    isRateLimited: () => false,
    users
});
assert(typeof registeredHandler === "function", "POST /api/agora/token handler was registered on app.post");

function mockRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

const res1 = mockRes();
registeredHandler({ authedMobile: null, body: { channelName: "room1" } }, res1);
assert(res1.statusCode === 401, "unauthenticated (no authedMobile) request is rejected with 401");

const res2 = mockRes();
registeredHandler({ authedMobile: "017...mock", body: {} }, res2);
assert(res2.statusCode === 400, "missing channelName is rejected with 400");
assert(res2.body.success === false, "400 response has success:false");

const res3 = mockRes();
registeredHandler({ authedMobile: "017...mock", body: { channelName: "room1" } }, res3);
assert(res3.statusCode === 200, "valid authenticated request succeeds");
assert(res3.body.success === true, "success response has success:true");
assert(typeof res3.body.token === "string" && res3.body.token.length > 0, "success response includes a token");
assert(!JSON.stringify(res3.body).includes("test-app-certificate-should-never-appear-in-output"), "route response never contains the certificate");

const res4 = mockRes();
registeredHandler({ authedMobile: "unknown-mobile-not-in-users", body: { channelName: "room1" } }, res4);
assert(res4.statusCode === 401, "authedMobile not present in users map is rejected with 401 (cannot resolve to a userId)");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail > 0 ? 1 : 0;
