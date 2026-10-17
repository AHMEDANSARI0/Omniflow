/**
 * Client-auth endpoints of the existing Control Plane, reused as-is by the
 * mobile Client app (the web portal uses the same routes via
 * lib/omniflow/control-plane.ts). Admin auth is the CP's Neon-backed
 * mobile-admin login and lives in src/api/admin.ts (§275).
 */

import { z } from "zod";
import { api } from "@/api/client";

export const loginInputSchema = z.object({
  email: z.string().trim().min(3, "Enter your email").email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

export const tokenPairSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive().optional(),
});
export type TokenPair = z.infer<typeof tokenPairSchema>;

export const sessionUserSchema = z.object({
  // §277b fail-soft: the live CP /me payload can omit `id` entirely - a
  // missing id must never break session hydrate (ZodError loop on login).
  id: z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v) => v ?? "")
    .catch(""),
  email: z.string().optional(),
  name: z.string().optional(),
  role: z.string().optional(),
  business_name: z.string().optional(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export async function login(input: LoginInput): Promise<TokenPair> {
  const data = await api.post<unknown>("/api/v1/auth/login", input, {
    auth: false,
  });
  return tokenPairSchema.parse(data);
}

export async function refresh(refreshToken: string): Promise<TokenPair> {
  const data = await api.post<unknown>(
    "/api/v1/auth/refresh",
    { refresh_token: refreshToken },
    { auth: false, retries: 1 },
  );
  return tokenPairSchema.parse(data);
}

export async function fetchSession(): Promise<SessionUser> {
  const data = await api.get<unknown>("/api/v1/auth/me");
  const obj = (data ?? {}) as Record<string, unknown>;
  const candidate =
    obj && typeof obj.user === "object" && obj.user !== null
      ? (obj.user as Record<string, unknown>)
      : obj;
  // §277b: CP portal sessions expose display_name / business rather than
  // name / business_name - map them so the UI shows a friendly greeting.
  const mapped: Record<string, unknown> = { ...candidate };
  if (mapped.name == null && typeof mapped.display_name === "string") {
    mapped.name = mapped.display_name;
  }
  if (mapped.business_name == null && typeof mapped.business === "string") {
    mapped.business_name = mapped.business;
  }
  return sessionUserSchema.parse(mapped);
}

export async function logoutCall(): Promise<void> {
  try {
    await api.post<void>("/api/v1/auth/logout", undefined, { retries: 0 });
  } catch {
    // fail-soft: local sign-out always succeeds
  }
}

export async function forgotPassword(email: string): Promise<void> {
  await api.post<void>("/api/v1/auth/forgot-password", { email }, { auth: false });
}
