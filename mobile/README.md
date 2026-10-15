# OmniFlow Mobile

One Expo (React Native + TypeScript) codebase, two apps:

| Variant | Env | App id | Deep link |
| --- | --- | --- | --- |
| Client (business owners/staff) | `OMNIFLOW_APP_VARIANT=client` (default) | `com.omniflow.app` | `omniflow://` |
| Admin (platform owner) | `OMNIFLOW_APP_VARIANT=admin` | `com.omniflow.admin` | `omniflow-admin://` |

Architecture map: `docs/MOBILE_ARCHITECTURE.md` (repo root).

## Principles

- **Client of the Control Plane.** Every byte comes from the existing CP
  (`src/api/client.ts`). No second backend, no direct DB access, no secrets
  in the binary.
- **Lightweight & fast.** GET dedupe + bounded jittered retries, cached query
  state (TanStack Query), native-thread animations only (Reanimated 4),
  `expo-image` for media, system fonts.
- **Upgradeable.** Feature code lives in `src/features/*` (P2+); UI atoms in
  `src/ui/*`; transport isolated so SSE/WebSocket can plug in later without
  touching screens.
- **Responsive.** All layout is flex-based with tokenized spacing; screens
  adapt from small Android phones to large iOS displays; light + dark themes
  follow the system.

## Run

```bash
cd mobile
npm install
npm start            # Expo dev server -> scan with Expo Go
npm run typecheck    # strict TS
npm test             # unit tests (api client, tokens, schemas, formats)
```

Build APKs (EAS free tier, no store account needed):

```bash
OMNIFLOW_APP_VARIANT=client npx eas build -p android --profile preview
OMNIFLOW_APP_VARIANT=admin  npx eas build -p android --profile preview
```

## How "push the repos -> the app updates" works

1. **Backend changes** (CP or website APIs): instant. The app reads the live
   CP over HTTPS on every screen - a Vercel deploy is visible on the next
   request, with zero app involvement.
2. **App code changes**: OTA via Expo Updates (free tier). Set
   `OMNIFLOW_EAS_UPDATE_URL` once (EAS project URL), then any CI run of
   `eas update --branch production` publishes the new JS bundle; installed
   apps download it silently on next launch/foreground
   (`src/lib/updates.ts` checks on boot and can be checked manually from
   Settings). Until the URL is configured everything still works - the
   embedded bundle is simply used.

## Roadmap

P0 foundation (this tree) -> P1 auth hardening + admin guard -> P2 inbox/
dashboard/WhatsApp -> P3 contacts/workflows/analytics/AI -> P4 push/sounds/
deep links -> P5 admin app -> P6 offline hardening -> P7 APK + /download page.
