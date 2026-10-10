// §263 harness: checks the finish batch on fixed inputs - the admin nav now
// carries Client billing, the shared active-link rule highlights exactly one
// item (deepest match on a full path segment), the icon registry knows
// "credit-card", and the analytics privacy copy no longer claims a
// site-wide "no local storage" it cannot keep. One PASS/FAIL line per check,
// then a SUMMARY line.
//
// It finds the website root (the folder that holds lib/omniflow/admin-nav.ts)
// by looking in its own folder and then upward, so it runs from tools/cp-testrig/
// in the repo and also when copied to the website root. OF_RIG_WEB_ROOT
// overrides the search. Node 22.6 to 22.17 cannot load .ts files without
// --experimental-strip-types, so this file starts itself once more with that
// flag (guarded by OF_RIG_RELAUNCHED). A plain `node finish_harness_263.mjs`
// therefore works on every Node 22.6+ install.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NAV_HELPER = path.join("lib", "omniflow", "admin-nav.ts");
const ICON_TYPES = path.join("lib", "marketing", "types.ts");
const ANALYTICS_PAGE = path.join("app", "admin", "(panel)", "analytics", "page.tsx");

function findWebRoot() {
  if (process.env.OF_RIG_WEB_ROOT) return path.resolve(process.env.OF_RIG_WEB_ROOT);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, NAV_HELPER))) {
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
    console.log("FAIL  cannot find lib/omniflow/admin-nav.ts (run from the repo or set OF_RIG_WEB_ROOT)");
    process.exitCode = 1;
    return;
  }
  let nav;
  let types;
  try {
    nav = await import(pathToFileURL(path.join(root, NAV_HELPER)).href);
    types = await import(pathToFileURL(path.join(root, ICON_TYPES)).href);
  } catch (error) {
    console.log("FAIL  cannot load the admin nav helpers under " + root + " - " + error.code);
    process.exitCode = 1;
    return;
  }

  check("the nav has one Client billing entry with the expected shape", () => {
    const billing = nav.ADMIN_NAV.filter((item) => item.href === "/admin/customers/billing");
    assert.equal(billing.length, 1, "exactly one Client billing entry");
    assert.equal(billing[0].label, "Client billing");
    assert.equal(billing[0].icon, "credit-card");
    assert.equal(billing[0].enabled, true);
    assert.ok(billing[0].description.length > 0, "description is not empty");
  });

  check("Client billing sits right after Customers in the nav order", () => {
    const customersIndex = nav.ADMIN_NAV.findIndex((item) => item.href === "/admin/customers");
    const billingIndex = nav.ADMIN_NAV.findIndex((item) => item.href === "/admin/customers/billing");
    assert.ok(customersIndex >= 0, "Customers entry exists");
    assert.equal(billingIndex, customersIndex + 1);
  });

  check("every nav item has a unique href and a known icon", () => {
    const hrefs = nav.ADMIN_NAV.map((item) => item.href);
    assert.equal(new Set(hrefs).size, hrefs.length, "no duplicate hrefs");
    const known = new Set(types.ICON_NAMES);
    for (const item of nav.ADMIN_NAV) {
      assert.ok(known.has(item.icon), item.href + " uses unknown icon " + item.icon);
      assert.ok(typeof item.enabled === "boolean", item.href + " enabled is a boolean");
    }
    assert.ok(known.has("credit-card"), "the icon registry knows credit-card");
  });

  check("the dashboard root highlights only the Dashboard item", () => {
    assert.equal(nav.activeAdminHref("/admin"), "/admin");
  });

  check("a top-level section highlights itself", () => {
    for (const href of ["/admin/analytics", "/admin/customers", "/admin/settings", "/admin/ai-router"]) {
      assert.equal(nav.activeAdminHref(href), href, href);
    }
  });

  check("the billing page highlights Client billing, not Customers", () => {
    assert.equal(nav.activeAdminHref("/admin/customers/billing"), "/admin/customers/billing");
  });

  check("a deeper billing page still highlights Client billing", () => {
    assert.equal(nav.activeAdminHref("/admin/customers/billing/detail"), "/admin/customers/billing");
  });

  check("matches stop at a full path segment", () => {
    assert.equal(nav.activeAdminHref("/admin/customers-x"), null);
    assert.equal(nav.activeAdminHref("/adminx"), null);
    assert.equal(nav.activeAdminHref("/"), null);
  });

  check("the analytics privacy copy is scoped to the measurement", () => {
    const source = readFileSync(path.join(root, ANALYTICS_PAGE), "utf8");
    assert.ok(!source.includes("No cookies or local storage."), "the site-wide claim is gone");
    assert.ok(source.includes("This measurement sets no cookies and uses no local storage."), "the scoped claim is present");
  });

  console.log("SUMMARY " + passed + " passed, " + failed + " failed");
  if (failed > 0) process.exitCode = 1;
}

if (!relaunchWithStripTypes()) {
  main().catch((error) => {
    console.log("FAIL  harness crashed - " + String(error && error.message).split("\n")[0]);
    process.exitCode = 1;
  });
}
