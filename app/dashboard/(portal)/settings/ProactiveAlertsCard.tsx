"use client";

/** §242 Proactive alerts: demand and complaint patterns, raised as they appear. */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { ProactiveAlert, ProactiveRule, ProactiveState } from "../../../../lib/omniflow/portal";

const API = "/api/omniflow/portal/proactive";
const INPUT =
  "w-full rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none focus:border-brand/40 disabled:opacity-60";

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  return (await response.json().catch(() => null)) as Record<string, unknown> | null;
}

function errorText(payload: Record<string, unknown> | null, fallback: string): string {
  const error = payload?.error as { message?: unknown } | undefined;
  return typeof error?.message === "string" && error.message ? error.message : fallback;
}

function when(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

export default function ProactiveAlertsCard() {
  const [state, setState] = useState<ProactiveState | null>(null);
  const [rules, setRules] = useState<ProactiveRule[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "run">("");
  const [note, setNote] = useState("");

  const apply = useCallback((next: ProactiveState) => {
    setState(next);
    setRules(next.rules);
    setEnabled(next.enabled);
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch(API, { credentials: "same-origin", cache: "no-store" });
      const payload = await readJson(response);
      if (response.ok && payload && Array.isArray(payload.rules)) apply(payload as unknown as ProactiveState);
      else setNote(errorText(payload, "Could not load proactive alerts right now."));
    } catch {
      setNote("Could not load proactive alerts right now.");
    } finally {
      setLoaded(true);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  function setRule(key: string, change: (rule: ProactiveRule) => ProactiveRule) {
    setRules((prev) => prev.map((rule) => (rule.key === key ? change(rule) : rule)));
  }

  async function save() {
    setBusy("save");
    setNote("");
    const body = {
      enabled,
      rules: Object.fromEntries(
        rules.map((rule) => [
          rule.key,
          { enabled: rule.enabled, ...Object.fromEntries(rule.params.map((p) => [p.key, p.value])) },
        ])
      ),
    };
    try {
      const response = await fetch(API, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      const payload = await readJson(response);
      if (!response.ok || !payload || !Array.isArray(payload.rules)) {
        setNote(errorText(payload, "Could not save right now. Try again shortly."));
        return;
      }
      apply(payload as unknown as ProactiveState);
      setNote(enabled ? "Saved. Alerts go to the bell (and email, if Notifications email is on)." : "Saved. Proactive alerts are off.");
    } catch {
      setNote("Could not save right now. Try again shortly.");
    } finally {
      setBusy("");
    }
  }

  async function runNow() {
    setBusy("run");
    setNote("");
    try {
      const response = await fetch(API + "/run", { method: "POST", credentials: "same-origin" });
      const payload = await readJson(response);
      if (!response.ok || !payload) {
        setNote(errorText(payload, "Could not check right now. Try again shortly."));
        return;
      }
      const found = Array.isArray(payload.alerts) ? (payload.alerts as ProactiveAlert[]).length : 0;
      const checked = typeof payload.checked === "number" ? payload.checked : 0;
      setNote(
        "Checked " + checked + " recent customer message" + (checked === 1 ? "" : "s") + ": " +
          (found ? found + " new alert" + (found === 1 ? "" : "s") + "." : "nothing new.")
      );
      await load();
    } catch {
      setNote("Could not check right now. Try again shortly.");
    } finally {
      setBusy("");
    }
  }

  const canEdit = state?.can_edit === true;
  const recent = state?.recent ?? [];

  return (
    <div className="mt-6 rounded-xl2 border border-line bg-white p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Proactive alerts</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">
            Watches recent customer messages and alerts you as soon as a pattern appears: demand for
            products you don&apos;t sell right now, repeated complaints, complaints about one product
            and complaint spikes.
            {state ? " Checked automatically about every " + state.every_minutes + " minutes." : ""}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={!canEdit}
          onClick={() => setEnabled((prev) => !prev)}
          className={
            "rounded-lg border px-2.5 py-1 text-[11px] disabled:opacity-60 " +
            (enabled ? "border-emerald-400/25 bg-emerald-400/[0.08] text-ok" : "border-line bg-soft text-ink-3")
          }
        >
          {enabled ? "Alerts on" : "Alerts off"}
        </button>
      </div>

      {!loaded ? (
        <p className="mt-4 text-xs text-ink-3">Loading rules...</p>
      ) : state && !state.available ? (
        <p className="mt-4 text-xs text-ink-3">Proactive alerts are turned off on this server.</p>
      ) : (
        <div className="mt-4 space-y-3">
          {rules.map((rule) => (
            <div key={rule.key} className="rounded-lg border border-line bg-soft p-3">
              <label className="flex items-start gap-2 text-xs text-ink">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  disabled={!canEdit}
                  onChange={(event) => setRule(rule.key, (r) => ({ ...r, enabled: event.target.checked }))}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">{rule.label}</span>
                  {rule.severity === "high" ? <span className="ml-2 text-[11px] text-danger">high</span> : null}
                  <span className="mt-0.5 block text-[11px] text-ink-3">{rule.description}</span>
                </span>
              </label>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {rule.params.map((param) => (
                  <label key={param.key} className="block text-[11px] text-ink-2">
                    <span className="mb-1 block">
                      {param.label} ({param.min}-{param.max})
                    </span>
                    <input
                      type="number"
                      min={param.min}
                      max={param.max}
                      step={1}
                      value={param.value}
                      disabled={!canEdit || !rule.enabled}
                      onChange={(event) =>
                        setRule(rule.key, (r) => ({
                          ...r,
                          params: r.params.map((p) =>
                            p.key === param.key ? { ...p, value: Math.trunc(Number(event.target.value) || 0) } : p
                          ),
                        }))
                      }
                      className={INPUT}
                    />
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {canEdit ? (
          <button
            type="button"
            disabled={busy !== "" || !state}
            onClick={() => void save()}
            className="rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-50"
          >
            {busy === "save" ? "Saving..." : "Save"}
          </button>
        ) : state ? (
          <span className="text-[11px] text-ink-3">Only owners and admins can change these rules.</span>
        ) : null}
        <button
          type="button"
          disabled={busy !== "" || !state || !state.enabled || !state.available}
          onClick={() => void runNow()}
          className="rounded-xl border border-line bg-white px-3 py-2 text-xs font-medium text-ink-2 transition-colors hover:border-line-2 disabled:opacity-50"
        >
          {busy === "run" ? "Checking..." : "Check now"}
        </button>
        {note ? <span className="text-xs text-ink-2">{note}</span> : null}
      </div>

      {state ? (
        <div className="mt-5">
          <h3 className="text-xs font-semibold text-ink">Recent alerts</h3>
          {state.last_run_at ? <p className="mt-0.5 text-[11px] text-ink-3">Last check: {when(state.last_run_at)}</p> : null}
          {recent.length === 0 ? (
            <p className="mt-2 text-xs text-ink-3">No alerts yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-line">
              {recent.map((alert) => (
                <li key={alert.id} className="py-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className={"text-xs font-medium " + (alert.severity === "high" ? "text-danger" : "text-ink")}>
                      {alert.title}
                    </span>
                    <span className="text-[11px] text-ink-3">{when(alert.created_at)}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-ink-3">
                    {alert.detail}
                    {alert.href.startsWith("/dashboard/") ? (
                      <>
                        {" "}
                        <Link href={alert.href} className="text-brand hover:underline">
                          Open
                        </Link>
                      </>
                    ) : null}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
