# Agency Center — Official/Handler + Royal Purple Premium Update

## Implemented
- Agency Center redesigned with a light/white page and royal-purple premium cards, glow, gradients and responsive sizing.
- Every Agency Management action now has a dedicated inline SVG icon.
- Added Host Data screen with Daily / Weekly / Monthly tabs using live server data.
- Agency identity now exposes the assigned Official Handler name without copying any reference-image data.
- Admin Agency Command Center now shows Official Handler, assignment controls, assignment source, and audit state.
- Added Official Network dashboard: Total Officials, Assigned Agencies, Assigned by Me, per-Official Agency count and Inquiry.
- Added Official Inquiry showing Agency-related activity, action counts, timestamps, actor and success/failure status.
- Official assignment is server-authoritative, country-scoped, permission-gated and audited.
- Official assignment requires the target user to carry the existing `official_tag` (or an explicitly trusted `official=true` user flag).
- Agency removal remains isolated: removing a Host never removes the Agency or its Official Handler.
- Existing KYC, Salary/Beans, Agency Commission, RBAC and other modules remain untouched.

## New persistent store
- `data/agency_officials.json` — starts empty; no reference-image IDs or user data were copied into it.

## New endpoints
- `GET /api/admin/agency-officials`
- `PUT /api/admin/agency/:agencyId/official`
- `GET /api/admin/agency-officials/:officialUserId/inquiry`

## Verification
- `node --check server.js` — PASS
- `node --check agencyHost.js` — PASS
- `node --check agencyOfficials.js` — PASS
- `node --check admin/app.js` — PASS
- `node --check public/app.js` — PASS
- `node test/agencyRanking.test.js` — PASS
- `node test/agencyCommission.test.js` — PASS
- Full `npm test` reached 43/47 suites passing. Four failures are the same existing environment/test-fixture failures in Agora Token, Friendship CP Visual, Profile Security Hardening and Recharge Service; no Agency Ranking/Commission regression was introduced.
