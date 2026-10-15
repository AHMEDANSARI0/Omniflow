// §276r4f: admin-only self-diagnostics route /api/omniflow/admin/selftest.
// Reports exact Neon + Control Plane errors from the LIVE deployment.
// Run from the website repo root: node website_selftest_276r4f.mjs
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const BACKUP_TAG = ".pre_276r4f.bak";
let applied = 0, already = 0, warnings = 0;
if (!fs.existsSync("OmniFlow-Control-Plane") || !fs.statSync("OmniFlow-Control-Plane").isDirectory()) {
  console.log("X Run this from the website repo root (bot root) - the folder that contains OmniFlow-Control-Plane/. Nothing was written.");
  process.exit(1);
}
if (!fs.existsSync("OmniFlow-Control-Plane/app.py")) {
  console.log("X OmniFlow-Control-Plane/ is empty or not the Control Plane repo (no app.py). On a fresh machine the website clone leaves this folder empty: delete it, then clone the Control Plane repo into it (git clone <CP repo url> OmniFlow-Control-Plane) and run this again. Nothing was written.");
  process.exit(1);
}
function compilePython(pathArg) {
  const { spawnSync } = require("child_process");
  for (const py of ["python3", "python", "py"]) {
    const probe = spawnSync(py, ["--version"], { encoding: "utf8" });
    if (probe.status !== 0) continue;
    const check = spawnSync(py, ["-c", "import sys;sys.exit(0 if sys.version_info[0]>=3 else 1)"], { encoding: "utf8" });
    if (check.status !== 0) continue;
    const result = spawnSync(py, ["-c", "import py_compile,sys;py_compile.compile(sys.argv[1],doraise=True);sys.exit(0)", pathArg], { encoding: "utf8" });
    return result.status === 0;
  }
  console.log("  (python not found - skipped compile guard)");
  return true;
}
function writeNewRepair(repoPath, marker, isCp, content) {
  try {
  let existed = false;
  if (fs.existsSync(repoPath)) {
    if (fs.statSync(repoPath).isDirectory()) {
      let target = repoPath + ".dir_conflict.bak";
      let n = 1;
      while (fs.existsSync(target)) { target = repoPath + ".dir_conflict.bak." + n; n++; }
      fs.renameSync(repoPath, target);
      console.log("! " + repoPath + " was a DIRECTORY on this machine - renamed to " + target + "; writing the real file.");
      warnings++;
    } else existed = true;
  }
  if (!existed) {
    const cut = Math.max(repoPath.lastIndexOf("/"), repoPath.lastIndexOf("\\"));
    if (cut > 0) fs.mkdirSync(repoPath.slice(0, cut), { recursive: true });
    fs.writeFileSync(repoPath, content, "utf8");
    if (isCp && repoPath.endsWith(".py") && !compilePython(repoPath)) {
      fs.unlinkSync(repoPath);
      console.log("X " + repoPath + " FAILED to compile - not written");
      warnings++;
      return;
    }
    console.log("+ " + repoPath + " (new file)");
    applied++;
    return;
  }
  const original = fs.readFileSync(repoPath, "utf8").replace(/\r\n/g, "\n");
  if (original.includes(marker)) {
    console.log("= " + repoPath + " (already correct)");
    already++;
    return;
  }
  const backup = repoPath + BACKUP_TAG;
  if (!fs.existsSync(backup)) fs.copyFileSync(repoPath, backup);
  fs.writeFileSync(repoPath, content, "utf8");
  if (isCp && repoPath.endsWith(".py") && !compilePython(repoPath)) {
    fs.copyFileSync(backup, repoPath);
    console.log("X " + repoPath + " FAILED to compile - old copy restored");
    warnings++;
    return;
  }
  console.log("+ " + repoPath + " (REPAIRED - old copy kept as " + BACKUP_TAG + ")");
  applied++;
  } catch (err) {
    console.log("X " + repoPath + " FAILED: " + err.message);
    warnings++;
  }
}
function removeFile(repoPath) {
  try {
    if (!fs.existsSync(repoPath)) {
      console.log("= " + repoPath + " (already removed)");
      already++;
      return;
    }
    const backup = repoPath + BACKUP_TAG;
    if (!fs.existsSync(backup)) fs.copyFileSync(repoPath, backup);
    fs.unlinkSync(repoPath);
    console.log("- " + repoPath + " (removed - old copy kept as " + BACKUP_TAG + ")");
    applied++;
  } catch (err) {
    console.log("X " + repoPath + " FAILED to remove: " + err.message);
    warnings++;
  }
}
writeNewRepair("app/api/omniflow/admin/selftest/route.ts", "\u00a7276r4f", false,
    "import { NextResponse } from \"next/server\";\nimport { createClient } from \"../../../../../lib/supabase/server\";\nimport { getPool, neonEnabled } from \"../../../../../lib/db/neon\";\nimport { noStoreHeaders } from \"../../../../../lib/omniflow/request-security\";\n\n/**\n * \u00a7276r4f \u2014 admin-only self-diagnostics. Reports the EXACT failure of the\n * two live dependencies (website Neon DB + Control Plane) instead of the\n * dashboard's generic \"unavailable\" cards. Secrets are never echoed: only\n * host names, presence flags and lengths.\n *\n * GET /api/omniflow/admin/selftest  (requires an admin session cookie)\n */\nexport async function GET() {\n  const supabase = await createClient();\n  const {\n    data: { user },\n  } = await supabase.auth.getUser();\n  if (!user) {\n    return NextResponse.json(\n      { error: \"admin session required - sign in at /admin/login first\" },\n      { status: 401, headers: noStoreHeaders() },\n    );\n  }\n\n  const out: Record<string, unknown> = { at: new Date().toISOString() };\n\n  // --- Neon (website database) -------------------------------------------\n  const dbUrl = (process.env.DATABASE_URL || \"\").trim();\n  let dbHost = \"(missing)\";\n  if (dbUrl) {\n    try {\n      dbHost = new URL(dbUrl).host;\n    } catch {\n      dbHost = \"(unparsable value)\";\n    }\n  }\n  const db: Record<string, unknown> = { enabled: neonEnabled(), host: dbHost };\n  try {\n    const pool = getPool();\n    const leads = await pool.query(\"SELECT count(*)::int AS n FROM leads\");\n    const settings = await pool.query(\"SELECT count(*)::int AS n FROM site_settings\");\n    db.leads = { ok: true, count: leads.rows[0]?.n ?? null };\n    db.site_settings = { ok: true, count: settings.rows[0]?.n ?? null };\n  } catch (err) {\n    db.error = String((err as Error)?.message || err).slice(0, 400);\n  }\n  out.database = db;\n\n  // --- Control Plane ------------------------------------------------------\n  const cpRaw = (process.env.OMNIFLOW_CONTROL_PLANE_URL || \"\").trim();\n  const key = (process.env.OMNIFLOW_SERVICE_KEY || \"\").trim();\n  const cp: Record<string, unknown> = {\n    url: cpRaw || \"(missing)\",\n    keyPresent: Boolean(key),\n    keyLength: key.length,\n  };\n  try {\n    const base = cpRaw.endsWith(\"/\") ? cpRaw : cpRaw + \"/\";\n    const res = await fetch(new URL(\"api/v1/admin/site-analytics/stats?days=1\", base), {\n      headers: key ? { \"X-Omniflow-Key\": key } : undefined,\n      cache: \"no-store\",\n      signal: AbortSignal.timeout(8_000),\n    });\n    const text = await res.text();\n    cp.probe = { status: res.status, body: text.slice(0, 240) };\n  } catch (err) {\n    cp.probe = { error: String((err as Error)?.message || err).slice(0, 400) };\n  }\n  out.controlPlane = cp;\n\n  return NextResponse.json(out, { headers: noStoreHeaders() });\n}\n");

console.log("");
console.log("applied: " + applied + "  already: " + already + "  warnings: " + warnings);
console.log("Next: website only -> git add -A -> commit -> push (no Control Plane deploy).");
console.log("Then:");
console.log("  git add app/api/omniflow/admin/selftest");
console.log("  git commit -m \"website: admin selftest route (276r4f)\"");
console.log("  git commit --allow-empty -m \"chore: fresh deployment with current env\"");
console.log("  git push");
console.log("Wait Ready -> sign in /admin -> open /api/omniflow/admin/selftest -> paste the JSON.");