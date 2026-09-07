# Wallet / Gift Box Diamond Fix — 2026-09-04

## Root causes fixed
1. Beans → instant exchange was still wired to the retired Coins wallet. It now credits Diamonds, logs Diamonds, returns `diamondsReceived`, and pushes the authoritative wallet update.
2. Gift Box level/progress rendering was still calculated from `me.coins`, so a user with Diamonds could see zero/stale Gift Box progress. It now uses Diamonds.
3. Gift Box opening now refreshes the authenticated user wallet from `/api/user/:mobile` before rendering the balance, preventing a stale session snapshot after an exchange.
4. The main app's legacy instant-exchange handler now sends Beans and consumes the Diamonds response, updating the local wallet immediately.
5. Embedded Wallet exchange confirmation now says Diamonds added rather than Coins.

## Verification
- `node --check server.js` — PASS
- `node --check public/app.js` — PASS
- `node test/beansGiftAgencyRepair.test.js` — 18/18 PASS
- Full existing suite — 43/44 suites PASS; the only remaining failure is the pre-existing Agora token test fixture/environment path, unrelated to this wallet/Gift Box repair.

## Economy behavior
- Room gift: sender Diamonds -> receiver Beans.
- Beans exchange: Beans -> Diamonds.
- Coins are not used by the repaired exchange path.
