import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * One codebase, two apps. The build-time env var OMNIFLOW_APP_VARIANT
 * selects the Client app (default) or the Admin app: name, ids, deep-link
 * scheme and icon set. Nothing else forks - all features live in src/.
 */
const variant: "client" | "admin" =
  process.env.OMNIFLOW_APP_VARIANT === "admin" ? "admin" : "client";

const isClient = variant === "client";

export default ({ config }: ConfigContext): ExpoConfig => ({
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
    appVariant: variant,
    // §282: default is the live Control Plane (the old omniflow-backend
    // host was stale). eas.json profiles and `set OMNIFLOW_API_URL=...`
    // still override this at build time.
    apiUrl:
      process.env.OMNIFLOW_API_URL ||
      "https://omniflow-control-plane-rho.vercel.app",
  },
});
