import { createHash, randomBytes, scrypt, timingSafeEqual } from "crypto";
import { neonEnabled, neonQuery } from "./neon";

/**
 * §276 — Neon-backed website admin auth (replaces Supabase Auth).
 *
 * Pure server logic (no Next.js imports) so it is unit-testable against a real
 * Postgres. Passwords use scrypt (built into Node, no native deps); sessions
 * are opaque random tokens stored sha256-hashed in `admin_sessions`. The thin
 * cookie wrapper (reading/setting the httpOnly session cookie) lives in
 * lib/supabase/server.ts + the admin server actions.
 *
 * The session cookie value is the opaque token; only its hash is stored, so a
 * DB leak cannot replay a session.
 */

const SESSION_TTL_DAYS = Number(process.env.OF_WEB_SESSION_TTL_DAYS || 30);
const SCRYPT_KEYLEN = 64;

export interface AdminUser {
  id: string;
  email: string;
  role: string;
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt) — format: scrypt$<saltHex>$<derivedHex>
// ---------------------------------------------------------------------------
export function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16).toString("hex");
    scrypt(password.normalize("NFKC"), salt, SCRYPT_KEYLEN, (err, derived) => {
      if (err) return reject(err);
      resolve(`scrypt$${salt}$${derived.toString("hex")}`);
    });
  });
}

export function verifyPassword(password: string, stored: string): Promise<boolean> {
  return new Promise((resolve) => {
    const parts = (stored || "").split("$");
    if (parts.length !== 3 || parts[0] !== "scrypt") return resolve(false);
    const [, salt, hashHex] = parts;
    scrypt(password.normalize("NFKC"), salt, SCRYPT_KEYLEN, (err, derived) => {
      if (err) return resolve(false);
      try {
        const a = derived;
        const b = Buffer.from(hashHex, "hex");
        resolve(a.length === b.length && timingSafeEqual(a, b));
      } catch {
        resolve(false);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------
function newToken(): string {
  return randomBytes(32).toString("base64url");
}
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const normEmail = (e: string) => (e || "").trim().toLowerCase();

// ---------------------------------------------------------------------------
// Admin users
// ---------------------------------------------------------------------------
/** Create or update (by email) an admin user. Returns the user row. */
export async function upsertAdminUser(
  email: string,
  password: string,
  role = "admin"
): Promise<AdminUser | null> {
  if (!neonEnabled()) return null;
  if (!email || password.length < 8) {
    throw new Error("email and a password of 8+ characters are required");
  }
  const ph = await hashPassword(password);
  const res = await neonQuery(
    `INSERT INTO admin_users (email, password_hash, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE
        SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role
     RETURNING id, email, role`,
    [normEmail(email), ph, role]
  );
  const row = res.rows[0];
  return row ? { id: row.id, email: row.email, role: row.role } : null;
}

/** Verify email+password. Returns the user (no session) or null. */
export async function verifyLogin(
  email: string,
  password: string
): Promise<AdminUser | null> {
  if (!neonEnabled()) return null;
  const res = await neonQuery(
    `SELECT id, email, password_hash, role FROM admin_users WHERE email = $1`,
    [normEmail(email)]
  );
  const row = res.rows[0];
  if (!row) {
    // Burn time to reduce user-enumeration timing signal.
    await verifyPassword(password, "scrypt$00$00");
    return null;
  }
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return null;
  return { id: row.id, email: row.email, role: row.role };
}

export async function getUserById(id: string): Promise<AdminUser | null> {
  if (!neonEnabled() || !id) return null;
  const res = await neonQuery(`SELECT id, email, role FROM admin_users WHERE id = $1`, [id]);
  const row = res.rows[0];
  return row ? { id: row.id, email: row.email, role: row.role } : null;
}

/** Change a user's password and revoke all their existing sessions. */
export async function changePassword(userId: string, newPassword: string): Promise<boolean> {
  if (!neonEnabled() || !userId) return false;
  if (newPassword.length < 8) throw new Error("password must be 8+ characters");
  const ph = await hashPassword(newPassword);
  await neonQuery(`UPDATE admin_users SET password_hash = $1 WHERE id = $2`, [ph, userId]);
  await neonQuery(
    `UPDATE admin_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
  return true;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
/** Create a session for a user; returns the opaque token to put in the cookie. */
export async function createSession(
  userId: string
): Promise<{ token: string; expiresAt: Date } | null> {
  if (!neonEnabled() || !userId) return null;
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  await neonQuery(
    `INSERT INTO admin_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, hashToken(token), expiresAt.toISOString()]
  );
  return { token, expiresAt };
}

/** Resolve a session token to its user (valid, unrevoked, unexpired) or null. */
export async function getUserBySession(token: string | null | undefined): Promise<AdminUser | null> {
  if (!neonEnabled() || !token) return null;
  const res = await neonQuery(
    `SELECT u.id, u.email, u.role
       FROM admin_sessions s
       JOIN admin_users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [hashToken(token)]
  );
  const row = res.rows[0];
  if (!row) return null;
  // Best-effort activity stamp; never block the read on it.
  neonQuery(`UPDATE admin_sessions SET last_seen_at = now() WHERE token_hash = $1`, [
    hashToken(token),
  ]).catch(() => {});
  return { id: row.id, email: row.email, role: row.role };
}

/** Revoke a single session by token. */
export async function revokeSession(token: string | null | undefined): Promise<void> {
  if (!neonEnabled() || !token) return;
  await neonQuery(
    `UPDATE admin_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token)]
  );
}

/** One-time bootstrap: create the first admin (used by the migrate/CLI tool). */
export const adminAuthBootstrap = upsertAdminUser;
