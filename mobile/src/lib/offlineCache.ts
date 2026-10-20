/**
 * §281 P6 offline cache - zero new dependencies. A bounded, serializable
 * snapshot of the most useful query results is persisted to AsyncStorage
 * (debounced on every cache change) and seeded back into the query client
 * at boot, so the app opens instantly with the last known data even with no
 * network. Seeded entries are invalidated right away: online, they refetch
 * and replace themselves; offline, the fetch fails soft and the snapshot
 * stays on screen.
 *
 * The pure core (buildSnapshot / applySnapshot / schemas) has no native
 * imports and is fully unit-tested; the AsyncStorage IO is a thin wrapper.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { logger } from "@/lib/logger";

const STORAGE_KEY = "omniflow.cache.v1";
const SESSION_FINGERPRINT_KEY = "omniflow.cache.session";
let currentFingerprint: string | null = null;

/** Query-key prefixes worth persisting (dashboards, lists, configs). */
export const SNAPSHOT_PREFIXES = [
  "operations",
  "whatsapp-status",
  "conversations",
  "customers",
  "workflows",
  "profile",
  "admin-overview",
  "admin-quality",
  "admin-site-stats",
  "mobile-config",
] as const;

export const MAX_SNAPSHOT_ENTRIES = 40;

export const snapshotEntrySchema = z.object({
  key: z.array(z.unknown()),
  data: z.unknown(),
  savedAt: z.number().catch(0),
});

export const snapshotSchema = z.object({
  version: z.number().catch(1),
  savedAt: z.number().catch(0),
  fingerprint: z.string().catch(""),
  entries: z.array(snapshotEntrySchema).catch([]),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

/** Minimal shape we need from a TanStack query (keeps the core testable). */
export interface CacheEntryLike {
  queryKey: readonly unknown[];
  state?: { data?: unknown } | null;
  data?: unknown;
}

function entryData(entry: CacheEntryLike): unknown {
  return entry.state ? entry.state.data : entry.data;
}

function isSerializable(data: unknown): boolean {
  try {
    JSON.stringify(data);
    return true;
  } catch {
    return false; // circular structures etc. - skip
  }
}

/** Filter + serialize cache entries into a bounded snapshot. */
export function buildSnapshot(
  entries: readonly CacheEntryLike[],
  now = Date.now(),
): Snapshot {
  const out: Array<{ key: unknown[]; data: unknown; savedAt: number }> = [];
  for (const entry of entries) {
    if (out.length >= MAX_SNAPSHOT_ENTRIES) break;
    const key = Array.isArray(entry.queryKey) ? [...entry.queryKey] : [];
    const head = String(key[0] ?? "");
    if (!(SNAPSHOT_PREFIXES as readonly string[]).includes(head)) continue;
    const data = entryData(entry);
    if (data === undefined || data === null) continue;
    if (!isSerializable(data)) continue;
    out.push({ key, data, savedAt: now });
  }
  return { version: 1, savedAt: now, fingerprint: currentFingerprint ?? "", entries: out };
}

/**
 * Seed a query client from an untrusted snapshot. Returns the number of
 * entries applied. Every entry is invalidated afterwards so it refetches
 * as soon as a screen mounts with network access.
 */
export function applySnapshot(
  setQueryData: (key: unknown[], data: unknown) => void,
  invalidate: (key: unknown[]) => void,
  snapshot: unknown,
): number {
  const parsed = snapshotSchema.safeParse(snapshot);
  if (!parsed.success) return 0;
  let applied = 0;
  for (const entry of parsed.data.entries) {
    if (entry.key.length === 0) continue;
    setQueryData(entry.key, entry.data);
    invalidate(entry.key);
    applied += 1;
  }
  return applied;
}

/** Convenience wiring for the real QueryClient (used by the root layout). */
export function seedQueryClient(queryClient: QueryClient, snapshot: unknown, expectedFingerprint?: string): number {
  const parsed = snapshotSchema.safeParse(snapshot);
  if (!parsed.success) return 0;
  if (expectedFingerprint && parsed.data.fingerprint && parsed.data.fingerprint !== expectedFingerprint) {
    return 0;
  }
  return applySnapshot(
    (key, data) => queryClient.setQueryData(key, data),
    (key) => void queryClient.invalidateQueries({ queryKey: key, refetchType: "none" }),
    snapshot,
  );
}

// ---------------------------------------------------------------------------
// AsyncStorage IO (thin, fail-soft)
// ---------------------------------------------------------------------------

export async function loadSnapshot(): Promise<{ snapshot: Snapshot; fingerprint: string | null } | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = snapshotSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { snapshot: parsed.data, fingerprint: parsed.data.fingerprint ?? null } : null;
  } catch (err) {
    logger.warn("offline cache load failed soft", err);
    return null;
  }
}

export async function saveSnapshot(snapshot: Snapshot): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch (err) {
    logger.warn("offline cache save failed soft", err);
  }
}

export function setSessionFingerprint(fp: string): void {
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
export function startCachePersistence(
  queryClient: QueryClient,
  debounceMs = 2_000,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    const entries = queryClient.getQueryCache().getAll().map((q) => ({
      queryKey: q.queryKey,
      state: { data: q.state.data },
    }));
    void saveSnapshot(buildSnapshot(entries));
  };

  const unsubscribe = queryClient.getQueryCache().subscribe(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  });

  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}