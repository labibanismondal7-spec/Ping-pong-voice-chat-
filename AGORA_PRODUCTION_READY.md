# PingPong — Agora Production Voice

This release switches **room voice transport** to Agora RTC when `VOICE_MODE=agora`.
The existing room/auth/seat/socket architecture remains the business authority; Agora is the media transport.

## Required Railway variables

```text
VOICE_MODE=agora
AGORA_APP_ID=<Agora App ID>
AGORA_APP_CERTIFICATE=<Agora App Certificate>
AGORA_TOKEN_TTL_SECONDS=3600
```

Never commit `AGORA_APP_CERTIFICATE` or a real token to source control.

## Runtime flow

```text
PingPong login/session
  -> authenticated /api/agora/token
  -> server verifies room membership
  -> server determines publisher/subscriber from seat state
  -> short-lived Agora RTC token
  -> Agora channel join
  -> seated user publishes microphone
  -> audience subscribes only
```

A room channel is derived from a SHA-256 hash of the PingPong room ID, so raw room IDs are not exposed as Agora channel names.

## Seat behavior

- Take seat: Agora client publishes microphone.
- Leave seat: microphone is unpublished but the client remains in the room as an audience listener.
- Seat move: same Agora channel/client is retained; no media teardown is required.
- Audience: no microphone is created or published.
- Token renewal: client renews before expiry and reacts to Agora expiry events.
- Connection failure: bounded automatic reconnect with exponential backoff.
- Room exit/logout: Agora client leaves and microphone resources are released.

## Security

The browser does not choose its Agora UID, publisher role, or certificate. The server derives UID from the authenticated PingPong user ID and verifies room membership. The certificate is never returned to the client.

## Verification

Run on the production server:

```bash
npm run preflight:agora
```

Then perform the real end-to-end smoke test with two Android devices:

1. Login as User A and User B.
2. Both enter the same room.
3. A takes a seat and speaks; B must hear A.
4. B takes a seat and speaks; A must hear B.
5. B leaves the seat; B must continue hearing A but must not publish audio.
6. B takes a different seat; voice must resume without a room rejoin.
7. Toggle mute/unmute on both users.
8. Lock/unlock the phone, background/foreground the app, and verify recovery.
9. Switch Wi-Fi/mobile data and verify recovery.
10. Leave/re-enter the room and verify a clean reconnect.

The ZIP is code-complete for the Agora integration, but a real Agora project and real-device network test are required before claiming a live deployment is operational; those external credentials and network conditions cannot be embedded in the archive.
