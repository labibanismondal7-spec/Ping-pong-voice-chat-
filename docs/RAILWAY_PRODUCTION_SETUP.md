# Railway production setup

Set these Railway variables before deploying:

- `NODE_ENV=production`
- `VOICE_MODE=sfu`
- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `TURN_*` or the relay settings required by the selected LiveKit deployment
- `DATABASE_URL`
- `REDIS_URL`
- `SMS_GATEWAY_MODE=http`
- `SMS_GATEWAY_URL`
- `SMS_GATEWAY_TOKEN`
- `OTP_TEST_MODE=false`

The application accepts the SMS gateway as a provider-neutral HTTP service. The gateway endpoint receives a POST JSON body containing `to`, `message`, and `channel`. Return HTTP 2xx with `{ "success": true }` only when the upstream SMS provider accepted the message.

For SFU, this application intentionally fails fast in production when `VOICE_MODE=sfu` is selected but LiveKit credentials are missing. This prevents an accidental silent fallback to mesh.
