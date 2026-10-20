#!/usr/bin/env node
// §282i — Offline cache account isolation (client app fix)
// Run from repo root:  node PATCHERS_TO_RUN\offline_cache_isolation_282i.mjs
// Target: mobile/ (Expo app)
//
// What it does:
//  - Scopes the offline snapshot to the current session (fingerprint = user id)
//  - Clears persisted + in-memory cache on logout / account switch
//  - Drops a mismatched snapshot after boot auth (session mismatch → clear)
//  - No service key, DB secret, Supabase reference, or new dependency.
//
// Idempotent: safe to run multiple times.

import fs from 'node:fs';
import path from 'node:path';

const mobileRoot = path.join(process.cwd(), 'mobile');

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function write(p, text) {
  const wasCRLF = fs.existsSync(p) && read(p).includes('\r\n');
  const out = wasCRLF ? text.replace(/\n/g, '\r\n') : text;
  fs.writeFileSync(p, out, 'utf8');
}

function hasFile(p, needle) {
  return read(p).includes(needle);
}

function replaceOnce(p, oldText, newText) {
  const file = read(p);
  if (!file.includes(oldText)) return false;
  const updated = file.replace(oldText, newText);
  if (updated === file) return false;
  write(p, updated);
  return true;
}

// ----------------------------------------------------------------------------
// 1) mobile/src/api/queryClient.ts  — singleton + clearQueryCache()
// ----------------------------------------------------------------------------
function patchQueryClient() {
  const file = path.join(mobileRoot, 'src', 'api', 'queryClient.ts');

  if (!fs.existsSync(file)) {
    console.warn(`! ${path.relative(mobileRoot, file)} not found — skipping`);
    return;
  }

  const fp = path.relative(mobileRoot, file);

  if (hasFile(file, 'export function clearQueryCache()')) {
    console.log(`= ${fp} already patched`);
    return;
  }

  let content = read(file);

  content = content.replace(
    'import { QueryClient } from "@tanstack/react-query";\n\n',
    'import { QueryClient } from "@tanstack/react-query";\n\nlet client: QueryClient | null = null;\n'
  );

  content = content.replace(
    'export function createQueryClient(): QueryClient {\n  return new QueryClient({',
    'export function createQueryClient(): QueryClient {\n  client = new QueryClient({'
  );

  if (!content.endsWith('\n')) content += '\n';
  content += '\n/** Clear every query in the shared client — used on logout / account\n * switch so the next session never sees the previous one\'s cached data. */\nexport function clearQueryCache(): void {\n  client?.clear();\n}\n';

  write(file, content);
  console.log(`+ ${fp} — singleton + clearQueryCache()`);
}

// ----------------------------------------------------------------------------
// 2) mobile/src/lib/offlineCache.ts — session fingerprint + clear
// ----------------------------------------------------------------------------
function patchOfflineCache() {
  const file = path.join(mobileRoot, 'src', 'lib', 'offlineCache.ts');

  if (!fs.existsSync(file)) {
    console.warn(`! ${path.relative(mobileRoot, file)} not found — skipping`);
    return;
  }

  const fp = path.relative(mobileRoot, file);

  if (hasFile(file, 'export function setSessionFingerprint(') &&
      hasFile(file, 'export async function clearOfflineCache()') &&
      hasFile(file, 'fingerprint: z.string().catch("")') &&
      hasFile(file, 'expectedFingerprint')) {
    console.log(`= ${fp} already patched`);
    return;
  }

  let content = read(file);

  // 2a) Add fingerprint module-level vars after STORAGE_KEY
  if (!content.includes('SESSION_FINGERPRINT_KEY')) {
    content = content.replace(
      'const STORAGE_KEY = "omniflow.cache.v1";',
      'const STORAGE_KEY = "omniflow.cache.v1";\nconst SESSION_FINGERPRINT_KEY = "omniflow.cache.session";\nlet currentFingerprint: string | null = null;'
    );
  }

  // 2b) Add setSessionFingerprint + clearOfflineCache before startCachePersistence
  //     Works with or without the "Debounced persistence" comment.
  if (!content.includes('export function setSessionFingerprint(')) {
    const insertion = `export function setSessionFingerprint(fp: string): void {
  currentFingerprint = fp;
  AsyncStorage.setItem(SESSION_FINGERPRINT_KEY, fp).catch(() => {});
}

export async function clearOfflineCache(): Promise<void> {
  currentFingerprint = null;
  try {
    await AsyncStorage.multiRemove([STORAGE_KEY, SESSION_FINGERPRINT_KEY]);
  } catch (err) {
    logger.warn("offline cache clear failed soft", err);
  }
}

/** Debounced persistence; returns a stop function for cleanup. */
export function startCachePersistence(`;

    // First try with the comment (sandbox original style)
    let modified = content.replace(
      '/** Debounced persistence; returns a stop function for cleanup. */\nexport function startCachePersistence(',
      insertion
    );
    // Fallback: without the comment (some file variants)
    if (modified === content) {
      modified = content.replace(
        'export function startCachePersistence(',
        insertion
      );
    }
    if (modified !== content) {
      content = modified;
    }
  }
  write(file, content);
  content = read(file);

  // Repeat if still missing (in case first pass didn't take)
  if (!content.includes('export function setSessionFingerprint(')) {
    const insertion = `export function setSessionFingerprint(fp: string): void {
  currentFingerprint = fp;
  AsyncStorage.setItem(SESSION_FINGERPRINT_KEY, fp).catch(() => {});
}

export async function clearOfflineCache(): Promise<void> {
  currentFingerprint = null;
  try {
    await AsyncStorage.multiRemove([STORAGE_KEY, SESSION_FINGERPRINT_KEY]);
  } catch (err) {
    logger.warn("offline cache clear failed soft", err);
  }
}

/** Debounced persistence; returns a stop function for cleanup. */
export function startCachePersistence(`;

    let modified = content.replace(
      '/** Debounced persistence; returns a stop function for cleanup. */\nexport function startCachePersistence(',
      insertion
    );
    if (modified === content) {
      modified = content.replace(
        'export function startCachePersistence(',
        insertion
      );
    }
    if (modified !== content) {
      content = modified;
    }
  }
  write(file, content);

  // 2c) Update snapshotSchema
  if (!hasFile(file, 'fingerprint: z.string().catch("")')) {
    replaceOnce(file,
      'export const snapshotSchema = z.object({\n  version: z.number().catch(1),\n  savedAt: z.number().catch(0),\n  entries: z.array(snapshotEntrySchema).catch([]),\n});',
      'export const snapshotSchema = z.object({\n  version: z.number().catch(1),\n  savedAt: z.number().catch(0),\n  fingerprint: z.string().catch(""),\n  entries: z.array(snapshotEntrySchema).catch([]),\n});'
    );
  }

  // 2d) Update buildSnapshot return
  if (!hasFile(file, 'fingerprint: currentFingerprint ?? ""')) {
    replaceOnce(file,
      '  return { version: 1, savedAt: now, entries: out };\n}',
      '  return { version: 1, savedAt: now, fingerprint: currentFingerprint ?? "", entries: out };\n}'
    );
  }

  // 2e) Update loadSnapshot return type
  if (!hasFile(file, 'fingerprint: string | null')) {
    replaceOnce(file,
      'export async function loadSnapshot(): Promise<Snapshot | null> {\n  try {\n    const raw = await AsyncStorage.getItem(STORAGE_KEY);\n    if (!raw) return null;\n    const parsed = snapshotSchema.safeParse(JSON.parse(raw));\n    return parsed.success ? parsed.data : null;\n  } catch (err) {\n    logger.warn("offline cache load failed soft", err);\n    return null;\n  }\n}',
      'export async function loadSnapshot(): Promise<{ snapshot: Snapshot; fingerprint: string | null } | null> {\n  try {\n    const raw = await AsyncStorage.getItem(STORAGE_KEY);\n    if (!raw) return null;\n    const parsed = snapshotSchema.safeParse(JSON.parse(raw));\n    return parsed.success ? { snapshot: parsed.data, fingerprint: parsed.data.fingerprint ?? null } : null;\n  } catch (err) {\n    logger.warn("offline cache load failed soft", err);\n    return null;\n  }\n}'
    );
  }

  // 2f) Update seedQueryClient
  if (!hasFile(file, 'expectedFingerprint')) {
    replaceOnce(file,
      'export function seedQueryClient(queryClient: QueryClient, snapshot: unknown): number {\n  return applySnapshot(\n    (key, data) => queryClient.setQueryData(key, data),\n    (key) => void queryClient.invalidateQueries({ queryKey: key, refetchType: "none" }),\n    snapshot,\n  );\n}',
      'export function seedQueryClient(queryClient: QueryClient, snapshot: unknown, expectedFingerprint?: string): number {\n  const parsed = snapshotSchema.safeParse(snapshot);\n  if (!parsed.success) return 0;\n  if (expectedFingerprint && parsed.data.fingerprint && parsed.data.fingerprint !== expectedFingerprint) {\n    return 0;\n  }\n  return applySnapshot(\n    (key, data) => queryClient.setQueryData(key, data),\n    (key) => void queryClient.invalidateQueries({ queryKey: key, refetchType: "none" }),\n    snapshot,\n  );\n}'
    );
  }

  console.log(`+ ${fp} — fingerprint + clearOfflineCache`);
}

// ----------------------------------------------------------------------------
// 3) mobile/src/store/auth.ts — fingerprint on login/hydrate, clear on logout
// ----------------------------------------------------------------------------
function patchAuth() {
  const file = path.join(mobileRoot, 'src', 'store', 'auth.ts');

  if (!fs.existsSync(file)) {
    console.warn(`! ${path.relative(mobileRoot, file)} not found — skipping`);
    return;
  }

  const fp = path.relative(mobileRoot, file);

  if (hasFile(file, 'export function fingerprintForUser(') &&
      hasFile(file, 'setSessionFingerprint(fingerprintForUser(user))') &&
      hasFile(file, 'clearOfflineCache()') &&
      hasFile(file, 'clearQueryCache()')) {
    console.log(`= ${fp} already patched`);
    return;
  }

  let content = read(file);

  // 3a) Add imports
  if (!content.includes('import { clearOfflineCache, setSessionFingerprint }')) {
    content = content.replace(
      'import { clearOfflineCache } from "@/lib/offlineCache";',
      'import { clearOfflineCache, setSessionFingerprint } from "@/lib/offlineCache";'
    );
  }
  if (!content.includes('import { clearQueryCache }')) {
    content = content.replace(
      'import { clearOfflineCache, setSessionFingerprint } from "@/lib/offlineCache";',
      'import { clearOfflineCache, setSessionFingerprint } from "@/lib/offlineCache";\nimport { clearQueryCache } from "@/api/queryClient";'
    );
  }
  write(file, content);
  content = read(file);

  if (!content.includes('import { clearOfflineCache, setSessionFingerprint }')) {
    content = content.replace(
      'import { clearOfflineCache } from "@/lib/offlineCache";',
      'import { clearOfflineCache, setSessionFingerprint } from "@/lib/offlineCache";'
    );
  }
  if (!content.includes('import { clearQueryCache }')) {
    content = content.replace(
      'import { clearOfflineCache, setSessionFingerprint } from "@/lib/offlineCache";',
      'import { clearOfflineCache, setSessionFingerprint } from "@/lib/offlineCache";\nimport { clearQueryCache } from "@/api/queryClient";'
    );
  }
  write(file, content);

  // 3b) Add fingerprintForUser function
  if (!hasFile(file, 'export function fingerprintForUser(')) {
    replaceOnce(file,
      'export const useAuthStore = create<AuthState>()((set, get) => ({',
      'export function fingerprintForUser(user: SessionUser): string {\n  return `user=${user.id}`;\n}\n\nexport const useAuthStore = create<AuthState>()((set, get) => ({'
    );
  }

  // 3c) Add setSessionFingerprint in hydrate
  if (!hasFile(file, 'setSessionFingerprint(fingerprintForUser(user));')) {
    replaceOnce(file,
      '      const user = await currentSession().catch(async () => {\n        const newAccess = await doRefresh();\n        if (!newAccess) throw new Error("session expired");\n        return currentSession();\n      });\n      set({ status: "authenticated", user });',
      '      const user = await currentSession().catch(async () => {\n        const newAccess = await doRefresh();\n        if (!newAccess) throw new Error("session expired");\n        return currentSession();\n      });\n      setSessionFingerprint(fingerprintForUser(user));\n      set({ status: "authenticated", user });'
    );
  }

  // 3d) Add setSessionFingerprint in login
  if (!hasFile(file, 'setSessionFingerprint(fingerprintForUser(user));')) {
    replaceOnce(file,
      '    const user = await currentSession();\n    set({ status: "authenticated", user });',
      '    const user = await currentSession();\n    setSessionFingerprint(fingerprintForUser(user));\n    set({ status: "authenticated", user });'
    );
  }

  // 3e) Add clearOfflineCache and clearQueryCache in logout
  if (!hasFile(file, 'clearOfflineCache()') || !hasFile(file, 'clearQueryCache()')) {
    replaceOnce(file,
      '    void (isAdminApp ? adminLogout() : logoutCall());\n    await clearSessionSecrets();\n    accessToken = null;\n    refreshToken = null;\n    set({ status: "unauthenticated", user: null });',
      '    void (isAdminApp ? adminLogout() : logoutCall());\n    await clearSessionSecrets();\n    await clearOfflineCache();\n    clearQueryCache();\n    accessToken = null;\n    refreshToken = null;\n    set({ status: "unauthenticated", user: null });'
    );
  }

  console.log(`+ ${fp} — fingerprint on login/hydrate, clear on logout`);
}

// ----------------------------------------------------------------------------
// 4) mobile/app/_layout.tsx — validate fingerprint after boot auth
// ----------------------------------------------------------------------------
function patchLayout() {
  const file = path.join(mobileRoot, 'app', '_layout.tsx');

  if (!fs.existsSync(file)) {
    console.warn(`! ${path.relative(process.cwd(), file)} not found — skipping`);
    return;
  }

  const fp = path.relative(process.cwd(), file);

  if (hasFile(file, 'let loadedFingerprint') && hasFile(file, 'fingerprintForUser(state.user)')) {
    console.log(`= ${fp} already patched`);
    return;
  }

  let content = read(file);

  // 4a) Update import to include fingerprintForUser
  if (!content.includes('fingerprintForUser')) {
    content = content.replace(
      'import { useAuthStore } from "@/store/auth";',
      'import { useAuthStore, fingerprintForUser } from "@/store/auth";'
    );
  }
  write(file, content);
  content = read(file);

  if (!content.includes('fingerprintForUser')) {
    replaceOnce(file,
      'import { useAuthStore } from "@/store/auth";',
      'import { useAuthStore, fingerprintForUser } from "@/store/auth";'
    );
  }

  // 4b) Update the first useEffect
  if (!hasFile(file, 'let loadedFingerprint')) {
    const oldEffect = '  useEffect(() => {\n    let cancelled = false;\n    (async () => {\n      try {\n        // §281: seed the offline snapshot BEFORE first paint so a cold start\n        // (even with no network) shows the last known data immediately. The\n        // entries are invalidated right away - online, they refetch and\n        // replace themselves; offline, the cached data stays on screen.\n        const snapshot = await loadSnapshot();\n        if (snapshot && !cancelled) {\n          const seeded = seedQueryClient(queryClient, snapshot);\n          if (seeded > 0) logger.log("offline cache seeded", { entries: seeded });\n        }\n      } catch {\n        // the cache must never block boot\n      }\n      try {\n        await Promise.all([\n          useAuthStore.getState().hydrate(),\n          useAppStore.getState().loadConfig(),\n          // §279 P4: local settings + notification plumbing boot with the app\n          useSettingsStore.getState().hydrate(),\n          initNotifications(),\n        ]);\n      } catch (err) {\n        logger.warn("boot failed soft", err);\n      } finally {\n        if (!cancelled) setReady(true);\n        setNotificationNavigator((href) => router.push(href as never));\n        void checkForUpdatesSilently();\n      }\n    })();\n    return () => {\n      cancelled = true;\n    };\n  }, []);';

    const newEffect = '  useEffect(() => {\n    let cancelled = false;\n    let loadedFingerprint: string | null = null;\n    (async () => {\n      try {\n        // §281: seed the offline snapshot BEFORE first paint so a cold start\n        // (even with no network) shows the last known data immediately. The\n        // entries are invalidated right away - online, they refetch and\n        // replace themselves; offline, the cached data stays on screen.\n        const cached = await loadSnapshot();\n        if (cached && !cancelled) {\n          loadedFingerprint = cached.fingerprint;\n          const seeded = seedQueryClient(queryClient, cached.snapshot);\n          if (seeded > 0) logger.log("offline cache seeded", { entries: seeded });\n        }\n      } catch {\n        // the cache must never block boot\n      }\n      try {\n        await Promise.all([\n          useAuthStore.getState().hydrate(),\n          useAppStore.getState().loadConfig(),\n          // §279 P4: local settings + notification plumbing boot with the app\n          useSettingsStore.getState().hydrate(),\n          initNotifications(),\n        ]);\n        // §282i: if the seeded snapshot belongs to a different session,\n        // clear it so the current user never sees another account\'s data.\n        if (!cancelled && loadedFingerprint) {\n          const state = useAuthStore.getState();\n          if (state.status === "authenticated" && state.user) {\n            const expected = fingerprintForUser(state.user);\n            if (loadedFingerprint !== expected) {\n              queryClient.clear();\n              logger.log("offline cache cleared: session fingerprint mismatch");\n            }\n          }\n        }\n      } catch (err) {\n        logger.warn("boot failed soft", err);\n      } finally {\n        if (!cancelled) setReady(true);\n        setNotificationNavigator((href) => router.push(href as never));\n        void checkForUpdatesSilently();\n      }\n    })();\n    return () => {\n      cancelled = true;\n    };\n  }, []);';

    replaceOnce(file, oldEffect, newEffect);
  }

  console.log(`+ ${fp} — fingerprint validation after boot auth`);
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
console.log('§282i — Offline cache account isolation');
console.log('Target:', mobileRoot);
console.log('');

if (!fs.existsSync(mobileRoot)) {
  console.error('! mobile/ not found. Run from the repo root (where mobile/ exists).');
  process.exit(1);
}

patchQueryClient();
patchOfflineCache();
patchAuth();
patchLayout();

console.log('');
console.log('Done. Next:');
console.log('  1. npx tsc --noEmit   (typecheck)');
console.log('  2. npx jest           (tests)');
console.log('  3. Restart TS server in VS Code if errors linger');