// test/roomEvents.test.js
// ==================================================
// ROOM EVENTS — High-Value Gift & Big Win notifications
// ==================================================
// Spec: "PingPong — High-Value Gift & Big-Win Room Notification System"
// (2026-08-29). Dependency-free, same style as the rest of test/ — pure
// assert against roomEvents.js (the presentation-only payload builder).
// This suite does NOT re-test the transaction logic in server.js (gift
// spend/credit, fruit-wheel payout) — those are covered by their own
// existing suites and are untouched by this feature. It covers exactly
// what roomEvents.js is responsible for:
//   1. Threshold gating (isHighValueGift / isBigWin)
//   2. Payload shape (§9 — sender/receiver/gift/room fields present)
//   3. No hard-coded room ID/name (§9 — roomId/roomName always echo the
//      caller-supplied values, never a constant)
//   4. Unique eventId per call (§11 — dedupe relies on this)
//   5. displayDurationMs ~5s default (§1/§2)
//
// Run: node test/roomEvents.test.js  (or via npm test / test/run-all.js)

const assert = require("assert");
const roomEvents = require("../roomEvents.js");

let passed = 0;
let failed = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (e) {
        console.log(`  ✗ ${name}`);
        console.log(`    ${e.message}`);
        failed++;
    }
}

console.log("\n1. High-Value Gift threshold (§1 — 100,000 Diamonds)");
test("100,000 exactly is high-value (>=, not >)", () => {
    assert.strictEqual(roomEvents.isHighValueGift(100000), true);
});
test("99,999 is NOT high-value", () => {
    assert.strictEqual(roomEvents.isHighValueGift(99999), false);
});
test("far above threshold is high-value", () => {
    assert.strictEqual(roomEvents.isHighValueGift(5000000), true);
});
test("string numeric input is coerced correctly (client/DB values may arrive as strings)", () => {
    assert.strictEqual(roomEvents.isHighValueGift("100000"), true);
    assert.strictEqual(roomEvents.isHighValueGift("99999"), false);
});
test("threshold constant matches spec default (100000)", () => {
    assert.strictEqual(roomEvents.HIGH_VALUE_GIFT_THRESHOLD, 100000);
});

console.log("\n2. Big Win threshold (§2 — 1,000,000)");
test("1,000,000 exactly is a big win (>=, not >)", () => {
    assert.strictEqual(roomEvents.isBigWin(1000000), true);
});
test("999,999 is NOT a big win", () => {
    assert.strictEqual(roomEvents.isBigWin(999999), false);
});
test("far above threshold is a big win", () => {
    assert.strictEqual(roomEvents.isBigWin(50000000), true);
});
test("threshold constant matches spec default (1000000)", () => {
    assert.strictEqual(roomEvents.BIG_WIN_THRESHOLD, 1000000);
});

console.log("\n3. High-Value Gift payload shape (§9)");
test("includes sender, receiver, gift, room fields with no hard-coded room", () => {
    const evt = roomEvents.buildHighValueGiftEvent({
        roomId: "room_9f3d2",
        roomName: "Late Night Lounge",
        sender: { userId: "u1", name: "Rakib" },
        receiver: { userId: "u2", name: "Nusrat" },
        gift: { id: "g_dragon", name: "Luxury Dragon", icon: "/images/gifts/dragon.png" },
        quantity: 1,
        value: 150000
    });
    assert.strictEqual(evt.type, "HIGH_VALUE_GIFT");
    assert.strictEqual(evt.roomId, "room_9f3d2");
    assert.strictEqual(evt.roomName, "Late Night Lounge");
    assert.strictEqual(evt.sender.name, "Rakib");
    assert.strictEqual(evt.receiver.name, "Nusrat");
    assert.strictEqual(evt.gift.name, "Luxury Dragon");
    assert.strictEqual(evt.gift.value, 150000);
    assert.ok(evt.eventId && typeof evt.eventId === "string");
});
test("roomId echoes exactly whatever the caller passes — never a fixed value", () => {
    const evtA = roomEvents.buildHighValueGiftEvent({
        roomId: "room_alpha", sender: { userId: "u1", name: "A" }, receiver: { userId: "u2", name: "B" },
        gift: { id: "g1", name: "Rose" }, value: 100000
    });
    const evtB = roomEvents.buildHighValueGiftEvent({
        roomId: "room_beta", sender: { userId: "u3", name: "C" }, receiver: { userId: "u4", name: "D" },
        gift: { id: "g1", name: "Rose" }, value: 100000
    });
    assert.strictEqual(evtA.roomId, "room_alpha");
    assert.strictEqual(evtB.roomId, "room_beta");
    assert.notStrictEqual(evtA.roomId, evtB.roomId);
});
test("default display duration is 5000ms", () => {
    const evt = roomEvents.buildHighValueGiftEvent({
        roomId: "r1", sender: { userId: "u1", name: "A" }, receiver: { userId: "u2", name: "B" },
        gift: { id: "g1", name: "Rose" }, value: 100000
    });
    assert.strictEqual(evt.displayDurationMs, 5000);
});
test("gift.id fallback: accepts either gift.giftId or gift.id from the caller", () => {
    const evt1 = roomEvents.buildHighValueGiftEvent({
        roomId: "r1", sender: { userId: "u1", name: "A" }, receiver: { userId: "u2", name: "B" },
        gift: { giftId: "g_x", name: "Rose" }, value: 100000
    });
    const evt2 = roomEvents.buildHighValueGiftEvent({
        roomId: "r1", sender: { userId: "u1", name: "A" }, receiver: { userId: "u2", name: "B" },
        gift: { id: "g_y", name: "Rose" }, value: 100000
    });
    assert.strictEqual(evt1.gift.giftId, "g_x");
    assert.strictEqual(evt2.gift.giftId, "g_y");
});

console.log("\n4. Big Win payload shape (§9)");
test("includes player, amount, room fields with no hard-coded room", () => {
    const evt = roomEvents.buildBigWinEvent({
        roomId: "room_9f3d2", roomName: "Late Night Lounge",
        player: { userId: "u1", name: "Rakib" }, amount: 2500000, gameName: "Fruit Wheel"
    });
    assert.strictEqual(evt.type, "BIG_WIN");
    assert.strictEqual(evt.roomId, "room_9f3d2");
    assert.strictEqual(evt.player.name, "Rakib");
    assert.strictEqual(evt.amount, 2500000);
    assert.strictEqual(evt.gameName, "Fruit Wheel");
    assert.ok(evt.eventId && typeof evt.eventId === "string");
});
test("default display duration is 5000ms", () => {
    const evt = roomEvents.buildBigWinEvent({ roomId: "r1", player: { userId: "u1", name: "A" }, amount: 1000000 });
    assert.strictEqual(evt.displayDurationMs, 5000);
});

console.log("\n5. Event deduplication support (§11 — unique eventId per call)");
test("two events built from identical input still get distinct eventIds", () => {
    const input = {
        roomId: "r1", sender: { userId: "u1", name: "A" }, receiver: { userId: "u2", name: "B" },
        gift: { id: "g1", name: "Rose" }, value: 100000
    };
    const evt1 = roomEvents.buildHighValueGiftEvent(input);
    const evt2 = roomEvents.buildHighValueGiftEvent(input);
    assert.notStrictEqual(evt1.eventId, evt2.eventId);
});
test("BIG_WIN eventIds are likewise always unique", () => {
    const input = { roomId: "r1", player: { userId: "u1", name: "A" }, amount: 2000000 };
    const evt1 = roomEvents.buildBigWinEvent(input);
    const evt2 = roomEvents.buildBigWinEvent(input);
    assert.notStrictEqual(evt1.eventId, evt2.eventId);
});

console.log("\n6. Room isolation (§8 — server.js wiring, verified statically here)");
test("server.js emits both event types via io.to(roomId).emit(...), never io.emit(...) (global broadcast)", () => {
    const fs = require("fs");
    const src = fs.readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
    // Find the two integration call-sites and confirm each is wrapped in
    // an io.to(roomId).emit("room-event", ...) — i.e. scoped to the room
    // the event happened in, not broadcast server-wide.
    const bigWinSite = src.indexOf("roomEvents.buildBigWinEvent(");
    const giftSite = src.indexOf("roomEvents.buildHighValueGiftEvent(");
    assert.ok(bigWinSite > -1, "BIG_WIN integration call-site not found in server.js");
    assert.ok(giftSite > -1, "HIGH_VALUE_GIFT integration call-site not found in server.js");
    const beforeBigWin = src.slice(Math.max(0, bigWinSite - 120), bigWinSite);
    const beforeGift = src.slice(Math.max(0, giftSite - 120), giftSite);
    assert.ok(/io\.to\(roomId\)\.emit\(\s*"room-event"/.test(beforeBigWin), "BIG_WIN emit is not scoped via io.to(roomId)");
    assert.ok(/io\.to\(roomId\)\.emit\(\s*"room-event"/.test(beforeGift), "HIGH_VALUE_GIFT emit is not scoped via io.to(roomId)");
});
test("no static/hard-coded room id or name (e.g. \"101\", \"Room 101\") appears in roomEvents.js", () => {
    const fs = require("fs");
    const src = fs.readFileSync(require("path").join(__dirname, "..", "roomEvents.js"), "utf8");
    assert.ok(!/["']101["']/.test(src), "found a literal \"101\" room id in roomEvents.js");
    assert.ok(!/Room\s*101/i.test(src), "found a literal \"Room 101\" string in roomEvents.js");
});

console.log("\n7. Security — thresholds are enforced server-side only, never client-suppliable (static check)");
test("threshold checks (isHighValueGift/isBigWin) run against server-computed amounts (perTargetAmount / amount), not any raw client payload field", () => {
    const fs = require("fs");
    const src = fs.readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
    // perTargetAmount is derived server-side from gift.price * qty / targets.length
    // earlier in the same handler; amount in the fruit-wheel path is the
    // server-computed payout (betOnWin * mult). Neither is ever read
    // directly off req.body/socket payload at the isHighValueGift/isBigWin
    // call site itself.
    assert.ok(src.includes("roomEvents.isHighValueGift(perTargetAmount)"), "expected the high-value-gift check to run against the server-derived perTargetAmount");
    assert.ok(src.includes("roomEvents.isBigWin(amount)"), "expected the big-win check to run against the server-derived payout amount");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
