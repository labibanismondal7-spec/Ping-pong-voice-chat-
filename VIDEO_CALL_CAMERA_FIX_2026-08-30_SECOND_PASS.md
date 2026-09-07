# PingPong — Video Camera Fix — Second Pass — 2026-08-30

The first video patch was insufficient on Android WebView. The observed symptom was a small local camera rectangle that became visible but stayed completely black while the call itself remained connected.

## Additional root cause addressed

The MediaStream was being attached and `video.play()` was being attempted while the containing wrapper was still `display:none`. Android Chromium/WebView can resolve `play()` successfully in that state while the hardware video surface remains black after the wrapper becomes visible.

## Fix

`attachLiveVideo()` now:

1. Reveals the video wrapper before attaching/playing the MediaStream.
2. Waits for the next animation frame so the WebView compositor has a visible surface.
3. Attaches the stream and explicitly calls `play()`.
4. Logs `readyState`, `videoWidth`, `videoHeight`, and live-track state.
5. Waits for `loadedmetadata`, `canplay`, or `playing` and retries playback.
6. Applies the same path to private-call local/remote video and hosted/random-call local/remote video.

This specifically targets the exact symptom visible in the supplied screenshot: the video box is present but its frame is black.
