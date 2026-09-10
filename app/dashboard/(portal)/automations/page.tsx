"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface AutomationRule {
  id: number;
  keyword: string;
  actionType: "add_tag" | "assign";
  actionValue: string;
  isActive: boolean;
  timesTriggered: number;
  createdAt: string | null;
}

interface TeamMemberLite {
  email: string;
  name: string;
}

export default function AutomationsPage() {
  const [rules, setRules] = useState<AutomationRule[] | null>(null);
  const [expired, setExpired] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [actionType, setActionType] = useState<"add_tag" | "assign">("add_tag");
  const [actionValue, setActionValue] = useState("");
  const [teamMembers, setTeamMembers] = useState<TeamMemberLite[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );
  const [welcomeEnabled, setWelcomeEnabled] = useState(false);
  const [welcomeText, setWelcomeText] = useState("");
  const [welcomeBusy, setWelcomeBusy] = useState(false);
  const [welcomeMessage, setWelcomeMessage] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/automations", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        if (mounted.current) setExpired(true);
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        automations?: AutomationRule[];
      } | null;
      if (mounted.current && payload && Array.isArray(payload.automations)) {
        setRules(payload.automations);
      }
    } catch {
      // Transient network issue — retry on next visit.
    }
  }, []);

  const loadWelcome = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/automations/welcome", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        setExpired(true);
        return;
      }
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        enabled?: boolean;
        text?: string;
      } | null;
      if (payload) {
        setWelcomeEnabled(payload.enabled === true);
        setWelcomeText(typeof payload.text === "string" ? payload.text : "");
      }
    } catch {
      // Additive card — never block the page on it.
    }
  }, []);

  useEffect(() => {
    void loadWelcome();
  }, [loadWelcome]);

  useEffect(() => {
    mounted.current = true;
    void load();
    void (async () => {
      try {
        const response = await fetch("/api/omniflow/portal/team", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (response.status !== 200) return;
        const payload = (await response.json().catch(() => null)) as {
          members?: { email?: string; name?: string; status?: string }[];
        } | null;
        if (mounted.current && payload && Array.isArray(payload.members)) {
          setTeamMembers(
            payload.members
              .filter(
                (member): member is { email: string; name?: string; status?: string } =>
                  member !== null &&
                  typeof member === "object" &&
                  typeof member.email === "string" &&
                  member.status === "active"
              )
              .map((member) => ({
                email: member.email,
                name: typeof member.name === "string" ? member.name : "",
              }))
          );
        }
      } catch {
        // Assign dropdown stays empty — typed emails still work via the API.
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  async function saveWelcome() {
    if (welcomeBusy) return;
    setWelcomeBusy(true);
    setWelcomeMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/automations/welcome", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ enabled: welcomeEnabled, text: welcomeText.trim() }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setWelcomeMessage({ kind: "ok", text: "Welcome message saved." });
      } else {
        setWelcomeMessage({
          kind: "error",
          text: payload?.error?.message || "Could not save. Try again shortly.",
        });
      }
    } catch {
      setWelcomeMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setWelcomeBusy(false);
    }
  }

  async function addRule() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ keyword, actionType, actionValue }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        automation?: AutomationRule;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok && payload.automation) {
        setRules((current) => [
          payload.automation as AutomationRule,
          ...(current ?? []),
        ]);
        setKeyword("");
        setActionValue("");
        setMessage({ kind: "ok", text: "Automation saved — it runs on every incoming message." });
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not save the automation.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  async function toggleRule(rule: AutomationRule) {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(
        "/api/omniflow/portal/automations/" + rule.id,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ isActive: !rule.isActive }),
        }
      );
      if (response.ok) {
        setRules((current) =>
          (current ?? []).map((item) =>
            item.id === rule.id ? { ...item, isActive: !item.isActive } : item
          )
        );
      }
    } catch {
      // Toggle is best-effort — reload to see the stored state.
    } finally {
      setBusy(false);
    }
  }

  async function removeRule(rule: AutomationRule) {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(
        "/api/omniflow/portal/automations/" + rule.id,
        { method: "DELETE", credentials: "same-origin" }
      );
      if (response.ok) {
        setRules((current) =>
          (current ?? []).filter((item) => item.id !== rule.id)
        );
      }
    } catch {
      // Delete is best-effort — reload to see the stored state.
    } finally {
      setBusy(false);
    }
  }

  function describeAction(rule: AutomationRule): string {
    if (rule.actionType === "add_tag") return "Adds label #" + rule.actionValue;
    const member = teamMembers.find((item) => item.email === rule.actionValue);
    return "Assigns to " + (member ? member.name || member.email : rule.actionValue);
  }

  if (expired) {
    return (
      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
        <p className="text-sm text-slate-300">Session expired.</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-base font-semibold text-white">Automations</h1>
      <p className="mt-0.5 text-xs text-slate-500">
        Simple keyword rules that run instantly on every incoming message —
        WhatsApp and website. No AI, fully deterministic.
      </p>

      <div className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-300">Welcome message</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-600">
              Sent automatically when a customer messages for the first time.
              Use {"{{name}}"} to greet by first name.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setWelcomeEnabled(!welcomeEnabled)}
            className={
              "shrink-0 rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors duration-300 " +
              (welcomeEnabled
                ? "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300"
                : "border-white/[0.08] bg-white/[0.03] text-slate-500")
            }
          >
            {welcomeEnabled ? "On" : "Off"}
          </button>
        </div>
        <textarea
          value={welcomeText}
          onChange={(event) => setWelcomeText(event.target.value)}
          maxLength={500}
          rows={3}
          placeholder="Hi! Thanks for reaching out — how can we help you today?"
          className="mt-3 w-full resize-none rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[10px] text-slate-600">
            {welcomeText.trim().length}/500
          </span>
          <button
            type="button"
            onClick={() => void saveWelcome()}
            disabled={welcomeBusy || (welcomeEnabled && !welcomeText.trim())}
            className="rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50"
          >
            {welcomeBusy ? "Saving…" : "Save welcome message"}
          </button>
        </div>
        {welcomeMessage && (
          <p
            className={
              "mt-2 text-xs " +
              (welcomeMessage.kind === "ok" ? "text-emerald-300" : "text-red-300")
            }
          >
            {welcomeMessage.text}
          </p>
        )}
      </div>

      <div className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
        <p className="text-xs font-medium text-slate-300">
          When a message contains…
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            maxLength={40}
            placeholder="keyword, e.g. wholesale"
            className="w-full sm:w-56 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
          />
          <select
            value={actionType}
            onChange={(event) => {
              setActionType(event.target.value as "add_tag" | "assign");
              setActionValue("");
            }}
            className="w-full sm:w-44 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-sm text-white outline-none"
          >
            <option value="add_tag">Add label…</option>
            <option value="assign">Assign to…</option>
          </select>
          {actionType === "add_tag" ? (
            <input
              value={actionValue}
              onChange={(event) => setActionValue(event.target.value)}
              maxLength={24}
              placeholder="label, e.g. pricing"
              className="w-full flex-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
            />
          ) : (
            <select
              value={actionValue}
              onChange={(event) => setActionValue(event.target.value)}
              className="w-full flex-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-sm text-white outline-none"
            >
              <option value="">Choose team member…</option>
              {teamMembers.map((member) => (
                <option key={member.email} value={member.email}>
                  {member.name || member.email}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => void addRule()}
            disabled={
              busy || !keyword.trim() || !actionValue.trim()
            }
            className="shrink-0 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50"
          >
            {busy ? "Working…" : "Add automation"}
          </button>
        </div>
        {message && (
          <p
            className={
              "mt-2 text-xs " +
              (message.kind === "ok" ? "text-emerald-300" : "text-red-300")
            }
          >
            {message.text}
          </p>
        )}
      </div>

      {!rules ? (
        <div className="mt-4 animate-pulse space-y-3">
          {[0, 1].map((index) => (
            <div
              key={index}
              className="h-16 rounded-2xl border border-white/[0.06] bg-white/[0.015]"
            />
          ))}
        </div>
      ) : rules.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-sm text-slate-300">
            No automations yet — add your first rule above (for example
            &quot;wholesale&quot; adds the label #wholesale).
          </p>
        </div>
      ) : (
        <ul className="mt-4 space-y-3">
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="flex flex-col gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="text-sm text-white">
                  <span className="rounded-md border border-cyan-400/20 bg-cyan-400/[0.06] px-1.5 py-0.5 text-xs font-semibold text-cyan-300">
                    {rule.keyword}
                  </span>
                  <span className="mx-2 text-slate-500">→</span>
                  <span className="text-xs text-slate-300">
                    {describeAction(rule)}
                  </span>
                </p>
                <p className="mt-1 text-[11px] text-slate-500">
                  Fired {rule.timesTriggered}
                  {rule.timesTriggered === 1 ? " time" : " times"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void toggleRule(rule)}
                  disabled={busy}
                  className={
                    "rounded-lg border px-3 py-1.5 text-[11px] font-medium transition-colors duration-300 disabled:opacity-40 " +
                    (rule.isActive
                      ? "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300"
                      : "border-white/[0.08] bg-white/[0.02] text-slate-400")
                  }
                >
                  {rule.isActive ? "Active" : "Paused"}
                </button>
                <button
                  type="button"
                  onClick={() => void removeRule(rule)}
                  disabled={busy}
                  className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-[11px] text-slate-400 transition-colors duration-300 hover:text-white disabled:opacity-40"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
