// §259 harness: runs the admin dashboard helpers and the shared admin nav on
// fixed inputs. One PASS/FAIL line per check, then a SUMMARY line.
//
// It finds the website root (the folder that holds lib/omniflow/admin-dashboard.ts)
// by looking in its own folder and then upward, so it runs from tools/cp-testrig/
// in the repo and also when copied to the website root (the bot root on the
// laptop). OF_RIG_WEB_ROOT overrides the search.
// §259r2: Node 22.6 to 22.17 cannot load .ts files without --experimental-strip-types.
// Then the harness starts itself once more with that flag, so a plain
// `node admin_dashboard_harness.mjs` works on every Node 22.6+ install.
//
// Run from any folder (Node 22.6+ needs the flag to import .ts files):
//   node --experimental-strip-types --no-warnings admin_dashboard_harness.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HELPER = path.join("lib", "omniflow", "admin-dashboard.ts");

function findWebRoot() {
  if (process.env.OF_RIG_WEB_ROOT) return path.resolve(process.env.OF_RIG_WEB_ROOT);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, HELPER))) {
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return dir;
}

async function loadHelpers(root) {
  const at = (file) => pathToFileURL(path.join(root, file)).href;
  const dashboard = await import(at(HELPER));
  const nav = await import(at(path.join("lib", "omniflow", "admin-nav.ts")));
  const types = await import(at(path.join("lib", "marketing", "types.ts")));
  return { ...dashboard, ADMIN_NAV: nav.ADMIN_NAV, ICON_NAMES: types.ICON_NAMES };
}

const NOW = Date.parse("2026-10-09T12:00:00Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

// Runs this same file again with the strip-types flag. The child prints the checks
// and sets the exit code. OF_RIG_RELAUNCHED stops a loop if a Node build ignores the flag.
function relaunchWithStripTypes() {
  if (process.env.OF_RIG_RELAUNCHED === "1") return false;
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 6)) {
    console.log("FAIL  Node 22.6 or newer is needed (this is " + process.version + ")");
    process.exitCode = 1;
    return true;
  }
  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, OF_RIG_RELAUNCHED: "1" } },
  );
  if (child.error) return false;
  process.exitCode = child.status === null ? 1 : child.status;
  return true;
}

async function main() {
  // Node prints a typeless-package notice when it loads the .ts helpers. The harness
  // prints only its own PASS/FAIL lines, so that notice is switched off here.
  process.removeAllListeners("warning");
  const root = findWebRoot();
  if (root === null) {
    console.log("FAIL  lib/omniflow/admin-dashboard.ts not found in this folder or above it");
    console.log("      Apply PATCHERS_TO_RUN/admin_polish_259.mjs in the website repo root, or set OF_RIG_WEB_ROOT.");
    process.exitCode = 1;
    return;
  }
  let helpers;
  try {
    helpers = await loadHelpers(root);
  } catch (error) {
    if (error && error.code === "ERR_UNKNOWN_FILE_EXTENSION" && relaunchWithStripTypes()) return;
    console.log("FAIL  cannot load the TypeScript helpers under " + root + " :: " + String(error.code || error.message).split("\n")[0]);
    console.log("      Run with: node --experimental-strip-types --no-warnings admin_dashboard_harness.mjs");
    process.exitCode = 1;
    return;
  }
  const {
    aiRates,
    humanize,
    leadStats,
    percent,
    problemRows,
    providerLabel,
    providerRows,
    relativeTime,
    signalLabel,
    usd,
    workspaceName,
    ADMIN_NAV,
    ICON_NAMES,
  } = helpers;

  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try {
      fn();
      pass += 1;
      console.log("PASS " + name);
    } catch (error) {
      fail += 1;
      console.log("FAIL " + name + " :: " + String(error.message).split("\n")[0]);
    }
  }

  check("problems: clean workspaces are left out", () => {
    const rows = problemRows([
      { client_id: 1, name: "Clean", email: "c@x", failed: 0, open_escalations: 0, pending_approvals: 0, blocked: 0 },
    ]);
    assert.equal(rows.length, 0);
  });

  check("problems: most kinds of signal first, then most events", () => {
    const rows = problemRows([
      { client_id: 3, name: "Zed", email: "", failed: 50, open_escalations: 0, pending_approvals: 0 },
      { client_id: 2, name: "", email: "b@x", failed: 3, open_escalations: 1, pending_approvals: 0, blocked: 0 },
      { client_id: 4, name: "Beta", email: "", failed: 1, open_escalations: 0, pending_approvals: 2, blocked: 1 },
    ]);
    assert.deepEqual(rows.map((r) => r.client_id), [4, 2, 3]);
  });

  check("problems: signals keep a fixed order and drop zeros", () => {
    const [row] = problemRows([
      { client_id: 4, name: "Beta", email: "", failed: 1, open_escalations: 0, pending_approvals: 2, blocked: 1 },
    ]);
    assert.deepEqual(
      row.signals.map((s) => [s.kind, s.count]),
      [["failed_calls", 1], ["pending_approvals", 2], ["blocked_attempts", 1]]
    );
    assert.equal(row.total, 4);
  });

  check("problems: name falls back to email, then to the id", () => {
    const rows = problemRows([
      { client_id: 2, name: "", email: "b@x", failed: 1, open_escalations: 0, pending_approvals: 0 },
      { client_id: 9, name: "", email: "", failed: 1, open_escalations: 0, pending_approvals: 0 },
    ]);
    assert.deepEqual(rows.map((r) => r.name).sort(), ["Workspace #9", "b@x"]);
  });

  check("problems: bad numbers count as zero, decimals round down", () => {
    const [row] = problemRows([
      { client_id: 5, name: "Odd", email: "", failed: "2.7", open_escalations: -4, pending_approvals: "abc", blocked: null },
    ]);
    assert.deepEqual(row.signals, [{ kind: "failed_calls", count: 2 }]);
  });

  check("signal labels are singular and plural", () => {
    assert.equal(signalLabel({ kind: "failed_calls", count: 1 }), "1 AI call failed");
    assert.equal(signalLabel({ kind: "failed_calls", count: 3 }), "3 AI calls failed");
    assert.equal(signalLabel({ kind: "open_escalations", count: 1 }), "1 open escalation");
    assert.equal(signalLabel({ kind: "pending_approvals", count: 2 }), "2 approvals waiting");
    assert.equal(signalLabel({ kind: "blocked_attempts", count: 1 }), "1 blocked attempt");
  });

  check("workspace name: business name, email, then id", () => {
    assert.equal(workspaceName({ client_id: 7, name: "Acme", email: "a@x" }), "Acme");
    assert.equal(workspaceName({ client_id: 7, name: "", email: "a@x" }), "a@x");
    assert.equal(workspaceName({ client_id: 7, name: "", email: "" }), "Workspace #7");
  });

  check("leads: window count ignores bad dates, status buckets are complete", () => {
    const stats = leadStats(
      [
        { status: "new", created_at: iso(NOW - 1 * DAY) },
        { status: "contacted", created_at: iso(NOW - 10 * DAY) },
        { status: "closed", created_at: "not-a-date" },
        { status: "weird", created_at: iso(NOW - 2 * HOUR) },
      ],
      NOW,
      7
    );
    assert.equal(stats.total, 4);
    assert.equal(stats.recent, 2);
    assert.deepEqual(stats.byStatus, { new: 1, contacted: 1, closed: 1, other: 1 });
  });

  check("leads: an empty list is all zeros", () => {
    const stats = leadStats([], NOW, 30);
    assert.deepEqual([stats.total, stats.recent], [0, 0]);
  });

  check("AI rates: automation and failure shares", () => {
    const rates = aiRates({ calls: 10, failed: 2, answers: 6, handoffs: 2 });
    assert.equal(rates.automationRate, 0.75);
    assert.equal(rates.failureRate, 0.2);
  });

  check("AI rates: no data gives null, never a division by zero", () => {
    const rates = aiRates({ calls: 0, failed: 0, answers: 0, handoffs: 0 });
    assert.deepEqual(rates, { automationRate: null, failureRate: null });
  });

  check("percent and usd format or say why not", () => {
    assert.equal(percent(0.75), "75%");
    assert.equal(percent(2 / 3), "67%");
    assert.equal(percent(null), "—");
    assert.equal(usd(1.234), "$1.23");
    assert.equal(usd(null), "not priced");
    assert.equal(usd(Number.NaN), "not priced");
  });

  check("relative time buckets", () => {
    assert.equal(relativeTime(iso(NOW - 30 * 1000), NOW), "just now");
    assert.equal(relativeTime(iso(NOW - 5 * MIN), NOW), "5 min ago");
    assert.equal(relativeTime(iso(NOW - 3 * HOUR), NOW), "3 h ago");
    assert.equal(relativeTime(iso(NOW - 50 * HOUR), NOW), "2 d ago");
    assert.equal(relativeTime(iso(NOW + HOUR), NOW), "just now");
  });

  check("relative time: missing or broken dates give a dash", () => {
    assert.equal(relativeTime(null, NOW), "—");
    assert.equal(relativeTime(undefined, NOW), "—");
    assert.equal(relativeTime("garbage", NOW), "—");
  });

  check("humanize turns event keys into readable text", () => {
    assert.equal(humanize("ai_quality.check"), "Ai quality check");
    assert.equal(humanize(""), "");
  });

  check("provider rows: sorted, flags left out, missing flag is not set", () => {
    const rows = providerRows({
      flags: { configured: true },
      llm: { configured: true },
      email: { configured: false },
      ai: {},
    });
    assert.deepEqual(rows, [
      { group: "ai", configured: false },
      { group: "email", configured: false },
      { group: "llm", configured: true },
    ]);
    assert.deepEqual(providerRows(null), []);
  });

  check("provider labels: known names, own-key guard, fallback", () => {
    assert.equal(providerLabel("llm"), "Chat model (LLM)");
    assert.equal(providerLabel("unknown_group"), "Unknown group");
    assert.equal(providerLabel("constructor"), "Constructor");
  });

  // §260 added Website analytics, §263 adds Client billing: eleven sections now.
  check("admin nav: eleven sections, unique links, first is the dashboard", () => {
    assert.equal(ADMIN_NAV.length, 11);
    assert.equal(ADMIN_NAV[0].href, "/admin");
    assert.equal(new Set(ADMIN_NAV.map((i) => i.href)).size, 11);
    assert.equal(new Set(ADMIN_NAV.map((i) => i.label)).size, 11);
    for (const item of ADMIN_NAV) assert.ok(item.href.startsWith("/admin"));
  });

  check("admin nav: every icon exists in the shared registry", () => {
    for (const item of ADMIN_NAV) assert.ok(ICON_NAMES.includes(item.icon), item.icon);
  });

  console.log("SUMMARY[admin_dashboard_harness]: " + pass + " PASS, " + fail + " FAIL");
  process.exitCode = fail === 0 ? 0 : 1;
}

main();
