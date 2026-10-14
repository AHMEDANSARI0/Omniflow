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
