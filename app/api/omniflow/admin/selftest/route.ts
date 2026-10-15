import { NextResponse } from "next/server";
import { createClient } from "../../../../../lib/supabase/server";
import { getPool, neonEnabled } from "../../../../../lib/db/neon";
import { noStoreHeaders } from "../../../../../lib/omniflow/request-security";

/**
 * §276r4f — admin-only self-diagnostics. Reports the EXACT failure of the
 * two live dependencies (website Neon DB + Control Plane) instead of the
 * dashboard's generic "unavailable" cards. Secrets are never echoed: only
 * host names, presence flags and lengths.
 *
 * GET /api/omniflow/admin/selftest  (requires an admin session cookie)
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: "admin session required - sign in at /admin/login first" },
      { status: 401, headers: noStoreHeaders() },
    );
  }

  const out: Record<string, unknown> = { at: new Date().toISOString() };

  // --- Neon (website database) -------------------------------------------
  const dbUrl = (process.env.DATABASE_URL || "").trim();
  let dbHost = "(missing)";
  if (dbUrl) {
    try {
      dbHost = new URL(dbUrl).host;
    } catch {
      dbHost = "(unparsable value)";
    }
  }
  const db: Record<string, unknown> = { enabled: neonEnabled(), host: dbHost };
  try {
    const pool = getPool();
    const leads = await pool.query("SELECT count(*)::int AS n FROM leads");
    const settings = await pool.query("SELECT count(*)::int AS n FROM site_settings");
    db.leads = { ok: true, count: leads.rows[0]?.n ?? null };
    db.site_settings = { ok: true, count: settings.rows[0]?.n ?? null };
  } catch (err) {
    db.error = String((err as Error)?.message || err).slice(0, 400);
  }
  out.database = db;

  // --- Control Plane ------------------------------------------------------
  const cpRaw = (process.env.OMNIFLOW_CONTROL_PLANE_URL || "").trim();
  const key = (process.env.OMNIFLOW_SERVICE_KEY || "").trim();
  const cp: Record<string, unknown> = {
    url: cpRaw || "(missing)",
    keyPresent: Boolean(key),
    keyLength: key.length,
  };
  try {
    const base = cpRaw.endsWith("/") ? cpRaw : cpRaw + "/";
    const res = await fetch(new URL("api/v1/admin/site-analytics/stats?days=1", base), {
      headers: key ? { "X-Omniflow-Key": key } : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const text = await res.text();
    cp.probe = { status: res.status, body: text.slice(0, 240) };
  } catch (err) {
    cp.probe = { error: String((err as Error)?.message || err).slice(0, 400) };
  }
  out.controlPlane = cp;

  return NextResponse.json(out, { headers: noStoreHeaders() });
}
