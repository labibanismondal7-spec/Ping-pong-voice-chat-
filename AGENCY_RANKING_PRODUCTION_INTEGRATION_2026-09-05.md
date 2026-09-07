# Agency Ranking Event — Production Integration

Date: 2026-09-05

## Replaced
- The `/club/` screen now renders the Agency Ranking Event UI.
- The legacy Club service is no longer initialized by `server.js`.
- Home "Club" popular tool now opens Agency Ranking.

## Real data source
- Agency names come from the real `agencies` store.
- Agency image uses the real Agency logo; if no logo exists, the Agency owner's real profile image is used.
- Ranking points come only from the existing confirmed gift ledger (`giftHistory`) and the recorded `agencyId`.
- No client-supplied score, rank, Agency name, owner name, or host name is accepted.

## Event
- One persistent 7-day event window.
- The first event starts on the first production boot and is persisted.
- Subsequent events start immediately after the previous 7-day window.
- Restart/recovery finalizes completed windows automatically.

## Rewards
Default production reward configuration:
- 1st: 100,000 Diamonds
- 2nd: 75,000 Diamonds
- 3rd: 50,000 Diamonds

Rewards are recorded in `data/agency_ranking_rewards.json` as an Agency-level event reward ledger. The existing user wallet is not silently credited because this codebase has a separate user wallet and no native Agency wallet account. `earnedDiamonds` remains reserved for the existing Agency commission domain.

The reward ledger is idempotent by `eventId + agencyId + rank`, preventing duplicate settlement after retries/restarts.

## API
- `GET /api/agency-ranking` — authenticated live ranking + event state + reward policy.
- `GET /api/agency-ranking/history` — authenticated settled Agency reward history.
- `GET /api/agency-ranking/mine/:userId` — authenticated Agency owner view of Agency-level ranking reward balance.
- Admin:
  - `GET /api/admin/agency-ranking/config`
  - `PUT /api/admin/agency-ranking/config`
  - `GET /api/admin/agency-ranking/rewards`

## Live updates
Confirmed gifts trigger `agency-ranking:update` through Socket.IO. The ranking page also keeps a local countdown and falls back to authenticated HTTP refresh; socket failure never clears the user's session or forces logout.

## Verification
- `node --check server.js` — PASS
- `node --check agencyRanking.service.js` — PASS
- `node --check agencyHost.js` — PASS
- `node --check public/app.js` — PASS
- `node --check public/club/club.js` — PASS
- `node test/agencyRanking.test.js` — PASS
- `node test/clubService.test.js` — PASS
- `node test/agencyCommission.test.js` — PASS
- `node test/beansGiftAgencyRepair.test.js` — PASS

The repository's full pre-existing test runner still has unrelated baseline failures in six suites; those failures were present before this change and were not altered as part of the Agency Ranking integration.
