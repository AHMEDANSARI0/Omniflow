import { create } from "zustand";
import { z } from "zod";
import { api } from "@/api/client";
import { logger } from "@/lib/logger";

/**
 * Remote config + feature flags, served by the CP endpoint
 * /api/v1/mobile/config (CP-side gap #3). Until that endpoint ships the
 * fetch fails soft and the built-in defaults below apply, so the app never
 * blocks on remote config.
 */

export const mobileConfigSchema = z.object({
  min_version: z.string().optional(),
  recommended_version: z.string().optional(),
  maintenance: z.boolean().optional(),
  announcement: z.string().optional(),
  flags: z.record(z.string(), z.boolean()).optional(),
});
export type MobileConfig = z.infer<typeof mobileConfigSchema>;

interface AppState {
  config: MobileConfig;
  loaded: boolean;
  loadConfig: () => Promise<void>;
  flag: (name: string) => boolean;
}

const DEFAULT_CONFIG: MobileConfig = { flags: {} };

export const useAppStore = create<AppState>()((set, get) => ({
  config: DEFAULT_CONFIG,
  loaded: false,

  async loadConfig() {
    try {
      const data = await api.get<unknown>("/api/v1/mobile/config", {
        auth: false,
        timeoutMs: 8_000,
        retries: 0,
      });
      const parsed = mobileConfigSchema.safeParse(data ?? {});
      set({ config: parsed.success ? parsed.data : DEFAULT_CONFIG, loaded: true });
    } catch (err) {
      logger.warn("mobile config unavailable, using defaults", err);
      set({ config: DEFAULT_CONFIG, loaded: true });
    }
  },

  flag(name: string): boolean {
    return get().config.flags?.[name] === true;
  },
}));

/** Semantic version compare: -1 (a<b), 0, 1 (a>b). Non-numeric = 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return 0;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// §281 P6: version/maintenance gate (pure, unit-tested). The CP admin sets
// min_version and/or maintenance under /api/v1/mobile/config; this maps the
// fetched config plus the app's own version onto one of three UI states.
export type UpdateGate = "ok" | "maintenance" | "update_required";

export function updateGate(config: MobileConfig, currentVersion: string): UpdateGate {
  if (config.maintenance === true) return "maintenance";
  const min = typeof config.min_version === "string" ? config.min_version.trim() : "";
  if (min.length > 0 && compareVersions(currentVersion, min) < 0) return "update_required";
  return "ok";
}
