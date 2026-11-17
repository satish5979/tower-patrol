#!/usr/bin/env bash
# Builds the Android APK by wrapping the web app with Capacitor. Run from the repo root (used by .github/workflows/apk.yml).
set -euo pipefail
ROOT="$(pwd)"; B="$ROOT/android/build"; RUN="${GITHUB_RUN_NUMBER:-1}"
rm -rf "$B" && mkdir -p "$B/www" "$ROOT/android/out" && cd "$B"
cp -r "$ROOT"/index.html "$ROOT"/app.js "$ROOT"/style.css "$ROOT"/manifest.webmanifest "$ROOT"/lib "$ROOT"/icons www/
cp "$ROOT/android/capacitor.config.json" .
npm init -y >/dev/null
npm install --no-audit --no-fund @capacitor/core@7 @capacitor/cli@7 @capacitor/android@7 @capacitor/filesystem@7 @capacitor/share@7
npx cap add android
npx cap sync android

APP=android/app/src/main
sed -i 's#<uses-permission android:name="android.permission.INTERNET" />#&\n    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />\n    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />\n    <uses-permission android:name="android.permission.VIBRATE" />\n    <uses-permission android:name="android.permission.WAKE_LOCK" />\n    <uses-feature android:name="android.hardware.location.gps" android:required="false" />#' "$APP/AndroidManifest.xml"
grep -q ACCESS_FINE_LOCATION "$APP/AndroidManifest.xml"
cp "$ROOT/android/MainActivity.java" "$(find "$APP/java" -name MainActivity.java)"

rm -rf "$APP"/res/mipmap-anydpi-v26
for d in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  cp "$ROOT/android/icons/$d.png" "$APP/res/mipmap-$d/ic_launcher.png"
  cp "$ROOT/android/icons/$d.png" "$APP/res/mipmap-$d/ic_launcher_round.png"
  rm -f "$APP/res/mipmap-$d/ic_launcher_foreground.png"
done

sed -i "s/versionCode 1\b/versionCode $RUN/; s/versionName \"1.0\"/versionName \"1.$RUN\"/" android/app/build.gradle

mkdir -p ~/.android && cp "$ROOT/android/debug.keystore" ~/.android/debug.keystore   # same key every build, so updates install over the old app
cd android && chmod +x gradlew && ./gradlew --no-daemon assembleDebug
cp app/build/outputs/apk/debug/app-debug.apk "$ROOT/android/out/tower-patrol.apk"
ls -la "$ROOT/android/out"
