# §282 OmniFlow Mobile App Guide (P0-P7)

One Expo/TypeScript codebase in `mobile/` produces **two apps**:

| Variant | Name | Android package | Who uses it |
| --- | --- | --- | --- |
| `client` (default) | OmniFlow | `com.omniflow.app` | Customers / portal teams |
| `admin` | OmniFlow Admin | `com.omniflow.admin` | You + your staff only |

The mobile apps are pure clients of the existing Control Plane
(`/api/v1/...`) - no second backend, no direct database access, service key
never on a device.

> **§282b:** the Expo config is plain JavaScript (`mobile/app.config.js`).
> The old `app.config.ts` made older eas-cli builds fail with
> `Error reading Expo config ... Unexpected token '{'` (the CLI evaluated
> the TypeScript file as plain JS). The client app's EAS projectId is also
> pre-linked inside that file, so client builds never show the interactive
> "EAS project not configured" step.

> **§282c/§282d:** EAS uploads should contain only the mobile project.
> EAS CLI 25.2.0 excludes `.git` and `node_modules` by default; the 148 MB
> then 97.5 MB upload sizes showed archive bloat, so §282d uses a root
> `.easignore` allowlist (only `mobile/`) because a root `.easignore`
> replaces all `.gitignore` files. The `!/mobile` rule has no trailing
> slash: eas-cli's copy filter checks the directory as `mobile` (no `/`).
>
> **§282e:** EAS runs `npm ci --include=dev`. The failed build proved
> `mobile/package.json` and `mobile/package-lock.json` were out of sync:
> Jest was locked at 29.7.0 instead of 30.5.2, TypeScript 6.0.3 instead of
> 5.9.3, and `@types/react` 19.2.18 instead of 19.3.0; many Jest 30
> transitive dependencies were also absent. Apply the §282e patcher to
> replace the lockfile generated from the current `package.json`. It was
> verified with Node 22 / npm 10.9.8 using the exact EAS command
> `npm ci --include=dev` (1243 packages installed). When package.json
> changes, regenerate the lockfile and verify `npm ci` before building.

Feature set shipped so far: portal login + session refresh, operations
dashboard, unified inbox with replies, WhatsApp connection status, AI engine
status, contacts, workflows (view/toggle), client analytics, admin analytics
(traffic + AI quality + guardrails), local notifications with sounds +
haptics + deep links, notification settings, offline cache with last-known
data + offline banner, render-crash ErrorBoundary, remote config
(feature flags, maintenance mode, min-version gate) and OTA update wiring.

---

## 1. Daily development (Expo Go - no account needed)

From `D:\whatsapp-ai-bot` (one command per paste):

```
cd mobile
set OMNIFLOW_API_URL=https://omniflow-control-plane-rho.vercel.app
npm start
```

Scan the QR with Expo Go. For the admin app add before `npm start`:

```
set OMNIFLOW_APP_VARIANT=admin
```

(The default API URL is now the live Control Plane, but setting it
explicitly is still the safe habit.)

## 2. One-time EAS setup (free Expo account)

1. Create a FREE account at https://expo.dev/signup
2. Install the CLI globally (SDK 57 needs a recent CLI):

```
npm install -g eas-cli@latest
```

3. Log in (from the `mobile` folder):

```
cd mobile
eas login
```

The CLIENT app is already linked to the EAS project
`ca30d461-910e-4661-bfb9-a7da7044ed5c` (see `extra.eas.projectId` in
`mobile/app.config.js`) - no project prompts on client builds. The ADMIN
app links its own project (slug `omniflow-admin`) on its first build:
accept the prompts, then paste the printed id into `app.config.js` the same
way (optional).

## 3. Build the Android APK

From `D:\whatsapp-ai-bot\mobile` (Windows-safe, env is baked in the
`eas.json` profiles - no `set` needed):

```
npm run build:client:apk
```

Admin build (private, for your team):

```
npm run build:admin:apk
```

What happens: the build uploads to Expo's free cloud queue (can take
~10-30 min on the free tier), then the CLI prints a **build page URL**.
Open it and press **Download** to get the `.apk` file.

`eas.json` profiles bake in:
- `OMNIFLOW_APP_VARIANT` (client/admin)
- `OMNIFLOW_API_URL=https://omniflow-control-plane-rho.vercel.app`
- APK output (`buildType: apk`, `distribution: internal`) - installs
  directly on any Android phone, no store.
- `appVersionSource: remote` - EAS auto-manages the Android `versionCode`,
  so every new build installs cleanly over the previous one.

The `production` profile (`.aab` bundle) exists for a future Play Store
release - not needed now.

## 4. Publish the APK on the website /download page

The `/download` page shows the button automatically once the APK exists in
`public/downloads/` at deploy time (build-time check - no dead links):

1. Copy the downloaded file to `D:\whatsapp-ai-bot\public\downloads\OmniFlow-client.apk`
2. From `D:\whatsapp-ai-bot`:

```
git add public/downloads
git commit -m "website: publish Android APK v0.1.0"
git push
```

3. Vercel redeploys - https://omniflow-bice.vercel.app/download now shows
   **Download APK (size)** and serves the file from
   `/downloads/OmniFlow-client.apk`.

Admin APK: copy as `public/downloads/OmniFlow-admin.apk` if you want a
private link - the public page never links it. (Or skip git for the admin
APK and share the file directly; APKs are ~40-80 MB each, so committing
every release grows the repo - prune old ones occasionally.)

To release a new version later: bump `version` in `mobile/app.config.js`
(e.g. 0.1.0 -> 0.2.0), rebuild, copy over the old APK, push.

## 5. Install on a phone

1. Open https://omniflow-bice.vercel.app/download on the phone, tap Download APK.
2. Android warns about "unknown sources" - Allow for the browser, then Install.
3. Open OmniFlow, log in with the portal account (client app) or the
   mobile-admin account (admin app).

## 6. OTA updates (optional, enable after the first build)

Once builds are running, instant JS updates (no new APK) can be enabled:

1. The project id is already in `mobile/app.config.js`
   (`extra.eas.projectId`) - or check with `eas project:info`.
2. In `mobile/eas.json`, add to BOTH preview profiles' `env`:
   `"OMNIFLOW_EAS_UPDATE_URL": "https://u.expo.dev/<project-id>"`
   (client uses the id above; the admin app uses its own project id once
   linked).
3. Rebuild the APK once (this embeds the update URL) and republish it.
4. After any code change: `eas update --channel preview-client --message "fix xyz"`
   (and the admin channel for the admin app). Installed apps pick the
   update up on next launch - the wiring (`expo-updates` +
   `checkForUpdatesNow`) is already in the app and fails soft while no URL
   is set.

## 7. Version gate + maintenance mode (server-controlled)

The CP endpoint `/api/v1/mobile/config` drives the gate screens built in P6:
- `maintenance: true` -> every app shows "OmniFlow is under maintenance".
- `min_version: "0.2.0"` -> builds older than that show "Update required".
- The app sends its version in the `X-Omniflow-Mobile` header on every
  request, so the CP can see which versions are alive.

## 8. Troubleshooting

- **`npm ci` says package.json and package-lock.json are out of sync**:
  apply the §282e lockfile patcher, then rebuild. For future package changes,
  run `npm install` in `mobile/` and verify `npm ci --include=dev` succeeds.
- **Archive is ~100 MB**: apply the §282d root `.easignore` allowlist
  (only `mobile/` is uploaded). EAS excludes `node_modules` by default, so
  do not assume it caused the bloat.
- **`Error reading Expo config ... Unexpected token '{'`**: you are on the
  pre-§282b TypeScript config or an old CLI - apply the §282b patcher
  (plain-JS `app.config.js`) and run `npm install -g eas-cli@latest`.
- **Build queue slow / "capacity"**: free tier - wait or retry later.
- **`eas: command not found`**: `npm install -g eas-cli@latest`, reopen CMD.
- **Login errors in the app**: confirm `OMNIFLOW_API_URL` (eas.json profile
  or `set` for Expo Go) points at the live CP; client login = portal
  account, admin login = mobile-admin bootstrap account.
- **Install blocked**: Settings -> allow "Install unknown apps" for the
  browser; a `versionCode` conflict cannot happen (remote auto-increment).
- **/download button missing**: the APK was not in `public/downloads/` at
  deploy time - copy it in and push again.
- **Type errors on tests only (owner machine)**: known `@types/jest`
  resolution issue - runtime and builds unaffected.
