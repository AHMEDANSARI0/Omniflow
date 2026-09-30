// §213 Build fix: repairs relative imports whose "../" depth is wrong.
//
// Why: the §205 / §207 / §209 patchers wrote ten API route files with one
// "../" too many (e.g. app/api/omniflow/portal/bi/weekly-problems/send/
// route.ts imported "../../../../../../../../lib/omniflow/control-plane").
// Windows dev may not notice, but `npm run build` (Turbopack) fails with
// "Module not found". §211 re-writes those files correctly, but if the
// build runs before §211 lands (or a file drifted) the build breaks.
//
// What it does (generic, not a list of hard-coded files):
//   * scans app/, lib/, components/ (whatever exists) for .ts/.tsx/.js/.jsx/.mjs
//   * for every relative import (from "...", import("..."), require("..."))
//     that does NOT resolve to a real file - checked with EXACT letter case,
//     because Vercel builds on case-sensitive Linux -
//   * tries the same path with fewer/more "../" and rewrites the import only
//     when exactly ONE depth resolves. Anything ambiguous or unresolvable is
//     reported and left untouched.
//   * keeps the old copy as <file>.pre_import_fix_213.bak (first run only).
//
// Run from the website repo root (the folder with package.json and app/):
//     node tools/patchers/fix_import_depth_213.mjs
// Expected: "fixed: N files" first time, then "fixed: 0" on rerun.
// Safe to run at any point in the patcher sequence and as often as you like.
import fs from "fs";
import path from "path";

const BACKUP_TAG = ".pre_import_fix_213.bak";
const SCAN_ROOTS = ["app", "lib", "components", "hooks", "utils", "types", "src"];
const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", ".vercel", ".turbo", "dist", "build", "out", "coverage",
  "OmniFlow-Control-Plane", "omniflow-backend-patch",
]);
const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs)$/;
const RESOLVE_SUFFIXES = [
  "", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".scss",
  "/index.ts", "/index.tsx", "/index.js", "/index.jsx",
];
// from "x" | import("x") | import "x" | require("x") | export ... from "x"
const IMPORT_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'])(\.{1,2}\/[^"'\n]*)\2/g;

if (!fs.existsSync("package.json") || !fs.existsSync("app") || !fs.statSync("app").isDirectory()) {
  console.log("X Run this from the website repo root (the folder with package.json and app/). Nothing was written.");
  process.exit(1);
}
const ROOT = process.cwd();

const dirCache = new Map();
function listDir(dir) {
  if (!dirCache.has(dir)) {
    let names = null;
    try { names = new Set(fs.readdirSync(dir)); } catch { names = null; }
    dirCache.set(dir, names);
  }
  return dirCache.get(dir);
}
// Exact-case existence check, segment by segment, never above ROOT.
function isFileExact(abs) {
  const rel = path.relative(ROOT, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  let cur = ROOT;
  const parts = rel.split(path.sep);
  for (let i = 0; i < parts.length; i++) {
    const names = listDir(cur);
    if (!names || !names.has(parts[i])) return false;
    cur = path.join(cur, parts[i]);
  }
  try { return fs.statSync(cur).isFile(); } catch { return false; }
}
function resolves(fromDir, spec) {
  const base = path.resolve(fromDir, spec);
  return RESOLVE_SUFFIXES.some((s) => isFileExact(base + s));
}
function splitSpec(spec) {
  let rest = spec;
  let ups = 0;
  for (;;) {
    if (rest.startsWith("../")) { ups++; rest = rest.slice(3); continue; }
    if (rest.startsWith("./")) { rest = rest.slice(2); continue; }
    break;
  }
  return { ups, rest };
}
function candidateFor(fromDir, spec) {
  const { ups, rest } = splitSpec(spec);
  if (!rest || rest.startsWith(".")) return { fix: null, why: "unparseable" };
  const hits = [];
  const maxUps = ups + 3;
  for (let n = 0; n <= maxUps; n++) {
    if (n === ups) continue;
    const cand = n === 0 ? "./" + rest : "../".repeat(n) + rest;
    if (resolves(fromDir, cand)) hits.push(cand);
  }
  if (hits.length === 1) return { fix: hits[0], why: "" };
  return { fix: null, why: hits.length ? "ambiguous (" + hits.join(" | ") + ")" : "no matching file at any depth (missing file or letter-case mismatch?)" };
}
function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(path.join(dir, e.name), out);
    } else if (e.isFile() && CODE_FILE.test(e.name) && !e.name.includes(".bak")) {
      out.push(path.join(dir, e.name));
    }
  }
}

const files = [];
for (const r of SCAN_ROOTS) {
  if (fs.existsSync(r) && fs.statSync(r).isDirectory()) walk(path.join(ROOT, r), files);
}

let fixedFiles = 0, fixedImports = 0, unresolved = 0, failed = 0;
for (const abs of files) {
  const shown = path.relative(ROOT, abs).split(path.sep).join("/");
  let text;
  try { text = fs.readFileSync(abs, "utf8"); } catch (err) {
    console.log("X " + shown + " unreadable: " + err.message); failed++; continue;
  }
  const fromDir = path.dirname(abs);
  const changes = [];
  const next = text.replace(IMPORT_RE, (whole, lead, quote, spec) => {
    if (resolves(fromDir, spec)) return whole;
    const { fix, why } = candidateFor(fromDir, spec);
    if (!fix) {
      console.log("! " + shown + ": cannot fix \"" + spec + "\" - " + why);
      unresolved++;
      return whole;
    }
    changes.push(spec + "  ->  " + fix);
    return lead + quote + fix + quote;
  });
  if (!changes.length) continue;
  try {
    const backup = abs + BACKUP_TAG;
    if (!fs.existsSync(backup)) fs.copyFileSync(abs, backup);
    fs.writeFileSync(abs, next, "utf8");
  } catch (err) {
    console.log("X " + shown + " FAILED to write: " + err.message); failed++; continue;
  }
  fixedFiles++;
  fixedImports += changes.length;
  console.log("+ " + shown + " (old copy kept as " + BACKUP_TAG + ")");
  for (const c of changes) console.log("    " + c);
}

console.log("");
console.log("scanned: " + files.length + " files  fixed: " + fixedFiles + " files / " + fixedImports +
  " imports  unresolved: " + unresolved + "  failed: " + failed);
if (unresolved) {
  console.log("Unresolved imports point at files that do not exist here. Run the batch patchers in order");
  console.log("(205 -> D7 -> 207 -> 208 -> 209 -> 210 -> 211 -> 212), then run this fixer again.");
}
console.log("Next: npm run build. If it passes: git add -A -> commit -> push (website repo only; this fixer does not touch OmniFlow-Control-Plane).");
process.exit(failed ? 1 : 0);