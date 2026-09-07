# Room UI Premium Update — 2026-09-06

Applied to the supplied `PINGPONG-FINAL-ROOM-70PERCENT-PREMIUM-VISIBLE-GAME-2026-09-06.zip`.

## Changes
- Room chat now uses a compact reference-style identity row:
  - username
  - User ID
  - Level
  - message on the next line
- Chat now respects the existing admin-controlled animated `premium_gradient` name effect.
- Reworked the existing name effect into a lighter animated gradient with subtle glow/bevel depth.
- Replaced the Room Ranking trophy placeholder with the supplied gold/red-rose cup artwork.
- Added the same supplied cup artwork to the Room Ranking popup heading.
- Added the supplied `Active Agency` artwork as a dedicated persistent user badge.
- Added Admin Control Panel actions to send/remove `Active Agency` by User ID.
- Active Agency badge is delivered live to the target user and reflected in room seat/profile/chat.
- Generic custom tags remain separate from Active Agency so one does not overwrite the other.
- Added a glassy/premium animation finish to room chrome and Home room cards without changing core room sizing/voice/game behavior.
- Supplied JPG artwork was converted to transparent PNG assets so the black source background does not appear inside the UI.

## Validation
- `node --check server.js` — PASS
- `node --check public/app.js` — PASS
- `node --check admin/app.js` — PASS
- Existing full suite: 41/46 suites passed; the same five environment/test-fixture suites remained failing (Agora token, Friendship CP visual, Profile security, Random Call, Recharge Service). Agency Ranking and Agency Commission passed.
