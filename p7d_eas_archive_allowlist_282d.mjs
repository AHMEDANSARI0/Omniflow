// §282d P7 hotfix: reduce the EAS archive to the mobile app only.
// The owner build uploaded 97.5 MB and failed in Install dependencies. EAS
// CLI 25.2.0 source shows node_modules/.git are excluded by default, so the
// previous claim that Windows node_modules caused the 97.5 MB upload was
// wrong; the metadata does not identify the included files or the install
// error. Replace the incomplete blacklist with a repo-root allowlist that
// excludes every top-level path except mobile/. IMPORTANT: use !/mobile
// without a trailing slash. eas-cli fs.cp tests the directory path as
// 'mobile', so !/mobile/ still excludes the directory. Verified against
// eas-cli's ignore package: mobile/package.json included; website/runtime
// files excluded; mobile/.env and mobile/node_modules excluded.
// Run from D:\whatsapp-ai-bot (root, after p7c):
//   node PATCHERS_TO_RUN\p7d_eas_archive_allowlist_282d.mjs
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const BACKUP_TAG = ".pre_282d.bak";
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
writeNewRepair(".easignore", "\u00a7282d", false,
    "# \u00a7282d: EAS archive = ONLY mobile/ (allowlist). EAS CLI archives from\n# the Git root and, when a root .easignore exists, ignores ALL .gitignore\n# files. The earlier blacklist still allowed unrelated root/runtime files;\n# the observed 97.5 MB upload is proof of archive bloat, but NOT proof of\n# what those files were. This allowlist excludes everything at repo root\n# except mobile/. The trailing-slash-free !/mobile is deliberate: eas-cli's\n# fs.cp filter tests the directory as the path \"mobile\" (no slash); the\n# !/mobile/ form would still exclude that directory and its entire tree.\n/*\n!/mobile\n\n# Keep secrets, generated outputs and install artifacts out of the mobile\n# project too. eas-cli also excludes node_modules and .git by default.\n.expo/\ndist/\nweb-build/\ncoverage/\n*.jks\n*.p8\n*.p12\n*.key\n*.mobileprovision\n.env\n.env.*\n!.env.example\n*.tsbuildinfo\nnpm-debug.log*\n");
writeNewRepair("docs/MOBILE_APP_GUIDE.md", "\u00a7282d", false,
    "# \u00a7282 OmniFlow Mobile App Guide (P0-P7)\n\nOne Expo/TypeScript codebase in `mobile/` produces **two apps**:\n\n| Variant | Name | Android package | Who uses it |\n| --- | --- | --- | --- |\n| `client` (default) | OmniFlow | `com.omniflow.app` | Customers / portal teams |\n| `admin` | OmniFlow Admin | `com.omniflow.admin` | You + your staff only |\n\nThe mobile apps are pure clients of the existing Control Plane\n(`/api/v1/...`) - no second backend, no direct database access, service key\nnever on a device.\n\n> **\u00a7282b:** the Expo config is plain JavaScript (`mobile/app.config.js`).\n> The old `app.config.ts` made older eas-cli builds fail with\n> `Error reading Expo config ... Unexpected token '{'` (the CLI evaluated\n> the TypeScript file as plain JS). The client app's EAS projectId is also\n> pre-linked inside that file, so client builds never show the interactive\n> \"EAS project not configured\" step.\n\n> **\u00a7282c/\u00a7282d:** EAS uploads should contain only the mobile project.\n> EAS CLI 25.2.0's source confirms it always excludes `.git` and\n> `node_modules`; the 148 MB then 97.5 MB upload sizes prove unrelated files\n> were still entering the archive, but do not identify which files. A root\n> `.easignore` replaces all `.gitignore` rules, so \u00a7282d switches to an\n> allowlist: exclude everything at the repo root except `mobile/`, then\n> exclude mobile secrets/build outputs. The `!/mobile` rule deliberately\n> has no trailing slash: eas-cli's copy filter checks the directory path as\n> `mobile` (without `/`). After applying \u00a7282d, verify the compressed upload\n> drops sharply. If the worker still fails at Install dependencies, the\n> actual failed-phase log is required before changing dependencies.\n\nFeature set shipped so far: portal login + session refresh, operations\ndashboard, unified inbox with replies, WhatsApp connection status, AI engine\nstatus, contacts, workflows (view/toggle), client analytics, admin analytics\n(traffic + AI quality + guardrails), local notifications with sounds +\nhaptics + deep links, notification settings, offline cache with last-known\ndata + offline banner, render-crash ErrorBoundary, remote config\n(feature flags, maintenance mode, min-version gate) and OTA update wiring.\n\n---\n\n## 1. Daily development (Expo Go - no account needed)\n\nFrom `D:\\whatsapp-ai-bot` (one command per paste):\n\n```\ncd mobile\nset OMNIFLOW_API_URL=https://omniflow-control-plane-rho.vercel.app\nnpm start\n```\n\nScan the QR with Expo Go. For the admin app add before `npm start`:\n\n```\nset OMNIFLOW_APP_VARIANT=admin\n```\n\n(The default API URL is now the live Control Plane, but setting it\nexplicitly is still the safe habit.)\n\n## 2. One-time EAS setup (free Expo account)\n\n1. Create a FREE account at https://expo.dev/signup\n2. Install the CLI globally (SDK 57 needs a recent CLI):\n\n```\nnpm install -g eas-cli@latest\n```\n\n3. Log in (from the `mobile` folder):\n\n```\ncd mobile\neas login\n```\n\nThe CLIENT app is already linked to the EAS project\n`ca30d461-910e-4661-bfb9-a7da7044ed5c` (see `extra.eas.projectId` in\n`mobile/app.config.js`) - no project prompts on client builds. The ADMIN\napp links its own project (slug `omniflow-admin`) on its first build:\naccept the prompts, then paste the printed id into `app.config.js` the same\nway (optional).\n\n## 3. Build the Android APK\n\nFrom `D:\\whatsapp-ai-bot\\mobile` (Windows-safe, env is baked in the\n`eas.json` profiles - no `set` needed):\n\n```\nnpm run build:client:apk\n```\n\nAdmin build (private, for your team):\n\n```\nnpm run build:admin:apk\n```\n\nWhat happens: the build uploads to Expo's free cloud queue (can take\n~10-30 min on the free tier), then the CLI prints a **build page URL**.\nOpen it and press **Download** to get the `.apk` file.\n\n`eas.json` profiles bake in:\n- `OMNIFLOW_APP_VARIANT` (client/admin)\n- `OMNIFLOW_API_URL=https://omniflow-control-plane-rho.vercel.app`\n- APK output (`buildType: apk`, `distribution: internal`) - installs\n  directly on any Android phone, no store.\n- `appVersionSource: remote` - EAS auto-manages the Android `versionCode`,\n  so every new build installs cleanly over the previous one.\n\nThe `production` profile (`.aab` bundle) exists for a future Play Store\nrelease - not needed now.\n\n## 4. Publish the APK on the website /download page\n\nThe `/download` page shows the button automatically once the APK exists in\n`public/downloads/` at deploy time (build-time check - no dead links):\n\n1. Copy the downloaded file to `D:\\whatsapp-ai-bot\\public\\downloads\\OmniFlow-client.apk`\n2. From `D:\\whatsapp-ai-bot`:\n\n```\ngit add public/downloads\ngit commit -m \"website: publish Android APK v0.1.0\"\ngit push\n```\n\n3. Vercel redeploys - https://omniflow-bice.vercel.app/download now shows\n   **Download APK (size)** and serves the file from\n   `/downloads/OmniFlow-client.apk`.\n\nAdmin APK: copy as `public/downloads/OmniFlow-admin.apk` if you want a\nprivate link - the public page never links it. (Or skip git for the admin\nAPK and share the file directly; APKs are ~40-80 MB each, so committing\nevery release grows the repo - prune old ones occasionally.)\n\nTo release a new version later: bump `version` in `mobile/app.config.js`\n(e.g. 0.1.0 -> 0.2.0), rebuild, copy over the old APK, push.\n\n## 5. Install on a phone\n\n1. Open https://omniflow-bice.vercel.app/download on the phone, tap Download APK.\n2. Android warns about \"unknown sources\" - Allow for the browser, then Install.\n3. Open OmniFlow, log in with the portal account (client app) or the\n   mobile-admin account (admin app).\n\n## 6. OTA updates (optional, enable after the first build)\n\nOnce builds are running, instant JS updates (no new APK) can be enabled:\n\n1. The project id is already in `mobile/app.config.js`\n   (`extra.eas.projectId`) - or check with `eas project:info`.\n2. In `mobile/eas.json`, add to BOTH preview profiles' `env`:\n   `\"OMNIFLOW_EAS_UPDATE_URL\": \"https://u.expo.dev/<project-id>\"`\n   (client uses the id above; the admin app uses its own project id once\n   linked).\n3. Rebuild the APK once (this embeds the update URL) and republish it.\n4. After any code change: `eas update --channel preview-client --message \"fix xyz\"`\n   (and the admin channel for the admin app). Installed apps pick the\n   update up on next launch - the wiring (`expo-updates` +\n   `checkForUpdatesNow`) is already in the app and fails soft while no URL\n   is set.\n\n## 7. Version gate + maintenance mode (server-controlled)\n\nThe CP endpoint `/api/v1/mobile/config` drives the gate screens built in P6:\n- `maintenance: true` -> every app shows \"OmniFlow is under maintenance\".\n- `min_version: \"0.2.0\"` -> builds older than that show \"Update required\".\n- The app sends its version in the `X-Omniflow-Mobile` header on every\n  request, so the CP can see which versions are alive.\n\n## 8. Troubleshooting\n\n- **Build fails at \"Install dependencies\" / archive is ~100 MB**: apply\n  the \u00a7282d root `.easignore` allowlist (only `mobile/` is uploaded).\n  EAS CLI excludes `node_modules` by default, so do not assume the large\n  archive was node_modules; the actual contents need log/archive inspection.\n  If the install phase still fails after the compressed archive shrinks,\n  open the build-page URL, expand the failed phase and share the last ~30\n  lines before changing package versions or the lockfile.\n- **`Error reading Expo config ... Unexpected token '{'`**: you are on the\n  pre-\u00a7282b TypeScript config or an old CLI - apply the \u00a7282b patcher\n  (plain-JS `app.config.js`) and run `npm install -g eas-cli@latest`.\n- **Build queue slow / \"capacity\"**: free tier - wait or retry later.\n- **`eas: command not found`**: `npm install -g eas-cli@latest`, reopen CMD.\n- **Login errors in the app**: confirm `OMNIFLOW_API_URL` (eas.json profile\n  or `set` for Expo Go) points at the live CP; client login = portal\n  account, admin login = mobile-admin bootstrap account.\n- **Install blocked**: Settings -> allow \"Install unknown apps\" for the\n  browser; a `versionCode` conflict cannot happen (remote auto-increment).\n- **/download button missing**: the APK was not in `public/downloads/` at\n  deploy time - copy it in and push again.\n- **Type errors on tests only (owner machine)**: known `@types/jest`\n  resolution issue - runtime and builds unaffected.\n");

console.log("");
console.log("applied: " + applied + "  already: " + already + "  warnings: " + warnings);
console.log("Next: website only -> git add -A -> commit -> push (no Control Plane deploy).");
console.log("Next (do not rebuild blindly yet):");
console.log("  1) Run this patcher from the bot root, AFTER p7c.");
console.log("  2) Refresh the failed build metadata/log link (the pasted signed URL");
console.log("     expires after 15 minutes):");
console.log("     npx eas-cli@latest build:view 5b347cf4-8913-4162-af5d-9c34da18bdaf --json");
console.log("     Open logFiles[0] immediately, expand/copy the Install dependencies");
console.log("     error and the last ~30 lines. The JSON metadata alone has no error");
console.log("     detail; do not change package versions/lockfile without those lines.");
console.log("  3) After inspecting/fixing the log's specific error, rebuild from mobile:");
console.log("     cd mobile");
console.log("     npm run build:client:apk");
console.log("     Confirm the upload is now only the mobile app (small, a few MB);");
console.log("     if Install dependencies fails again, paste the failed phase log.");
console.log("  4) On success, download APK -> public\\downloads\\OmniFlow-client.apk");
console.log("     -> root git add public/downloads -> commit/push -> /download live.");
console.log("  5) Root repo changes: git add -A");
console.log("     git commit -m \"mobile: P7d EAS archive allowlist (282d)\"");
console.log("     git push");