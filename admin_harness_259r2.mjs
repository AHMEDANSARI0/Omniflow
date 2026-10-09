// OmniFlow 259r2 - admin dashboard harness: a plain `node admin_dashboard_harness.mjs` works.
// On Node 22.6 to 22.17 the TypeScript helpers need --experimental-strip-types. The harness
// now starts itself once more with that flag (OF_RIG_RELAUNCHED stops any loop). One file,
// website only (tools/cp-testrig). Run it after admin_polish_259.mjs, from the bot root.
// Safe to run again: the file is rewritten only when the 259r2 marker is missing.
// No database change, no Control Plane deploy, no bridge restart, no env change.
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const BACKUP_TAG = ".pre_259r2.bak";
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
if (!fs.existsSync("tools/cp-testrig/admin_dashboard_harness.mjs") || !fs.readFileSync("tools/cp-testrig/admin_dashboard_harness.mjs", "utf8").includes("findWebRoot")) {
  console.log("X " + "259 walk-up root finder (the harness must already be the 259 version)" + " Nothing was written.");
  process.exit(1);
}
writeNewRepair("tools/cp-testrig/admin_dashboard_harness.mjs", "\u00a7259r2", false,
    "// \u00a7259 harness: runs the admin dashboard helpers and the shared admin nav on\n// fixed inputs. One PASS/FAIL line per check, then a SUMMARY line.\n//\n// It finds the website root (the folder that holds lib/omniflow/admin-dashboard.ts)\n// by looking in its own folder and then upward, so it runs from tools/cp-testrig/\n// in the repo and also when copied to the website root (the bot root on the\n// laptop). OF_RIG_WEB_ROOT overrides the search.\n// \u00a7259r2: Node 22.6 to 22.17 cannot load .ts files without --experimental-strip-types.\n// Then the harness starts itself once more with that flag, so a plain\n// `node admin_dashboard_harness.mjs` works on every Node 22.6+ install.\n//\n// Run from any folder (Node 22.6+ needs the flag to import .ts files):\n//   node --experimental-strip-types --no-warnings admin_dashboard_harness.mjs\nimport assert from \"node:assert/strict\";\nimport { spawnSync } from \"node:child_process\";\nimport { existsSync } from \"node:fs\";\nimport path from \"node:path\";\nimport { fileURLToPath, pathToFileURL } from \"node:url\";\n\nconst HELPER = path.join(\"lib\", \"omniflow\", \"admin-dashboard.ts\");\n\nfunction findWebRoot() {\n  if (process.env.OF_RIG_WEB_ROOT) return path.resolve(process.env.OF_RIG_WEB_ROOT);\n  let dir = path.dirname(fileURLToPath(import.meta.url));\n  while (!existsSync(path.join(dir, HELPER))) {\n    const up = path.dirname(dir);\n    if (up === dir) return null;\n    dir = up;\n  }\n  return dir;\n}\n\nasync function loadHelpers(root) {\n  const at = (file) => pathToFileURL(path.join(root, file)).href;\n  const dashboard = await import(at(HELPER));\n  const nav = await import(at(path.join(\"lib\", \"omniflow\", \"admin-nav.ts\")));\n  const types = await import(at(path.join(\"lib\", \"marketing\", \"types.ts\")));\n  return { ...dashboard, ADMIN_NAV: nav.ADMIN_NAV, ICON_NAMES: types.ICON_NAMES };\n}\n\nconst NOW = Date.parse(\"2026-10-09T12:00:00Z\");\nconst MIN = 60 * 1000;\nconst HOUR = 60 * MIN;\nconst DAY = 24 * HOUR;\nconst iso = (ms) => new Date(ms).toISOString();\n\n// Runs this same file again with the strip-types flag. The child prints the checks\n// and sets the exit code. OF_RIG_RELAUNCHED stops a loop if a Node build ignores the flag.\nfunction relaunchWithStripTypes() {\n  if (process.env.OF_RIG_RELAUNCHED === \"1\") return false;\n  const [major, minor] = process.versions.node.split(\".\").map(Number);\n  if (major < 22 || (major === 22 && minor < 6)) {\n    console.log(\"FAIL  Node 22.6 or newer is needed (this is \" + process.version + \")\");\n    process.exitCode = 1;\n    return true;\n  }\n  const child = spawnSync(\n    process.execPath,\n    [\"--experimental-strip-types\", \"--no-warnings\", fileURLToPath(import.meta.url), ...process.argv.slice(2)],\n    { stdio: \"inherit\", env: { ...process.env, OF_RIG_RELAUNCHED: \"1\" } },\n  );\n  if (child.error) return false;\n  process.exitCode = child.status === null ? 1 : child.status;\n  return true;\n}\n\nasync function main() {\n  // Node prints a typeless-package notice when it loads the .ts helpers. The harness\n  // prints only its own PASS/FAIL lines, so that notice is switched off here.\n  process.removeAllListeners(\"warning\");\n  const root = findWebRoot();\n  if (root === null) {\n    console.log(\"FAIL  lib/omniflow/admin-dashboard.ts not found in this folder or above it\");\n    console.log(\"      Apply PATCHERS_TO_RUN/admin_polish_259.mjs in the website repo root, or set OF_RIG_WEB_ROOT.\");\n    process.exitCode = 1;\n    return;\n  }\n  let helpers;\n  try {\n    helpers = await loadHelpers(root);\n  } catch (error) {\n    if (error && error.code === \"ERR_UNKNOWN_FILE_EXTENSION\" && relaunchWithStripTypes()) return;\n    console.log(\"FAIL  cannot load the TypeScript helpers under \" + root + \" :: \" + String(error.code || error.message).split(\"\\n\")[0]);\n    console.log(\"      Run with: node --experimental-strip-types --no-warnings admin_dashboard_harness.mjs\");\n    process.exitCode = 1;\n    return;\n  }\n  const {\n    aiRates,\n    humanize,\n    leadStats,\n    percent,\n    problemRows,\n    providerLabel,\n    providerRows,\n    relativeTime,\n    signalLabel,\n    usd,\n    workspaceName,\n    ADMIN_NAV,\n    ICON_NAMES,\n  } = helpers;\n\n  let pass = 0;\n  let fail = 0;\n  function check(name, fn) {\n    try {\n      fn();\n      pass += 1;\n      console.log(\"PASS \" + name);\n    } catch (error) {\n      fail += 1;\n      console.log(\"FAIL \" + name + \" :: \" + String(error.message).split(\"\\n\")[0]);\n    }\n  }\n\n  check(\"problems: clean workspaces are left out\", () => {\n    const rows = problemRows([\n      { client_id: 1, name: \"Clean\", email: \"c@x\", failed: 0, open_escalations: 0, pending_approvals: 0, blocked: 0 },\n    ]);\n    assert.equal(rows.length, 0);\n  });\n\n  check(\"problems: most kinds of signal first, then most events\", () => {\n    const rows = problemRows([\n      { client_id: 3, name: \"Zed\", email: \"\", failed: 50, open_escalations: 0, pending_approvals: 0 },\n      { client_id: 2, name: \"\", email: \"b@x\", failed: 3, open_escalations: 1, pending_approvals: 0, blocked: 0 },\n      { client_id: 4, name: \"Beta\", email: \"\", failed: 1, open_escalations: 0, pending_approvals: 2, blocked: 1 },\n    ]);\n    assert.deepEqual(rows.map((r) => r.client_id), [4, 2, 3]);\n  });\n\n  check(\"problems: signals keep a fixed order and drop zeros\", () => {\n    const [row] = problemRows([\n      { client_id: 4, name: \"Beta\", email: \"\", failed: 1, open_escalations: 0, pending_approvals: 2, blocked: 1 },\n    ]);\n    assert.deepEqual(\n      row.signals.map((s) => [s.kind, s.count]),\n      [[\"failed_calls\", 1], [\"pending_approvals\", 2], [\"blocked_attempts\", 1]]\n    );\n    assert.equal(row.total, 4);\n  });\n\n  check(\"problems: name falls back to email, then to the id\", () => {\n    const rows = problemRows([\n      { client_id: 2, name: \"\", email: \"b@x\", failed: 1, open_escalations: 0, pending_approvals: 0 },\n      { client_id: 9, name: \"\", email: \"\", failed: 1, open_escalations: 0, pending_approvals: 0 },\n    ]);\n    assert.deepEqual(rows.map((r) => r.name).sort(), [\"Workspace #9\", \"b@x\"]);\n  });\n\n  check(\"problems: bad numbers count as zero, decimals round down\", () => {\n    const [row] = problemRows([\n      { client_id: 5, name: \"Odd\", email: \"\", failed: \"2.7\", open_escalations: -4, pending_approvals: \"abc\", blocked: null },\n    ]);\n    assert.deepEqual(row.signals, [{ kind: \"failed_calls\", count: 2 }]);\n  });\n\n  check(\"signal labels are singular and plural\", () => {\n    assert.equal(signalLabel({ kind: \"failed_calls\", count: 1 }), \"1 AI call failed\");\n    assert.equal(signalLabel({ kind: \"failed_calls\", count: 3 }), \"3 AI calls failed\");\n    assert.equal(signalLabel({ kind: \"open_escalations\", count: 1 }), \"1 open escalation\");\n    assert.equal(signalLabel({ kind: \"pending_approvals\", count: 2 }), \"2 approvals waiting\");\n    assert.equal(signalLabel({ kind: \"blocked_attempts\", count: 1 }), \"1 blocked attempt\");\n  });\n\n  check(\"workspace name: business name, email, then id\", () => {\n    assert.equal(workspaceName({ client_id: 7, name: \"Acme\", email: \"a@x\" }), \"Acme\");\n    assert.equal(workspaceName({ client_id: 7, name: \"\", email: \"a@x\" }), \"a@x\");\n    assert.equal(workspaceName({ client_id: 7, name: \"\", email: \"\" }), \"Workspace #7\");\n  });\n\n  check(\"leads: window count ignores bad dates, status buckets are complete\", () => {\n    const stats = leadStats(\n      [\n        { status: \"new\", created_at: iso(NOW - 1 * DAY) },\n        { status: \"contacted\", created_at: iso(NOW - 10 * DAY) },\n        { status: \"closed\", created_at: \"not-a-date\" },\n        { status: \"weird\", created_at: iso(NOW - 2 * HOUR) },\n      ],\n      NOW,\n      7\n    );\n    assert.equal(stats.total, 4);\n    assert.equal(stats.recent, 2);\n    assert.deepEqual(stats.byStatus, { new: 1, contacted: 1, closed: 1, other: 1 });\n  });\n\n  check(\"leads: an empty list is all zeros\", () => {\n    const stats = leadStats([], NOW, 30);\n    assert.deepEqual([stats.total, stats.recent], [0, 0]);\n  });\n\n  check(\"AI rates: automation and failure shares\", () => {\n    const rates = aiRates({ calls: 10, failed: 2, answers: 6, handoffs: 2 });\n    assert.equal(rates.automationRate, 0.75);\n    assert.equal(rates.failureRate, 0.2);\n  });\n\n  check(\"AI rates: no data gives null, never a division by zero\", () => {\n    const rates = aiRates({ calls: 0, failed: 0, answers: 0, handoffs: 0 });\n    assert.deepEqual(rates, { automationRate: null, failureRate: null });\n  });\n\n  check(\"percent and usd format or say why not\", () => {\n    assert.equal(percent(0.75), \"75%\");\n    assert.equal(percent(2 / 3), \"67%\");\n    assert.equal(percent(null), \"\u2014\");\n    assert.equal(usd(1.234), \"$1.23\");\n    assert.equal(usd(null), \"not priced\");\n    assert.equal(usd(Number.NaN), \"not priced\");\n  });\n\n  check(\"relative time buckets\", () => {\n    assert.equal(relativeTime(iso(NOW - 30 * 1000), NOW), \"just now\");\n    assert.equal(relativeTime(iso(NOW - 5 * MIN), NOW), \"5 min ago\");\n    assert.equal(relativeTime(iso(NOW - 3 * HOUR), NOW), \"3 h ago\");\n    assert.equal(relativeTime(iso(NOW - 50 * HOUR), NOW), \"2 d ago\");\n    assert.equal(relativeTime(iso(NOW + HOUR), NOW), \"just now\");\n  });\n\n  check(\"relative time: missing or broken dates give a dash\", () => {\n    assert.equal(relativeTime(null, NOW), \"\u2014\");\n    assert.equal(relativeTime(undefined, NOW), \"\u2014\");\n    assert.equal(relativeTime(\"garbage\", NOW), \"\u2014\");\n  });\n\n  check(\"humanize turns event keys into readable text\", () => {\n    assert.equal(humanize(\"ai_quality.check\"), \"Ai quality check\");\n    assert.equal(humanize(\"\"), \"\");\n  });\n\n  check(\"provider rows: sorted, flags left out, missing flag is not set\", () => {\n    const rows = providerRows({\n      flags: { configured: true },\n      llm: { configured: true },\n      email: { configured: false },\n      ai: {},\n    });\n    assert.deepEqual(rows, [\n      { group: \"ai\", configured: false },\n      { group: \"email\", configured: false },\n      { group: \"llm\", configured: true },\n    ]);\n    assert.deepEqual(providerRows(null), []);\n  });\n\n  check(\"provider labels: known names, own-key guard, fallback\", () => {\n    assert.equal(providerLabel(\"llm\"), \"Chat model (LLM)\");\n    assert.equal(providerLabel(\"unknown_group\"), \"Unknown group\");\n    assert.equal(providerLabel(\"constructor\"), \"Constructor\");\n  });\n\n  check(\"admin nav: nine sections, unique links, first is the dashboard\", () => {\n    assert.equal(ADMIN_NAV.length, 9);\n    assert.equal(ADMIN_NAV[0].href, \"/admin\");\n    assert.equal(new Set(ADMIN_NAV.map((i) => i.href)).size, 9);\n    assert.equal(new Set(ADMIN_NAV.map((i) => i.label)).size, 9);\n    for (const item of ADMIN_NAV) assert.ok(item.href.startsWith(\"/admin\"));\n  });\n\n  check(\"admin nav: every icon exists in the shared registry\", () => {\n    for (const item of ADMIN_NAV) assert.ok(ICON_NAMES.includes(item.icon), item.icon);\n  });\n\n  console.log(\"SUMMARY[admin_dashboard_harness]: \" + pass + \" PASS, \" + fail + \" FAIL\");\n  process.exitCode = fail === 0 ? 0 : 1;\n}\n\nmain();\n");

console.log("");
console.log("applied: " + applied + "  already: " + already + "  warnings: " + warnings);
console.log("Next: website only -> git add -A -> commit -> push (no Control Plane deploy).");
console.log("Harness 259r2: `node admin_dashboard_harness.mjs` now works without the flag on Node 22.6 or newer (the harness relaunches itself with --experimental-strip-types).");
console.log("Website only: `git add -A`, then nothing else. No Control Plane deploy, no bridge restart, no DB change.");