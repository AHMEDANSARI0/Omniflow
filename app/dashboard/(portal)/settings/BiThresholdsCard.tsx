"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Thresholds = Record<string, number>;

const SHARE_KEYS = new Set([
  "delivery_share",
  "price_share",
  "trouble_share",
  "negative_share",
  "handoff_share",
  "ai_fail_share",
  "cod_decline_share",
  "checkout_conversion",
  "delivery_fail_share",
  "stall_share",
  "handoff_growth",
]);

const LABELS: Record<string, string> = {
  gaps_min: "Knowledge gaps (min samples)",
  topic_min: "Topic spike (min samples)",
  delivery_share: "Delivery-topic share",
  price_share: "Price-topic share",
  trouble_share: "Complaint-topic share",
  negative_share: "Negative sentiment share",
  sentiment_min: "Sentiment (min samples)",
  handoff_share: "AI handoff share",
  decisions_min: "AI decisions (min samples)",
  handoff_growth: "Handoff growth factor",
  handoff_min: "Handoffs (min samples)",
  policy_min: "Policy blocks (min samples)",
  ai_fail_share: "AI engine failure share",
  ai_calls_min: "AI calls (min samples)",
  cod_decline_share: "COD decline share",
  cod_min: "COD answers (min samples)",
  checkout_conversion: "Checkout conversion floor",
  checkout_min: "Checkout links (min samples)",
  delivery_fail_share: "Courier problem share",
  bookings_min: "Courier bookings (min samples)",
  csat_low: "CSAT floor (1-5)",
  csat_min: "CSAT answers (min samples)",
  overdue_min: "Overdue replies (min count)",
  stall_share: "Journey stall share",
  stall_min: "Journey events (min samples)",
};

const GROUPS: { title: string; keys: string[] }[] = [
  {
    title: "Customer topics",
    keys: [
      "gaps_min",
      "topic_min",
      "delivery_share",
      "price_share",
      "trouble_share",
      "negative_share",
      "sentiment_min",
    ],
  },
  {
    title: "AI quality",
    keys: [
      "handoff_share",
      "decisions_min",
      "handoff_growth",
      "handoff_min",
      "policy_min",
      "ai_fail_share",
      "ai_calls_min",
    ],
  },
  {
    title: "Commerce & service",
    keys: [
      "cod_decline_share",
      "cod_min",
      "checkout_conversion",
      "checkout_min",
      "delivery_fail_share",
      "bookings_min",
      "csat_low",
      "csat_min",
      "overdue_min",
      "stall_share",
      "stall_min",
    ],
  },
];

function labelFor(key: string): string {
  return LABELS[key] || key.replace(/_/g, " ");
}

function displayValue(key: string, value: number): string {
  if (SHARE_KEYS.has(key)) return String(Math.round(value * 1000) / 10);
  return String(value);
}

function parseInput(key: string, raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (SHARE_KEYS.has(key)) return Math.max(0, Math.min(100, n)) / 100;
  return n;
}

export default function BiThresholdsCard() {
  const [thresholds, setThresholds] = useState<Thresholds | null>(null);
  const [defaults, setDefaults] = useState<Thresholds>({});
  const [keys, setKeys] = useState<string[]>([]);
  const [tzOffset, setTzOffset] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/bi/thresholds", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json()) as {
        thresholds?: Thresholds;
        defaults?: Thresholds;
        timezone_offset_hours?: number;
        keys?: string[];
      };
      if (payload.thresholds) setThresholds({ ...payload.thresholds });
      if (payload.defaults) setDefaults(payload.defaults);
      if (Array.isArray(payload.keys)) setKeys(payload.keys);
      if (typeof payload.timezone_offset_hours === "number") {
        setTzOffset(payload.timezone_offset_hours);
      }
    } catch {
      // Transient network issue.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const orderedGroups = useMemo(() => {
    const known = new Set(GROUPS.flatMap((g) => g.keys));
    const extra = keys.filter((k) => !known.has(k));
    if (!extra.length) return GROUPS;
    return [...GROUPS, { title: "Other", keys: extra }];
  }, [keys]);

  function setKey(key: string, raw: string) {
    setThresholds((current) => {
      if (!current) return current;
      const parsed = parseInput(key, raw);
      if (parsed === null) return current;
      return { ...current, [key]: parsed };
    });
  }

  async function save() {
    if (!thresholds || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/omniflow/portal/bi/thresholds", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thresholds }),
      });
      const payload = (await response.json().catch(() => null)) as {
        thresholds?: Thresholds;
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        setNotice(payload?.error?.message || "Could not save thresholds.");
        return;
      }
      if (payload?.thresholds) setThresholds(payload.thresholds);
      setNotice("Problem detector thresholds saved.");
    } catch {
      setNotice("Could not save thresholds.");
    } finally {
      setBusy(false);
    }
  }

  async function resetDefaults() {
    if (!defaults || busy) return;
    setThresholds({ ...defaults });
  }

  return (
    <div className="mt-6 rounded-xl2 border border-line bg-white p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Business insights thresholds</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">
            When the problem detector flags an issue. Shares are percentages; mins
            are sample sizes so thin data stays quiet. Busy hours already follow
            your business-hours timezone
            {tzOffset === null ? "" : " (UTC" + (tzOffset >= 0 ? "+" : "") + tzOffset + ")"}.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy || !thresholds}
            onClick={() => void resetDefaults()}
            className="rounded-xl border border-line bg-white px-3 py-2 text-xs font-medium text-ink-2 transition-colors hover:border-line-2 disabled:opacity-50"
          >
            Reset defaults
          </button>
          <button
            type="button"
            disabled={busy || !thresholds}
            onClick={() => void save()}
            className="rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-50"
          >
            {busy ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {!thresholds ? (
        <p className="mt-4 text-xs text-ink-3">Loading thresholds...</p>
      ) : (
        <div className="mt-4 space-y-5">
          {orderedGroups.map((group) => (
            <div key={group.title}>
              <p className="text-[11px] font-medium uppercase tracking-wider text-ink-3">
                {group.title}
              </p>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {group.keys
                  .filter((key) => key in thresholds || key in defaults)
                  .map((key) => {
                    const value = thresholds[key] ?? defaults[key] ?? 0;
                    const shown = displayValue(key, value);
                    const suffix = SHARE_KEYS.has(key) ? "%" : "";
                    return (
                      <label key={key} className="block text-xs text-ink-2">
                        <span className="mb-1 block">{labelFor(key)}</span>
                        <div className="flex items-center gap-2">
                          <input
                            className="w-full rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none focus:border-brand/40"
                            inputMode="decimal"
                            value={shown}
                            onChange={(event) => setKey(key, event.target.value)}
                          />
                          {suffix ? (
                            <span className="text-[11px] text-ink-3">{suffix}</span>
                          ) : null}
                        </div>
                      </label>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      )}

      {notice ? (
        <p className="mt-3 text-xs text-ink-2">{notice}</p>
      ) : null}
    </div>
  );
}
