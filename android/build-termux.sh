#!/data/data/com.termux/files/usr/bin/bash
# Termux build wrapper for the PingPong Android app.
#
# Why this exists (2026-08-25 production readiness pass): AGP's default
# aapt2 (downloaded from Maven) is a Linux x86_64 ELF binary that cannot run
# under Termux (Android/aarch64/bionic). The fix is to point AGP at
# Termux's own native aapt2 instead — but that override must ONLY apply
# inside Termux, or it breaks every other build environment (GitHub
# Actions, a normal dev machine, etc.) that doesn't have that path. So the
# override is no longer hardcoded in gradle.properties; this script detects
# Termux at run time and passes it in for just this one environment.
#
# Usage (from android/):
#   chmod +x build-termux.sh
#   ./build-termux.sh clean assembleRelease
#   ./build-termux.sh assembleDebug

set -e

TERMUX_AAPT2="/data/data/com.termux/files/usr/bin/aapt2"
EXTRA_ARGS=()

if [ -f "$TERMUX_AAPT2" ]; then
  EXTRA_ARGS+=("-Pandroid.aapt2FromMavenOverride=$TERMUX_AAPT2")
  echo "[build-termux] Detected Termux — using native aapt2 at $TERMUX_AAPT2"
elif [ -n "$PREFIX" ] && [ -f "$PREFIX/bin/aapt2" ]; then
  EXTRA_ARGS+=("-Pandroid.aapt2FromMavenOverride=$PREFIX/bin/aapt2")
  echo "[build-termux] Detected Termux (custom prefix) — using native aapt2 at $PREFIX/bin/aapt2"
else
  echo "[build-termux] No Termux aapt2 found at $TERMUX_AAPT2 or \$PREFIX/bin/aapt2."
  echo "[build-termux] Falling back to AGP's default (Maven-downloaded) aapt2."
  echo "[build-termux] If this fails with a 'Syntax error: (' unexpected, install aapt2:"
  echo "[build-termux]   pkg install aapt2"
fi

chmod +x ./gradlew
./gradlew "${EXTRA_ARGS[@]}" "$@"
