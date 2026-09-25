// fix_deep_imports.mjs — hotfix: repair relative import depth in two BFF routes.
//
// Vercel "Module not found" build failure: app/api/omniflow/portal/broadcasts/
// preview/route.ts and app/api/omniflow/portal/csat/summary/route.ts sit one
// directory deeper than the route whose import block they were templated from,
// so their three relative imports pointed at app/lib/... instead of the repo
// root lib/. This adds the missing "../" level to exactly those three imports
// in each file, then re-verifies EVERY relative import in the whole app.
//
// Zero runtime changes — imports only. No bot restart needed.
//
// Run from the bot ROOT (folder containing Omniflow/):
//   node fix_deep_imports.mjs
//
// Expected first run: 6 imports repaired across 2 files, final check 0 broken.
// Expected rerun:     0 repaired (already correct), final check 0 broken.

import fs from "node:fs";
import path from "node:path";

const TARGETS = [
  {
    file: "Omniflow/app/api/omniflow/portal/broadcasts/preview/route.ts",
    depth: 6,
  },
  {
    file: "Omniflow/app/api/omniflow/portal/csat/summary/route.ts",
    depth: 6,
  },
];

const WRONG = '"../../../../../lib/'; // 5 levels  -> resolves to app/lib (broken)
const RIGHT_HEAD = '"../../../../../../lib/'; // 6 levels -> repo root (correct)

let repaired = 0;
let filesFixed = 0;

for (const target of TARGETS) {
  if (!fs.existsSync(target.file)) {
    console.log("SKIP (file not found): " + target.file);
    continue;
  }
  const original = fs.readFileSync(target.file, "utf8");
  const text = original.replace(/\r\n/g, "\n");
  const hits = text.split(WRONG).length - 1;
  if (hits === 0) {
    console.log("= " + target.file + " (already correct)");
    continue;
  }
  const backup = target.file + ".pre_fix.bak";
  if (!fs.existsSync(backup)) fs.copyFileSync(target.file, backup);
  fs.writeFileSync(target.file, text.split(WRONG).join(RIGHT_HEAD), "utf8");
  repaired += hits;
  filesFixed++;
  console.log("+ " + target.file + " (" + hits + " imports repaired)");
}

// Full-app resolution check: every relative import in app/ and lib/ must
// point at a file that exists. This is the check the earlier tooling skipped.
const EXTENSIONS = ["", ".ts", ".tsx", ".d.ts", "/index.ts", "/index.tsx"];
let checked = 0;
let broken = 0;

function resolves(fromDir, spec) {
  const base = path.resolve(fromDir, spec);
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return true;
  }
  return false;
}

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(entry.name)) checkFile(full);
  }
}

function checkFile(file) {
  const src = fs.readFileSync(file, "utf8");
  const re = /from\s+["'](\.\.?\/[^"']+)["']/g;
  let match;
  while ((match = re.exec(src)) !== null) {
    checked++;
    if (!resolves(path.dirname(file), match[1])) {
      broken++;
      console.log("  STILL BROKEN " + path.join(file) + " :: " + match[1]);
    }
  }
}

walk("Omniflow/app");
walk("Omniflow/lib");

console.log("");
console.log(
  "SUMMARY: " +
    repaired +
    " imports repaired across " +
    filesFixed +
    " files"
);
console.log(
  "RESOLUTION CHECK: " +
    checked +
    " relative imports checked, " +
    broken +
    " broken" +
    (broken === 0 ? " — build should pass now" : " — DO NOT PUSH, report this output")
);