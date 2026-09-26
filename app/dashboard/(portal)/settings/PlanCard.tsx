"use client";

import { useCallback, useEffect, useState } from "react";

interface PlanCatalogEntry {
  key: string;
  label: string;
  description: string;
  limits: Record<string, number | null>;
}

interface PlansPayload {
  plan: string;
  limits: Record<string, number | null>;
  usage: Record<string, number>;
  catalog: PlanCatalogEntry[];
}

const USAGE_LABELS: Record<string, string> = {
  broadcasts_per_month: "Broadcasts this month",
  team_seats: "Team seats",
  kb_entries: "Knowledge-base entries",
  alert_rules: "Keyword alerts",
  courier_providers: "Courier companies",
  brands: "Brands",
};

function UsageRow({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: number | null;
}) {
  const unlimited = limit === null;
  const pct =
    !unlimited && limit > 0
      ? Math.min(100, Math.round((used / limit) * 100))
      : 0;
  return (
    <li>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-ink-3">{label}</span>
        <span className="text-[11px] text-ink-3">
          {used} / {unlimited ? "\u221e" : limit}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-soft">
        <div
          className={
            "h-full rounded-full " +
            (unlimited
              ? "bg-cyan-400/40"
              : pct >= 100
                ? "bg-rose-400/60"
                : pct >= 80
                  ? "bg-amber-400/60"
                  : "bg-emerald-400/50")
          }
          style={{ width: unlimited ? "12px" : Math.max(4, pct) + "%" }}
        />
      </div>
    </li>
  );
}

/**
 * Plan + usage: what the workspace is on, what it has used against
 * the plan limits, and one-click switching. Every workspace starts on
 * the unlimited legacy plan - switching is always the owner's choice.
 */
export default function PlanCard() {
  const [data, setData] = useState<PlansPayload | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/plans",
        { cache: "no-store" });
      if (response.ok) {
        setData((await response.json()) as PlansPayload);
      }
    } catch {
      /* keep the last state */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function switchPlan(plan: string) {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/omniflow/portal/plans", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      if (response.ok) {
        setNote("Plan updated.");
        await load();
      } else {
        setNote("Could not switch the plan - try again.");
      }
    } catch {
      setNote("Could not switch the plan - try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-line bg-soft p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-ink">Plan &amp; usage</p>
          <p className="mt-0.5 text-[11px] text-ink-3">
            Live usage against the plan limits. Every workspace starts
            unlimited - switching is always your choice.
          </p>
        </div>
        {data ? (
          <span className="shrink-0 rounded-full border border-brand/30 bg-brand-soft px-3 py-1 text-[11px] text-brand">
            {data.plan === "legacy" ? "Unlimited" : data.plan}
          </span>
        ) : null}
      </div>

      {!data ? (
        <div className="mt-3 space-y-2" aria-busy="true">
          {[0, 1, 2, 3, 4].map((row) => (
            <div
              key={row}
              className="h-8 animate-pulse rounded-lg bg-white/5"
            />
          ))}
        </div>
      ) : (
        <>
          <ul className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {Object.keys(USAGE_LABELS).map((key) => (
              <UsageRow
                key={key}
                label={USAGE_LABELS[key]}
                used={Number(data.usage[key] ?? 0)}
                limit={data.limits[key] ?? null}
              />
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {data.catalog.map((entry) => (
              <button
                key={entry.key}
                onClick={() => void switchPlan(entry.key)}
                disabled={busy || entry.key === data.plan}
                title={entry.description}
                className={
                  "rounded-lg border px-3 py-1.5 text-[11px] disabled:opacity-40 " +
                  (entry.key === data.plan
                    ? "border-brand/40 bg-cyan-400/[0.12] text-brand"
                    : "border-line bg-soft text-ink-2 hover:bg-soft")
                }
              >
                {entry.label}
              </button>
            ))}
          </div>
        </>
      )}
      {note ? (
        <p className="mt-1.5 text-[11px] text-ink-2">{note}</p>
      ) : null}
    </section>
  );
}
