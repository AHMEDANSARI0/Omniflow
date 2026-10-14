/**
 * §276r4b — Neon-only admin bootstrap (no Supabase anywhere).
 *
 * Creates (or resets) the website admin user directly in Neon.
 *
 *   set DATABASE_URL=postgresql://<neon pooled>?sslmode=require
 *   set MIGRATE_ADMIN_EMAIL=you@example.com
 *   set MIGRATE_ADMIN_PASSWORD=min-8-chars
 *   npx tsx tools/website-migrate/bootstrap-admin.ts
 *
 * CMD/PowerShell quirks tolerated: surrounding quotes and stray whitespace
 * are stripped from all three vars before use (CMD keeps quotes in values).
 * Idempotent: re-running resets the password of the same email.
 */
const clean = (v: string | undefined) => (v ?? "").trim().replace(/^["']+|["']+$/g, "").trim();
for (const key of ["DATABASE_URL", "MIGRATE_ADMIN_EMAIL", "MIGRATE_ADMIN_PASSWORD", "ADMIN_EMAIL", "ADMIN_PASSWORD"]) {
  if (process.env[key] !== undefined) process.env[key] = clean(process.env[key]);
}

const email = (process.env.MIGRATE_ADMIN_EMAIL || process.env.ADMIN_EMAIL || "").toLowerCase();
const password = process.env.MIGRATE_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "";

function fail(msg: string): never {
  console.error("X " + msg);
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  fail("DATABASE_URL isi window me set nahi hai. Pehle: set DATABASE_URL=postgresql://... (bina quotes), phir dobara chalayein.");
}
if (email === "") {
  fail("MIGRATE_ADMIN_EMAIL isi window me set nahi hai. Pehle: set MIGRATE_ADMIN_EMAIL=you@example.com (bina quotes, koi space nahi), phir dobara chalayein.");
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  fail(`MIGRATE_ADMIN_EMAIL email-address jaisa nahi lag raha - mila ye: ${email} (quotes/space hata kar dobara set karein).`);
}
if (password.length < 8) {
  fail("MIGRATE_ADMIN_PASSWORD must be at least 8 characters (set isi window me, bina quotes).");
}

async function main() {
  const { upsertAdminUser, verifyLogin } = await import("../../lib/db/auth");
  const user = await upsertAdminUser(email, password, "admin");
  const check = await verifyLogin(email, password);
  if (!check) fail("admin row written but login verification failed - send this output.");
  console.log(`+ admin: ${user.email} ready (role=${user.role})`);
  console.log("  Sign in at /admin/login with these credentials.");
  process.exit(0);
}

main().catch((err) => fail(`bootstrap failed: ${err && err.message ? err.message : String(err)}`));
