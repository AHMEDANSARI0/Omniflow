"use client";

import { useState } from "react";
import type { FollowupSettings } from "../../../../lib/omniflow/portal";

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const labelClass = "mb-1.5 block text-xs font-medium text-slate-400";

export default function FollowupSettingsForm({
  initial,
}: {
  initial: FollowupSettings | null;
}) {
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [delayHours, setDelayHours] = useState(initial?.delayHours ?? 24);
  const [maxAttempts, setMaxAttempts] = useState(initial?.maxAttempts ?? 2);
  const [messageTemplate, setMessageTemplate] = useState(
    initial?.messageTemplate ?? ""
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );

  async function save() {
    if (saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/followups", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          settings: {
            enabled,
            delayHours,
            maxAttempts,
            messageTemplate,
          },
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({ kind: "ok", text: "Follow-up settings saved." });
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not save. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-white">Follow-up agent</h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            Automatically follows up with customers who went silent after asking
            about pricing, stock, or buying. Stops as soon as the customer
            replies or asks for a human.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEnabled((value) => !value)}
          aria-pressed={enabled}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
            enabled ? "bg-cyan-400" : "bg-white/[0.1]"
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
              enabled ? "left-[22px]" : "left-0.5"
            }`}
          />
        </button>
      </div>

      {initial === null ? (
        <p className="mt-4 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] px-4 py-3 text-xs leading-relaxed text-cyan-200/90">
          The follow-up module is rolling out on the server — configure it now;
          it syncs automatically after the deploy.
        </p>
      ) : (
        <div className="mt-5 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="fuDelay" className={labelClass}>
                Wait before follow-up (hours)
              </label>
              <input
                id="fuDelay"
                type="number"
                min={1}
                max={168}
                value={delayHours}
                onChange={(e) => setDelayHours(Number(e.target.value))}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="fuAttempts" className={labelClass}>
                Maximum attempts
              </label>
              <select
                id="fuAttempts"
                value={maxAttempts}
                onChange={(e) => setMaxAttempts(Number(e.target.value))}
                className={`${inputClass} cursor-pointer`}
              >
                <option value={1} className="bg-[#081522]">
                  1
                </option>
                <option value={2} className="bg-[#081522]">
                  2
                </option>
                <option value={3} className="bg-[#081522]">
                  3
                </option>
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="fuTemplate" className={labelClass}>
              Message template
            </label>
            <textarea
              id="fuTemplate"
              rows={3}
              maxLength={1000}
              value={messageTemplate}
              onChange={(e) => setMessageTemplate(e.target.value)}
              placeholder={
                "Hi {name}! Following up on your question — if you need any more details or want to place an order, just let me know."
              }
              className={`${inputClass} resize-y`}
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
              {"{name}"} is replaced with the customer&apos;s first name. Leave
              empty to use the default message.
            </p>
          </div>

          {message && (
            <p
              role="status"
              className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${
                message.kind === "ok"
                  ? "border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-300"
                  : "border-red-400/20 bg-red-400/[0.06] text-red-300"
              }`}
            >
              {message.text}
            </p>
          )}

          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="rounded-xl bg-cyan-400 px-5 py-2.5 text-sm font-semibold text-[#07111f] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save follow-up settings"}
          </button>
        </div>
      )}
    </div>
  );
}
