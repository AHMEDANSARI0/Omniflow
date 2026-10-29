// §282h — Repair the Admin mobile analytics API wiring.
//
// The native Admin screens already request /api/v1/mobile/admin/quality and
// /site-stats, but the Neon-backed mobile-admin CP module had no routes for
// them. This adds session-guarded server-side adapters over the EXISTING
// admin_ai and portal_site_analytics calculations. No service key, DB secret,
// second backend, or Supabase credential is sent to the app.
//
// Run from D:\\whatsapp-ai-bot (repo root):
//   node PATCHERS_TO_RUN\\mobile_admin_metrics_282h.mjs
// Then restart/deploy the Control Plane. The patcher keeps a .pre_282h.bak.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cpRoot = path.join(process.cwd(), "OmniFlow-Control-Plane");
const target = path.join(cpRoot, "portal_mobile_admin.py");
const anchor = '# -------------------------------------------------------------------- users\n@bp.get("/admin/users")\ndef admin_users_list():\n';
const marker = "# §282h mobile admin summary routes";
const backup = target + ".pre_282h.bak";

if (!fs.existsSync(cpRoot) || !fs.existsSync(path.join(cpRoot, "app.py"))) {
  console.error("X Run from the bot/repo root with OmniFlow-Control-Plane\\app.py present. Nothing was changed.");
  process.exit(1);
}
if (!fs.existsSync(target)) {
  console.error("X OmniFlow-Control-Plane\\portal_mobile_admin.py not found. Nothing was changed.");
  process.exit(1);
}

const raw = fs.readFileSync(target, "utf8");
const hadCRLF = raw.includes("\r\n");
const source = raw.replace(/\r\n/g, "\n");
const hasQuality = source.includes('@bp.get("/admin/quality")');
const hasSiteStats = source.includes('@bp.get("/admin/site-stats")');
if (hasQuality && hasSiteStats && source.includes(marker)) {
  console.log("= OmniFlow-Control-Plane/portal_mobile_admin.py (already patched)");
  process.exit(0);
}
if (hasQuality || hasSiteStats || source.includes(marker)) {
  console.error("X Partial §282h implementation detected. Inspect portal_mobile_admin.py; nothing was changed.");
  process.exit(1);
}
const anchorCount = source.split(anchor).length - 1;
if (anchorCount !== 1) {
  console.error(`X Expected one Admin users anchor, found ${anchorCount}. Nothing was changed.`);
  process.exit(1);
}

const insertion = `${marker}
# ------------------------------------------------------------------ analytics

def _mobile_days() -> int:
    """Small, predictable window set used by the native Admin analytics UI."""
    try:
        days = int(request.args.get("days") or 7)
    except (TypeError, ValueError):
        days = 7
    return days if days in (1, 7, 14, 30) else 7


@bp.get("/admin/quality")
def admin_quality():
    """Session-guarded, compact platform AI summary for the Admin app.

    The web admin endpoint is service-key guarded and must never be called
    by a device. Reuse its server-side Neon calculation behind this mobile
    session guard, returning only the totals/controls the native screen needs.
    """
    result = _guard()
    if not isinstance(result, dict):
        return result
    days = _mobile_days()
    try:
        import admin_ai

        conn = _conn()
        try:
            with conn.cursor() as cur:
                snapshot = admin_ai.overview(cur, days)
            conn.commit()
        finally:
            conn.close()
        overview = snapshot if isinstance(snapshot, dict) else {}
        return jsonify({
            "days": days,
            "degraded": False,
            "overview": {
                "totals": overview.get("totals") or {},
                "controls": overview.get("controls") or {},
            },
        }), 200
    except Exception as exc:
        logger.warning("mobile admin AI summary failed: %s", exc)
        return jsonify({"error": "AI analytics unavailable right now."}), 503


@bp.get("/admin/site-stats")
def admin_site_stats():
    """Session-guarded, compact website analytics for the Admin app.

    Call the existing Neon analytics implementation on the server; never
    expose its service-key-only HTTP endpoint or ship credentials.
    """
    result = _guard()
    if not isinstance(result, dict):
        return result
    days = _mobile_days()
    try:
        import portal_site_analytics

        snapshot = portal_site_analytics._run(
            lambda cur: portal_site_analytics._stats(cur, days)
        )
        stats = snapshot if isinstance(snapshot, dict) else {}
        return jsonify({
            "days": days,
            "degraded": False,
            "stats": {
                "days": days,
                "timezone": stats.get("timezone") or "Asia/Karachi",
                "totals": stats.get("totals") or {},
                "daily": stats.get("daily") or [],
                "countries": stats.get("countries") or [],
                "browsers": stats.get("browsers") or [],
            },
        }), 200
    except Exception as exc:
        logger.warning("mobile admin site stats failed: %s", exc)
        return jsonify({"error": "Website analytics unavailable right now."}), 503


`;
const updated = source.replace(anchor, insertion + anchor);
for (const required of [
  '@bp.get("/admin/quality")',
  '@bp.get("/admin/site-stats")',
  '"/admin/quality"',
  '"/admin/site-stats"',
]) {
  if (!updated.includes(required)) {
    console.error(`X Post-check failed for ${required}. Nothing was changed.`);
    process.exit(1);
  }
}

if (!fs.existsSync(backup)) fs.copyFileSync(target, backup);
const finalText = hadCRLF ? updated.replace(/\n/g, "\r\n") : updated;
fs.writeFileSync(target, finalText, "utf8");

function compilePython(file) {
  const candidates = process.platform === "win32"
    ? [["py", ["-3"]], ["python", []], ["python3", []]]
    : [["python3", []], ["python", []], ["py", ["-3"]]];
  for (const [exe, prefix] of candidates) {
    const probe = spawnSync(exe, [...prefix, "--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) continue;
    const result = spawnSync(exe, [...prefix, "-m", "py_compile", file], { encoding: "utf8" });
    if (result.status === 0) return true;
    console.error((result.stderr || result.stdout || "Python compile failed").trim());
    return false;
  }
  console.warn("! Python was not found; compile guard skipped. Run py_compile before deploying.");
  return true;
}

if (!compilePython(target)) {
  fs.copyFileSync(backup, target);
  console.error("X Compile guard failed; original file restored from .pre_282h.bak.");
  process.exit(1);
}
console.log("+ OmniFlow-Control-Plane/portal_mobile_admin.py (2 session-guarded analytics routes)");
console.log("= Backup: OmniFlow-Control-Plane/portal_mobile_admin.py.pre_282h.bak");
console.log("Next: run the CP test rig, commit/deploy the Control Plane, then build the separate Admin APK after its remaining controls are added.");