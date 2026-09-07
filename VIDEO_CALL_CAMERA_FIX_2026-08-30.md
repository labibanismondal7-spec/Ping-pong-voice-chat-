# PingPong — Video Call Camera Fix — 2026-08-30

## Scope

Fixed the WebRTC video path used by both:

- Private video calls (`call:*`)
- Random video calls / Call Hosting (`hostcall:*` + `random-call:*`)
- Android WebView camera/microphone permission handling

## Root causes found in the supplied project

1. **Local camera rendering was too optimistic.** The code assigned `srcObject` and called `play()` once, then ignored a failed/deferred play on Android WebView. A live MediaStream could therefore remain on a black first frame.
2. **The remote video layer was revealed for an audio track.** `ontrack` made the full-screen remote-video wrapper visible for every received track. On mobile, audio can arrive before video, so a black video surface could cover the call UI while video was still being negotiated.
3. **`RTCTrackEvent.streams[0]` was assumed to exist.** The new code creates a MediaStream from the received track when `streams[]` is empty.
4. **Caller ICE candidates could be emitted before `callId` existed.** Early candidates were sent with `callId: null` and discarded by the server. They are now queued and flushed as soon as the server assigns the real call ID.
5. **Camera constraints were unnecessarily strict for some Android camera implementations.** Video capture now uses `ideal` facing mode/resolution/frame-rate constraints and falls back to `{audio:true, video:true}` if the preferred constraints are rejected.
6. **Android WebView permission handling was tightened.** Only the supported `AUDIO_CAPTURE` and `VIDEO_CAPTURE` resources are granted, and the WebView is kept on the hardware compositor.

## Rendering behavior after the fix

- Local video is attached with `playsinline`, `autoplay`, `muted`, and an explicit play/retry sequence.
- Remote video is attached unmuted and the full-screen video layer is revealed **only after a video track is received and playback succeeds**.
- Audio arriving first no longer paints a black video layer over the call.
- Empty `RTCTrackEvent.streams[]` is handled safely.
- Camera switch and unexpected camera-track recovery use the same hardened rendering path.

## Verification performed

- `node --check public/app.js` — passed.
- `node test/randomCall.test.js` — **all smoke tests passed**.
- `node test/callSignaling.test.js` — **13 passed, 0 failed**.

An Android Gradle build was attempted, but this execution environment could not download the configured Gradle 8.11.1 distribution because outbound network/DNS access was unavailable. The source changes are included in the Android project; build locally in Termux/Android Studio using the project's normal Gradle wrapper.

## Expected result

After rebuilding/reinstalling the Android APK and granting Camera + Microphone permissions, private and random video calls should show:

- your live front-camera preview,
- the other participant's live camera feed,
- two-way audio,
- camera on/off and camera switching without returning to a permanent black surface.
