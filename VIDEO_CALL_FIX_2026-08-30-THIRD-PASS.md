# PingPong Video Call Fix — 2026-08-30 Third Pass

## Root cause addressed
Private video-call accept was acknowledging `call:accept` before the callee had finished opening the camera/microphone and creating its RTCPeerConnection. That allowed the caller to immediately create/send the SDP offer while the callee was still starting media on Android WebView.

## Changes
- Private-call callee now acquires local media and creates the PeerConnection before emitting `call:accept`.
- Local/remote video attachment is hardened for Android WebView: visible wrapper before playback, explicit inline/autoplay/muted properties, plain rectangular video surface, and a short first-frame/unmute retry.
- Private-call server now buffers early ICE candidates generated before the winning callee socket is registered and flushes them after accept.
- Existing audio/private-call, host-call, and random-call architecture is preserved.

## Validation
- `node --check public/app.js` — PASS
- `node --check callSignaling.js` — PASS
