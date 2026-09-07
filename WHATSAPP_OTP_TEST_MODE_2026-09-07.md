# WhatsApp OTP Test Mode — 2026-09-07

- Added `OTP_TEST_MODE` to the self-hosted OTP endpoint.
- In test mode, the server generates the real OTP as usual but does not call the SMS gateway.
- The server returns a `wa.me` link for the configured test WhatsApp recipient.
- The web client opens WhatsApp with the OTP message prefilled.
- The final **Send** tap remains manual because WhatsApp Business App does not provide an official server-side auto-send API.
- Verification still happens through `/api/auth/verify-otp` against the originally requested mobile number.
- Production example keeps `OTP_TEST_MODE=false`.
