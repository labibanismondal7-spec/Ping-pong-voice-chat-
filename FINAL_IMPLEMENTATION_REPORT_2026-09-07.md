# PingPong Production Integration – 2026-09-07

Implemented in this package:

1. Android launcher and round launcher icons replaced with the supplied Ping Pong artwork in all standard density buckets. Android 8+ adaptive launcher resources also point to the supplied artwork.
2. Android version advanced to versionCode 5 / versionName 1.4.0.
3. Lucky Fruit's eight fruit symbols increased from 42px to 52px, with taller tiles for visual balance.
4. Agora room voice recovery strengthened: audio subscriptions are replayed after reconnection, remote audio is explicitly replayed after subscribe, and a user who leaves a seat releases the microphone while remaining connected as an audience listener.
5. LiveKit/SFU room capacity changed from an 8-participant ceiling to a configurable default of 64. This preserves the 8-seat publisher model while allowing audience listeners below the seats to subscribe at the same time. `LIVEKIT_MAX_PARTICIPANTS` can be configured from 8 to 500.
6. API credentials remain server-side and environment driven; `.env.example` documents the relevant LiveKit/Agora/AI/TURN configuration.
7. Added `build-android-release.sh` to produce both APK and AAB when a Gradle/Android build environment is available.

Validation completed in the current environment:
- `node --check public/voice-agora.js`
- `node --check public/app.js`
- `node --check voice_sfu/livekit.js`
- Launcher image generated successfully at all target densities.

The Android Gradle build was attempted, but this execution environment cannot resolve `services.gradle.org`, so Gradle 8.11.1 could not be downloaded. No APK/AAB is claimed as built in this environment. The included build script/Gradle project is prepared to generate both in an Android build environment with dependency access and the correct release signing key.
