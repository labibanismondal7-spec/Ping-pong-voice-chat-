# PingPong Final Update — 2026-09-06

## Included
- Random video-call matching/retry/race fixes preserved.
- Random-call smoke test: 6/6 PASS.
- Seller Tag artwork replaced with the supplied Seller image, transparent PNG.
- Official Tag artwork replaced with the supplied Official image, transparent PNG.
- Existing Active Agency badge artwork/system retained.
- Added separate Admin-selectable Agency Tag alongside Seller Tag and Official Tag.
- Agency/Seller/Official compact tags remain profile/identity tags; room seats do not render the agency artwork underneath a seat.
- Normal room-seat names remain white and slightly larger.
- Premium name animation now uses the supplied purple-to-pink palette, fast/deep, text-only.
- Badge catalog live-update handling remains compatible with the client cache.

## Verification
- `node --check server.js badges.js public/app.js admin/app.js`: PASS
- `node test/randomCall.test.js`: PASS (6/6)
- Full `npm test`: 42/46 suites passed in the local sandbox. Existing unrelated failures remain in Agora token, Friendship/CP visual, profile-security, and recharge-service tests; these were not introduced by this UI/tag update.

## Production note
Real mobile-to-mobile WebRTC connectivity still depends on valid TURN configuration in the deployment environment. No TURN secrets are embedded in this ZIP.
