// OmniFlow 264 - GitHub cleanup: the final .gitignore (all known local junk stays out), the eslint 9 flat config restored, and the full remaining-work + cleanup guide.
// Website only - no Control Plane files and no SQL. The `git rm --cached` steps are printed at the end.
// Run from the website root (the folder that has package.json): node github_clean_264.mjs
// Safe to run again: a file that already has the 264 marker is reported as already.
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const BACKUP_TAG = ".pre_264.bak";
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
if (!fs.existsSync("package.json") || !fs.readFileSync("package.json", "utf8").includes("\"lint\": \"eslint\"")) {
  console.log("X " + "the lint script (the restored eslint.config.mjs is what it runs)" + " Nothing was written.");
  process.exit(1);
}
if (!fs.existsSync("package.json") || !fs.readFileSync("package.json", "utf8").includes("\"eslint-config-next\"")) {
  console.log("X " + "the Next eslint preset (used by the restored config)" + " Nothing was written.");
  process.exit(1);
}
writeNewRepair(".gitignore", "\u00a7264", false,
    "# See https://help.github.com/articles/ignoring-files/ for more about ignoring files.\n\n# dependencies\n/node_modules\n/.pnp\n.pnp.*\n.yarn/*\n!.yarn/patches\n!.yarn/plugins\n!.yarn/releases\n!.yarn/versions\n\n# testing\n/coverage\n__pycache__/\n*.py[cod]\n\n# next.js\n/.next/\n/out/\n\n# production\n/build\n\n# misc\n.DS_Store\n*.pem\n\n# debug\nnpm-debug.log*\nyarn-debug.log*\nyarn-error.log*\n.pnpm-debug.log*\n\n# env files (commit only the secret-free example)\n.env*\n!.env.example\n\n# vercel\n.vercel\n\n# typescript\n*.tsbuildinfo\nnext-env.d.ts\n*.pre_*.bak\n\n# bot runtime + local accident backups (never commit)\n/whatsapp_sessions/\n/src/whatsapp_session/\n/logs/\n/src/logs/\n/hide/\n/Omniflow/\n*.dir_conflict.bak/\n\n# Nested CP repo lives on the laptop bot root; never track it in the website repo.\nOmniFlow-Control-Plane/\n/patchers\n/hide\n/.connector_node.env\n.connector_node.env\n\n# \u00a7264 GitHub cleanup: local-only junk that must never be committed.\n# These were swept into git by a bulk commit once; they are untracked again\n# (git rm --cached) and stay out with these rules.\n/venv/\n/whatsapp_session/\n/_archive/\n/backups/\n/runtime_locks/\n/data/\n/.agents/\n/verify-script/\n");
writeNewRepair("eslint.config.mjs", "\u00a7264", false,
    "// \u00a7264: restored - the eslint 9 flat config was dropped from the repo by a\n// bulk commit, which broke `npm run lint`. Keep this file tracked.\nimport { defineConfig, globalIgnores } from \"eslint/config\";\nimport nextVitals from \"eslint-config-next/core-web-vitals\";\nimport nextTs from \"eslint-config-next/typescript\";\n\nconst eslintConfig = defineConfig([\n  ...nextVitals,\n  ...nextTs,\n  // Override default ignores of eslint-config-next.\n  globalIgnores([\n    // Default ignores of eslint-config-next:\n    \".next/**\",\n    \"out/**\",\n    \"build/**\",\n    \"next-env.d.ts\",\n    // Local-only folders that must never be linted:\n    \"venv/**\",\n    \"_archive/**\",\n    \"whatsapp_session/**\",\n    \"connector-bridge/**\",\n    \"OmniFlow-Control-Plane/**\",\n    \"PATCHERS_TO_RUN/**\",\n    \"tools/patchers/**\",\n  ]),\n]);\n\nexport default eslintConfig;\n");
writeNewRepair("docs/GITHUB_CLEANUP_264.md", "\u00a7264", false,
    "# GitHub Cleanup and Remaining Work (\u00a7264)\n\n_Dated 2026-10-10. Run the steps from the laptop (`...whatsapp-ai-bot\\Omniflow` and `...OmniFlow-Control-Plane`). All pushes happen from the laptop._\n\n---\n\n## 1. Remaining work (complete list)\n\n### A. Apply and deploy (code ready, waiting for the laptop)\n1. **`finish_263.mjs`** - apply on the laptop, then `npx tsc --noEmit` and `node tools/cp-testrig/finish_harness_263.mjs` (9 checks), deploy the website. Adds Client billing to the admin nav and fixes the analytics privacy wording.\n2. **Push billing \u00a7261 to GitHub** - billing is applied on the laptop but GitHub (origin/main) has zero \u00a7261 files. Commit + push the website changes from the batch.\n3. **Push the Control Plane side of \u00a7261** - the `OmniFlow-Control-Plane` repo needs its own commit + push: `portal_billing.py` (new), `portal_plans.py`, `app.py`. Deploy CP first, then the website. Verify by opening `/admin/customers/billing` after deploy.\n4. **Push \u00a7263** after it is applied (9 files, website only).\n\n### B. GitHub hygiene (this batch fixes the files; the `git rm` commands are in section 3)\n5. Remove tracked local junk from the index: `venv/` (1204 files), `whatsapp_session/` (533), `_archive/` (184), `backups/` (8 DB dumps), `runtime_locks/` (4), `data/` (2), `.agents/` (2), `verify-script/` (1).\n6. Remove the `OmniFlow-Control-Plane` gitlink entry from the website repo (it shows as a broken submodule on GitHub; the real CP code lives in its own repo).\n7. Restore `eslint.config.mjs` (it was dropped; `npm run lint` cannot run without it).\n8. Land the final `.gitignore` (this batch writes it).\n\n### C. Security follow-ups (important)\n9. **Rotate the WhatsApp Web link**: `whatsapp_session/` (including 24 cookie/storage files) was committed to GitHub history. On the phone: WhatsApp > Linked devices > log the session out, then relink.\n10. **Check repo visibility**: `backups/pre_migration_00*.dump` are full database dumps and `data/conversations.json` holds chat data. If the repo is PUBLIC, make it private first, then consider purging history (GitHub support / `git filter-repo`). If it is already private, removing the files from tracking plus the session rotation is enough for most cases.\n11. No `.env` or service key was ever committed (verified); `.env*` is ignored.\n\n### D. Owner decisions (no code until decided)\n12. **Currency**: billing defaults to PKR. Confirm PKR or name another currency.\n13. **Invoices**: excluded from billing by decision; new batch if/when needed.\n14. **Payment gateway**: manual payments for now; gateway is a later batch.\n\n### E. Verify after deploy\n15. `/admin` sidebar and Sections grid show Client billing; `/admin/customers/billing` highlights only Client billing; `/admin/analytics` shows the scoped privacy card.\n16. Confirm batches 255-260 applied status on the laptop is fully pushed (GitHub already shows \u00a7243-\u00a7260 markers).\n\n---\n\n## 2. What GitHub has today (origin/main = `99d0c72 \"admin dashboard polish\"`)\n\n| State | Detail |\n|---|---|\n| Batches on GitHub | \u00a7243 to \u00a7260 are present (marker scan: 243, 244, 245, 246, 247, 250, 255, 256, 257, 258, 259, 260 all found) |\n| Missing on GitHub | \u00a7261 billing (0 files) and \u00a7263 finish batch (0 files) - applied/pending on the laptop, not pushed |\n| Junk tracked | `venv/` 1204 files, `whatsapp_session/` 533, `_archive/` 184, `backups/` 8, `runtime_locks/` 4, `data/` 2, `.agents/` 2, `verify-script/` 1 |\n| Broken entry | `OmniFlow-Control-Plane` committed as a gitlink (mode 160000) - GitHub renders it as an unreadable folder |\n| Deleted file | `eslint.config.mjs` gone from GitHub (lint broken) |\n| Secrets | no `.env` / service keys committed; but session cookies + DB dumps in history (section C) |\n\n---\n\n## 3. Cleanup steps on the laptop (run AFTER `github_clean_264.mjs`)\n\nThe patcher writes the final `.gitignore`, restores `eslint.config.mjs`, and drops this guide. Then, at the website root:\n\n```bat\ngit rm -r --cached --ignore-unmatch venv whatsapp_session _archive backups runtime_locks data .agents verify-script\ngit rm --cached --ignore-unmatch OmniFlow-Control-Plane\ngit add .gitignore eslint.config.mjs docs/GITHUB_CLEANUP_264.md\ngit commit -m \"GitHub cleanup: untrack local junk, restore eslint config, final gitignore\"\ngit push origin main\n```\n\nNotes:\n- `git rm --cached` only removes the files from the index; the local copies on the laptop stay on disk.\n- The `.gitignore` written by this batch keeps them out forever.\n- The commit stays in history with the old junk; the security steps in section C cover that.\n\nThen commit + push the pending work:\n\n```bat\n:: billing 261 + finish 263 website changes (adjust message as needed)\ngit add -A\ngit commit -m \"Client billing (261) and finish batch (263): billing nav, privacy wording\"\ngit push origin main\n\n:: Control Plane repo (billing 261)\ncd OmniFlow-Control-Plane\ngit add portal_billing.py portal_plans.py app.py\ngit commit -m \"Client billing: ledger, expiry rule, blueprint registration (261)\"\ngit push origin main\n```\n\n---\n\n## 4. Definition of clean\n\nAfter the steps above, GitHub is clean when:\n- `git status` on the laptop shows nothing to commit (working tree clean).\n- GitHub shows no `venv/`, `whatsapp_session/`, `_archive/`, `backups/`, `runtime_locks/`, `data/`, `.agents/`, `verify-script/` folders and no `OmniFlow-Control-Plane` gitlink.\n- \u00a7261 and \u00a7263 markers are present on origin/main.\n- `npm run lint` runs (eslint.config.mjs restored).\n- The WhatsApp session is relinked and the repo visibility decision is made.\n");
writeNewRepair("tools/cp-testrig/cleanup_harness_264.mjs", "\u00a7264", false,
    "// \u00a7264 harness: checks the GitHub cleanup batch on fixed inputs - the final\n// .gitignore keeps every known local-junk folder out (and keeps .env.example\n// tracked), and the eslint 9 flat config is back. One PASS/FAIL line per\n// check, then a SUMMARY line.\n//\n// It finds the website root (the folder that holds .gitignore and\n// eslint.config.mjs) by looking in its own folder and then upward, so it\n// runs from tools/cp-testrig/ in the repo and also when copied to the\n// website root. OF_RIG_WEB_ROOT overrides the search. Node 22.6 to 22.17\n// cannot load .ts files without --experimental-strip-types, so this file\n// starts itself once more with that flag (guarded by OF_RIG_RELAUNCHED).\n// A plain `node cleanup_harness_264.mjs` therefore works on every Node 22.6+\n// install.\nimport assert from \"node:assert/strict\";\nimport { readFileSync, existsSync } from \"node:fs\";\nimport { spawnSync } from \"node:child_process\";\nimport path from \"node:path\";\nimport { fileURLToPath } from \"node:url\";\n\nconst MARKER_FILE = path.join(\"eslint.config.mjs\");\n\nfunction findWebRoot() {\n  if (process.env.OF_RIG_WEB_ROOT) return path.resolve(process.env.OF_RIG_WEB_ROOT);\n  let dir = path.dirname(fileURLToPath(import.meta.url));\n  while (!existsSync(path.join(dir, MARKER_FILE))) {\n    const up = path.dirname(dir);\n    if (up === dir) return null;\n    dir = up;\n  }\n  return dir;\n}\n\nfunction relaunchWithStripTypes() {\n  if (process.env.OF_RIG_RELAUNCHED === \"1\") return false;\n  const [major, minor] = process.versions.node.split(\".\").map(Number);\n  if (major < 22 || (major === 22 && minor < 6)) {\n    console.log(\"FAIL  Node 22.6 or newer is needed (this is \" + process.version + \")\");\n    process.exitCode = 1;\n    return true;\n  }\n  const child = spawnSync(\n    process.execPath,\n    [\"--experimental-strip-types\", \"--no-warnings\", fileURLToPath(import.meta.url), ...process.argv.slice(2)],\n    { stdio: \"inherit\", env: { ...process.env, OF_RIG_RELAUNCHED: \"1\" } }\n  );\n  process.exitCode = child.status ?? 1;\n  return true;\n}\n\nlet passed = 0;\nlet failed = 0;\nfunction check(name, fn) {\n  try {\n    fn();\n    passed += 1;\n    console.log(\"PASS  \" + name);\n  } catch (error) {\n    failed += 1;\n    console.log(\"FAIL  \" + name + \" - \" + String(error.message).split(\"\\n\")[0]);\n  }\n}\n\nconst JUNK = [\n  \"/venv/\",\n  \"/whatsapp_session/\",\n  \"/_archive/\",\n  \"/backups/\",\n  \"/runtime_locks/\",\n  \"/data/\",\n  \"/.agents/\",\n  \"/verify-script/\",\n];\n\nfunction main() {\n  const root = findWebRoot();\n  if (!root) {\n    console.log(\"FAIL  cannot find eslint.config.mjs (run from the repo or set OF_RIG_WEB_ROOT)\");\n    process.exitCode = 1;\n    return;\n  }\n  const ignore = readFileSync(path.join(root, \".gitignore\"), \"utf8\");\n  const lines = ignore.split(/\\r?\\n/).map((line) => line.trim());\n\n  check(\"every known junk folder is ignored\", () => {\n    for (const rule of JUNK) assert.ok(lines.includes(rule), rule + \" missing\");\n  });\n\n  check(\"the nested Control Plane repo is ignored\", () => {\n    assert.ok(lines.includes(\"OmniFlow-Control-Plane/\"), \"OmniFlow-Control-Plane/\");\n  });\n\n  check(\".env.example stays tracked (the un-ignore is the last word)\", () => {\n    const bang = lines.lastIndexOf(\"!.env.example\");\n    assert.ok(bang >= 0, \"!.env.example missing\");\n    const reignore = lines.slice(bang + 1).findIndex((line) => line === \".env.example\");\n    assert.equal(reignore, -1, \"a later .env.example line would re-ignore it\");\n    assert.ok(ignore.includes(\".env*\"), \"the .env* catch-all is present\");\n  });\n\n  check(\"the backup-tag ignore survives (pagespeed suite pins it)\", () => {\n    assert.ok(ignore.includes(\"*.pre_*.bak\"));\n  });\n\n  check(\"the eslint 9 flat config is back and carries the marker\", () => {\n    const source = readFileSync(path.join(root, MARKER_FILE), \"utf8\");\n    assert.ok(source.includes(\"defineConfig(\"), \"defineConfig\");\n    assert.ok(source.includes(\"export default eslintConfig;\"), \"default export\");\n    assert.ok(source.includes(\"eslint-config-next/core-web-vitals\"), \"next vitals preset\");\n    assert.ok(source.includes(\"\\u00a7264\"), \"marker\");\n  });\n\n  check(\"the cleanup guide ships with the batch\", () => {\n    const guide = readFileSync(path.join(root, \"docs\", \"GITHUB_CLEANUP_264.md\"), \"utf8\");\n    assert.ok(guide.includes(\"\\u00a7264\"), \"marker\");\n    assert.ok(guide.includes(\"git rm -r --cached\"), \"the untrack commands are documented\");\n  });\n\n  console.log(\"SUMMARY \" + passed + \" passed, \" + failed + \" failed\");\n  if (failed > 0) process.exitCode = 1;\n}\n\nif (!relaunchWithStripTypes()) {\n  try {\n    main();\n  } catch (error) {\n    console.log(\"FAIL  harness crashed - \" + String(error && error.message).split(\"\\n\")[0]);\n    process.exitCode = 1;\n  }\n}\n");

console.log("");
console.log("applied: " + applied + "  already: " + already + "  warnings: " + warnings);
console.log("Next: website only -> git add -A -> commit -> push (no Control Plane deploy).");
console.log("Then at the website root, untrack the junk that the bulk commit swept in (files stay on disk):");
console.log("  git rm -r --cached --ignore-unmatch venv whatsapp_session _archive backups runtime_locks data .agents verify-script");
console.log("  git rm --cached --ignore-unmatch OmniFlow-Control-Plane");
console.log("  git add .gitignore eslint.config.mjs docs/GITHUB_CLEANUP_264.md tools/cp-testrig/cleanup_harness_264.mjs");
console.log("  git commit -m \"GitHub cleanup: untrack local junk, restore eslint config, final gitignore\"");
console.log("  git push origin main");
console.log("Then push the pending work: website `git add -A` + commit + push (billing 261 and finish 263), and in OmniFlow-Control-Plane commit + push portal_billing.py, portal_plans.py and app.py (billing 261). Deploy the Control Plane first, then the website.");
console.log("Security: whatsapp_session (cookies) and backups/*.dump were in git history - log the WhatsApp Web session out from the phone and relink it, and confirm the repo is PRIVATE. Full list: docs/GITHUB_CLEANUP_264.md.");
console.log("Verify: `node tools/cp-testrig/cleanup_harness_264.mjs` must print 6 passed, 0 failed.");