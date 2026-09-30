"use client";

import { useCallback, useEffect, useState } from "react";

interface UsageTotals {
  calls: number;
  failed: number;
  prompt_tokens: number;
  completion_tokens: number;
  tokens: number;
  avg_latency_ms: number;
  cost_usd: number | null;
  priced: boolean;
  unpriced_calls: number;
}

interface Overview {
  days: number;
  total: number;
  by_category: { key: string; label: string; count: number }[];
  by_actor: Record<string, number>;
  approvals_pending: number | null;
  escalations: { open: number; open_high: number } | null;
  usage: { totals: UsageTotals; prices_configured: boolean } | null;
}

interface Usage {
  days: number;
  totals: UsageTotals;
  by_feature: { feature: string; label: string; calls: number; failed: number; tokens: number; cost_usd: number | null }[];
  by_model: { model: string; calls: number; failed: number; tokens: number; cost_usd: number | null }[];
  by_day: { day: string; calls: number; tokens: number }[];
  prices_configured: boolean;
}

interface AuditItem {
  id: number;
  action: string;
  category: string;
  actor_kind: string;
  conversation_id: number | null;
  note: string;
  created_at: string | null;
}

interface Audit {
  days: number;
  category: string;
  items: AuditItem[];
  categories: { key: string; label: string }[];
}

const ACTOR_LABEL: Record<string, string> = {
  automation: "AI",
  bot: "AI",
  ai: "AI",
  workflow: "Workflow",
  system: "System",
  customer_user: "Team",
  human: "Team",
};

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - then) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  return Math.floor(hours / 24) + "d ago";
}

function formatTokens(value: number): string {
  if (value >= 1000000) return (value / 1000000).toFixed(2) + "M";
  if (value >= 1000) return (value / 1000).toFixed(1) + "k";
  return String(value);
}

function formatCost(value: number | null, priced: boolean): string {
  if (!priced || value === null) return "not configured";
  return "$" + value.toFixed(value < 1 ? 4 : 2);
}

/**
 * Configure AI -> AI operations: what the assistant did (one unified audit
 * across answers, actions, workflows, handoffs, approvals, rules), what it
 * cost (calls, tokens, latency, estimated spend when the admin saved model
 * prices) and the live queues (approvals waiting, handoffs open).
 */
export default function AiOpsCard() {
  const [days, setDays] = useState<7 | 30>(7);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [category, setCategory] = useState("");
  const [tab, setTab] = useState<"activity" | "usage">("activity");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const [o, u, a] = await Promise.all([
        fetch("/api/omniflow/portal/ai/overview?days=" + days, { credentials: "same-origin", cache: "no-store" }),
        fetch("/api/omniflow/portal/ai/usage?days=" + days, { credentials: "same-origin", cache: "no-store" }),
        fetch(
          "/api/omniflow/portal/ai/audit?days=" + days + "&limit=40&category=" + encodeURIComponent(category),
          { credentials: "same-origin", cache: "no-store" }
        ),
      ]);
      setOverview(o.ok ? ((await o.json()) as Overview) : null);
      setUsage(u.ok ? ((await u.json()) as Usage) : null);
      setAudit(a.ok ? ((await a.json()) as Audit) : null);
    } catch {
      setOverview(null);
      setUsage(null);
      setAudit(null);
    } finally {
      setLoaded(true);
    }
  }, [days, category]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = usage?.totals ?? overview?.usage?.totals ?? null;
  const pricesConfigured = usage?.prices_configured ?? overview?.usage?.prices_configured ?? false;

  return (
    <section className="rounded-2xl border border-line bg-white shadow-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">AI operations</h2>
          <p className="mt-1 text-xs text-ink-3">
            Everything the assistant did, in one place: answers, actions,
            workflows, handoffs and approvals, plus what it cost.
          </p>
        </div>
        <div className="flex gap-1.5">
          {([7, 30] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setDays(option)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                days === option
                  ? "border-brand/30 bg-brand-soft text-brand"
                  : "border-line bg-soft text-ink-3 hover:text-ink"
              }`}
            >
              {option} days
            </button>
          ))}
        </div>
      </div>

      {!loaded ? (
        <p className="mt-3 text-xs text-ink-3">Loading&#8230;</p>
      ) : !overview && !usage && !audit ? (
        <p className="mt-3 text-xs text-ink-3">AI operations are unavailable right now. Try again shortly.</p>
      ) : (
        <>
          <div className="mt-4 grid gap-2 sm:grid-cols-4">
            <div className="rounded-xl border border-line px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider text-ink-3">AI actions</p>
              <p className="mt-0.5 text-lg font-semibold text-ink">{overview?.total ?? "\u2014"}</p>
            </div>
            <div className="rounded-xl border border-line px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider text-ink-3">Waiting on you</p>
              <p className="mt-0.5 text-lg font-semibold text-ink">
                {overview?.approvals_pending ?? 0} <span className="text-[10px] font-normal text-ink-3">approvals</span>
                {" \u00b7 "}
                {overview?.escalations?.open ?? 0} <span className="text-[10px] font-normal text-ink-3">handoffs</span>
              </p>
            </div>
            <div className="rounded-xl border border-line px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider text-ink-3">AI calls</p>
              <p className="mt-0.5 text-lg font-semibold text-ink">
                {totals ? totals.calls : "\u2014"}
                {totals && totals.failed > 0 ? (
                  <span className="text-[10px] font-normal text-danger"> {totals.failed} failed</span>
                ) : null}
              </p>
            </div>
            <div className="rounded-xl border border-line px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider text-ink-3">Estimated cost</p>
              <p className="mt-0.5 text-lg font-semibold text-ink">
                {totals ? formatCost(totals.cost_usd, totals.priced) : "\u2014"}
              </p>
              {totals && !pricesConfigured ? (
                <p className="text-[10px] text-ink-3">Model prices are not configured yet (Admin &rarr; Integrations &rarr; AI engine).</p>
              ) : totals && !totals.priced ? (
                <p className="text-[10px] text-ink-3">{totals.unpriced_calls} calls used a model without a price.</p>
              ) : null}
            </div>
          </div>

          <div className="mt-4 flex gap-1.5">
            {(["activity", "usage"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setTab(option)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  tab === option
                    ? "border-brand/30 bg-brand-soft text-brand"
                    : "border-line bg-soft text-ink-3 hover:text-ink"
                }`}
              >
                {option === "activity" ? "Activity" : "Usage & cost"}
              </button>
            ))}
          </div>

          {tab === "activity" ? (
            <div className="mt-3">
              {overview ? (
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setCategory("")}
                    className={`rounded-full border px-2.5 py-0.5 text-[10px] ${
                      category === "" ? "border-brand/30 bg-brand-soft text-brand" : "border-line text-ink-3"
                    }`}
                  >
                    All {overview.total}
                  </button>
                  {overview.by_category
                    .filter((entry) => entry.count > 0)
                    .map((entry) => (
                      <button
                        key={entry.key}
                        type="button"
                        onClick={() => setCategory(entry.key)}
                        className={`rounded-full border px-2.5 py-0.5 text-[10px] ${
                          category === entry.key
                            ? "border-brand/30 bg-brand-soft text-brand"
                            : "border-line text-ink-3"
                        }`}
                      >
                        {entry.label} {entry.count}
                      </button>
                    ))}
                </div>
              ) : null}
              {!audit ? (
                <p className="mt-3 text-xs text-ink-3">The activity log is unavailable right now.</p>
              ) : audit.items.length === 0 ? (
                <p className="mt-3 text-xs text-ink-3">No AI activity in this window.</p>
              ) : (
                <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto">
                  {audit.items.map((item) => (
                    <li key={item.id} className="rounded-xl border border-line px-3 py-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="min-w-0 truncate text-xs text-ink">
                          <span className="mr-1.5 rounded-md border border-line px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-ink-3">
                            {ACTOR_LABEL[item.actor_kind] ?? item.actor_kind}
                          </span>
                          {item.note || item.action}
                        </p>
                        <span className="shrink-0 text-[10px] text-ink-3">{formatWhen(item.created_at)}</span>
                      </div>
                      <p className="mt-0.5 text-[10px] text-ink-3">
                        {item.action}
                        {item.conversation_id ? (
                          <>
                            {" \u00b7 "}
                            <a
                              href={"/dashboard/conversations/" + item.conversation_id}
                              className="text-brand hover:underline"
                            >
                              open chat
                            </a>
                          </>
                        ) : null}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : !usage ? (
            <p className="mt-3 text-xs text-ink-3">Usage figures are unavailable right now.</p>
          ) : usage.totals.calls === 0 ? (
            <p className="mt-3 text-xs text-ink-3">
              No AI calls recorded in this window. Calls are counted from the
              moment this ledger went live.
            </p>
          ) : (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-[11px] text-ink-3">By feature</p>
                <ul className="space-y-1">
                  {usage.by_feature.map((entry) => (
                    <li key={entry.feature} className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="text-ink">{entry.label}</span>
                      <span className="text-ink-3">
                        {entry.calls} calls{entry.failed > 0 ? " (" + entry.failed + " failed)" : ""}
                        {" \u00b7 "}
                        {formatTokens(entry.tokens)} tokens
                        {entry.cost_usd !== null ? " \u00b7 $" + entry.cost_usd.toFixed(4) : ""}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[10px] text-ink-3">
                  {formatTokens(usage.totals.prompt_tokens)} prompt + {formatTokens(usage.totals.completion_tokens)} completion tokens
                  {" \u00b7 "}avg {usage.totals.avg_latency_ms} ms per call
                </p>
              </div>
              <div>
                <p className="mb-1 text-[11px] text-ink-3">By model</p>
                <ul className="space-y-1">
                  {usage.by_model.map((entry) => (
                    <li key={entry.model} className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="text-ink">{entry.model}</span>
                      <span className="text-ink-3">
                        {entry.calls} calls {" \u00b7 "} {formatTokens(entry.tokens)} tokens
                        {entry.cost_usd !== null ? " \u00b7 $" + entry.cost_usd.toFixed(4) : " \u00b7 no price"}
                      </span>
                    </li>
                  ))}
                </ul>
                {usage.by_day.length > 1 ? (
                  <p className="mt-2 text-[10px] text-ink-3">
                    Daily calls: {usage.by_day.map((d) => d.day.slice(5) + " " + d.calls).join(" \u00b7 ")}
                  </p>
                ) : null}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
