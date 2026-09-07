# Wallet Call-Site Mapping (re-verified against current source, 2026-08-25)

**Finding:** `WALLET_CUTOVER_PLAN.md`'s 25-site trace was written when `server.js` was 6,697 lines.
It is now **8,056 lines** (grown by ~1,359 lines since). Re-running the same grep methodology shows
**`server.js`'s line numbers in the original plan are stale** — the code moved. The other 4 files
(`coinCenter.js`, `diamondSeller.js`, `callHosting.js`, `rechargeWithdrawApproval.js`) are unchanged;
their line numbers still match exactly. This table replaces the `server.js` rows only.

Method (same as the original plan, re-run): `grep -noE "\.(coins|diamonds)\s*[+\-]=|\.(coins|diamonds)\s*=\s*[^=]" server.js`, each hit manually read in context to exclude non-balance accumulators.

| # | File:Line (current) | Trigger | Currency | Module 4 API to use in Stage 3 |
|---|---|---|---|---|
| 1 | server.js:863 | Boot-time default fill (`u.diamonds = 0` if missing) — NOT a mutation, a schema-default. Excluded. | — | n/a |
| 2 | server.js:1274 | Ranking totals accumulator (`totals[senderId].diamonds`) — NOT a live balance, excluded (matches original plan's exclusion list) | — | n/a |
| 3 | server.js:1505 | Treasure chest reward | coins | `wallet.credit({userId, currency:"coins", amount, txnId, reason:"chest-reward"})` |
| 4 | server.js:1509 | Treasure chest reward | diamonds | `wallet.credit(...currency:"diamonds"...)` |
| 5 | server.js:2598 | Gift send (sender debit) | coins | `wallet.transferBetweenUsers({fromUserId:senderId, toUserId:<house/recipient>, currency:"coins", amount:gift.price, txnId, reason:"gift-send"})` |
| 6 | server.js:2603 | Gift receive (recipient credit, diamonds) | diamonds | second leg of the same `transferBetweenUsers` call if coins→diamonds settle 1:1, or a separate `credit()` if not — **confirm gift economics with product before wiring** |
| 7 | server.js:4074 | Instant diamond→coin exchange (debit) | diamonds | `wallet.debit(...)` |
| 8 | server.js:4075 | Instant diamond→coin exchange (credit) | coins | `wallet.credit(...)` — pair with #7 via shared base `txnId` |
| 9 | server.js:4120 | Daily reward | coins | `wallet.credit(...reason:"daily-reward")` |
| 10 | server.js:4136 | Weekly reward | coins | `wallet.credit(...reason:"weekly-reward")` |
| 11 | server.js:5550 | Admin direct coin-balance edit | coins | `wallet.credit`/`debit` depending on `diff` sign, `reason:"admin-coin-edit"` |
| 12 | server.js:5910 | Admin exchange decision (debit) | diamonds | `wallet.debit(...)` |
| 13 | server.js:5912 | Admin exchange decision (credit) | coins | `wallet.credit(...)` |
| 14 | server.js:6208 | Fruit Wheel restart refund | coins | `wallet.credit(...reason:"fruit-wheel-restart-refund")` |
| 15 | server.js:6352 | Fruit Wheel payout | coins | `wallet.credit(...reason:"fruit-wheel-payout")` |
| 16 | server.js:7061 | Multi-target gift send (sender debit) | coins | `wallet.debit(...)` |
| 17 | server.js:7068 | Multi-target gift receive | diamonds | `wallet.credit(...)` per target |
| 18 | server.js:7142 | Gift send, socket variant (sender debit) | coins | `wallet.debit(...)` |
| 19 | server.js:7696 | Fruit Wheel bet | coins | `wallet.debit(...reason:"fruit-wheel-bet")` |
| 20 | server.js:7787 | Game-wheel sync correction | coins | `wallet.credit`/`debit` depending on `delta` sign |
| 21 | coinCenter.js:144 | Coin Center single send | coins | `wallet.transferBetweenUsers(...)` |
| 22 | coinCenter.js:327 | Coin Center bulk send | coins | loop of `transferBetweenUsers`, or a batched variant if one gets added to Module 4 |
| 23 | diamondSeller.js:370 | Diamond seller sale (buyer credit) | diamonds | `wallet.credit(...)` |
| 24 | diamondSeller.js:371 | Diamond seller commission | coins | `wallet.credit(...)` |
| 25 | callHosting.js:270 | Per-minute call billing | coins | `wallet.debit(...reason:"call-billing")` |
| 26 | rechargeWithdrawApproval.js:83 | Recharge approval | coins | `wallet.credit(...reason:"recharge-approved")` |
| 27 | rechargeWithdrawApproval.js:124 | Withdraw approval (debit) | diamonds | `wallet.debit(...reason:"withdraw-approved")` |

Real mutation-site count in current `server.js`: **18** (rows 3–20 above; rows 1–2 are confirmed non-balance,
same as the original plan's exclusions). Combined with the 7 sites in the other 4 files (rows 21–27),
**total = 25** — same count as the original plan, just redistributed after the file grew. No new
untraced mutation sites were found; no sites disappeared.

**Excluded (re-confirmed false positives, same reasoning as original plan):**
- `server.js:863` — schema-default fill on boot, not a mutation.
- `server.js:1274` — ranking accumulator object, not a live user balance.
- `callHosting.js:198` — analytics `stats.byDay[day].coins` bucket, not a live balance (re-checked, unchanged).

## Module 4 API signatures (verified directly from `wallet/index.js` source, not assumed)

```
credit({ userId, currency, amount, txnId, reason, context })
debit({ userId, currency, amount, txnId, reason, context })
transferBetweenUsers({ fromUserId, toUserId, currency, amount, txnId, reason, context })
getBalance(userId, currency)
getTransaction(txnId)
reconcileBalance(userId, currency, { repair = false })
```
`txnId` is required (not auto-generated) on every mutating call — confirmed via the code comment at
`wallet/index.js:342` ("BUG FIX ... no longer auto-generated on omission"). Every Stage 3 call site
must generate its own deterministic `txnId` (e.g. `gift:<giftEventId>:coins`) the same way
`scripts/wallet-opening-balance-migration.js` does for opening balances (`opening-balance:<userId>:<currency>`).

**Still not done (correctly, per your instruction not to touch these yet):** actually rewriting any of
these 25/27 sites. This table is verification/mapping only, for when Stage 3 is approved.
