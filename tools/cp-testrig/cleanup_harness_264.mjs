// §264 harness: checks the GitHub cleanup batch on fixed inputs - the final
// .gitignore keeps every known local-junk folder out (and keeps .env.example
// tracked), and the eslint 9 flat config is back. One PASS/FAIL line per
// check, then a SUMMARY line.
//
// It finds the website root (the folder that holds .gitignore and
// eslint.config.mjs) by looking in its own folder and then upward, so it
// runs from tools/cp-testrig/ in the repo and also when copied to the
// website root. OF_RIG_WEB_ROOT overrides the search. Node 22.6 to 22.17
// cannot load .ts files without --experimental-strip-types, so this file
// starts itself once more with that flag (guarded by OF_RIG_RELAUNCHED).
// A plain `node cleanup_harness_264.mjs` therefore works on every Node 22.6+
// install.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER_FILE = path.join("eslint.config.mjs");

function findWebRoot() {
  if (process.env.OF_RIG_WEB_ROOT) return path.resolve(process.env.OF_RIG_WEB_ROOT);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, MARKER_FILE))) {
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

const JUNK = [
  "/venv/",
  "/whatsapp_session/",
  "/_archive/",
  "/backups/",
  "/runtime_locks/",
  "/data/",
  "/.agents/",
  "/verify-script/",
];

function main() {
  const root = findWebRoot();
  if (!root) {
    console.log("FAIL  cannot find eslint.config.mjs (run from the repo or set OF_RIG_WEB_ROOT)");
    process.exitCode = 1;
    return;
  }
  const ignore = readFileSync(path.join(root, ".gitignore"), "utf8");
  const lines = ignore.split(/\r?\n/).map((line) => line.trim());

  check("every known junk folder is ignored", () => {
    for (const rule of JUNK) assert.ok(lines.includes(rule), rule + " missing");
  });

  check("the nested Control Plane repo is ignored", () => {
    assert.ok(lines.includes("OmniFlow-Control-Plane/"), "OmniFlow-Control-Plane/");
  });

  check(".env.example stays tracked (the un-ignore is the last word)", () => {
    const bang = lines.lastIndexOf("!.env.example");
    assert.ok(bang >= 0, "!.env.example missing");
    const reignore = lines.slice(bang + 1).findIndex((line) => line === ".env.example");
    assert.equal(reignore, -1, "a later .env.example line would re-ignore it");
    assert.ok(ignore.includes(".env*"), "the .env* catch-all is present");
  });

  check("the backup-tag ignore survives (pagespeed suite pins it)", () => {
    assert.ok(ignore.includes("*.pre_*.bak"));
  });

  check("the eslint 9 flat config is back and carries the marker", () => {
    const source = readFileSync(path.join(root, MARKER_FILE), "utf8");
    assert.ok(source.includes("defineConfig("), "defineConfig");
    assert.ok(source.includes("export default eslintConfig;"), "default export");
    assert.ok(source.includes("eslint-config-next/core-web-vitals"), "next vitals preset");
    assert.ok(source.includes("\u00a7264"), "marker");
  });

  check("the cleanup guide ships with the batch", () => {
    const guide = readFileSync(path.join(root, "docs", "GITHUB_CLEANUP_264.md"), "utf8");
    assert.ok(guide.includes("\u00a7264"), "marker");
    assert.ok(guide.includes("git rm -r --cached"), "the untrack commands are documented");
  });

  console.log("SUMMARY " + passed + " passed, " + failed + " failed");
  if (failed > 0) process.exitCode = 1;
}

if (!relaunchWithStripTypes()) {
  try {
    main();
  } catch (error) {
    console.log("FAIL  harness crashed - " + String(error && error.message).split("\n")[0]);
    process.exitCode = 1;
  }
}
