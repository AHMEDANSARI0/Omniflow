"use server";

import { cookies } from "next/headers";
import { ADMIN_SESSION_COOKIE } from "@/lib/supabase/server";
import {
  changePassword,
  createSession,
  getUserBySession,
  revokeSession,
  verifyLogin,
} from "@/lib/db/auth";

/**
 * §276 — Website admin auth as SERVER ACTIONS (replaces the browser Supabase
 * client). The browser never touches the database: it calls these actions,
 * which verify credentials against Neon `admin_users` and keep an opaque,
 * httpOnly session cookie (`of_admin_session`) whose hash lives in
 * `admin_sessions`. Sign-in/out/password all run here.
 */

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days (matches token TTL)

export type AdminAuthResult = { success: boolean; message: string };

async function setSessionCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/** Verify email+password against Neon and start a session cookie. */
export async function adminSignIn(
  email: string,
  password: string
): Promise<AdminAuthResult> {
  const cleanEmail = String(email ?? "").trim().toLowerCase();
  if (!cleanEmail || !password) {
    return { success: false, message: "Email and password are required." };
  }

  const user = await verifyLogin(cleanEmail, password);
  if (!user) {
    return { success: false, message: "Invalid email or password." };
  }

  const session = await createSession(user.id);
  if (!session) {
    return { success: false, message: "Could not start a session. Try again." };
  }
  await setSessionCookie(session.token);
  return { success: true, message: "Signed in." };
}

/** Revoke the current session (if any) and clear the cookie. */
export async function adminSignOut(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_SESSION_COOKIE)?.value ?? null;
  if (token) {
    await revokeSession(token);
  }
  cookieStore.delete(ADMIN_SESSION_COOKIE);
}

/**
 * Change the signed-in admin's password. `changePassword` revokes every
 * existing session, so we immediately mint a fresh one and reset the cookie —
 * the admin stays signed in (same UX as before). Reusing the current password
 * is rejected, detected via a verifyLogin round-trip (no new DB surface).
 */
export async function adminChangePassword(
  newPassword: string
): Promise<AdminAuthResult> {
  if (!newPassword || newPassword.length < 8) {
    return {
      success: false,
      message: "Password must be at least 8 characters.",
    };
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_SESSION_COOKIE)?.value ?? null;
  const user = await getUserBySession(token);
  if (!user) {
    return {
      success: false,
      message: "You are signed out. Please sign in again.",
    };
  }

  // If the new password already authenticates, it equals the current one.
  const unchanged = await verifyLogin(user.email, newPassword);
  if (unchanged) {
    return {
      success: false,
      message: "New password must be different from the current one.",
    };
  }

  const ok = await changePassword(user.id, newPassword);
  if (!ok) {
    return { success: false, message: "Failed to update password. Try again." };
  }

  const session = await createSession(user.id);
  if (session) {
    await setSessionCookie(session.token);
  }
  return { success: true, message: "Password updated successfully." };
}
