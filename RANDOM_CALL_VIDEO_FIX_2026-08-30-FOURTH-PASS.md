# PingPong Random Call — Fourth Pass — 2026-08-30

This pass looked at the actual reported symptoms (timer stuck at 00:00,
no audio, black camera on both sides, mute button doing nothing) against
the **Random Call / Call Hosting (`hostcall:*`/`random-call:*`)** path
specifically, since that's what the screenshots show (100 Diamonds/minute
billing UI, mic+hangup-only control bar). Three prior passes already
hardened video *rendering* (wrapper-reveal timing, unmute waits, black
first-frame retries) for this exact code path and the symptom persisted —
so this pass looked past rendering, at signaling and connection state.

## Root causes found and fixed in code

### 1. Timer was never a real timer (confirmed root cause of "টাইমার চালু হচ্ছে না")
`hostcall:tick` — the only thing that ever touched the on-screen clock —
is emitted by `callHosting.js`'s `billOneMinute()` **once every 60
seconds** (`BILL_INTERVAL_MS`), because billing happens one full minute
at a time. There was no independent per-second clock on the client, so
the screen showed "00:00" (the immediate first tick, prepaid at connect)
and then didn't move again for up to a full minute — exactly the "stuck
at zero, no counting" behavior in the screenshots.
**Fix:** `public/app.js` now runs its own 1-second `setInterval` timer
(`chStartLocalTimer`) starting the moment the call connects, and silently
resyncs itself against the server's authoritative `elapsedSec` on every
60-second tick so display time and billed time can never drift apart.

### 2. Host never told when a random-call ring timed out
In `callHosting.js`, when a ring timed out only the **caller** got
`hostcall:ended`; the host whose phone was still showing "Incoming video
call..." was never notified. For Random Call specifically this could
leave a host's incoming-call overlay stuck open and, until they backed
out manually, kept them marked busy — shrinking the eligible pool for
every later random-call attempt. **Fixed** — both sides are now notified,
matching how decline/host-offline were already handled.

### 3. No ICE-failure detection on the hostcall/random-call path (likely root cause of the black screen + silence)
The private call system (`call:*`) already has connection diagnostics
and an ICE-restart-then-give-up recovery path
(`startConnectionDiagnostics`, `pc.oniceconnectionstatechange`). The
hostcall/random-call peer connection (`chCreatePeerConnection`) never had
either — it only wired `onicecandidate`/`ontrack`. The UI marks the call
"Connected" the instant *signaling* completes (`hostcall:accepted`),
which is before WebRTC media has actually connected. If the underlying
ICE connection then fails or never completes — very plausible on mobile
data with no TURN relay, see below — the call sits there showing a live,
billed, "Connected" call with a permanently black screen and no audio in
either direction, with nothing to retry and nothing telling the user why.
That matches every symptom reported. **Fixed** — `chCreatePeerConnection`
now runs the same diagnostics/ICE-restart/recovery logic the private call
system has, and the on-screen timer now pauses during ICE
renegotiation/failure instead of implying the call is fine.

## Real infrastructure gap found — not a code bug, needs a config change

Running this project's own test suite prints, on every run:
```
[turn-config] TURN missing — STUN-only fallback active
```
`turn-config.js` already fully supports a TURN relay (`TURN_URL` +
`TURN_USERNAME`/`TURN_CREDENTIAL`, or Cloudflare's managed TURN via
`CLOUDFLARE_TURN_KEY_ID`/`CLOUDFLARE_TURN_API_TOKEN`) — it's just not
configured in this deployment's environment variables. **STUN-only ICE
frequently cannot establish a peer-to-peer path between two phones on
carrier mobile data** (the "4G"/"VoLTE" indicators in the screenshots are
consistent with this) — this is one of the most common causes of exactly
"connected but black screen, no audio" on real phones, as opposed to two
browser tabs on the same Wi-Fi where STUN-only usually happens to work.
This is very likely contributing to, maybe entirely explaining, the
black-screen/no-audio symptom on top of fix #3 above.

**Action needed (outside this codebase):** set `TURN_URL` +
`TURN_USERNAME` + `TURN_CREDENTIAL` in Railway's environment variables
(or `CLOUDFLARE_TURN_KEY_ID` + `CLOUDFLARE_TURN_API_TOKEN` for
Cloudflare's free managed TURN — this project already has direct support
for it, see `turn-config.js`). No code change can substitute for an
actual TURN relay existing.

## On the mute button
`btn-hostcall-mute`'s click handler (toggling
`audioTrack.enabled`) is correct and identical in shape to the private
call system's working mute button — no bug found there. If it visibly
"does nothing," the most likely explanation is the same one as the black
screen: there's no live audio track to mute in the first place because
media never connected. Fix #3 (visible "Reconnecting..."/failure state
instead of a silent fake "Connected") should make this failure mode
obvious instead of looking like a broken mute button; the TURN fix above
is what actually restores the audio track.

## Files changed
- `callHosting.js` — host-side ring-timeout notification (fix #2)
- `public/app.js` — real per-second timer (fix #1), ICE diagnostics +
  recovery for hostcall/random-call (fix #3)

## Verification performed
- `node --check public/app.js` / `callHosting.js` / `randomCall.js` — PASS
- `node test/randomCall.test.js` — all 6 smoke tests PASS
- `node test/run-all.js` — **38/39 suites pass**, same single pre-existing
  unrelated failure as before (`test/agoraToken.test.js` — its own mock
  `app` object is missing `.get()`; untouched by this change)

### Not verified in this environment (no network / no device access)
- Real on-device camera/mic + TURN relay behavior on Android/mobile data
- Whether setting TURN env vars resolves the black-screen/silence
  symptom in practice — very likely, but only a real device test on
  mobile data (not Wi-Fi) after the env change can confirm it


## Final production hardening — 2026-09-06

This release adds another reliability layer to the same Random Call / Call Hosting WebRTC path:
- remote ICE candidates are queued until a remote SDP description exists, preventing early ICE packets from being silently discarded;
- host-call ICE configuration is refreshed every 10 minutes on the client so short-lived TURN credentials are not held for hours;
- a 20-second media-connection watchdog detects a call stuck in ICE `checking` instead of leaving a fake connected/black-screen call indefinitely; one caller-side ICE restart is attempted before the call is ended;
- seat moves resolve the existing seat record by userId as a fallback, preventing stale `seat-update` ordering from temporarily losing the user's name/effect;
- Active Agency artwork is no longer rendered beneath room seats; seats show the user's name only;
- normal room-seat names are clean white and slightly larger; Admin-granted `premium_gradient` remains text-only and is now a fast, deep blue/cyan/violet animation;
- the supplied Agency/Seller artwork and Official artwork replace the previous assets, with the black backgrounds removed to transparent PNGs.

Targeted verification after this pass:
- `node --check public/app.js` — PASS
- `node --check server.js` — PASS
- `node --check badges.js` — PASS
- `node --check randomCall.js` — PASS
- `node test/randomCall.test.js` — ALL SMOKE TESTS PASSED

External requirement unchanged: a real TURN relay credential must still be configured in the production environment for reliable carrier-mobile NAT traversal. The project already supports static/dynamic TURN and Cloudflare TURN; secrets are not embedded in this release.
