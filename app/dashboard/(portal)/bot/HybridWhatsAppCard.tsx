"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type {
  BasicBusinessConfig,
  HybridDeterministicRule,
  HybridExecutionResult,
} from "../../../../lib/omniflow/hybrid-whatsapp-engine";

export interface HybridWhatsAppCardProps {
  mode?: "ai" | "rules" | "full";
}

const inputClass =
  "mt-1 w-full rounded-xl border border-line bg-white px-3.5 py-2 text-xs text-ink placeholder:text-ink-3 focus:border-brand focus:outline-none";

export default function HybridWhatsAppCard({
  mode = "full",
}: HybridWhatsAppCardProps) {
  const [config, setConfig] = useState<BasicBusinessConfig | null>(null);
  const [rules, setRules] = useState<HybridDeterministicRule[]>([]);
  const [stats, setStats] = useState<{
    received: number;
    sent: number;
    aiReplies: number;
    ruleReplies: number;
    humanHandovers: number;
    failedExecutions: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");
  const [errorNote, setErrorNote] = useState("");

  // Test Simulator state
  const [testText, setTestText] = useState(
    mode === "rules" ? "Delivery kab milega?" : "Assalam-o-Alaikum, aapke paas kya products hain?"
  );
  const [testFirstMsg, setTestFirstMsg] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<HybridExecutionResult | null>(
    null
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/omniflow/portal/hybrid-automation", {
        cache: "no-store",
      });
      const payload = await res.json().catch(() => null);
      if (res.ok && payload) {
        if (payload.businessConfig) setConfig(payload.businessConfig);
        if (Array.isArray(payload.rules)) setRules(payload.rules);
        if (payload.stats) setStats(payload.stats);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveAll() {
    if (!config || saving) return;
    setSaving(true);
    setNote("");
    setErrorNote("");
    try {
      const res = await fetch("/api/omniflow/portal/hybrid-automation", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessConfig: config,
          rules,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setErrorNote(
          payload?.error?.message || "Could not save configuration."
        );
        return;
      }
      setNote(
        mode === "rules"
          ? "Automation rules saved successfully."
          : mode === "ai"
            ? "AI Assistant configuration saved successfully."
            : "Hybrid WhatsApp configuration & rules saved."
      );
      if (payload?.stats) setStats(payload.stats);
    } catch {
      setErrorNote("Network error while saving.");
    } finally {
      setSaving(false);
    }
  }

  async function runTestPipeline() {
    if (!testText.trim() || testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/omniflow/portal/hybrid-automation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageId: "sim_" + Date.now(),
          text: testText.trim(),
          isFirstMessage: testFirstMsg,
        }),
      });
      const payload = (await res.json().catch(() => null)) as HybridExecutionResult | null;
      if (payload) {
        setTestResult(payload);
        void load();
      }
    } catch {
      // ignore
    } finally {
      setTesting(false);
    }
  }

  function addRule() {
    setRules((prev) => [
      ...prev,
      {
        id: "rule_" + Date.now(),
        name: "New Keyword Rule",
        type: "keyword",
        enabled: true,
        priority: prev.length + 1,
        keywords: ["price", "rate"],
        matchMode: "contains_word",
        responseText:
          "Humari standard pricing list ke liye apna product naam batayein.",
      },
    ]);
  }

  function updateRule(
    idx: number,
    patch: Partial<HybridDeterministicRule>
  ) {
    setRules((prev) =>
      prev.map((item, i) => (i === idx ? { ...item, ...patch } : item))
    );
  }

  function removeRule(idx: number) {
    setRules((prev) => prev.filter((_, i) => i !== idx));
  }

  if (loading || !config) {
    return (
      <section className="rounded-2xl border border-line bg-white p-5 shadow-card">
        <p className="text-xs text-ink-3">
          Loading WhatsApp automation configuration...
        </p>
      </section>
    );
  }

  const showAiSection = mode === "ai" || mode === "full";
  const showRulesSection = mode === "rules" || mode === "full";

  return (
    <div className="space-y-6">
      {/* Live KPI Summary Strip */}
      {stats && (
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div className="rounded-xl border border-line bg-white p-3.5 shadow-card">
            <p className="text-[10px] font-medium uppercase tracking-wider text-ink-3">
              Received
            </p>
            <p className="mt-1 text-lg font-semibold text-ink">
              {stats.received}
            </p>
          </div>
          <div className="rounded-xl border border-line bg-white p-3.5 shadow-card">
            <p className="text-[10px] font-medium uppercase tracking-wider text-ink-3">
              Sent
            </p>
            <p className="mt-1 text-lg font-semibold text-ink">{stats.sent}</p>
          </div>
          <div className="rounded-xl border border-line bg-white p-3.5 shadow-card">
            <p className="text-[10px] font-medium uppercase tracking-wider text-ink-3">
              Rule Replies
            </p>
            <p className="mt-1 text-lg font-semibold text-brand">
              {stats.ruleReplies}
            </p>
          </div>
          <div className="rounded-xl border border-line bg-white p-3.5 shadow-card">
            <p className="text-[10px] font-medium uppercase tracking-wider text-ink-3">
              AI Replies
            </p>
            <p className="mt-1 text-lg font-semibold text-emerald-700">
              {stats.aiReplies}
            </p>
          </div>
          <div className="rounded-xl border border-line bg-white p-3.5 shadow-card">
            <p className="text-[10px] font-medium uppercase tracking-wider text-ink-3">
              Handovers
            </p>
            <p className="mt-1 text-lg font-semibold text-amber-700">
              {stats.humanHandovers}
            </p>
          </div>
          <div className="rounded-xl border border-line bg-white p-3.5 shadow-card">
            <p className="text-[10px] font-medium uppercase tracking-wider text-ink-3">
              Failed
            </p>
            <p className="mt-1 text-lg font-semibold text-danger">
              {stats.failedExecutions}
            </p>
          </div>
        </div>
      )}

      {/* AI CONFIGURATION MODE (/dashboard/bot) */}
      {showAiSection && (
        <>
          {/* Synced Business Profile Context Banner (Prevents duplicate Business Profile forms!) */}
          <section className="rounded-2xl border border-brand/20 bg-brand/[0.03] p-4 shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  <p className="text-xs font-semibold text-ink">
                    Synced Business Context: {config.businessName}
                  </p>
                </div>
                <p className="mt-1 text-xs text-ink-2">
                  {config.businessDescription || "Customer support and order assistance on WhatsApp."}
                </p>
                <p className="mt-1 text-[11px] text-ink-3">
                  Products/Services: {config.productsAndServices.slice(0, 90)}
                  {config.productsAndServices.length > 90 ? "..." : ""} · Contact:{" "}
                  {config.contactInfo || "WhatsApp Desk"}
                </p>
              </div>
              <Link
                href="/dashboard/profile"
                className="inline-flex h-8 items-center whitespace-nowrap rounded-xl border border-brand/25 bg-white px-3 text-xs font-medium text-brand transition-colors hover:bg-brand-soft"
              >
                Edit Business Profile →
              </Link>
            </div>
          </section>

          {/* AI Assistant Behavior, Language, & Handover Configuration */}
          <section className="rounded-2xl border border-line bg-white p-5 shadow-card">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-ink">
                  AI Assistant Persona, Language & Handover
                </h2>
                <p className="mt-0.5 text-xs text-ink-3">
                  Control how your AI assistant speaks to customers when no deterministic keyword rule matches.
                </p>
              </div>
              <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-[11px] font-medium text-brand">
                Urdu · Roman Urdu · English
              </span>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="block text-xs font-medium text-ink-2">
                Preferred Response Language
                <select
                  value={config.preferredLanguage}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      preferredLanguage:
                        e.target.value as BasicBusinessConfig["preferredLanguage"],
                    })
                  }
                  className={inputClass}
                >
                  <option value="auto">
                    Auto-detect Customer Language (Urdu / Roman Urdu / English)
                  </option>
                  <option value="roman_urdu">Always Reply in Roman Urdu</option>
                  <option value="urdu">Always Reply in Urdu (اردو)</option>
                  <option value="english">Always Reply in English</option>
                </select>
              </label>

              <label className="block text-xs font-medium text-ink-2">
                AI Conversation Tone
                <select
                  value={config.aiTone}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      aiTone: e.target.value as BasicBusinessConfig["aiTone"],
                    })
                  }
                  className={inputClass}
                >
                  <option value="friendly">Friendly & Helpful</option>
                  <option value="professional">Professional & Formal</option>
                  <option value="concise">Short & Direct</option>
                </select>
              </label>

              <label className="block text-xs font-medium text-ink-2 sm:col-span-2">
                AI Assistant System Instructions & Guardrails
                <textarea
                  rows={3}
                  value={config.basicInstructions}
                  onChange={(e) =>
                    setConfig({ ...config, basicInstructions: e.target.value })
                  }
                  placeholder="e.g., Answer politely using our business profile. Never invent prices that are not listed. Ask for the customer's city when discussing delivery."
                  className={inputClass}
                />
              </label>

              <label className="block text-xs font-medium text-ink-2 sm:col-span-2">
                Human Escalation Trigger Keywords (comma-separated)
                <input
                  value={config.handoverKeywords.join(", ")}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      handoverKeywords: e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                  placeholder="agent, human, representative, complaint, shikayat, call me"
                  className={inputClass}
                />
              </label>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-4">
              <label className="flex items-center gap-2 text-xs text-ink-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.humanHandoverEnabled}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      humanHandoverEnabled: e.target.checked,
                    })
                  }
                  className="h-4 w-4 rounded border-line accent-brand"
                />
                Automatically pause AI and hand over to a human agent when escalation keywords are detected
              </label>

              <div className="flex items-center gap-2">
                <Link
                  href="/dashboard/rules"
                  className="inline-flex h-9 items-center rounded-xl border border-line bg-soft px-3.5 text-xs font-medium text-ink-2 hover:text-ink"
                >
                  Manage Keyword Rules →
                </Link>
                <button
                  type="button"
                  onClick={() => void saveAll()}
                  disabled={saving}
                  className="inline-flex h-9 items-center rounded-xl bg-brand px-4 text-xs font-semibold text-white hover:bg-brand-2 disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Save AI Configuration"}
                </button>
              </div>
            </div>

            {note && <p className="mt-2.5 text-xs font-medium text-ok">{note}</p>}
            {errorNote && (
              <p className="mt-2.5 text-xs font-medium text-danger">
                {errorNote}
              </p>
            )}
          </section>
        </>
      )}

      {/* DETERMINISTIC RULES MODE (/dashboard/rules) */}
      {showRulesSection && (
        <section className="rounded-2xl border border-line bg-white p-5 shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-ink">
                Deterministic Rule Engine (Runs Before AI)
              </h2>
              <p className="mt-0.5 text-xs text-ink-3">
                When a deterministic rule matches an incoming message, OmniFlow sends the exact predefined reply immediately and skips the AI assistant.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={addRule}
                className="inline-flex h-8 items-center rounded-xl border border-brand/30 bg-brand-soft px-3 text-xs font-semibold text-brand hover:bg-brand/15"
              >
                + Add Keyword Rule
              </button>
            </div>
          </div>

          {/* Business Hours & Away Schedule Bar */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-soft px-3.5 py-2.5">
            <label className="flex items-center gap-2 text-xs font-medium text-ink cursor-pointer">
              <input
                type="checkbox"
                checked={config.businessHoursEnabled}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    businessHoursEnabled: e.target.checked,
                  })
                }
                className="h-4 w-4 rounded border-line accent-brand"
              />
              Enforce Business Hours Schedule (Auto-send Away Reply outside working hours)
            </label>
            <div className="flex items-center gap-2 text-xs text-ink-2">
              <span>Start:</span>
              <input
                type="time"
                value={config.businessHoursStart}
                onChange={(e) =>
                  setConfig({ ...config, businessHoursStart: e.target.value })
                }
                className="rounded-lg border border-line bg-white px-2 py-1 text-xs text-ink"
              />
              <span>End:</span>
              <input
                type="time"
                value={config.businessHoursEnd}
                onChange={(e) =>
                  setConfig({ ...config, businessHoursEnd: e.target.value })
                }
                className="rounded-lg border border-line bg-white px-2 py-1 text-xs text-ink"
              />
            </div>
          </div>

          <div className="mt-4 space-y-3">
            {rules.map((rule, idx) => (
              <div
                key={rule.id}
                className="rounded-xl border border-line bg-soft/60 p-3.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(e) =>
                        updateRule(idx, { enabled: e.target.checked })
                      }
                      className="h-4 w-4 rounded border-line accent-brand"
                    />
                    <input
                      value={rule.name}
                      onChange={(e) =>
                        updateRule(idx, { name: e.target.value })
                      }
                      className="rounded-lg border border-line bg-white px-2.5 py-1 text-xs font-semibold text-ink"
                    />
                    <select
                      value={rule.type}
                      onChange={(e) =>
                        updateRule(idx, {
                          type: e.target.value as HybridDeterministicRule["type"],
                        })
                      }
                      className="rounded-lg border border-line bg-white px-2 py-1 text-[11px] font-medium uppercase text-ink-2"
                    >
                      <option value="welcome">Welcome (First Message)</option>
                      <option value="keyword">Keyword Match</option>
                      <option value="faq">FAQ Trigger</option>
                      <option value="away">After-Hours Away</option>
                    </select>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeRule(idx)}
                    className="text-xs font-medium text-danger hover:underline"
                  >
                    Remove
                  </button>
                </div>

                {(rule.type === "keyword" || rule.type === "faq") && (
                  <div className="mt-2.5">
                    <label className="block text-[11px] font-medium text-ink-3">
                      Trigger Keywords (comma-separated)
                      <input
                        value={(rule.keywords || []).join(", ")}
                        onChange={(e) =>
                          updateRule(idx, {
                            keywords: e.target.value
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                        placeholder="delivery, shipping, kab milega, parcel"
                        className={inputClass}
                      />
                    </label>
                  </div>
                )}

                <div className="mt-2.5">
                  <label className="block text-[11px] font-medium text-ink-3">
                    Automated WhatsApp Reply
                    <input
                      value={rule.responseText}
                      onChange={(e) =>
                        updateRule(idx, { responseText: e.target.value })
                      }
                      className={inputClass}
                    />
                  </label>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => void saveAll()}
              disabled={saving}
              className="rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white hover:bg-brand-2 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save Automation Rules"}
            </button>
            {note && <p className="text-xs font-medium text-ok">{note}</p>}
            {errorNote && (
              <p className="text-xs font-medium text-danger">{errorNote}</p>
            )}
          </div>
        </section>
      )}

      {/* Live 10-Step Hybrid Pipeline Simulator */}
      <section className="rounded-2xl border border-line bg-white p-5 shadow-card">
        <h2 className="text-sm font-semibold text-ink">
          {mode === "rules"
            ? "Test Keyword & Rule Matching"
            : "Test Live AI & Hybrid WhatsApp Response"}
        </h2>
        <p className="mt-0.5 text-xs text-ink-3">
          Simulate an incoming customer WhatsApp message to verify exact rule matching, AI fallback in Urdu/Roman Urdu/English, and duplicate prevention.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            placeholder="Type a sample customer message (e.g., Delivery kab milega?)"
            className="min-w-[240px] flex-1 rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink focus:border-brand focus:bg-white focus:outline-none"
          />
          <label className="flex items-center gap-1.5 text-xs text-ink-2 cursor-pointer">
            <input
              type="checkbox"
              checked={testFirstMsg}
              onChange={(e) => setTestFirstMsg(e.target.checked)}
              className="rounded border-line accent-brand"
            />
            First message
          </label>
          <button
            type="button"
            onClick={() => void runTestPipeline()}
            disabled={testing}
            className="rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white hover:bg-brand-2 disabled:opacity-50"
          >
            {testing ? "Testing..." : "Test Reply"}
          </button>
        </div>

        {testResult && (
          <div className="mt-4 rounded-xl border border-line bg-soft p-3.5 text-xs space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-[11px] font-semibold text-brand">
                Handled by: {testResult.handledBy}
              </span>
              <span className="rounded-full bg-white border border-line px-2.5 py-0.5 text-[11px] text-ink-2">
                Language: {testResult.detectedLanguage}
              </span>
              {testResult.matchedRuleName && (
                <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700">
                  Rule: {testResult.matchedRuleName}
                </span>
              )}
            </div>
            {testResult.replyText && (
              <div className="rounded-lg border border-line bg-white p-3 text-ink">
                <p className="text-[10px] uppercase tracking-wider text-ink-3">
                  Outbound WhatsApp Reply
                </p>
                <p className="mt-1 font-medium">{testResult.replyText}</p>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
