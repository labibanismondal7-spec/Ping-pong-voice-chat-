# PingPong Host Salary / Beans Policy

## Source policy

Implemented from the supplied Bangladesh and India Host Diamond Target / Host Beans Reward sheets.

- Level 1–20 target table is preserved exactly.
- Every reward is 120% of the corresponding Diamond target.
- Bangladesh reference: 200,000 Beans = USD 1; USD 1 = BDT 120; exchange rate 30%.
- India reference: 200,000 Beans = USD 1; USD 1 = INR 90; exchange rate 30%.
- Other countries use the same Beans reward table and a configurable local-currency reference rate.

## Automatic host salary calculation

For the selected salary period:

1. Consider only users who are currently `isHost === true`.
2. The user must have an active `agencyId` and that agency must contain the user in `agency.hostIds`.
3. Only confirmed gift-history records for that host and current agency are counted.
4. Sum the gift Diamonds inside the selected period.
5. Select the highest policy level whose Diamond target is less than or equal to the host's earned Diamonds.
6. Credit that level's Beans reward to the host's separate `beans` wallet.
7. Diamonds are never deducted by salary payout.
8. The same host + agency + exact period can receive only one automatic salary payout.

Example:

- 200,000 Diamonds → Level 1 → 240,000 Beans.
- 500,000 Diamonds → Level 2 → 600,000 Beans.
- 1,200,000 Diamonds → Level 3 → 1,440,000 Beans.
- 250,000 Diamonds → Level 1 reward (240,000 Beans), because Level 2 has not been reached.

## Cash reference shown in the panel

The panel does **not** convert the salary payout into cash or deduct anything from the host. It only shows a reference estimate:

`USD reference = Beans / 200,000`

`Local payout reference = USD reference × local USD rate × 30% exchange rate`

For example, Level 1 (240,000 Beans):

- Bangladesh: 240,000 / 200,000 × 120 × 30% = BDT 43.20 reference.
- India: 240,000 / 200,000 × 90 × 30% = INR 32.40 reference.

## Manual payouts

### Manual Host Beans

Owner can send a one-off Beans adjustment to an existing Agency Host by User ID.

### Manual Agency Beans

Owner can select an Agency and send Beans manually. The Beans are credited to that Agency's Owner user wallet and the Agency ID is recorded in the payout ledger.

Manual payouts are separate from the automatic period idempotency rule and are intended for adjustments/agency payments.

## Security

- `host-salary:manage` is an Owner-only RBAC permission.
- Backend routes enforce the permission; hiding the menu is not the security boundary.
- Automatic and manual payouts are audit logged.
- Payout records are persisted in `data/host_salary_payouts.json`.
- Policy is persisted in `data/host_salary_policy.json`.
- Beans are persisted as a separate user wallet balance and included in wallet-update events/API responses.
