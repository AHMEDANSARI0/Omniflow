"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";


export interface BotConfigView {
  configured: boolean;
  agentName: string;
  tone: "friendly" | "professional" | "concise";
  greeting: string;
  fallback: string;
  workingHoursEnabled: boolean;
  workingHoursStart: string;
  workingHoursEnd: string;
  humanHandoffEnabled: boolean;
}

const DRAFT_KEY = "omniflow.bot.draft.v1";

const TONES: Array<{ value: BotConfigView["tone"]; label: string }> = [
  { value: "friendly", label: "Friendly" },
  { value: "professional", label: "Professional" },
  { value: "concise", label: "Concise" },
];

const FALLBACK_INITIAL: BotConfigView = {
  configured: false,
  agentName: "OmniFlow Assistant",
  tone: "friendly",
  greeting: "",
  fallback: "",
  workingHoursEnabled: false,
  workingHoursStart: "09:00",
  workingHoursEnd: "18:00",
  humanHandoffEnabled: false,
};

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-4 rounded-xl border border-white/[0.05] bg-white/[0.02] px-4 py-3 text-left transition-colors hover:border-white/[0.1]"
      aria-pressed={checked}
    >
      <span>
        <span className="block text-sm text-slate-200">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] text-slate-500">{hint}</span>}
      </span>
      <span
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ${
          checked ? "bg-cyan-400" : "bg-white/[0.1]"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all duration-200 ${
            checked ? "left-[22px]" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}

export default function BotForm({
  initial,
  backendConfigured,
}: {
  initial: BotConfigView | null;
  backendConfigured: boolean;
}) {
  const [config, setConfig] = useState<BotConfigView>(initial ?? FALLBACK_INITIAL);
  const [serverConfigured, setServerConfigured] = useState(backendConfigured);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "info" | "error"; text: string } | null>(
    null
  );

  // If the server module is pending, prefer the local draft (if any).
  useEffect(() => {
    if (backendConfigured) return;
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY);
      if (raw) setConfig({ ...FALLBACK_INITIAL, ...(JSON.parse(raw) as BotConfigView) });
    } catch {
      // Ignore corrupt drafts.
    }
  }, [backendConfigured]);

  function update<K extends keyof BotConfigView>(key: K, value: BotConfigView[K]) {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setMessage(null);
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setMessage(null);

    try {
      const response = await fetch("/api/omniflow/portal/bot", {
        method: "PUT",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      if (response.status === 401) {
        setMessage({ kind: "error", text: "Session expired — reload the page." });
        return;
      }

      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        configured?: boolean;
      } | null;

      if (payload && payload.ok && payload.configured) {
        setServerConfigured(true);
        try {
          window.localStorage.removeItem(DRAFT_KEY);
        } catch {}
        setMessage({ kind: "ok", text: "Saved to the server." });
        return;
      }

      // Server module pending — keep a local draft so nothing is lost.
      try {
        window.localStorage.setItem(DRAFT_KEY, JSON.stringify(config));
      } catch {}
      setServerConfigured(false);
      setMessage({
        kind: "info",
        text:
          "Server module is not deployed yet — your changes are saved as a draft on this device and will sync automatically once the endpoint ships.",
      });
    } catch {
      setMessage({ kind: "error", text: "Network error — please try again." });
    } finally {
      setSaving(false);
    }
  }

  const inputClass =
    "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-200 focus:border-cyan-400/40";
  const labelClass = "mb-1.5 block text-xs font-medium text-slate-400";

  return (
    <motion.form
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      onSubmit={handleSave}
      className="space-y-5"
    >
      {!serverConfigured && (
        <p className="rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] px-4 py-3 text-xs leading-relaxed text-cyan-200/90">
          Backend module pending — you can configure everything now; settings are
          kept as a local draft and sync to the server automatically later.
        </p>
      )}

      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="agentName" className={labelClass}>
              Agent name
            </label>
            <input
              id="agentName"
              className={inputClass}
              maxLength={120}
              value={config.agentName}
              onChange={(e) => update("agentName", e.target.value)}
              placeholder="OmniFlow Assistant"
            />
          </div>
          <div>
            <label htmlFor="tone" className={labelClass}>
              Tone
            </label>
            <select
              id="tone"
              className={`${inputClass} appearance-none`}
              value={config.tone}
              onChange={(e) => update("tone", e.target.value as BotConfigView["tone"])}
            >
              {TONES.map((t) => (
                <option key={t.value} value={t.value} className="bg-[#0b1626]">
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-4">
          <label htmlFor="greeting" className={labelClass}>
            Greeting message
          </label>
          <textarea
            id="greeting"
            className={`${inputClass} min-h-[72px] resize-y`}
            maxLength={1000}
            value={config.greeting}
            onChange={(e) => update("greeting", e.target.value)}
            placeholder="Hi! Thanks for messaging — how can we help you today?"
          />
        </div>

        <div className="mt-4">
          <label htmlFor="fallback" className={labelClass}>
            Fallback message
          </label>
          <textarea
            id="fallback"
            className={`${inputClass} min-h-[72px] resize-y`}
            maxLength={1000}
            value={config.fallback}
            onChange={(e) => update("fallback", e.target.value)}
            placeholder="I'm not sure about that — connecting you to a human colleague."
          />
        </div>
      </div>

      <div className="space-y-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-6">
        <Toggle
          checked={config.workingHoursEnabled}
          onChange={(v) => update("workingHoursEnabled", v)}
          label="Working hours"
          hint="Only reply automatically during these hours"
        />
        {config.workingHoursEnabled && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            className="grid grid-cols-2 gap-3 overflow-hidden"
          >
            <div>
              <label htmlFor="whStart" className={labelClass}>
                From
              </label>
              <input
                id="whStart"
                type="time"
                className={inputClass}
                value={config.workingHoursStart}
                onChange={(e) => update("workingHoursStart", e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="whEnd" className={labelClass}>
                Until
              </label>
              <input
                id="whEnd"
                type="time"
                className={inputClass}
                value={config.workingHoursEnd}
                onChange={(e) => update("workingHoursEnd", e.target.value)}
              />
            </div>
          </motion.div>
        )}
        <Toggle
          checked={config.humanHandoffEnabled}
          onChange={(v) => update("humanHandoffEnabled", v)}
          label="Human handoff"
          hint="Offer a human colleague when the AI is unsure"
        />
      </div>

      {message && (
        <motion.p
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          role="status"
          className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${
            message.kind === "ok"
              ? "border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-300"
              : message.kind === "info"
                ? "border-cyan-400/20 bg-cyan-400/[0.05] text-cyan-200/90"
                : "border-red-400/20 bg-red-400/[0.06] text-red-300"
          }`}
        >
          {message.text}
        </motion.p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="rounded-xl bg-cyan-400 px-5 py-2.5 text-sm font-semibold text-[#07111f] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        <span className="text-[11px] text-slate-600">
          {serverConfigured ? "Synced with Control Plane" : "Draft mode (device only)"}
        </span>
      </div>
    </motion.form>
  );
}
