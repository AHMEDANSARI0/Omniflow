// OmniFlow batch 222 - GitHub repo cleanup (website repo + Control Plane repo).
//
// Run from the WEBSITE repo root (the bot root - the folder that contains OmniFlow-Control-Plane/):
//     node repo_cleanup_222.mjs              -> DRY RUN: lists what would change, writes nothing
//     node repo_cleanup_222.mjs --apply      -> does it (this machine)
//     node repo_cleanup_222.mjs --other-machine  -> on your OTHER machine, instead of a plain "git pull"
//
// What --apply does, in each repo (website, and OmniFlow-Control-Plane/ when it is a git repo):
//  * REMOVE  - junk that never belonged in git: *.bak / *.pre_*.bak backups, old patchers (*.mjs at the repo
//              root, tools/patchers/*.mjs), _archive/, verify-script/, the google test app.py, run_931_1010.sh,
//              test-message.json, .agents/, skills-lock.json, PATCHERS_TO_RUN/. Taken out of git AND moved to
//              .repo_cleanup_222_trash/ (ignored) - delete that folder yourself once you are happy.
//  * UNTRACK - private / runtime files the bot needs on this machine: venv/, whatsapp_session/ (WhatsApp login),
//              backups/ (database dumps), data/, runtime_locks/, oflow_service_key.txt, .connector_node.env,
//              .neon, *.dump, __pycache__, real .env files. Taken out of git only - they STAY on disk.
//  * .gitignore - rules so none of these is ever pushed again (incl. patchers dropped at the repo root).
//  Nothing is committed or pushed by this script. Staged changes must be committed first.
//
// Then:  website:  git add -A   -> git commit -m "Repo cleanup: remove junk and private runtime files" -> git push
//        CP:       cd OmniFlow-Control-Plane -> git add -A -> git commit -m "Repo cleanup" -> git push
// Other machine (BEFORE pulling): stop the WhatsApp bot, then  node repo_cleanup_222.mjs --other-machine
//   It moves the UNTRACK files aside, runs "git pull --ff-only" in both repos and puts them back, so the pull
//   cannot delete venv/ or the WhatsApp login there.
// Old copies stay in GitHub history. Rotate the service key and CONNECTOR_NODE_CREDENTIAL after pushing.
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const MODE = process.argv.includes("--apply") ? "apply"
  : process.argv.includes("--other-machine") ? "other" : "dry";
const TRASH = ".repo_cleanup_222_trash";
const KEEP = ".repo_cleanup_222_keep";
const MARK = "# repo cleanup 222";
const CONFIG_MJS = new Set(["postcss.config.mjs", "eslint.config.mjs", "next.config.mjs",
  "tailwind.config.mjs", "prettier.config.mjs"]);
const BACKUP_RE = /(\.bak|\.bak\.\d+|\.orig|\.rej)$/i;
const ENV_RE = /^\.env(\..+)?$/;

// ---------- rules ----------
// Each rule returns "remove" | "untrack" | "" for a tracked path (posix, repo-relative).
function websiteRule(p) {
  const top = p.split("/")[0];
  const base = p.split("/").pop();
  if (["venv", ".venv", "whatsapp_session", "whatsapp_sessions", "backups", "data", "runtime_locks"].includes(top)) return "untrack";
  if (!p.includes("/") && ["oflow_service_key.txt", ".connector_node.env", ".neon"].includes(p)) return "untrack";
  if (/\.dump(\.sha256)?$/i.test(p) || p.split("/").includes("__pycache__") || /\.py[cod]$/.test(p)) return "untrack";
  if (ENV_RE.test(base) && base !== ".env.example") return "untrack";
  if (["_archive", "verify-script", ".agents", "PATCHERS_TO_RUN", TRASH].includes(top)) return "remove";
  if (BACKUP_RE.test(base) || p.split("/").some((part) => /\.dir_conflict\.bak/.test(part))) return "remove";
  if (!p.includes("/") && p.endsWith(".mjs") && !CONFIG_MJS.has(p)) return "remove";
  if (/^tools\/patchers\/[^/]+\.mjs$/.test(p)) return "remove";
  if (["run_931_1010.sh", "test-message.json", "skills-lock.json"].includes(p)) return "remove";
  if (p === "app.py" && isGoogleTest()) return "remove";
  return "";
}

function cpRule(p) {
  const top = p.split("/")[0];
  const base = p.split("/").pop();
  if (["venv", ".venv"].includes(top)) return "untrack";
  if (/\.dump(\.sha256)?$/i.test(p) || p.split("/").includes("__pycache__") || /\.py[cod]$/.test(p) || /\.log$/i.test(p)) return "untrack";
  if (ENV_RE.test(base) && base !== ".env.example") return "untrack";
  if ([TRASH, "PATCHERS_TO_RUN"].includes(top)) return "remove";
  if (BACKUP_RE.test(base) || p.split("/").some((part) => /\.dir_conflict\.bak/.test(part))) return "remove";
  if (!p.includes("/") && p.endsWith(".mjs") && !CONFIG_MJS.has(p)) return "remove";
  return "";
}

let googleTest = null;
function isGoogleTest() {
  if (googleTest === null) {
    try {
      const text = fs.readFileSync("app.py", "utf8");
      googleTest = text.includes("VERSION 2 RUNNING") && text.includes("google.com") && text.length < 2000;
    } catch {
      googleTest = false;
    }
  }
  return googleTest;
}

const WEBSITE_IGNORE = [
  MARK + " - never commit these again",
  "/venv/", "/.venv/", "/whatsapp_session/", "/backups/", "/data/", "/runtime_locks/",
  "/oflow_service_key.txt", "/.connector_node.env", "/.neon", "*.dump", "*.dump.sha256",
  "*.bak", "*.bak.*", "*.orig", "*.rej", "/_archive/", "/verify-script/", "/.agents/", "/skills-lock.json",
  "/PATCHERS_TO_RUN/", "/tools/patchers/*.mjs", "/" + TRASH + "/", "/" + KEEP + "/",
  "/*.mjs", "!/postcss.config.mjs", "!/eslint.config.mjs", "!/next.config.mjs",
];
const CP_IGNORE = [
  MARK + " - never commit these again",
  "__pycache__/", "*.py[cod]", "/venv/", "/.venv/", ".env", ".env.*", "!.env.example", "*.dump", "*.log",
  "*.bak", "*.bak.*", "*.orig", "*.rej", "/*.mjs", "/PATCHERS_TO_RUN/", "/" + TRASH + "/", "/" + KEEP + "/",
];

// ---------- helpers ----------
function git(cwd, args, opts = {}) {
  const result = spawnSync("git", ["--literal-pathspecs", ...args], {
    cwd, encoding: opts.binary ? "buffer" : "utf8", maxBuffer: 512 * 1024 * 1024,
    input: opts.input, stdio: opts.inherit ? "inherit" : undefined,
  });
  if (result.error) throw new Error("git is not available: " + result.error.message);
  return result;
}

function isRepo(dir) {
  if (!fs.existsSync(path.join(dir, ".git"))) return false;
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  return top.status === 0 && path.resolve(top.stdout.trim()) === path.resolve(dir);
}

function tracked(dir) {
  // -s: skip gitlinks (mode 160000), keep real files only.
  const out = git(dir, ["ls-files", "-s", "-z"], { binary: true });
  if (out.status !== 0) throw new Error("git ls-files failed in " + dir);
  return out.stdout.toString("utf8").split("\0").filter(Boolean)
    .map((line) => line.split("\t")).filter(([meta]) => !meta.startsWith("160000"))
    .map(([, p]) => p);
}

function size(dir, p) {
  try { return fs.statSync(path.join(dir, p)).size; } catch { return 0; }
}

function plan(dir, rule) {
  const groups = { remove: [], untrack: [] };
  for (const p of tracked(dir)) {
    const kind = rule(p);
    if (kind) groups[kind].push(p);
  }
  return groups;
}

function summarise(label, dir, list) {
  if (!list.length) return;
  const byTop = new Map();
  for (const p of list) {
    const parts = p.split("/");
    const key = parts.length > 2 && ["venv", "whatsapp_session", "_archive", ".venv"].includes(parts[0])
      ? parts[0] + "/" : parts.length > 1 ? parts.slice(0, -1).join("/") + "/" : p;
    const entry = byTop.get(key) || { files: 0, bytes: 0 };
    entry.files += 1;
    entry.bytes += size(dir, p);
    byTop.set(key, entry);
  }
  let total = 0;
  for (const v of byTop.values()) total += v.bytes;
  console.log("  " + label + ": " + list.length + " files, " + (total / 1048576).toFixed(1) + " MB");
  for (const [key, v] of [...byTop.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 25)) {
    console.log("     " + String(v.files).padStart(5) + " files  " + (v.bytes / 1024).toFixed(0).padStart(7) + " KB  " + key);
  }
  if (byTop.size > 25) console.log("     ... and " + (byTop.size - 25) + " more folders");
}

function rmCached(dir, list) {
  for (let i = 0; i < list.length; i += 2000) {
    const chunk = list.slice(i, i + 2000);
    const r = git(dir, ["rm", "-r", "-q", "--cached", "--ignore-unmatch",
      "--pathspec-from-file=-", "--pathspec-file-nul"], { input: chunk.join("\0") + "\0" });
    if (r.status !== 0) throw new Error("git rm --cached failed in " + dir + ": " + (r.stderr || "").trim());
  }
}

function moveToTrash(dir, list, trashRoot) {
  let moved = 0;
  for (const p of list) {
    const from = path.join(dir, p);
    if (!fs.existsSync(from)) continue;
    let to = path.join(trashRoot, p);
    let n = 1;
    while (fs.existsSync(to)) { to = path.join(trashRoot, p) + "." + n; n++; }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    moved++;
  }
  // drop folders left empty by the move (never folders that still hold anything)
  const dirs = [...new Set(list.map((p) => path.dirname(p)).filter((d) => d !== "."))]
    .sort((a, b) => b.length - a.length);
  for (const d of dirs) {
    let cur = d;
    while (cur && cur !== ".") {
      try { fs.rmdirSync(path.join(dir, cur)); } catch { break; }
      cur = path.dirname(cur);
    }
  }
  return moved;
}

// Delete a folder only if it holds nothing but (nested) empty folders.
function removeEmptyTree(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) if (entry.isDirectory()) removeEmptyTree(path.join(dir, entry.name));
  try { fs.rmdirSync(dir); } catch { /* still holds files - keep it */ }
}

function ensureIgnore(dir, lines) {
  const file = path.join(dir, ".gitignore");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (text.includes(MARK)) return false;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const sep = text && !text.endsWith("\n") ? eol : "";
  fs.writeFileSync(file, text + sep + eol + lines.join(eol) + eol);
  return true;
}

// ---------- main ----------
const ROOT = process.cwd();
if (!isRepo(ROOT) || !fs.existsSync(path.join(ROOT, "package.json"))) {
  console.log("X Run this from the website repo root (bot root - the folder with package.json and .git). Nothing was written.");
  process.exit(1);
}
const repos = [{ name: "website", dir: ROOT, rule: websiteRule, ignore: WEBSITE_IGNORE, trash: path.join(ROOT, TRASH, "website") }];
const CPDIR = path.join(ROOT, "OmniFlow-Control-Plane");
if (isRepo(CPDIR)) {
  repos.push({ name: "Control Plane (OmniFlow-Control-Plane/)", dir: CPDIR, rule: cpRule, ignore: CP_IGNORE, trash: path.join(ROOT, TRASH, "control-plane") });
} else {
  console.log("! OmniFlow-Control-Plane/ is not a git repo here - only the website repo is cleaned.");
}

if (MODE === "other") {
  // Move UNTRACK paths aside, pull, put them back: a pull that removes them from git never deletes them here.
  let failed = false;
  for (const repo of repos) {
    const keepRoot = path.join(repo.dir, KEEP);
    const roots = [...new Set(plan(repo.dir, repo.rule).untrack.map((p) => {
      const top = p.split("/")[0];
      return ["venv", ".venv", "whatsapp_session", "whatsapp_sessions", "backups", "data", "runtime_locks"].includes(top) ? top : p;
    }))].filter((p) => fs.existsSync(path.join(repo.dir, p)));
    const moved = [];
    console.log("== " + repo.name + ": protecting " + roots.length + " paths during the pull");
    try {
      for (const p of roots) {
        const to = path.join(keepRoot, p);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(path.join(repo.dir, p), to);
        moved.push(p);
      }
      const pull = git(repo.dir, ["pull", "--ff-only"], { inherit: true });
      if (pull.status !== 0) { failed = true; console.log("X git pull failed in " + repo.name + " (see above)."); }
    } catch (error) {
      failed = true;
      console.log("X " + error.message + " - is the WhatsApp bot still running? Stop it and run this again.");
    } finally {
      for (const p of moved.reverse()) {
        const back = path.join(repo.dir, p);
        if (fs.existsSync(back)) { console.log("! " + p + " came back from the pull - your copy is kept in " + KEEP + "/" + p); continue; }
        fs.mkdirSync(path.dirname(back), { recursive: true });
        fs.renameSync(path.join(keepRoot, p), back);
      }
      removeEmptyTree(keepRoot);
    }
    if (failed) break;
  }
  console.log(failed ? "Stopped. Your files are back in place." : "Done. Pulled the cleanup and kept venv/, the WhatsApp login and the other private files.");
  process.exit(failed ? 1 : 0);
}

let changes = 0;
for (const repo of repos) {
  const staged = git(repo.dir, ["diff", "--cached", "--quiet"]);
  if (MODE === "apply" && staged.status !== 0) {
    console.log("X " + repo.name + " has staged changes. Commit them first, then run this again. Nothing was written.");
    process.exit(1);
  }
}
for (const repo of repos) {
  const groups = plan(repo.dir, repo.rule);
  console.log("\n== " + repo.name);
  summarise("REMOVE (out of git, moved to " + TRASH + "/)", repo.dir, groups.remove);
  summarise("UNTRACK (out of git, stays on this machine)", repo.dir, groups.untrack);
  const ignoreText = fs.existsSync(path.join(repo.dir, ".gitignore")) ? fs.readFileSync(path.join(repo.dir, ".gitignore"), "utf8") : "";
  const needIgnore = !ignoreText.includes(MARK);
  if (!groups.remove.length && !groups.untrack.length && !needIgnore) { console.log("  already clean"); continue; }
  if (needIgnore) console.log("  .gitignore: add " + (repo.ignore.length - 1) + " rules");
  if (MODE !== "apply") continue;
  rmCached(repo.dir, [...groups.remove, ...groups.untrack]);
  const moved = moveToTrash(repo.dir, groups.remove, repo.trash);
  const ignored = ensureIgnore(repo.dir, repo.ignore);
  changes += groups.remove.length + groups.untrack.length + (ignored ? 1 : 0);
  console.log("  done: " + (groups.remove.length + groups.untrack.length) + " files out of git, " + moved + " moved to the trash" + (ignored ? ", .gitignore updated" : ""));
}

if (MODE === "dry") {
  console.log("\nDRY RUN - nothing was written. Check the list, then run:  node repo_cleanup_222.mjs --apply");
} else if (changes) {
  console.log("\nNext:");
  console.log("  website:  git add -A  ->  git commit -m \"Repo cleanup: remove junk and private runtime files\"  ->  git push");
  if (repos.length > 1) console.log("  CP:       cd OmniFlow-Control-Plane  ->  git add -A  ->  git commit -m \"Repo cleanup\"  ->  git push");
  console.log("  Other machine: stop the WhatsApp bot, then  node repo_cleanup_222.mjs --other-machine  (instead of git pull)");
  console.log("  Then rotate the service key and CONNECTOR_NODE_CREDENTIAL (old copies stay in GitHub history).");
  console.log("  When happy, delete the " + TRASH + "/ folder.");
} else {
  console.log("\nAlready clean - nothing to do.");
}