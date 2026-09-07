# PingPong Android release build

This package is prepared to produce both a signed APK and an Android App Bundle (AAB).

- Configure server/API keys in `.env` or your production host secret manager.
- Set `WEB_APP_URL` to the production HTTPS URL in `android/local.properties` or as a Gradle property.
- For the existing Play Store app, provide the original upload keystore through `PINGPONG_KEYSTORE_FILE`, `PINGPONG_KEYSTORE_PASSWORD`, `PINGPONG_KEY_ALIAS`, and `PINGPONG_KEY_PASSWORD`.
- Build with `cd android && ./gradlew assembleRelease bundleRelease`.

Outputs:
- APK: `android/app/build/outputs/apk/release/app-release.apk`
- AAB: `android/app/build/outputs/bundle/release/app-release.aab`

The supplied app icon is installed as both launcher and round launcher artwork. The Lucky Fruit symbols are enlarged to 52px and tile minimum height increased for visual balance. Agora/SFU audience playback recovery is hardened so seat transitions keep listeners subscribed.
