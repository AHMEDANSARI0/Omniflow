/**
 * §275 Admin-app API. Everything routes through the Control Plane's
 * mobile-admin endpoints (CP portal_mobile_admin.py): admin credentials are
 * exchanged server-side against the CP's single Neon database (table
 * mobile_admins), so no database secret ever ships inside the app binary.
 * There is no second database or auth provider in the Control Plane or the
 * mobile app.
 */

import { z } from "zod";
import { api } from "@/api/client";

export const adminLoginInputSchema = z.object({
  email: z.string().trim().min(3, "Enter your email").email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});
export type AdminLoginInput = z.infer<typeof adminLoginInputSchema>;

export const adminTokenPairSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive().optional(),
  user: z
    .object({
      id: z.union([z.string(), z.number()]).optional(),
      email: z.string().optional(),
      name: z.string().nullable().optional(),
      role: z.string().optional(),
    })
    .optional(),
});
export type AdminTokenPair = z.infer<typeof adminTokenPairSchema>;

export const adminOverviewSchema = z.object({
  platform_users: z.number().int().nullable().optional(),
  database: z.boolean().optional(),
  mobile_admin: z.boolean().optional(),
});
export type AdminOverview = z.infer<typeof adminOverviewSchema>;

export const adminUserSchema = z.object({
  id: z.union([z.string(), z.number()]),
  email: z.string().optional(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

export const adminUsersSchema = z.object({
  users: z.array(adminUserSchema),
  count: z.number().int(),
});
export type AdminUsers = z.infer<typeof adminUsersSchema>;

export async function adminLogin(input: AdminLoginInput): Promise<AdminTokenPair> {
  const data = await api.post<unknown>("/api/v1/mobile/admin/login", input, {
    auth: false,
  });
  return adminTokenPairSchema.parse(data);
}

export async function adminRefresh(refreshToken: string): Promise<AdminTokenPair> {
  const data = await api.post<unknown>(
    "/api/v1/mobile/admin/refresh",
    { refresh_token: refreshToken },
    { auth: false, retries: 1 },
  );
  return adminTokenPairSchema.parse(data);
}

export async function fetchAdminSession(): Promise<NonNullable<AdminTokenPair["user"]>> {
  const data = await api.get<{ user?: unknown }>("/api/v1/mobile/admin/me");
  const user = (data?.user ?? {}) as Record<string, unknown>;
  return z
    .object({
      id: z.union([z.string(), z.number()]).optional(),
      email: z.string().optional(),
      name: z.string().nullable().optional(),
      role: z.string().optional(),
    })
    .parse(user);
}

export async function fetchAdminOverview(): Promise<AdminOverview> {
  const data = await api.get<unknown>("/api/v1/mobile/admin/overview");
  return adminOverviewSchema.parse(data ?? {});
}

/** Revoke the current admin session on the CP (fail-soft). */
export async function adminLogout(): Promise<void> {
  try {
    await api.post<void>("/api/v1/mobile/admin/logout", undefined, { retries: 0 });
  } catch {
    // local sign-out always succeeds even if the server call fails
  }
}

export async function fetchAdminUsers(): Promise<AdminUsers> {
  const data = await api.get<unknown>("/api/v1/mobile/admin/users");
  return adminUsersSchema.parse(data ?? { users: [], count: 0 });
}

// ---------------------------------------------------------------------------
// §280 P5: platform quality + website analytics for the Admin app. Both are
// session-guarded CP routes (portal_mobile_admin.py) that reuse the exact
// sources the web admin uses - no service key ever ships in the app.
// ---------------------------------------------------------------------------

const numOr0 = z
  .number()
  .nullish()
  .transform((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0))
  .catch(0);

export const adminQualityEnvelopeSchema = z.object({
  days: z.number().catch(7),
  degraded: z.boolean().catch(false),
  overview: z
    .record(z.string(), z.unknown())
    .nullish()
    .transform((v) => v ?? null)
    .catch(null),
});
export type AdminQualityEnvelope = z.infer<typeof adminQualityEnvelopeSchema>;

export const siteStatsSchema = z.object({
  days: numOr0,
  timezone: z.string().catch(""),
  totals: z
    .object({
      views: numOr0,
      visitors: numOr0,
      cta_clicks: numOr0,
      cta_visitors: numOr0,
      form_submits: numOr0,
      form_visitors: numOr0,
      avg_seconds: numOr0,
    })
    .catch({
      views: 0,
      visitors: 0,
      cta_clicks: 0,
      cta_visitors: 0,
      form_submits: 0,
      form_visitors: 0,
      avg_seconds: 0,
    }),
  daily: z
    .array(z.object({ day: z.string().catch(""), views: numOr0, visitors: numOr0 }))
    .catch([]),
  countries: z
    .array(z.object({ country: z.string().catch(""), visitors: numOr0 }))
    .catch([]),
  browsers: z
    .array(z.object({ browser: z.string().catch(""), visitors: numOr0 }))
    .catch([]),
});
export type SiteStats = z.infer<typeof siteStatsSchema>;

export const adminSiteStatsEnvelopeSchema = z.object({
  days: z.number().catch(7),
  degraded: z.boolean().catch(false),
  stats: siteStatsSchema.nullish().transform((v) => v ?? null).catch(null),
});
export type AdminSiteStatsEnvelope = z.infer<typeof adminSiteStatsEnvelopeSchema>;

function safeDays(days: number): number {
  return [1, 7, 14, 30].includes(days) ? days : 7;
}

export async function fetchAdminQuality(
  days = 7,
): Promise<AdminQualityEnvelope> {
  const data = await api.get<unknown>(
    `/api/v1/mobile/admin/quality?days=${safeDays(days)}`,
  );
  return adminQualityEnvelopeSchema.parse(data ?? {});
}

export async function fetchAdminSiteStats(
  days = 7,
): Promise<AdminSiteStatsEnvelope> {
  const data = await api.get<unknown>(
    `/api/v1/mobile/admin/site-stats?days=${safeDays(days)}`,
  );
  return adminSiteStatsEnvelopeSchema.parse(data ?? {});
}
