/**
 * Fail-soft logger. In dev everything is visible; in production only
 * warnings/errors survive, and no call may ever throw into the caller.
 */

const isDev =
  typeof __DEV__ === "boolean" ? __DEV__ : process.env.NODE_ENV !== "production";

function safe(level: "log" | "warn" | "error", args: unknown[]): void {
  try {
    if (!isDev && level === "log") return;
    // eslint-disable-next-line no-console
    console[level]("[omniflow]", ...args);
  } catch {
    // logging must never crash the app
  }
}

export const logger = {
  log: (...args: unknown[]) => safe("log", args),
  warn: (...args: unknown[]) => safe("warn", args),
  error: (...args: unknown[]) => safe("error", args),
};
