// §261 harness: runs the client billing helpers (labels, money text, tone) on fixed
// inputs. One PASS/FAIL line per check, then a SUMMARY line.
//
// It finds the website root (the folder that holds lib/omniflow/admin-billing-core.ts)
// by looking in its own folder and then upward, so it runs from tools/cp-testrig/ in
// the repo and also when copied to the website root. OF_RIG_WEB_ROOT overrides the search.
// Node 22.6 to 22.17 cannot load .ts files without --experimental-strip-types, so this
// file starts itself once more with that flag (guarded by OF_RIG_RELAUNCHED). A plain
// `node billing_harness_261.mjs` therefore works on every Node 22.6+ install.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HELPER = path.join("lib", "omniflow", "admin-billing-core.ts");

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
    { stdio: "inherit", env: { ...process.env, OF_RIG_RELAUNCHED: "1" } }
  );
  process.exitCode = child.status ?? 1;
  return true;
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("PASS  " + name);
  } catch (error) {
    failed += 1;
    console.log("FAIL  " + name + " - " + String(error.message).split("\n")[0]);
  }
}

async function main() {
  const root = findWebRoot();
  if (!root) {
    console.log("FAIL  cannot find lib/omniflow/admin-billing-core.ts (run from the repo or set OF_RIG_WEB_ROOT)");
    process.exitCode = 1;
    return;
  }
  let core;
  try {
    core = await import(pathToFileURL(path.join(root, HELPER)).href);
  } catch (error) {
    console.log("FAIL  cannot load the billing helpers under " + root + " - " + error.code);
    process.exitCode = 1;
    return;
  }

  check("every billing kind has a label, and the labels differ", () => {
    const labels = core.BILLING_KINDS.map((kind) => core.kindLabel(kind));
    assert.equal(new Set(labels).size, core.BILLING_KINDS.length);
    for (const label of labels) assert.ok(label.length > 0);
  });

  check("commission bases, expiry modes and expiry states all have labels", () => {
    for (const base of core.COMMISSION_BASES) assert.ok(core.commissionBaseLabel(base).length > 0, base);
    for (const mode of core.EXPIRY_MODES) assert.ok(core.expiryModeLabel(mode).length > 0, mode);
    for (const state of core.EXPIRY_STATES) assert.ok(core.expiryStateLabel(state).length > 0, state);
  });

  check("the three commission bases are the owner's three options", () => {
    assert.deepEqual([...core.COMMISSION_BASES], ["paid_before_cancel", "paid_net", "delivered"]);
  });

  check("the three expiry modes are flag, grace then Free, and Free at once", () => {
    assert.deepEqual([...core.EXPIRY_MODES], ["flag", "grace_then_free", "free_now"]);
  });

  check("expiry tones: dropped and expired are bad, grace and soon are warn", () => {
    assert.equal(core.expiryTone("dropped_free"), "bad");
    assert.equal(core.expiryTone("expired"), "bad");
    assert.equal(core.expiryTone("grace"), "warn");
    assert.equal(core.expiryTone("expiring_soon"), "warn");
    assert.equal(core.expiryTone("active"), "ok");
    assert.equal(core.expiryTone("none"), "muted");
  });

  check("money uses the saved currency code and two decimals", () => {
    const text = core.formatMoney(1234.5, "PKR");
    assert.ok(text.includes("PKR"), text);
    assert.ok(text.includes("1,234.50"), text);
  });

  check("money with a zero amount still shows two decimals", () => {
    assert.ok(core.formatMoney(0, "PKR").includes("0.00"));
  });

  check("an unusable currency code falls back to the plain number", () => {
    assert.equal(core.formatMoney(12, "P1"), "P1 12.00");
  });

  check("hasPaymentDue is true only above zero", () => {
    const client = { payment_pending: 0 };
    assert.equal(core.hasPaymentDue(client), false);
    assert.equal(core.hasPaymentDue({ payment_pending: 0.01 }), true);
  });

  if (failed === 0) {
    console.log("SUMMARY " + passed + " passed, 0 failed");
  } else {
    console.log("SUMMARY " + passed + " passed, " + failed + " failed");
    process.exitCode = 1;
  }
}

if (!relaunchWithStripTypes()) {
  await main();
}
