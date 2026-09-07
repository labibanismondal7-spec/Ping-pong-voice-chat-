// ==================================================
// Room Events — High-Value Gift & Big Win notifications
// ==================================================
// Spec: "PingPong — High-Value Gift & Big-Win Room Notification System"
// (2026-08-29). This module is intentionally NOT a transaction authority
// (§13 AI ROLE / server-side security note in §10): it only builds the
// event payload that server.js broadcasts AFTER a gift/game transaction
// has already been validated and committed by the real authoritative
// code (send-gift handler, fruit-wheel payout resolution, etc). It never
// deducts diamonds, credits winnings, or decides room membership.
//
// Every event is scoped to a single room by the CALLER — this module
// never decides which sockets receive it; server.js does that with the
// existing `io.to(roomId).emit(...)`, which already fans out across
// instances via the Socket.IO Redis adapter (see redis/socketAdapter.js)
// with zero extra wiring needed here (§11/§18 "Redis/multi-instance
// compatible event delivery").
//
// No room ID/name is ever hard-coded here (§9) — every field comes from
// the caller, which in turn takes it from the validated room/user
// records already in server.js.

const crypto = require("crypto");

// ---- Configurable thresholds (§14) ----------------------------------
// Overridable via env for future admin-configuration wiring without a
// code change; defaults exactly match the spec.
const HIGH_VALUE_GIFT_THRESHOLD = Number(process.env.HIGH_VALUE_GIFT_THRESHOLD) || 100000;
const BIG_WIN_THRESHOLD = Number(process.env.BIG_WIN_THRESHOLD) || 1000000;
const ROOM_EVENT_DISPLAY_DURATION_MS = Number(process.env.ROOM_EVENT_DISPLAY_DURATION_MS) || 5000;

function isHighValueGift(diamondAmount) {
    return Number(diamondAmount) >= HIGH_VALUE_GIFT_THRESHOLD;
}

function isBigWin(winAmount) {
    return Number(winAmount) >= BIG_WIN_THRESHOLD;
}

// §9 event payload shape (kept intentionally close to the spec's example
// payload so it's easy to audit against the doc).
function buildHighValueGiftEvent({ roomId, roomName, sender, receiver, gift, quantity, value, timestamp }) {
    return {
        eventId: crypto.randomUUID(),
        type: "HIGH_VALUE_GIFT",
        roomId,
        roomName: roomName || null,
        sender: { userId: sender.userId, name: sender.name },
        receiver: { userId: receiver.userId, name: receiver.name },
        gift: {
            giftId: gift.giftId != null ? gift.giftId : gift.id,
            name: gift.name,
            value,
            icon: gift.icon || gift.image || null,
            quantity: quantity || 1
        },
        displayDurationMs: ROOM_EVENT_DISPLAY_DURATION_MS,
        timestamp: timestamp || new Date().toISOString()
    };
}

function buildBigWinEvent({ roomId, roomName, player, amount, gameName, timestamp }) {
    return {
        eventId: crypto.randomUUID(),
        type: "BIG_WIN",
        roomId,
        roomName: roomName || null,
        player: { userId: player.userId, name: player.name },
        amount,
        gameName: gameName || null,
        displayDurationMs: ROOM_EVENT_DISPLAY_DURATION_MS,
        timestamp: timestamp || new Date().toISOString()
    };
}

module.exports = {
    HIGH_VALUE_GIFT_THRESHOLD,
    BIG_WIN_THRESHOLD,
    ROOM_EVENT_DISPLAY_DURATION_MS,
    isHighValueGift,
    isBigWin,
    buildHighValueGiftEvent,
    buildBigWinEvent
};
