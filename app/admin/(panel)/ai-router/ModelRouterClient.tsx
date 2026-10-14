"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type {
  AdminModelRouter,
  AdminRouterTestResult,
  RouterTestTarget,
  RouterTier,
} from "../../../../lib/omniflow/admin-control-plane";

/**
 * Model Router (§229): fast / smart tiers, per-task routes, a secondary
 * provider for failover, the circuit breaker, and what each route costs.
 * Saves through the generic admin providers API (group "router").
 */

type Form = {
  mode: string;
  failover: string;
  fast_provider: string;
  fast_model: string;
  smart_provider: string;
  smart_model: string;
  secondary_base_url: string;
  secondary_api_key: string;
  secondary_model: string;
  breaker_failures: string;
  breaker_seconds: string;
};

const CARD = "mb-6 rounded-2xl border border-line bg-white shadow-card p-5";
const INPUT =
  "w-full rounded-xl border border-line bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-brand/40";
const LABEL = "mb-1 block text-xs font-medium text-ink-3";
const BUTTON =
  "rounded-xl border border-line bg-white px-3 py-1.5 text-xs font-medium text-ink-2 hover:border-brand/40 disabled:opacity-50";
const TIER_LABEL: Record<RouterTier, string> = {
  fast: "Fast",
  smart: "Smart",
  main: "AI engine",
};

function money(value: number | null): string {
  if (value === null) return "-";
  return "$" + (value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2));
}

function formFrom(data: AdminModelRouter): Form {
  const s = data.settings;
  return {
    // blank = not saved in the panel: show what is in effect (env or default)
    mode: s.mode || data.mode,
    failover: s.failover || data.failover,
    fast_provider: s.fast_provider || data.tiers.fast.provider,
    fast_model: s.fast_model,
    smart_provider: s.smart_provider || data.tiers.smart.provider,
    smart_model: s.smart_model,
    secondary_base_url: s.secondary_base_url,
    secondary_api_key: "",
    secondary_model: s.secondary_model,
    breaker_failures: s.breaker_failures,
    breaker_seconds: s.breaker_seconds,
  };
}

export default function ModelRouterClient() {
  const [data, setData] = useState<AdminModelRouter | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [routes, setRoutes] = useState<Record<string, RouterTier>>({});
  const [days, setDays] = useState(7);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [tests, setTests] = useState<Partial<Record<RouterTestTarget, string>>>({});
  const [testing, setTesting] = useState<RouterTestTarget | null>(null);

  const load = useCallback(async (range: number) => {
    setLoadError("");
    try {
      const response = await fetch("/api/omniflow/admin/ai/router?days=" + range, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.error) {
        setLoadError(payload?.error?.message || "Could not load the Model Router.");
        return;
      }
      const next = payload as AdminModelRouter;
      setData(next);
      setForm(formFrom(next));
      setRoutes(Object.fromEntries(next.routes.map((r) => [r.feature, r.tier])));
    } catch {
      setLoadError("Could not load the Model Router.");
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [load, days]);

  const set = (key: keyof Form, value: string) =>
    setForm((current) => (current ? { ...current, [key]: value } : current));

  async function save() {
    if (!form || !data) return;
    setSaving(true);
    setMessage(null);
    const changed = Object.fromEntries(
      data.routes
        .filter((r) => routes[r.feature] && routes[r.feature] !== r.default_tier)
        .map((r) => [r.feature, routes[r.feature]])
    );
    const values: Record<string, string> = {
      ...form,
      routes_json: Object.keys(changed).length ? JSON.stringify(changed) : "",
    };
    try {
      const response = await fetch("/api/omniflow/admin/providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group: "router", values }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.error) {
        setMessage({ ok: false, text: payload?.error?.message || "Could not save." });
      } else {
        setMessage({ ok: true, text: "Saved. New calls use it within 30 seconds." });
        await load(days);
      }
    } catch {
      setMessage({ ok: false, text: "Could not save." });
    } finally {
      setSaving(false);
    }
  }

  async function runTest(target: RouterTestTarget) {
    setTesting(target);
    setTests((current) => ({ ...current, [target]: "Testing..." }));
    try {
      const response = await fetch("/api/omniflow/admin/ai/router/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target }),
      });
      const payload = await response.json().catch(() => null);
      let text = "Test failed.";
      if (payload?.error?.message) {
        text = payload.error.message;
      } else if (payload && "ok" in payload) {
        const result = payload as AdminRouterTestResult;
        text = result.ok
          ? "Working - " + result.model + " answered in " + result.latency_ms + " ms."
          : "Failed - " + result.model + ": " + result.error;
      }
      setTests((current) => ({ ...current, [target]: text }));
    } catch {
      setTests((current) => ({ ...current, [target]: "Test failed." }));
    } finally {
      setTesting(null);
    }
  }

  if (loadError && !data) {
    return (
      <div className={CARD}>
        <p className="text-sm text-danger">{loadError}</p>
        <button className={BUTTON + " mt-3"} onClick={() => void load(days)}>
          Try again
        </button>
      </div>
    );
  }
  if (!data || !form) {
    return <p className="text-sm text-ink-3">Loading the Model Router...</p>;
  }

  const testButton = (target: RouterTestTarget) => (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button className={BUTTON} disabled={testing !== null} onClick={() => void runTest(target)}>
        Test
      </button>
      {tests[target] && <span className="text-xs text-ink-3">{tests[target]}</span>}
    </div>
  );

  const paused = (["primary", "secondary"] as const).filter((p) => data.breaker.state[p].paused);

  return (
    <div>
      <div className={CARD}>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-lg border border-line bg-soft px-2.5 py-1 text-ink-2">
            Routing {data.mode === "on" ? "on" : "off"}
          </span>
          <span className="rounded-lg border border-line bg-soft px-2.5 py-1 text-ink-2">
            Failover{" "}
            {data.failover === "on" ? (data.secondary.configured ? "ready" : "needs a secondary provider") : "off"}
          </span>
          <span className="rounded-lg border border-line bg-soft px-2.5 py-1 text-ink-2">
            Last {data.usage.days} days: {data.usage.calls} calls, {data.usage.failed} failed,{" "}
            {data.usage.failovers} failed over, {money(data.usage.cost_usd)}
          </span>
          {paused.map((p) => (
            <span key={p} className="rounded-lg border border-red-400/30 bg-red-400/10 px-2.5 py-1 text-danger">
              {p === "primary" ? "AI engine" : "Secondary"} paused for {data.breaker.state[p].paused_seconds_left}s
            </span>
          ))}
        </div>
        {data.warnings.length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {data.warnings.map((warning) => (
              <li key={warning} className="rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-ink-2">
                {warning}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className={CARD}>
          <h2 className="text-sm font-semibold text-ink">AI engine (primary)</h2>
          <p className="mt-1 text-xs text-ink-3">
            Set in{" "}
            <Link href="/admin/integrations" className="text-brand hover:underline">
              Integrations
            </Link>
            . Used for every task unless a tier below says otherwise.
          </p>
          <dl className="mt-3 space-y-1 text-xs">
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-ink-3">Model</dt>
              <dd className="text-ink-2">{data.primary.model || "-"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-ink-3">Address</dt>
              <dd className="break-all text-ink-2">{data.primary.base_url || "-"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-ink-3">Status</dt>
              <dd className="text-ink-2">
                {data.primary.configured ? (data.primary.enabled ? "Ready" : "Switched off") : "No API key"}
              </dd>
            </div>
          </dl>
          {testButton("primary")}
        </div>

        <div className={CARD}>
          <h2 className="text-sm font-semibold text-ink">Secondary provider</h2>
          <p className="mt-1 text-xs text-ink-3">
            Any OpenAI-compatible provider (another vendor, or a second key on the same one). Takes over
            when the AI engine does not answer, and can serve a tier.
          </p>
          <div className="mt-3 space-y-3">
            <label className="block">
              <span className={LABEL}>Base URL</span>
              <input
                className={INPUT}
                value={form.secondary_base_url}
                placeholder={data.primary.base_url || "https://api.groq.com/openai/v1"}
                onChange={(e) => set("secondary_base_url", e.target.value)}
              />
              <span className="mt-1 block text-[11px] text-ink-3">Blank = the AI engine address.</span>
            </label>
            <label className="block">
              <span className={LABEL}>API key</span>
              <input
                className={INPUT}
                type="password"
                autoComplete="off"
                value={form.secondary_api_key}
                placeholder={data.settings.secondary_api_key || (data.secondary.from_env ? "Set on the server" : "")}
                onChange={(e) => set("secondary_api_key", e.target.value)}
              />
              <span className="mt-1 block text-[11px] text-ink-3">
                Stored encrypted. Leave blank to keep the saved key.
              </span>
            </label>
            <label className="block">
              <span className={LABEL}>Default model</span>
              <input
                className={INPUT}
                value={form.secondary_model}
                placeholder="llama-3.1-8b-instant"
                onChange={(e) => set("secondary_model", e.target.value)}
              />
              <span className="mt-1 block text-[11px] text-ink-3">Blank = the same model name as the task.</span>
            </label>
          </div>
          {testButton("secondary")}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {(["fast", "smart"] as const).map((tier) => (
          <div key={tier} className={CARD}>
            <h2 className="text-sm font-semibold text-ink">{TIER_LABEL[tier]} tier</h2>
            <p className="mt-1 text-xs text-ink-3">
              {tier === "fast"
                ? "Short classification work. A small, cheap model is usually enough."
                : "Replies and writing customers and owners read. Use your best model here."}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="block">
                <span className={LABEL}>Provider</span>
                <select
                  className={INPUT}
                  value={form[(tier + "_provider") as keyof Form]}
                  onChange={(e) => set((tier + "_provider") as keyof Form, e.target.value)}
                >
                  <option value="primary">AI engine</option>
                  <option value="secondary">Secondary</option>
                </select>
              </label>
              <label className="block">
                <span className={LABEL}>Model</span>
                <input
                  className={INPUT}
                  value={form[(tier + "_model") as keyof Form]}
                  placeholder={data.tiers[tier].model || "provider default"}
                  onChange={(e) => set((tier + "_model") as keyof Form, e.target.value)}
                />
              </label>
            </div>
            <p className="mt-2 text-[11px] text-ink-3">
              Now: {data.tiers[tier].model || "-"} on {data.tiers[tier].provider === "primary" ? "the AI engine" : "the secondary provider"}.
              Blank model = that provider&apos;s default.
            </p>
            {testButton(tier)}
          </div>
        ))}
      </div>

      <div className={CARD}>
        <h2 className="text-sm font-semibold text-ink">Task routes</h2>
        <p className="mt-1 text-xs text-ink-3">Which tier each AI task uses. Usage covers the last {data.usage.days} days.</p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wider text-ink-3">
                <th className="px-3 py-2 font-medium">Task</th>
                <th className="px-3 py-2 font-medium">Tier</th>
                <th className="px-3 py-2 font-medium">Model now</th>
                <th className="px-3 py-2 font-medium">Calls</th>
                <th className="px-3 py-2 font-medium">Failed</th>
                <th className="px-3 py-2 font-medium">Failed over</th>
                <th className="px-3 py-2 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.routes.map((route) => (
                <tr key={route.feature} className="border-b border-line last:border-0">
                  <td className="px-3 py-2 text-ink">{route.label}</td>
                  <td className="px-3 py-2">
                    <select
                      className="rounded-lg border border-line bg-canvas px-2 py-1 text-xs text-ink"
                      value={routes[route.feature] || route.default_tier}
                      onChange={(e) =>
                        setRoutes((current) => ({ ...current, [route.feature]: e.target.value as RouterTier }))
                      }
                    >
                      {(["fast", "smart", "main"] as const).map((tier) => (
                        <option key={tier} value={tier}>
                          {TIER_LABEL[tier]}
                          {tier === route.default_tier ? " (default)" : ""}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-2">
                    {route.model || "-"}
                    {route.provider === "secondary" ? " (secondary)" : ""}
                  </td>
                  <td className="px-3 py-2 text-ink-2">{route.calls}</td>
                  <td className="px-3 py-2 text-ink-2">{route.failed}</td>
                  <td className="px-3 py-2 text-ink-2">{route.failovers}</td>
                  <td className="px-3 py-2 text-ink-2">{money(route.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className={CARD}>
        <h2 className="text-sm font-semibold text-ink">Dedicated routes</h2>
        <p className="mt-1 text-xs text-ink-3">
          These tasks have their own settings in{" "}
          <Link href="/admin/integrations" className="text-brand hover:underline">
            Integrations
          </Link>
          .
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wider text-ink-3">
                <th className="px-3 py-2 font-medium">Task</th>
                <th className="px-3 py-2 font-medium">Model</th>
                <th className="px-3 py-2 font-medium">Key</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Failover</th>
              </tr>
            </thead>
            <tbody>
              {data.dedicated.map((item) => (
                <tr key={item.feature} className="border-b border-line last:border-0">
                  <td className="px-3 py-2 text-ink">{item.label}</td>
                  <td className="px-3 py-2 text-xs text-ink-2">{item.model || "-"}</td>
                  <td className="px-3 py-2 text-xs text-ink-2">
                    {item.key_source === "llm" ? "AI engine key" : item.key_source === "none" ? "None" : "Own key"}
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-2">{item.active ? "Active" : item.reason.replace("_", " ")}</td>
                  <td className="px-3 py-2 text-xs text-ink-2">{item.failover ? "Secondary" : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className={CARD}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Models in use</h2>
            <p className="mt-1 text-xs text-ink-3">
              {data.prices_configured
                ? "Cost uses the model prices saved in Integrations."
                : "Save model prices in Integrations (AI engine) to see cost."}
            </p>
          </div>
          <select
            className="rounded-lg border border-line bg-canvas px-2 py-1 text-xs text-ink"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {[1, 7, 30].map((d) => (
              <option key={d} value={d}>
                Last {d} {d === 1 ? "day" : "days"}
              </option>
            ))}
          </select>
        </div>
        {data.usage.error && <p className="mt-3 text-xs text-danger">{data.usage.error}</p>}
        {data.usage.models.length === 0 ? (
          <p className="mt-3 text-xs text-ink-3">No AI calls in this period.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-wider text-ink-3">
                  <th className="px-3 py-2 font-medium">Model</th>
                  <th className="px-3 py-2 font-medium">Calls</th>
                  <th className="px-3 py-2 font-medium">Failed</th>
                  <th className="px-3 py-2 font-medium">Avg time</th>
                  <th className="px-3 py-2 font-medium">Tokens</th>
                  <th className="px-3 py-2 font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.usage.models.map((model) => (
                  <tr key={model.model} className="border-b border-line last:border-0">
                    <td className="px-3 py-2 text-xs text-ink">{model.model}</td>
                    <td className="px-3 py-2 text-ink-2">{model.calls}</td>
                    <td className="px-3 py-2 text-ink-2">{model.failed}</td>
                    <td className="px-3 py-2 text-ink-2">{model.avg_latency_ms} ms</td>
                    <td className="px-3 py-2 text-ink-2">{model.tokens}</td>
                    <td className="px-3 py-2 text-ink-2">{money(model.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className={CARD}>
        <h2 className="text-sm font-semibold text-ink">Routing and failover</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <label className="block">
            <span className={LABEL}>Routing</span>
            <select className={INPUT} value={form.mode} onChange={(e) => set("mode", e.target.value)}>
              <option value="on">On</option>
              <option value="off">Off - AI engine for everything</option>
            </select>
          </label>
          <label className="block">
            <span className={LABEL}>Failover</span>
            <select className={INPUT} value={form.failover} onChange={(e) => set("failover", e.target.value)}>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label className="block">
            <span className={LABEL}>Pause a provider after</span>
            <input
              className={INPUT}
              value={form.breaker_failures}
              placeholder={String(data.breaker.failures)}
              onChange={(e) => set("breaker_failures", e.target.value)}
            />
            <span className="mt-1 block text-[11px] text-ink-3">failures in a row (1-20)</span>
          </label>
          <label className="block">
            <span className={LABEL}>Pause for</span>
            <input
              className={INPUT}
              value={form.breaker_seconds}
              placeholder={String(data.breaker.seconds)}
              onChange={(e) => set("breaker_seconds", e.target.value)}
            />
            <span className="mt-1 block text-[11px] text-ink-3">seconds (10-3600)</span>
          </label>
        </div>
        <p className="mt-3 text-[11px] text-ink-3">
          A paused provider is skipped while the other one can answer. Every call still goes through the AI
          kill switch and the daily cap.
        </p>
      </div>

      <div className="mb-10 flex flex-wrap items-center gap-3">
        <button
          className="rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors hover:border-brand/40 disabled:opacity-50"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? "Saving..." : "Save router settings"}
        </button>
        {message && <span className={"text-xs " + (message.ok ? "text-ok" : "text-danger")}>{message.text}</span>}
      </div>
    </div>
  );
}
