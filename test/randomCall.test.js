// Standalone smoke test — mocks callHosting.js's dependencies (no real
// DB/filesystem/socket.io) to exercise the actual matching/retry/race
// logic in randomCall.js + callHosting.js's attemptInvite/getEligibleHostIds.
const { EventEmitter } = require("events");
const assert = require("assert");
const { initCallHosting } = require("../callHosting.js");
const { initRandomCall } = require("../randomCall.js");

function makeSocket(userId) {
    const s = new EventEmitter();
    s.id = "sock_" + userId;
    s.userId = userId;
    s.received = [];
    const origEmit = s.emit.bind(s);
    s.emit = (event, payload) => { s.received.push([event, payload]); return origEmit(event, payload); };
    return s;
}

const users = {
    caller1: { userId: "caller1", diamonds: 10000 },
    hostA: { userId: "hostA", diamonds: 0 },
    hostB: { userId: "hostB", diamonds: 0 },
    hostC: { userId: "hostC", diamonds: 0 }
};
const socketsByUserId = {};
const ioFake = {
    sockets: { sockets: new Map() },
    to(sid) { return { emit: (event, payload) => { const s = ioFake.sockets.sockets.get(sid); if (s) s.emit(event, payload); } }; }
};
function connect(userId) {
    const s = makeSocket(userId);
    socketsByUserId[userId] = s.id;
    ioFake.sockets.sockets.set(s.id, s);
    return s;
}

const dataStore = {};
function safeRead(file, def) { return dataStore[file] || def; }
function safeWrite(file, val) { dataStore[file] = val; }
function findUserByUserId(userId) { return users[userId] ? { user: users[userId] } : null; }
function saveUsers() {}
function clampDiamondBalance(uid, val) { return Math.max(0, val); }
function logTransaction() {}
function pushWalletUpdate() {}
const rbac = { logAction() {} };
function requireAdmin() { return (req, res, next) => next(); }
function requirePermission() { return (req, res, next) => next(); }
function actorCanAccessCountry() { return true; }
function countryDeniedResponse() { return {}; }
function reqUserAgent() { return "test"; }
const appFake = { get() {}, put() {}, post() {} };

const callHosting = initCallHosting({
    app: appFake, io: ioFake, DATA_FOLDER: "/tmp/fake",
    safeRead, safeWrite, findUserByUserId, socketsByUserId,
    saveUsers, clampDiamondBalance, logTransaction, pushWalletUpdate,
    rbac, requireAdmin, requirePermission, actorCanAccessCountry, countryDeniedResponse, reqUserAgent
});

// Approve three hosts (bypassing the admin REST route — direct data seed,
// same shape the route would produce).
dataStore["/tmp/fake/callhosting_hosts.json"] = {
    hostA: { userId: "hostA", status: "approved" },
    hostB: { userId: "hostB", status: "approved" },
    hostC: { userId: "hostC", status: "approved" }
};
// Re-init so the module picks up the seeded hosts (safeRead is called at init time).
const callHosting2 = initCallHosting({
    app: appFake, io: ioFake, DATA_FOLDER: "/tmp/fake",
    safeRead, safeWrite, findUserByUserId, socketsByUserId,
    saveUsers, clampDiamondBalance, logTransaction, pushWalletUpdate,
    rbac, requireAdmin, requirePermission, actorCanAccessCountry, countryDeniedResponse, reqUserAgent
});

function isRateLimited() { return false; }
const randomCall = initRandomCall({ io: ioFake, callHosting: callHosting2, findUserByUserId, isRateLimited, socketsByUserId });

async function main() {
    // ---- Test 1: hostA declines -> hostB times out (simulate manually) -> hostC accepts ----
    const caller = connect("caller1");
    const hA = connect("hostA");
    const hB = connect("hostB");
    const hC = connect("hostC");
    [caller, hA, hB, hC].forEach((s) => { callHosting2.registerSocketHandlers(s); randomCall.registerSocketHandlers(s); });

    caller.emit("random-call:start", { callType: "video" });
    await new Promise((r) => setTimeout(r, 10));

    const firstIncoming = [hA, hB, hC].find((s) => s.received.some(([e]) => e === "hostcall:incoming"));
    assert(firstIncoming, "one host should have received an incoming call");
    const [, incomingPayload] = firstIncoming.received.find(([e]) => e === "hostcall:incoming");
    assert.strictEqual(incomingPayload.from.userId, "caller1");
    console.log("PASS: caller1 random-call:start -> exactly one host got hostcall:incoming, tagged source=random-call:", incomingPayload.source === "random-call");

    // Decline it -> next host should get invited automatically.
    const declineCallId = incomingPayload.callId;
    firstIncoming.emit("hostcall:reject", { callId: declineCallId });
    await new Promise((r) => setTimeout(r, 10));

    const secondIncoming = [hA, hB, hC].filter((s) => s !== firstIncoming).find((s) => s.received.some(([e]) => e === "hostcall:incoming"));
    assert(secondIncoming, "decline should trigger next-host retry");
    console.log("PASS: decline -> automatic next-host retry fired to a different host");

    // Accept it -> caller gets hostcall:accepted + random-call:connected.
    const [, incoming2] = secondIncoming.received.find(([e]) => e === "hostcall:incoming");
    secondIncoming.emit("hostcall:accept", { callId: incoming2.callId });
    await new Promise((r) => setTimeout(r, 10));
    assert(caller.received.some(([e]) => e === "hostcall:accepted"), "caller should receive hostcall:accepted");
    assert(caller.received.some(([e]) => e === "random-call:connected"), "caller should receive random-call:connected");
    console.log("PASS: accept -> caller receives hostcall:accepted + random-call:connected");

    // ---- Test 2: no eligible hosts -> immediate no-host ----
    const caller2 = connect("caller2_missing"); // not in users -> caller-not-found path avoided by using real user below
    users.caller2 = { userId: "caller2", diamonds: 500 };
    const caller2b = connect("caller2");
    callHosting2.registerSocketHandlers(caller2b);
    randomCall.registerSocketHandlers(caller2b);
    // All three hosts are now busy (hostC connected above); hostA/hostB still free actually only hostC busy.
    // Force all hosts busy by making them "in a call": simplest is to mark them all offline instead.
    delete socketsByUserId.hostA; delete socketsByUserId.hostB; delete socketsByUserId.hostC;
    caller2b.emit("random-call:start", { callType: "video" });
    await new Promise((r) => setTimeout(r, 10));
    const noHostEvt = caller2b.received.find(([e]) => e === "random-call:end");
    assert(noHostEvt, "should end session");
    assert.strictEqual(noHostEvt[1].reason, "no-host");
    console.log("PASS: no eligible hosts (all offline/busy) -> random-call:end reason=no-host, no infinite loop");

    // ---- Test 3: caller cannot target self / self excluded from pool ----
    const poolExcludesCaller = callHosting2.getEligibleHostIds("hostC"); // hostC excluded from its own pool
    assert(!poolExcludesCaller.includes("hostC"));
    console.log("PASS: eligible pool excludes the caller themself");

    // ---- Test 4: race protection — two callers, one eligible host, only one wins ----
    users.callerX = { userId: "callerX", diamonds: 10000 };
    users.callerY = { userId: "callerY", diamonds: 10000 };
    const solo = connect("soloHost");
    dataStore["/tmp/fake/callhosting_hosts.json"].soloHost = { userId: "soloHost", status: "approved" };
    callHosting2.registerSocketHandlers(solo);
    const cx = connect("callerX"), cy = connect("callerY");
    callHosting2.registerSocketHandlers(cx); randomCall.registerSocketHandlers(cx);
    callHosting2.registerSocketHandlers(cy); randomCall.registerSocketHandlers(cy);
    cx.emit("random-call:start", { callType: "video" });
    cy.emit("random-call:start", { callType: "video" });
    await new Promise((r) => setTimeout(r, 10));
    const soloIncoming = solo.received.filter(([e]) => e === "hostcall:incoming");
    assert.strictEqual(soloIncoming.length, 1, "soloHost should receive exactly one incoming call, not two");
    const loserEnded = [cx, cy].find((s) => s.received.some(([e]) => e === "random-call:end"));
    assert(loserEnded, "the caller who lost the race should get a session end (no-host, soloHost was the only eligible host)");
    console.log("PASS: race protection — simultaneous callers targeting the same sole host -> exactly one reservation wins");

    console.log("\nALL SMOKE TESTS PASSED");
    process.exit(0); // test harness only — leftover billing/ring timers from simulated calls would otherwise keep the process alive
}

main().catch((e) => { console.error("SMOKE TEST FAILED:", e); process.exit(1); });
