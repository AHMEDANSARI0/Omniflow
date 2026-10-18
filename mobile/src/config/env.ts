import Constants from "expo-constants";

/**
 * Runtime environment. Everything mobile needs to reach the existing
 * Control Plane - no second backend, ever. Values come from the build-time
 * `extra` block in app.config.ts and can be overridden with OMNIFLOW_*.
 */

const extra = (Constants.expoConfig?.extra ?? {}) as {
  appVariant?: "client" | "admin";
  apiUrl?: string;
};

export type AppVariant = "client" | "admin";

export const appVariant: AppVariant =
  extra.appVariant === "admin" ? "admin" : "client";

// §282: fallback = the live Control Plane (old omniflow-backend host was
// stale). Builds bake extra.apiUrl from app.config.ts / eas.json env, so
// this only matters when expoConfig is unavailable (tests, bare runs).
export const apiUrl: string = (extra.apiUrl ?? "")
  .replace(/\/+$/, "") || "https://omniflow-control-plane-rho.vercel.app";

/** Sent on every request so the CP can gate/telemetry mobile versions. */
export const appVersion: string = Constants.expoConfig?.version ?? "0.0.0";

export const isClientApp = appVariant === "client";
export const isAdminApp = appVariant === "admin";
