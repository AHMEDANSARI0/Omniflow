/**
 * One codebase, two apps. The build-time env var OMNIFLOW_APP_VARIANT
 * selects the Client app (default) or the Admin app: name, ids, deep-link
 * scheme and icon set. Nothing else forks - all features live in src/.
 *
 * §282b: plain JavaScript ON PURPOSE. The previous app.config.ts broke
 * eas-cli's config reader on Windows ("Unexpected token '{'" - the reader
 * evaluated the TS file as plain JS and choked on `import type {`). A .js
 * config parses identically on every Node / eas-cli / expo version, so
 * builds and linking never touch TS transpilation again.
 */
const variant =
  process.env.OMNIFLOW_APP_VARIANT === "admin" ? "admin" : "client";
const isClient = variant === "client";

/**
 * §282b: the client app's EAS project, created on the owner's Expo account
 * (slug "omniflow"). Pre-linked here so `eas build` skips the interactive
 * "EAS project not configured" step entirely. The ADMIN app (slug
 * "omniflow-admin") links its own project on its first `eas build` - paste
 * its id below the same way afterwards. Switching Expo accounts? Replace
 * this id (or delete the line and let eas-cli re-link).
 */
const EAS_PROJECT_ID_CLIENT = "ca30d461-910e-4661-bfb9-a7da7044ed5c";

module.exports = ({ config }) => ({
  ...config,
  name: isClient ? "OmniFlow" : "OmniFlow Admin",
  slug: isClient ? "omniflow" : "omniflow-admin",
  scheme: isClient ? "omniflow" : "omniflow-admin",
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  backgroundColor: isClient ? "#0b1220" : "#0d1424",
  icon: "./assets/icon.png",
  ios: {
    bundleIdentifier: isClient ? "com.omniflow.app" : "com.omniflow.admin",
    supportsTablet: false,
  },
  android: {
    package: isClient ? "com.omniflow.app" : "com.omniflow.admin",
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: isClient ? "#0b1220" : "#0d1424",
    },
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    [
      "expo-splash-screen",
      {
        image: "./assets/splash.png",
        resizeMode: "contain",
        backgroundColor: isClient ? "#0b1220" : "#0d1424",
        imageWidth: 220,
      },
    ],
  ],
  updates: {
    // Set OMNIFLOW_EAS_UPDATE_URL (EAS free tier) to enable OTA updates:
    // push to the repos -> CI `eas update` -> installed apps refresh
    // themselves on next launch. Absent URL = updates disabled, fail-soft.
    ...(process.env.OMNIFLOW_EAS_UPDATE_URL
      ? { url: process.env.OMNIFLOW_EAS_UPDATE_URL }
      : {}),
  },
  extra: {
    // §282b: pre-linked EAS project (client variant only).
    ...(isClient ? { eas: { projectId: EAS_PROJECT_ID_CLIENT } } : {}),
    appVariant: variant,
    // §282: default is the live Control Plane (the old omniflow-backend
    // host was stale). eas.json profiles and OMNIFLOW_API_URL still
    // override this at build time.
    apiUrl:
      process.env.OMNIFLOW_API_URL ||
      "https://omniflow-control-plane-rho.vercel.app",
  },
});
