# PingPong Production Repair Report — 2026-09-04

## Requested fixes completed

### 1. Room gifts now credit Beans
The room gift economy is now server-authoritative:
- Sender: Diamonds are deducted.
- Recipient: Beans are credited.
- Both REST and Socket.IO gift paths were repaired.
- Multi-recipient and quantity sends use the same rule.
- Video gifts also credit Beans to the selected recipient (or room host for room-wide sends).
- Wallet updates and transaction ledger entries use the correct currency.
- Existing gift history continues to record the Diamond value used by Host/Agency statistics.

### 2. Agency creation / "Network issue" repaired
The Admin UI already called `/api/admin/agency/list`, `/api/admin/agency/create`, and
`/api/admin/agency/assign-host`, but the server routes were missing. A 404 HTML
response was then parsed as JSON by the Admin client and surfaced as the misleading
"Network issue" message.

Added:
- Authenticated + permission-gated Agency list/create/host-assignment routes.
- Country-scope validation.
- Duplicate Agency-name protection per country.
- Owner/host conflict checks.
- Audit logging.
- Live `agency-status-update` for online owners.

### 3. Agency user endpoints hardened
- Added authenticated `/api/agency/mine/:userId`.
- Agency invite, invite response, logo update, Host Center, and Agency dashboard
  now derive identity from the verified user session instead of trusting body/query
  user IDs.
- Cross-instance notifications continue to use `emitToUser()`.

### 4. My Frames route gap repaired
The public client referenced `/api/frames/*` endpoints that were absent from the
server. Added authenticated inventory, activation, and deactivation routes with
server-side ownership/expiry checks and live room/profile synchronization.

### 5. Admin API error handling
The Admin fetch wrapper now distinguishes:
- actual network failures,
- JSON API errors,
- non-JSON HTTP errors such as 404/500.

This prevents server-side 404s from being falsely reported as "Network issue".

## Verification

- Production preflight: PASS — 197 JavaScript files syntax-clean.
- Focused repair regression: PASS — 18/18.
- Existing profile security suite: PASS — 37/37.
- Agency cross-instance notification suite: PASS — 10/10.
- Full npm test suite: 43/44 suites passed in the sandbox.

The single remaining full-suite failure is `test/agoraToken.test.js`; its mock request
does not provide the required room membership/roomId for the now intentionally
room-authorized Agora token endpoint. This is a test-fixture mismatch, not a production
runtime failure. The Agora implementation correctly fails closed when a caller is not
a member of a room.

## Deployment note

The ZIP does not include `node_modules`. Run `npm install` on the deployment host,
then run:

    npm test
    npm run preflight
    npm run readiness
    npm start

Production environment variables (database/Redis/voice/payment/Firebase/etc.) must be
provided by the deployment environment; no secrets were added to this repair.
