/**
 * §281 P6: offline cache + hardening. Covers the pure core of the snapshot
 * cache (filtering, cap, circular-drop, junk tolerance), the version /
 * maintenance gate and the net store defaults. No network, no timers.
 */

// Official AsyncStorage jest mock (hoisted above imports) - offlineCache.ts
// pulls AsyncStorage at module level, which has no native module under jest.
jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

import {
  applySnapshot,
  buildSnapshot,
  MAX_SNAPSHOT_ENTRIES,
  snapshotSchema,
} from "@/lib/offlineCache";
import { useNetStore } from "@/store/net";
import { updateGate } from "@/store/app";

// ---------------------------------------------------------------------------
// updateGate (min_version / maintenance enforcement)
// ---------------------------------------------------------------------------

describe("updateGate", () => {
  it("returns ok for the default config (no min_version, no maintenance)", () => {
    expect(updateGate({ flags: {} }, "1.0.0")).toBe("ok");
  });

  it("returns maintenance when the CP sets maintenance mode", () => {
    expect(updateGate({ flags: {}, maintenance: true }, "9.9.9")).toBe("maintenance");
  });

  it("returns update_required when the app is below min_version", () => {
    expect(updateGate({ flags: {}, min_version: "1.1.0" }, "1.0.0")).toBe("update_required");
    expect(updateGate({ flags: {}, min_version: "1.1.0" }, "1.0.9")).toBe("update_required");
  });

  it("returns ok when the app meets or beats min_version", () => {
    expect(updateGate({ flags: {}, min_version: "1.0.0" }, "1.0.0")).toBe("ok");
    expect(updateGate({ flags: {}, min_version: "1.0.0" }, "1.2.3")).toBe("ok");
  });

  it("ignores empty / whitespace min_version", () => {
    expect(updateGate({ flags: {}, min_version: "" }, "0.0.1")).toBe("ok");
    expect(updateGate({ flags: {}, min_version: "   " }, "0.0.1")).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// buildSnapshot (prefix filter, bounds, serializability)
// ---------------------------------------------------------------------------

describe("buildSnapshot", () => {
  it("keeps only whitelisted query-key prefixes with usable data", () => {
    const snap = buildSnapshot(
      [
        { queryKey: ["operations"], state: { data: { hello: "world" } } },
        { queryKey: ["random-thing"], state: { data: { drop: true } } },
        { queryKey: ["conversations", { page: 1 }], state: { data: { list: [] } } },
        { queryKey: ["whatsapp-status"], state: { data: null } },
        { queryKey: ["customers"], state: { data: undefined } },
      ],
      1234,
    );
    expect(snap.version).toBe(1);
    expect(snap.savedAt).toBe(1234);
    expect(snap.entries.map((e) => e.key[0])).toEqual(["operations", "conversations"]);
  });

  it("drops circular (non-serializable) data instead of throwing", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    const snap = buildSnapshot([
      { queryKey: ["operations"], state: { data: circular } },
      { queryKey: ["workflows"], state: { data: { ok: true } } },
    ]);
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0]?.key[0]).toBe("workflows");
  });

  it("caps the snapshot at MAX_SNAPSHOT_ENTRIES", () => {
    const many = Array.from({ length: MAX_SNAPSHOT_ENTRIES + 10 }, (_, i) => ({
      queryKey: ["operations", i],
      state: { data: { i } },
    }));
    expect(buildSnapshot(many).entries).toHaveLength(MAX_SNAPSHOT_ENTRIES);
  });
});

// ---------------------------------------------------------------------------
// applySnapshot (junk tolerance + seeding counts)
// ---------------------------------------------------------------------------

describe("applySnapshot", () => {
  it("applies every entry and invalidates it, returning the count", () => {
    const setQueryData = jest.fn();
    const invalidate = jest.fn();
    const count = applySnapshot(setQueryData, invalidate, {
      version: 1,
      savedAt: 1,
      entries: [
        { key: ["operations"], data: { a: 1 }, savedAt: 1 },
        { key: ["conversations", { page: 1 }], data: { list: [] }, savedAt: 1 },
      ],
    });
    expect(count).toBe(2);
    expect(setQueryData).toHaveBeenCalledTimes(2);
    expect(setQueryData).toHaveBeenNthCalledWith(1, ["operations"], { a: 1 });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("skips entries with empty keys", () => {
    const setQueryData = jest.fn();
    const count = applySnapshot(setQueryData, jest.fn(), {
      version: 1,
      savedAt: 1,
      entries: [{ key: [], data: { a: 1 }, savedAt: 1 }],
    });
    expect(count).toBe(0);
    expect(setQueryData).not.toHaveBeenCalled();
  });

  it.each([null, undefined, "junk", 42, {}, { entries: "nope" }])(
    "tolerates junk snapshot %#",
    (junk) => {
      const setQueryData = jest.fn();
      expect(applySnapshot(setQueryData, jest.fn(), junk)).toBe(0);
      expect(setQueryData).not.toHaveBeenCalled();
    },
  );
});

describe("snapshotSchema", () => {
  it("falls back to safe defaults for broken fields", () => {
    const parsed = snapshotSchema.safeParse({ version: "x", savedAt: "y", entries: 5 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.version).toBe(1);
      expect(parsed.data.savedAt).toBe(0);
      expect(parsed.data.entries).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// net store (offline banner driver)
// ---------------------------------------------------------------------------

describe("net store", () => {
  it("starts online and flips on demand", () => {
    expect(useNetStore.getState().online).toBe(true);
    useNetStore.getState().setOnline(false);
    expect(useNetStore.getState().online).toBe(false);
    useNetStore.getState().setOnline(false); // no-op when unchanged
    expect(useNetStore.getState().online).toBe(false);
    useNetStore.getState().setOnline(true);
    expect(useNetStore.getState().online).toBe(true);
  });
});
