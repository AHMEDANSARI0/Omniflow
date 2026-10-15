#!/usr/bin/env node
/**
 * build-portal-patch.mjs — builds the SINGLE-FILE portal patch script (v3).
 *
 * Inputs (canonical):
 *   /home/user/Omniflow                    (website portal files, working tree)
 *   /home/user/Omniflow/omniflow-backend-patch/     (backend portal files)
 *
 * Output:
 *   /home/user/omniflow_portal_setup.mjs   (self-verifying, chunked payload)
 */
import fs from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";

const WEBSITE_ROOT = "/home/user/Omniflow";
const BACKEND_ROOT = "/home/user/Omniflow/omniflow-backend-patch";
const OUT = "/home/user/Omniflow/omniflow_portal_setup.mjs";

const WEBSITE_PATHS = [
  "app/api/omniflow/portal/api-key/route.ts",
  "app/api/omniflow/portal/bot/route.ts",
  "app/api/omniflow/portal/channels/whatsapp/route.ts",
  "app/api/omniflow/portal/conversations/[id]/route.ts",
  "app/api/omniflow/portal/conversations/route.ts",
  "app/api/omniflow/portal/profile/route.ts",
  "app/dashboard/(portal)/bot/BotForm.tsx",
  "app/dashboard/(portal)/bot/page.tsx",
  "app/dashboard/(portal)/channels/whatsapp/page.tsx",
  "app/dashboard/(portal)/conversations/[id]/page.tsx",
  "app/dashboard/(portal)/conversations/page.tsx",
  "app/dashboard/(portal)/page.tsx",
  "app/dashboard/(portal)/profile/actions.ts",
  "app/dashboard/(portal)/profile/page.tsx",
  "app/dashboard/(portal)/settings/ApiKeyCard.tsx",
  "app/dashboard/(portal)/settings/actions.ts",
  "app/dashboard/(portal)/settings/page.tsx",
  "lib/omniflow/portal.ts",
  "docs/PORTAL_API.md",
];

const WEBSITE_DELETE = [
  "app/dashboard/(portal)/bot/actions.ts", // v3 UI is self-contained; stale actions break the build
];

const BACKEND_PATHS = [
  "app.py",
  "admin_users.py",
  "auth_password_reset.py",
  "connector_api.py",
  "portal_apikeys.py",
  "portal_auth.py",
  "portal_bot.py",
  "portal_channels.py",
  "portal_conversations.py",
  "portal_db.py",
  "portal_profile.py",
  "migrations/007_password_reset_tokens.sql",
  "migrations/008_portal_connector.sql",
];

const COMMIT_MESSAGE =
  "feat: portal WhatsApp channel + AI agent config + connector API (008)";

function chunk(s, n) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

function buildEntries(root, paths) {
  const entries = [];
  for (const rel of paths) {
    const p = path.join(root, ...rel.split("/"));
    const buf = fs.readFileSync(p);
    const packed = deflateRawSync(buf, { level: 9 });
    entries.push({
      rel,
      size: buf.length,
      sha: createHash("sha256").update(buf).digest("hex"),
      b64: packed.toString("base64"),
    });
  }
  return entries;
}

function emitMap(name, entries) {
  let s = "const " + name + " = {\n";
  for (const e of entries) {
    s += "  " + JSON.stringify(e.rel) + ": {\n";
    s += "    size: " + e.size + ",\n";
    s += '    sha256: "' + e.sha + '",\n';
    s += "    data: [\n";
    for (const line of chunk(e.b64, 100)) s += "      " + JSON.stringify(line) + ",\n";
    s += '    ].join(""),\n';
    s += "  },\n";
  }
  s += "};\n";
  return s;
}

const siteEntries = buildEntries(WEBSITE_ROOT, WEBSITE_PATHS);
const beEntries = buildEntries(BACKEND_ROOT, BACKEND_PATHS);

const script = `#!/usr/bin/env node
/**
 * OMNIFLOW — PORTAL UPDATE patch v3 (single file, SELF-VERIFYING).
 * Portal WhatsApp channel + AI agent config + profile + API keys +
 * conversations + connector ingest API (backend module).
 *
 *         node omniflow_portal_setup.mjs           (files likhega)
 *         node omniflow_portal_setup.mjs --push    (commit + push bhi)
 *
 * Kis repo mein chalao:
 *   - BACKEND repo root (jahan app.py hai)  -> 13 backend files  (PEHLE YAHAN)
 *   - WEBSITE repo root (jahan package.json hai) -> 19 website files
 *
 * Dono repos aik hi parent folder mein hain to dono aik hi run mein patch ho
 * jati hain. Har file ka SHA-256 check hota hai — copy corrupt ho to script
 * khud bata degi kaunsi file kharab hai (zlib crash nahi hogi).
 *
 * v3: chunked payload (copy-safe), per-file integrity hash, delete-list.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

const doPush = process.argv.includes("--push");
const root = process.cwd();

const CYAN = "\\x1b[36m", GREEN = "\\x1b[32m", YELLOW = "\\x1b[33m", RED = "\\x1b[31m", BOLD = "\\x1b[1m", OFF = "\\x1b[0m";

function info(msg) { console.log(CYAN + "==> " + OFF + msg); }
function ok(msg)   { console.log("  " + GREEN + "+" + OFF + " " + msg); }
function warn(msg) { console.log("  " + YELLOW + "!" + OFF + " " + msg); }
function fail(msg) { console.error(RED + "ERROR: " + OFF + msg); process.exit(1); }

function unpack(rel, entry) {
  const b64 = entry.data.replace(/\\s+/g, "");
  let buf;
  try {
    buf = inflateRawSync(Buffer.from(b64, "base64"));
  } catch (e) {
    throw new Error(
      "payload corrupt: " + rel +
      " — script copy adhoori/corrupt hai. Poora code block DOBARA copy karo. (" +
      (e.code || e.message) + ")");
  }
  if (buf.length !== entry.size) {
    throw new Error("size mismatch: " + rel + " (" + buf.length + " != " + entry.size + ")");
  }
  const sha = createHash("sha256").update(buf).digest("hex");
  if (sha !== entry.sha256) {
    throw new Error("hash mismatch: " + rel + " — file copy corrupt hai. Script dobara copy karo.");
  }
  return buf;
}

${emitMap("WEBSITE_FILES", siteEntries)}
${emitMap("BACKEND_FILES", beEntries)}

const WEBSITE_DELETE = ${JSON.stringify(WEBSITE_DELETE, null, 2)};

function detectType(dir) {
  if (fs.existsSync(path.join(dir, "app.py"))) return "backend";
  if (fs.existsSync(path.join(dir, "package.json"))) return "website";
  return null;
}

function hasMarker(type, dir) {
  try {
    if (type === "backend") {
      const appPy = path.join(dir, "app.py");
      if (!fs.existsSync(appPy)) return false;
      return fs.readFileSync(appPy, "utf8").slice(0, 8192).includes("control_plane");
    }
    const pkg = path.join(dir, "package.json");
    if (!fs.existsSync(pkg)) return false;
    return fs.readFileSync(pkg, "utf8").slice(0, 4096).toLowerCase().includes("omniflow");
  } catch {
    return false;
  }
}

function findSiblingOf(otherType) {
  const parent = path.dirname(root);
  let hits = [];
  try {
    for (const name of fs.readdirSync(parent)) {
      const p = path.join(parent, name);
      if (p === root) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (!st.isDirectory()) continue;
      if (detectType(p) === otherType && hasMarker(otherType, p)) hits.push(p);
    }
  } catch { /* parent not readable */ }
  return hits.length === 1 ? hits[0] : null;
}

function writeFiles(map, label, baseDir) {
  let written = 0;
  let upToDate = 0;
  for (const [rel, packed] of Object.entries(map)) {
    const dest = path.join(baseDir, ...rel.split("/"));
    const content = unpack(rel, packed);
    if (fs.existsSync(dest)) {
      try {
        if (fs.readFileSync(dest).equals(content)) { upToDate++; continue; }
      } catch { /* fall through and overwrite */ }
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
    written++;
    ok(label + " " + rel);
  }
  console.log("  (" + written + " written, " + upToDate + " already up to date)\\n");
  return written;
}

function deleteFiles(list, label, baseDir) {
  for (const rel of list) {
    const dest = path.join(baseDir, ...rel.split("/"));
    if (fs.existsSync(dest)) {
      try {
        fs.unlinkSync(dest);
        ok(label + " removed " + rel);
      } catch {
        warn(label + " remove fail: " + rel);
      }
    }
  }
}

function gitCommitPush(dir, label) {
  if (!fs.existsSync(path.join(dir, ".git"))) { warn(label + " git repo nahi hai (skip push)"); return; }
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).trim();
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-m", ${JSON.stringify(COMMIT_MESSAGE)}], { cwd: dir });
    execFileSync("git", ["push", "origin", branch], { cwd: dir });
    ok(label + ": commit + push ho gaya (" + branch + ")");
  } catch {
    warn(label + ": commit/push fail — khud karein: git add -A && git commit && git push");
  }
}

const writtenByDir = new Map();

function applyTo(type, dir) {
  info("Repo mila: " + BOLD + type + OFF + "  ->  " + dir);
  console.log("");
  let count = 0;
  if (type === "website") {
    count += writeFiles(WEBSITE_FILES, "[website]", dir);
    deleteFiles(WEBSITE_DELETE, "[website]", dir);
  } else {
    count += writeFiles(BACKEND_FILES, "[backend]", dir);
    ok("[backend] app.py: composite WSGI entry point (managed file)");
  }
  writtenByDir.set(dir, count);
}

const selfType = detectType(root);
if (!selfType) {
  fail("Yeh folder koi OmniFlow repo nahi hai.\\n" +
       "   Website root: jahan package.json hai   |   Backend root: jahan app.py hai\\n" +
       "   Script file ko project root mein rakho aur 'node omniflow_portal_setup.mjs' chalao.");
}

const touched = [];
applyTo(selfType, root);
touched.push({ dir: root, type: selfType });

const otherType = selfType === "website" ? "backend" : "website";
const sibling = findSiblingOf(otherType);
if (sibling) {
  console.log(CYAN + "==> " + OFF + "Doosri repo mil gayi (aik hi parent me): " + BOLD + sibling + OFF + "\\n");
  applyTo(otherType, sibling);
  touched.push({ dir: sibling, type: otherType });
} else {
  console.log(CYAN + "==> " + OFF + "Doosri repo is folder ke saath nahi mili (us repo me bhi chalao).\\n");
}

if (doPush) {
  console.log("");
  for (const t of touched) {
    if ((writtenByDir.get(t.dir) || 0) > 0) gitCommitPush(t.dir, "[" + t.type + "]");
    else ok("[" + t.type + "] koi change nahi — push skip");
  }
}

console.log("\\n" + GREEN + "============================================================" + OFF);
console.log("  Portal module apply ho gaya!");
console.log("  - Backend deploy (~2 min): portal + profile + API keys +");
console.log("    conversations + connector ingest (X-Omniflow-Key)");
console.log("  - Tables lazily khud ban jati hain (008 SQL manual zaroori NAHI)");
console.log("  - Test: /dashboard/settings -> Generate key -> ofk_... (aik dafa)");
console.log("  - Test: /dashboard/profile save -> 'Profile saved.'");
console.log("  - Test: /dashboard/conversations -> list khali (connector baad me)");
console.log("  - Test: /dashboard/channels/whatsapp -> 'Live from Control Plane'");
console.log(GREEN + "============================================================" + OFF);
`;

fs.writeFileSync(OUT, script);
const stat = fs.statSync(OUT);
const sha = createHash("sha256").update(fs.readFileSync(OUT)).digest("hex");
const rawTotal = [...siteEntries, ...beEntries].reduce((a, e) => a + e.size, 0);
console.log("written:", OUT);
console.log("size:", stat.size, "bytes");
console.log("sha256:", sha);
console.log("files:", siteEntries.length, "website +", beEntries.length, "backend, raw", rawTotal, "bytes");
for (const e of [...siteEntries, ...beEntries]) {
  console.log("  ", String(e.size).padStart(7), e.sha.slice(0, 12), e.rel);
}
