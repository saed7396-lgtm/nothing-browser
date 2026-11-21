# nothing — Android GeckoView APK

Native Android browser powered by Mozilla GeckoView with one search bar and zero login, setup, settings, or tracking.

## Build an installable APK locally

Requires Android SDK (API 35) and JDK 17:

```bash
cd android
gradle assembleRelease
```

The installable universal APK is generated at:

`android/app/build/outputs/apk/release/nothing-universal-release.apk`

Install directly onto a connected Android device:

```bash
adb install android/app/build/outputs/apk/release/nothing-universal-release.apk
```

## Build via GitHub Actions

Push this repository to GitHub and run the **Build Android APK** workflow (`/.github/workflows/build-apk.yml`) to download the compiled `.apk` artifact.
