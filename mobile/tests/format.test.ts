import { formatCompact, formatPKR, formatRelative } from "@/lib/format";

describe("format helpers", () => {
  it("formats PKR amounts", () => {
    expect(formatPKR(1250)).toBe("PKR 1,250");
    expect(formatPKR(-99.5)).toBe("-PKR 99.5");
    expect(formatPKR(Number.NaN)).toBe("PKR —");
  });

  it("compacts large numbers", () => {
    expect(formatCompact(950)).toBe("950");
    expect(formatCompact(1200)).toBe("1.2K");
    expect(formatCompact(2_000_000)).toBe("2M");
    expect(formatCompact(Number.NaN)).toBe("—");
  });

  it("renders relative time buckets", () => {
    const now = Date.parse("2026-10-12T12:00:00Z");
    expect(formatRelative("2026-10-12T11:59:40Z", now)).toBe("just now");
    expect(formatRelative("2026-10-12T11:55:00Z", now)).toBe("5m");
    expect(formatRelative("2026-10-12T09:00:00Z", now)).toBe("3h");
    expect(formatRelative("2026-10-10T12:00:00Z", now)).toBe("2d");
    expect(formatRelative("not-a-date", now)).toBe("");
  });
});
