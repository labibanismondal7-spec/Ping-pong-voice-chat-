# PingPong Production Integration Patch — 2026-09-07

## Included fixes

### 1. Lucky Fruit / Fruit Wheel full-bleed layout
The Lucky Fruit iframe had an internal `max-w-[390px]` cap while Teen Patti already neutralized its corresponding max-width. The Fruit Wheel now uses the same full-bleed behavior.

- The iframe background can fill the complete available game screen.
- Existing wheel controls, server-authoritative round state, bets, wallet sync, winner feed and close protocol are unchanged.
- No room structure or seat layout is changed.

### 2. International mobile login
Phone login now has a country selector with calling code.

- All 249 ISO country/territory entries are included.
- India remains the default.
- Existing Indian 10-digit account keys are preserved.
- New international phone accounts use E.164 canonical keys (for example `+880...`, `+44...`, `+1...`).
- SMS delivery receives the canonical international number instead of always prepending `+91`.
- OTP verification remains server-authoritative and uses the existing hashed, single-use OTP store.

### 3. WhatsApp Cloud API production path
The existing WhatsApp test mode is still test-only: it opens a `wa.me` link and requires the user to tap Send.

A real Meta WhatsApp Cloud API delivery path is now available through:

- `SMS_GATEWAY_MODE=whatsapp`
- `WHATSAPP_CLOUD_API_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_API_VERSION`
- `WHATSAPP_OTP_TEMPLATE_NAME`
- `WHATSAPP_OTP_TEMPLATE_LANGUAGE`

For production, use an approved WhatsApp authentication/OTP template. Real secrets must be configured only in Railway/host environment variables.

### 4. Country-aware withdrawal KYC
The withdrawal KYC schema is now available for every ISO country in the registry.

- India keeps Aadhaar + PAN + IFSC.
- Bangladesh keeps NID + routing number.
- Pakistan keeps CNIC + IBAN.
- Other maintained country rules remain intact.
- Countries without a maintained local rule receive a conservative Government ID/Passport + bank-account schema rather than incorrectly borrowing another country's requirements.
- The KYC country list endpoint bug that referenced an undefined user variable is fixed.
- Withdrawal state now exposes the user's profile country so the KYC UI opens on the correct country.

## Data-safety
This patch does not delete, reset, migrate, format, or replace existing user/wallet/Postgres data.

## Validation performed
- Node syntax checks passed for all modified JS modules.
- Fruit Wheel production test passed.
- Existing country KYC tests passed.
- New international phone + 249-country KYC registry checks passed.
