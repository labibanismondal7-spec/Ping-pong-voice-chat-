#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/android"
chmod +x ./gradlew
./gradlew --no-daemon clean assembleRelease bundleRelease
printf '\nRelease outputs:\n  %s\n  %s\n' \
  "$(pwd)/app/build/outputs/apk/release/app-release.apk" \
  "$(pwd)/app/build/outputs/bundle/release/app-release.aab"
