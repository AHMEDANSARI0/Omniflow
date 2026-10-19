// §282c P7 hotfix: the first EAS cloud build died in 'Install dependencies'
// after uploading 148 MB ('Compressed project files 148 MB'). Cause: eas-cli
// archives from the repo root and applies the ROOT ignore file only - the
// root .gitignore anchors '/node_modules' (repo root only), so the
// Windows-built mobile/node_modules (~600 MB) rode along and poisoned the
// worker install. Fix: .easignore lists at the repo root (EAS prefers it
// over .gitignore and it also mirrors the mobile junk rules) and in mobile/
// (for cwd-rooted archives). A healthy upload is ~5-15 MB. The lockfile
// itself is fine - npm ci passes cleanly on Linux (sandbox-verified).
// Run from the bot root (the folder that contains OmniFlow-Control-Plane/),
// AFTER p7b_config_282b.mjs:
//   node p7c_easignore_282c.mjs
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const BACKUP_TAG = ".pre_282c.bak";
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
writeNewRepair(".easignore", "\u00a7282c", false,
    "# \u00a7282c: EAS build archive ignore list. When `eas build` archives from the\n# repo root it uses THIS file instead of the nested .gitignore rules - the\n# anchored /node_modules in the root .gitignore did not cover\n# mobile/node_modules, so a Windows-built node_modules (~600 MB) rode along\n# in the upload (\"Compressed project files 148 MB\") and killed the worker's\n# \"Install dependencies\" phase. A healthy upload is ~5-15 MB.\n# The mobile build only needs mobile/** minus its own junk.\n\n# every node_modules at any depth\n**/node_modules/\n\n# python virtualenvs + caches (the owner keeps a (venv) at the repo root)\nvenv/\n.venv/\n**/__pycache__/\n*.py[cod]\n\n# git + patcher backups\n.git/\n*.pre_*.bak\n*.dir_conflict.bak*\n\n# website / bot artifacts the mobile build never uses\n.next/\n.vercel/\n/patchers/\nPATCHERS_TO_RUN/\ntools/\ndb/\ndocs/\nomniflow-backend-patch/\nOmniFlow-Control-Plane/\nconnector-bridge/\nconnector-node/\npublic/downloads/\n/logs/\n/whatsapp_sessions/\n/hide/\n\n# mobile-side junk (mirrors mobile/.gitignore, whose rules .easignore replaces)\n.expo/\ndist/\nweb-build/\ncoverage/\n*.jks\n*.p8\n*.p12\n*.key\n*.mobileprovision\n.env\n.env.*\n!.env.example\n*.tsbuildinfo\nnpm-debug.log*\n");
writeNewRepair("mobile/.easignore", "\u00a7282c", false,
    "# \u00a7282c: archive ignore list for when eas-cli packs from THIS folder.\n# Mirrors mobile/.gitignore (.easignore replaces gitignore rules for the\n# upload) - node_modules and friends must never ride along; the EAS worker\n# installs fresh from package-lock.json.\nnode_modules/\n.expo/\ndist/\nweb-build/\ncoverage/\n*.jks\n*.p8\n*.p12\n*.key\n*.mobileprovision\n.env\n.env.*\n!.env.example\n*.tsbuildinfo\nnpm-debug.log*\n");
writeNewRepair("docs/MOBILE_APP_GUIDE.md", "\u00a7282c", false,
    "# \u00a7282 OmniFlow Mobile App Guide (P0-P7)\n\nOne Expo/TypeScript codebase in `mobile/` produces **two apps**:\n\n| Variant | Name | Android package | Who uses it |\n| --- | --- | --- | --- |\n| `client` (default) | OmniFlow | `com.omniflow.app` | Customers / portal teams |\n| `admin` | OmniFlow Admin | `com.omniflow.admin` | You + your staff only |\n\nThe mobile apps are pure clients of the existing Control Plane\n(`/api/v1/...`) - no second backend, no direct database access, service key\nnever on a device.\n\n> **\u00a7282b:** the Expo config is plain JavaScript (`mobile/app.config.js`).\n> The old `app.config.ts` made older eas-cli builds fail with\n> `Error reading Expo config ... Unexpected token '{'` (the CLI evaluated\n> the TypeScript file as plain JS). The client app's EAS projectId is also\n> pre-linked inside that file, so client builds never show the interactive\n> \"EAS project not configured\" step.\n\n> **\u00a7282c:** `eas build` uploads must stay small (~5-15 MB compressed).\n> The `.easignore` files at the repo root and in `mobile/` keep\n> `node_modules`, the python `venv` and the website/bot artifacts out of\n> the archive - the first build attempt uploaded 148 MB of Windows-built\n> `node_modules` and died in the worker's \"Install dependencies\" phase.\n> When a root `.easignore` exists, EAS uses it INSTEAD of the nested\n> .gitignore rules, so it also lists the mobile-side junk.\n\nFeature set shipped so far: portal login + session refresh, operations\ndashboard, unified inbox with replies, WhatsApp connection status, AI engine\nstatus, contacts, workflows (view/toggle), client analytics, admin analytics\n(traffic + AI quality + guardrails), local notifications with sounds +\nhaptics + deep links, notification settings, offline cache with last-known\ndata + offline banner, render-crash ErrorBoundary, remote config\n(feature flags, maintenance mode, min-version gate) and OTA update wiring.\n\n---\n\n## 1. Daily development (Expo Go - no account needed)\n\nFrom `D:\\whatsapp-ai-bot` (one command per paste):\n\n```\ncd mobile\nset OMNIFLOW_API_URL=https://omniflow-control-plane-rho.vercel.app\nnpm start\n```\n\nScan the QR with Expo Go. For the admin app add before `npm start`:\n\n```\nset OMNIFLOW_APP_VARIANT=admin\n```\n\n(The default API URL is now the live Control Plane, but setting it\nexplicitly is still the safe habit.)\n\n## 2. One-time EAS setup (free Expo account)\n\n1. Create a FREE account at https://expo.dev/signup\n2. Install the CLI globally (SDK 57 needs a recent CLI):\n\n```\nnpm install -g eas-cli@latest\n```\n\n3. Log in (from the `mobile` folder):\n\n```\ncd mobile\neas login\n```\n\nThe CLIENT app is already linked to the EAS project\n`ca30d461-910e-4661-bfb9-a7da7044ed5c` (see `extra.eas.projectId` in\n`mobile/app.config.js`) - no project prompts on client builds. The ADMIN\napp links its own project (slug `omniflow-admin`) on its first build:\naccept the prompts, then paste the printed id into `app.config.js` the same\nway (optional).\n\n## 3. Build the Android APK\n\nFrom `D:\\whatsapp-ai-bot\\mobile` (Windows-safe, env is baked in the\n`eas.json` profiles - no `set` needed):\n\n```\nnpm run build:client:apk\n```\n\nAdmin build (private, for your team):\n\n```\nnpm run build:admin:apk\n```\n\nWhat happens: the build uploads to Expo's free cloud queue (can take\n~10-30 min on the free tier), then the CLI prints a **build page URL**.\nOpen it and press **Download** to get the `.apk` file.\n\n`eas.json` profiles bake in:\n- `OMNIFLOW_APP_VARIANT` (client/admin)\n- `OMNIFLOW_API_URL=https://omniflow-control-plane-rho.vercel.app`\n- APK output (`buildType: apk`, `distribution: internal`) - installs\n  directly on any Android phone, no store.\n- `appVersionSource: remote` - EAS auto-manages the Android `versionCode`,\n  so every new build installs cleanly over the previous one.\n\nThe `production` profile (`.aab` bundle) exists for a future Play Store\nrelease - not needed now.\n\n## 4. Publish the APK on the website /download page\n\nThe `/download` page shows the button automatically once the APK exists in\n`public/downloads/` at deploy time (build-time check - no dead links):\n\n1. Copy the downloaded file to `D:\\whatsapp-ai-bot\\public\\downloads\\OmniFlow-client.apk`\n2. From `D:\\whatsapp-ai-bot`:\n\n```\ngit add public/downloads\ngit commit -m \"website: publish Android APK v0.1.0\"\ngit push\n```\n\n3. Vercel redeploys - https://omniflow-bice.vercel.app/download now shows\n   **Download APK (size)** and serves the file from\n   `/downloads/OmniFlow-client.apk`.\n\nAdmin APK: copy as `public/downloads/OmniFlow-admin.apk` if you want a\nprivate link - the public page never links it. (Or skip git for the admin\nAPK and share the file directly; APKs are ~40-80 MB each, so committing\nevery release grows the repo - prune old ones occasionally.)\n\nTo release a new version later: bump `version` in `mobile/app.config.js`\n(e.g. 0.1.0 -> 0.2.0), rebuild, copy over the old APK, push.\n\n## 5. Install on a phone\n\n1. Open https://omniflow-bice.vercel.app/download on the phone, tap Download APK.\n2. Android warns about \"unknown sources\" - Allow for the browser, then Install.\n3. Open OmniFlow, log in with the portal account (client app) or the\n   mobile-admin account (admin app).\n\n## 6. OTA updates (optional, enable after the first build)\n\nOnce builds are running, instant JS updates (no new APK) can be enabled:\n\n1. The project id is already in `mobile/app.config.js`\n   (`extra.eas.projectId`) - or check with `eas project:info`.\n2. In `mobile/eas.json`, add to BOTH preview profiles' `env`:\n   `\"OMNIFLOW_EAS_UPDATE_URL\": \"https://u.expo.dev/<project-id>\"`\n   (client uses the id above; the admin app uses its own project id once\n   linked).\n3. Rebuild the APK once (this embeds the update URL) and republish it.\n4. After any code change: `eas update --channel preview-client --message \"fix xyz\"`\n   (and the admin channel for the admin app). Installed apps pick the\n   update up on next launch - the wiring (`expo-updates` +\n   `checkForUpdatesNow`) is already in the app and fails soft while no URL\n   is set.\n\n## 7. Version gate + maintenance mode (server-controlled)\n\nThe CP endpoint `/api/v1/mobile/config` drives the gate screens built in P6:\n- `maintenance: true` -> every app shows \"OmniFlow is under maintenance\".\n- `min_version: \"0.2.0\"` -> builds older than that show \"Update required\".\n- The app sends its version in the `X-Omniflow-Mobile` header on every\n  request, so the CP can see which versions are alive.\n\n## 8. Troubleshooting\n\n- **Build fails at \"Install dependencies\" / \"Compressed project files\" is\n  100+ MB**: the archive picked up `node_modules` / `venv` junk - make sure\n  the \u00a7282c `.easignore` files (repo root + `mobile/`) are applied; a\n  healthy upload is ~5-15 MB. If the size is healthy but the install still\n  fails, open the build-page URL from the CLI output, expand the failed\n  phase and share the last ~30 log lines.\n- **`Error reading Expo config ... Unexpected token '{'`**: you are on the\n  pre-\u00a7282b TypeScript config or an old CLI - apply the \u00a7282b patcher\n  (plain-JS `app.config.js`) and run `npm install -g eas-cli@latest`.\n- **Build queue slow / \"capacity\"**: free tier - wait or retry later.\n- **`eas: command not found`**: `npm install -g eas-cli@latest`, reopen CMD.\n- **Login errors in the app**: confirm `OMNIFLOW_API_URL` (eas.json profile\n  or `set` for Expo Go) points at the live CP; client login = portal\n  account, admin login = mobile-admin bootstrap account.\n- **Install blocked**: Settings -> allow \"Install unknown apps\" for the\n  browser; a `versionCode` conflict cannot happen (remote auto-increment).\n- **/download button missing**: the APK was not in `public/downloads/` at\n  deploy time - copy it in and push again.\n- **Type errors on tests only (owner machine)**: known `@types/jest`\n  resolution issue - runtime and builds unaffected.\n");

console.log("");
console.log("applied: " + applied + "  already: " + already + "  warnings: " + warnings);
console.log("Next: website only -> git add -A -> commit -> push (no Control Plane deploy).");
console.log("Then:");
console.log("  1) cd mobile");
console.log("     npm run build:client:apk");
console.log("  2) Watch the upload line: 'Compressed project files' should now be");
console.log("     roughly 5-15 MB (was 148 MB). The build then queues on the free tier");
console.log("     (~10-30 min).");
console.log("  3) If 'Install dependencies' STILL fails: open the build-page URL the");
console.log("     CLI prints -> expand the failed phase -> copy the last ~30 log lines");
console.log("     and paste them back.");
console.log("  4) On success: build page -> Download -> the .apk file.");
console.log("     Publish: copy to public\\downloads\\OmniFlow-client.apk (bot root)");
console.log("     -> git add public/downloads -> commit -> push -> /download shows the button.");
console.log("  5) Root repo: git add -A");
console.log("     git commit -m \"mobile: P7c eas archive ignore lists (282c)\"");
console.log("     git push");
console.log("  Note: the .easignore files also keep your python venv/ and website");
console.log("  artifacts out of every future build upload.");