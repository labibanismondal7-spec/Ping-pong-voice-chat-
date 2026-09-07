# PingPong Play Store release gate

Before production upload:

1. Set `NODE_ENV=production`.
2. Set `VOICE_MODE=sfu` and configure `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`. The server intentionally fails fast if SFU mode is selected without LiveKit credentials.
3. Configure production TURN (or the LiveKit provider's production TURN) and verify Wi-Fi↔mobile handoff.
4. Set `SMS_GATEWAY_MODE=http` and configure the Railway SMS gateway URL/token.
5. Configure `DATABASE_URL`/Redis for the intended multi-instance deployment. JSON storage remains a local fallback, not the preferred multi-instance production datastore.
6. Build the signed AAB using the real Play upload key; the repository fallback keystore is local-test-only.
7. Complete Play Console declarations for microphone foreground service, Data Safety, privacy policy, account deletion, and UGC moderation.
8. Run the final device matrix: Android 15/16, Wi-Fi/4G/5G, screen lock/unlock, Bluetooth headset, background/foreground, and two-device voice rooms.
