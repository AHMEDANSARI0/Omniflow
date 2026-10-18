# §282: APK drop folder

Copy the built Android APKs here, then commit + push - Vercel serves them as
static files:

- `OmniFlow-client.apk` -> https://<website>/downloads/OmniFlow-client.apk
  (the public /download page links this file; the button appears
  automatically at the next deploy once the file exists here)
- `OmniFlow-admin.apk` -> admin build, share the link privately with your
  team only - the public site never links it.

Build steps + publishing flow: see `docs/MOBILE_APP_GUIDE.md`
(one-time free Expo/EAS account, `npm run build:client:apk`, copy the APK
here, push).

Keep this README in git so the folder survives; APK files themselves are
committed only when a release is published.
