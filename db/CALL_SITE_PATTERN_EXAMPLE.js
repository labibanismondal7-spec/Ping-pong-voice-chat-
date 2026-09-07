// ============================================================
// Reference pattern for Stage 3 of WALLET_CUTOVER_PLAN.md — NOT
// applied to server.js yet (Stage 2 staging validation must pass
// first, per the plan's own explicit ordering).
//
// This shows ONE of the 25 traced call sites (server.js:2282/2287,
// "Gift send") rewritten behind MODULE4_WALLET_ENABLED, using
// Module 4's own transferBetweenUsers() — not a custom repository.
// The other 24 sites follow the same shape.
// ============================================================

const module4Wallet = require("./integration_update/module4_wallet_ledger/wallet"); // adjust path
const MODULE4_WALLET_ENABLED = process.env.MODULE4_WALLET_ENABLED === "true";

// --- BEFORE (current server.js:2282/2287) ---
//   found.user.coins -= giftCost;
//   recipient.user.diamonds += giftDiamonds;

// --- AFTER (Stage 3 pattern) ---
async function handleGiftSend({ senderId, recipientId, giftId, coinCost, diamondValue, giftEventId }) {
    if (MODULE4_WALLET_ENABLED) {
        // Module 4 is now authority: durable, idempotent (txnId-keyed),
        // atomic debit+credit in one DB transaction.
        const coinResult = await module4Wallet.transferBetweenUsers({
            fromUserId: senderId,
            toUserId: recipientId, // or a house/escrow account if coins and diamonds settle differently — check with product on gift economics before wiring this for real
            currency: "coins",
            amount: coinCost,
            txnId: `gift:${giftEventId}:coins`,
            reason: "gift_send",
            context: giftId,
        });
        // existing in-memory `found.user`/`recipient.user` objects must be
        // refreshed from module4Wallet.getBalance() after this, since they
        // are no longer the source of truth once the flag is on.
        return coinResult;
    }

    // Legacy path — UNCHANGED, exactly what server.js does today.
    // Kept byte-for-byte so flipping MODULE4_WALLET_ENABLED back to
    // false is an instant, safe rollback (per the cutover plan's
    // Stage 4).
    found.user.coins -= coinCost;
    recipient.user.diamonds += diamondValue;
}
