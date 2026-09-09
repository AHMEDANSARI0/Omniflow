"use client";

import { useCallback, useEffect, useState } from "react";

interface WidgetSettings {
  enabled: boolean;
  businessName: string;
  welcomeText: string;
}

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const primaryBtn =
  "rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50";

export default function WidgetSettingsCard() {
  const [settings, setSettings] = useState<WidgetSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/widget-settings", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) {
        setLoadError(true);
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        settings?: {
          enabled?: boolean;
          businessName?: string;
          welcomeText?: string;
        } | null;
      } | null;
      if (payload?.settings) {
        setSettings({
          enabled: payload.settings.enabled === true,
          businessName: payload.settings.businessName ?? "",
          welcomeText: payload.settings.welcomeText ?? "",
        });
      }
      setLoaded(true);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(next: WidgetSettings) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/widget-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          enabled: next.enabled,
          businessName: next.businessName.trim(),
          welcomeText: next.welcomeText.trim(),
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setSettings(next);
        setMessage({
          kind: "ok",
          text: next.enabled
            ? "Saved — the website chat bubble updates right away."
            : "Saved — the website chat bubble is now hidden.",
        });
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not save. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  if (!loaded && !loadError) {
    return (
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
        <div className="h-4 w-40 animate-pulse rounded bg-white/[0.05]" />
        <div className="mt-3 h-10 animate-pulse rounded bg-white/[0.03]" />
      </div>
    );
  }

  if (loadError || !settings) {
    return (
      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-5 py-6 text-center">
        <p className="text-sm text-slate-300">
          The widget control is rolling out on the server — try again in a
          couple of minutes.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold text-white">
              Website chat widget
            </h2>
            <span
              className={
                "rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider " +
                (settings.enabled
                  ? "border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-300"
                  : "border-white/[0.08] bg-white/[0.03] text-slate-500")
              }
            >
              {settings.enabled ? "Live" : "Off"}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
            Visitors chat from your website straight into the same inbox —
            replies reach them inside the widget, never on WhatsApp.
          </p>
        </div>
        <button
          type="button"
          onClick={() => save({ ...settings, enabled: !settings.enabled })}
          disabled={busy}
          className={
            "w-full shrink-0 rounded-xl px-4 py-2 text-xs font-medium transition-colors duration-300 disabled:opacity-50 sm:w-auto " +
            (settings.enabled
              ? "border border-red-400/25 bg-red-400/[0.06] text-red-300 hover:bg-red-400/[0.12]"
              : "border border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300 hover:bg-emerald-400/[0.14]")
          }
        >
          {settings.enabled ? "Disable widget" : "Enable widget"}
        </button>
      </div>

      {settings.enabled && (
        <div className="mt-4 space-y-3 border-t border-white/[0.06] pt-4">
          <div>
            <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Business name (widget header)
            </label>
            <input
              value={settings.businessName}
              onChange={(event) =>
                setSettings({ ...settings, businessName: event.target.value })
              }
              maxLength={80}
              placeholder="e.g. Ahmed Collection"
              className={inputClass}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Welcome message
            </label>
            <textarea
              value={settings.welcomeText}
              onChange={(event) =>
                setSettings({ ...settings, welcomeText: event.target.value })
              }
              rows={2}
              maxLength={200}
              placeholder="Hi! Message us here and we will reply right away."
              className={inputClass + " resize-none"}
            />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            <button
              type="button"
              onClick={() => save(settings)}
              disabled={busy}
              className={primaryBtn + " w-full sm:w-auto"}
            >
              {busy ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      )}

      {message && (
        <p
          className={
            "mt-3 text-xs " +
            (message.kind === "ok" ? "text-emerald-300" : "text-red-300")
          }
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
