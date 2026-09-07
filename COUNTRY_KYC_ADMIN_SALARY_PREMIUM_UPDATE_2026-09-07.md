# PingPong — KYC / Admin Control / Salary Reset / Premium UI Update
Date: 2026-09-07

## Implemented
- Country-aware Withdrawal KYC registry with distinct identity and bank identifiers for India, Bangladesh, Pakistan, US, UK, UAE, Saudi Arabia, Nepal, Sri Lanka and Malaysia, plus a safe generic fallback.
- User KYC screen now loads the correct fields from the server and enforces profile-country matching when a real profile country exists.
- Withdrawal snapshots now preserve the KYC country, document statuses and country-specific bank identifiers.
- Admin KYC review now supports country/status filtering and displays the country-specific document set.
- Super Admin accounts can create/manage subordinate Admin/Moderator accounts through the existing Role & Country panel using a new server-side `admin-accounts:manage` permission. Country scope and role hierarchy remain enforced by RBAC.
- Added `rooms:global-control` to the permission catalog for explicit room-control delegation. Existing God Power room moderation already uses the server-side `isOwnerOrAdmin()` override, including seat locking, kick/mute and room media controls.
- Host and Agency salary payout now records a durable post-payout target-cycle reset marker so old gift activity cannot be carried into a later target cycle.
- Added premium purple motion/glow styling to the user UI and admin panel, with reduced-motion support.
- Existing Call Hosting / Video controls remain server-authoritative and gated by `callhosting:manage`.

## Verification
- `node -c server.js` PASS
- `node -c rbac.js` PASS
- `node -c payoutWithdrawal.js` PASS
- `node -c hostSalary.js` PASS
- `node -c agencyCommission.js` PASS
- `node -c countryKyc.js` PASS
- `node -c admin/app.js` PASS
- `countryKyc.test.js` — 3/3 PASS
- `rbacAccessControl.test.js` — 16/16 PASS
- `hostSalary.test.js` — PASS
- `agencyCommission.test.js` — PASS
- `payoutWithdrawal.test.js` — all tests PASS

## Important security behavior
Raw KYC values are not returned by the public withdrawal state. Country-specific KYC rules are enforced server-side. Super Admin account creation remains subject to the existing role hierarchy, country scope and permission-delegation rules; it does not bypass Owner-only protected system permissions.
