/**
 * §280 P5 admin data schemas: quality + site-stats envelopes must degrade
 * safely (CP sends {"overview": null, "degraded": true} when its database
 * is busy) and never crash the admin screens.
 */

import {
  adminQualityEnvelopeSchema,
  adminSiteStatsEnvelopeSchema,
  siteStatsSchema,
} from "@/api/admin";

describe("admin quality envelope (§280)", () => {
  it("passes a real overview through", () => {
    const parsed = adminQualityEnvelopeSchema.parse({
      days: 7,
      overview: {
        totals: { answers: 12, handoffs: 2, blocked: 1 },
        controls: { kill_switch: false, autonomy_cap: "auto" },
      },
    });
    expect(parsed.days).toBe(7);
    expect(parsed.degraded).toBe(false);
    expect(parsed.overview?.totals).toEqual({ answers: 12, handoffs: 2, blocked: 1 });
  });

  it("keeps the degraded shape intact", () => {
    const parsed = adminQualityEnvelopeSchema.parse({
      days: 30,
      overview: null,
      degraded: true,
    });
    expect(parsed.overview).toBeNull();
    expect(parsed.degraded).toBe(true);
    expect(parsed.days).toBe(30);
  });

  it("defaults junk envelopes", () => {
    const parsed = adminQualityEnvelopeSchema.parse({});
    expect(parsed.days).toBe(7);
    expect(parsed.overview).toBeNull();
    expect(parsed.degraded).toBe(false);
  });
});

describe("admin site stats (§280)", () => {
  it("normalizes a full stats payload", () => {
    const parsed = adminSiteStatsEnvelopeSchema.parse({
      days: 7,
      stats: {
        days: 7,
        timezone: "Asia/Karachi",
        totals: { views: 41, visitors: 9, cta_clicks: 3, form_submits: 2, avg_seconds: 55 },
        daily: [{ day: "2026-10-15", views: 14, visitors: 4 }],
        countries: [{ country: "PK", visitors: 8 }],
        browsers: [{ browser: "chrome", visitors: 7 }],
      },
    });
    expect(parsed.stats?.totals.views).toBe(41);
    expect(parsed.stats?.timezone).toBe("Asia/Karachi");
    expect(parsed.stats?.daily[0]?.day).toBe("2026-10-15");
    expect(parsed.stats?.countries[0]?.country).toBe("PK");
  });

  it("survives degraded and empty payloads", () => {
    const degraded = adminSiteStatsEnvelopeSchema.parse({
      days: 7,
      stats: null,
      degraded: true,
    });
    expect(degraded.stats).toBeNull();
    expect(degraded.degraded).toBe(true);

    const empty = adminSiteStatsEnvelopeSchema.parse({});
    expect(empty.stats).toBeNull();
    expect(empty.days).toBe(7);
  });

  it("defaults every stats section on junk", () => {
    const parsed = siteStatsSchema.parse({ totals: { views: "many" }, daily: null });
    expect(parsed.totals.views).toBe(0);
    expect(parsed.totals.visitors).toBe(0);
    expect(parsed.daily).toEqual([]);
    expect(parsed.countries).toEqual([]);
    expect(parsed.timezone).toBe("");
  });
});
