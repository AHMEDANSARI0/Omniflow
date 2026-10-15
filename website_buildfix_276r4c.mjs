// §276r4c: Vercel build fix - bootstrap-admin TS null-guard + remove 6 dead
// files resurrected by the unrelated-histories merge.
// Run from the website repo root: node website_buildfix_276r4c.mjs
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const BACKUP_TAG = ".pre_276r4c.bak";
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
writeNewRepair("tools/website-migrate/bootstrap-admin.ts", "\u00a7276r4c", false,
    "/**\n * \u00a7276r4c \u2014 Neon-only admin bootstrap (no Supabase anywhere).\n *\n * Creates (or resets) the website admin user directly in Neon.\n *\n *   set DATABASE_URL=postgresql://<neon pooled>?sslmode=require\n *   set MIGRATE_ADMIN_EMAIL=you@example.com\n *   set MIGRATE_ADMIN_PASSWORD=min-8-chars\n *   npx tsx tools/website-migrate/bootstrap-admin.ts\n *\n * CMD/PowerShell quirks tolerated: surrounding quotes and stray whitespace\n * are stripped from all three vars before use (CMD keeps quotes in values).\n * Idempotent: re-running resets the password of the same email.\n */\nconst clean = (v: string | undefined) => (v ?? \"\").trim().replace(/^[\"']+|[\"']+$/g, \"\").trim();\nfor (const key of [\"DATABASE_URL\", \"MIGRATE_ADMIN_EMAIL\", \"MIGRATE_ADMIN_PASSWORD\", \"ADMIN_EMAIL\", \"ADMIN_PASSWORD\"]) {\n  if (process.env[key] !== undefined) process.env[key] = clean(process.env[key]);\n}\n\nconst email = (process.env.MIGRATE_ADMIN_EMAIL || process.env.ADMIN_EMAIL || \"\").toLowerCase();\nconst password = process.env.MIGRATE_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || \"\";\n\nfunction fail(msg: string): never {\n  console.error(\"X \" + msg);\n  process.exit(1);\n}\n\nif (!process.env.DATABASE_URL) {\n  fail(\"DATABASE_URL isi window me set nahi hai. Pehle: set DATABASE_URL=postgresql://... (bina quotes), phir dobara chalayein.\");\n}\nif (email === \"\") {\n  fail(\"MIGRATE_ADMIN_EMAIL isi window me set nahi hai. Pehle: set MIGRATE_ADMIN_EMAIL=you@example.com (bina quotes, koi space nahi), phir dobara chalayein.\");\n}\nif (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {\n  fail(`MIGRATE_ADMIN_EMAIL email-address jaisa nahi lag raha - mila ye: ${email} (quotes/space hata kar dobara set karein).`);\n}\nif (password.length < 8) {\n  fail(\"MIGRATE_ADMIN_PASSWORD must be at least 8 characters (set isi window me, bina quotes).\");\n}\n\nasync function main() {\n  const { upsertAdminUser, verifyLogin } = await import(\"../../lib/db/auth\");\n  const user = await upsertAdminUser(email, password, \"admin\");\n  if (!user) fail(\"upsertAdminUser returned no row - send this output.\");\n  const check = await verifyLogin(email, password);\n  if (!check) fail(\"admin row written but login verification failed - send this output.\");\n  console.log(`+ admin: ${user.email} ready (role=${user.role})`);\n  console.log(\"  Sign in at /admin/login with these credentials.\");\n  process.exit(0);\n}\n\nmain().catch((err) => fail(`bootstrap failed: ${err && err.message ? err.message : String(err)}`));\n");
removeFile("app/components/HexGrid.tsx");
removeFile("app/components/animations/FadeUp.tsx");
removeFile("app/components/animations/Reveal.tsx");
removeFile("app/components/animations/Stagger.tsx");
removeFile("app/dashboard/(portal)/bot/actions.ts");
removeFile("test-message.json");

console.log("");
console.log("applied: " + applied + "  already: " + already + "  warnings: " + warnings);
console.log("Next: website only -> git add -A -> commit -> push (no Control Plane deploy).");
console.log("Then:");
console.log("  git rm --cached Omniflow-website-auth   (stops the Vercel submodule warning)");
console.log("  git add -A");
console.log("  git commit -m \"website: build fix (276r4c)\"");
console.log("  git push");
console.log("Vercel: Redeploy with 'Use existing Build Cache' UNCHECKED.");