# Fruit Wheel Production Update — 2026-09-05

## Included
- Betting phase increased from 20 seconds to 30 seconds.
- Lucky and Super Lucky player-side bulk-bet controls are disabled.
- Help text now makes clear that Lucky/Super Lucky are admin-controlled modes and player taps do not place multi-fruit bets.
- Existing server-authoritative result generation and wallet settlement are preserved.
- Existing per-round audit trail and targeted user result reporting are preserved.

## Important economic/security boundary
This update intentionally does NOT implement an outcome-selection rule that chooses the winning fruit from the lowest-bet/lowest-stake side, a forced loss ratio, or any hidden transfer of one user's wager to another user. Such logic would make outcomes depend on individual wagering behavior and would not be a fair/auditable game.

For company-risk control, use transparent, preconfigured payout rules and/or a clearly disclosed pooled-prize model. Any reserve/house-edge policy should be specified explicitly before changing settlement math.

## Validation
- `node --check server.js`
- `node --check fruitWheelAudit.js`
