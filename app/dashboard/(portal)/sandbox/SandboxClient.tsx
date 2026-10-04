"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type {
  SandboxChannel,
  SandboxExpectHandler,
  SandboxOverview,
  SandboxResult,
  SandboxScenario,
  SandboxTurn,
} from "../../../../lib/omniflow/portal";

// §230: every run goes through the real automations inside a transaction the
// server always rolls back - nothing is sent or saved (AI calls are real).

const API = "/api/omniflow/portal/sandbox";

const CHANNEL_LABELS: Record<SandboxChannel, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram DM",
  messenger: "Messenger",
  instagram_comment: "Instagram comment",
  facebook_comment: "Facebook comment",
};

const EXPECT_LABELS: Record<SandboxExpectHandler, string> = {
  "": "Anything (only check the words)",
  any_reply: "The customer gets a reply",
  no_reply: "No reply is sent",
  brain: "The AI brain answers",
  kb: "A knowledge base answer is sent",
  away: "The away / business-hours reply is sent",
  cod: "The COD confirmation flow answers",
  handoff: "It is handed to a person",
};

type Call<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

async function call<T>(path: string, init?: RequestInit): Promise<Call<T>> {
  try {
    const response = await fetch(path, {
      cache: "no-store",
      ...init,
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    });
    const payload = (await response.json().catch(() => null)) as
      | (T & { error?: { message?: string } })
      | null;
    if (response.ok && payload) return { ok: true, data: payload };
    return {
      ok: false,
      status: response.status,
      message: payload?.error?.message || "Could not reach the server. Try again shortly.",
    };
  } catch {
    return { ok: false, status: 0, message: "Could not reach the server. Try again shortly." };
  }
}

type Draft = {
  channel: SandboxChannel;
  customer_name: string;
  message: string;
  history: SandboxTurn[];
  force_auto: boolean;
  simulate_workflows: boolean;
};

type Expect = {
  name: string;
  expect_handler: SandboxExpectHandler;
  expect_contains: string;
  expect_absent: string;
};

const EMPTY_DRAFT: Draft = {
  channel: "whatsapp",
  customer_name: "",
  message: "",
  history: [],
  force_auto: false,
  simulate_workflows: true,
};

const EMPTY_EXPECT: Expect = { name: "", expect_handler: "any_reply", expect_contains: "", expect_absent: "" };

const field =
  "w-full rounded-xl border border-line bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-3 outline-none focus:border-brand/40";
const primary =
  "rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white transition-opacity duration-300 hover:opacity-90 disabled:opacity-50";
const secondary =
  "rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-soft disabled:opacity-50";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-line pt-3">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{title}</h3>
      <div className="space-y-1.5 text-sm text-ink">{children}</div>
    </div>
  );
}

function Pill({ tone, children }: { tone: "ok" | "warn" | "danger" | "soft"; children: React.ReactNode }) {
  const style = {
    ok: "bg-ok-soft text-ok",
    warn: "bg-warn-soft text-warn",
    danger: "bg-danger-soft text-danger",
    soft: "bg-soft text-ink-2",
  }[tone];
  return <span className={"rounded-full px-2 py-0.5 text-[11px] font-medium " + style}>{children}</span>;
}

function Result({ result }: { result: SandboxResult }) {
  const { outcome, ai } = result;
  const intel = result.intelligence;
  return (
    <div className="space-y-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-ink">{outcome.handler_label}</span>
          {result.verdict && (
            <Pill tone={result.verdict.pass ? "ok" : "danger"}>
              {result.verdict.pass ? "Test passed" : "Test failed"}
            </Pill>
          )}
          <Pill tone="soft">Nothing was sent or saved</Pill>
        </div>
        {result.error && <p className="mt-2 text-xs text-danger">{result.error}</p>}
        {outcome.replies.length > 0 ? (
          <div className="mt-3 space-y-2">
            {outcome.replies.map((reply, i) => (
              <div key={i} className="flex justify-start">
                <div className="max-w-[85%] whitespace-pre-line rounded-2xl bg-soft px-4 py-2.5 text-sm text-ink">
                  {reply.body}
                  <div className="mt-1 text-[10px] text-ink-3">
                    Would be sent on {CHANNEL_LABELS[result.channel]}
                    {reply.source ? " · " + reply.source.replace(/_/g, " ") : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-ink-2">No reply would be sent to the customer.</p>
        )}
        {outcome.notes.map((note) => (
          <p key={note} className="mt-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
            {note}
          </p>
        ))}
        {result.verdict && result.verdict.checks.length > 0 && (
          <ul className="mt-3 space-y-1 text-xs">
            {result.verdict.checks.map((check) => (
              <li key={check.label} className={check.ok ? "text-ok" : "text-danger"}>
                {check.ok ? "\u2713 " : "\u2717 "}
                {check.label}
              </li>
            ))}
          </ul>
        )}
      </div>

      {ai && (
        <Section title="AI decision">
          <p>
            {ai.decision === "send" ? "Answered the customer" : "Held for a person"}
            {typeof ai.confidence === "number" && " · confidence " + Math.round(ai.confidence * 100) + "%"}
          </p>
          {ai.reason_text && <p className="text-xs text-ink-2">{ai.reason_text}</p>}
          {ai.tools.length > 0 && <p className="text-xs text-ink-2">Looked at: {ai.tools.join(", ")}</p>}
          {ai.citations.length > 0 && (
            <p className="text-xs text-ink-2">Used {ai.citations.length} knowledge source(s)</p>
          )}
        </Section>
      )}

      {intel && (
        <Section title="Understood as">
          <div className="flex flex-wrap gap-1.5">
            {(["intent", "sentiment", "language", "purchase_intent", "urgency"] as const).map((key) =>
              intel[key] ? (
                <Pill key={key} tone="soft">
                  {key.replace("_", " ")}: {String(intel[key])}
                </Pill>
              ) : null
            )}
          </div>
        </Section>
      )}

      {(result.tags.length > 0 || Object.keys(result.routing).length > 0) && (
        <Section title="Conversation">
          {result.tags.length > 0 && <p>Tags: {result.tags.join(", ")}</p>}
          {Object.entries(result.routing).map(([key, value]) =>
            value === null || value === "" ? null : (
              <p key={key} className="text-xs text-ink-2">
                {key.replace(/_/g, " ")}: {String(value)}
              </p>
            )
          )}
        </Section>
      )}

      {result.handoffs.length > 0 && (
        <Section title="Handoffs">
          {result.handoffs.map((h, i) => (
            <p key={i}>
              {h.reason.replace(/_/g, " ")} <span className="text-xs text-ink-3">({h.severity}, {h.source})</span>
              {h.note && <span className="block text-xs text-ink-2">{h.note}</span>}
            </p>
          ))}
        </Section>
      )}

      {result.approvals.length > 0 && (
        <Section title="Approvals requested">
          {result.approvals.map((a, i) => (
            <p key={i}>
              {a.summary || a.action} <span className="text-xs text-ink-3">({a.status})</span>
            </p>
          ))}
        </Section>
      )}

      {result.workflows.length > 0 && (
        <Section title="Workflows">
          {result.workflows.map((wf) => (
            <div key={wf.id}>
              <p>
                {wf.name || "Workflow " + wf.id} <span className="text-xs text-ink-3">({wf.status})</span>
              </p>
              <ol className="mt-1 space-y-0.5 pl-4 text-xs text-ink-2">
                {wf.steps.map((step, i) => (
                  <li key={i}>
                    {step.step_no}. {step.kind} - {step.outcome}
                    {step.detail ? ": " + step.detail : ""}
                  </li>
                ))}
              </ol>
              {wf.last_error && <p className="text-xs text-danger">{wf.last_error}</p>}
            </div>
          ))}
        </Section>
      )}

      {result.sequences.length > 0 && (
        <Section title="Follow-up sequences">
          {result.sequences.map((s) => (
            <p key={s.id}>
              {s.name || "Sequence " + s.id} <span className="text-xs text-ink-3">({s.status})</span>
            </p>
          ))}
        </Section>
      )}

      {(result.notifications.length > 0 || result.other_messages.length > 0) && (
        <Section title="Other effects">
          {result.notifications.map((n, i) => (
            <p key={"n" + i}>
              Team notification: {n.title} <span className="text-xs text-ink-3">({n.severity})</span>
            </p>
          ))}
          {result.other_messages.map((m, i) => (
            <p key={"m" + i} className="text-xs text-ink-2">
              {"body" in m ? "Message" + (m.to === "team" ? " to the team" : "") + ": " + m.body : "Command: " + m.action}
            </p>
          ))}
        </Section>
      )}

      {result.listen.length > 0 && (
        <Section title="Listening rules matched">
          {result.listen.map((hit) => (
            <p key={hit.id} className="text-xs text-ink-2">
              {hit.snippet}
            </p>
          ))}
        </Section>
      )}

      {result.blocked.length > 0 && (
        <Section title="Blocked outside calls">
          {result.blocked.map((b, i) => (
            <p key={i} className="text-xs text-ink-2">
              {b.kind === "email" ? "Email via " : "Web request to "}
              {b.target}
            </p>
          ))}
        </Section>
      )}

      {result.timeline.length > 0 && (
        <Section title="Activity log">
          {result.timeline.map((t, i) => (
            <p key={i} className="text-xs text-ink-2">
              <span className="font-medium text-ink">{t.action}</span> {t.note}
            </p>
          ))}
        </Section>
      )}

      <p className="border-t border-line pt-3 text-[11px] text-ink-3">
        {result.usage.calls} AI call(s) · {result.usage.tokens} tokens
        {result.usage.failed > 0 && " · " + result.usage.failed + " failed"} ·{" "}
        {(result.duration_ms / 1000).toFixed(1)} s
      </p>
    </div>
  );
}

export default function SandboxClient() {
  const [overview, setOverview] = useState<SandboxOverview | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [expect, setExpect] = useState<Expect>(EMPTY_EXPECT);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SandboxResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [batch, setBatch] = useState<{ done: number; total: number; passed: number } | null>(null);

  const load = useCallback(async () => {
    const response = await call<SandboxOverview>(API);
    if (response.ok) setOverview(response.data);
    else setNote(response.message);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const body = (d: Draft) => ({
    ...d,
    history: d.history.filter((turn) => turn.text.trim()),
  });

  async function run() {
    if (!draft.message.trim() || busy) return;
    setBusy(true);
    setNote(null);
    const response = await call<SandboxResult>(API + "/run", {
      method: "POST",
      body: JSON.stringify(body(draft)),
    });
    setBusy(false);
    if (response.ok) setResult(response.data);
    else setNote(response.message);
  }

  async function save() {
    if (!expect.name.trim() || !draft.message.trim()) {
      setNote("Give the test a name and a customer message.");
      return;
    }
    setBusy(true);
    setNote(null);
    const payload = JSON.stringify({ ...body(draft), ...expect });
    const response = editingId
      ? await call<{ scenario: SandboxScenario }>(API + "/scenarios/" + editingId, { method: "PUT", body: payload })
      : await call<{ scenario: SandboxScenario }>(API + "/scenarios", { method: "POST", body: payload });
    setBusy(false);
    if (!response.ok) {
      setNote(response.message);
      return;
    }
    const saved = response.data.scenario;
    setOverview((current) =>
      current
        ? {
            ...current,
            scenarios: editingId
              ? current.scenarios.map((s) => (s.id === saved.id ? saved : s))
              : [...current.scenarios, saved],
          }
        : current
    );
    setEditingId(saved.id);
    setSaving(false);
  }

  function open(scenario: SandboxScenario) {
    setDraft({
      channel: scenario.channel,
      customer_name: scenario.customer_name === "Test Customer" ? "" : scenario.customer_name,
      message: scenario.message,
      history: scenario.history,
      force_auto: scenario.force_auto,
      simulate_workflows: true,
    });
    setExpect({
      name: scenario.name,
      expect_handler: scenario.expect_handler,
      expect_contains: scenario.expect_contains,
      expect_absent: scenario.expect_absent,
    });
    setEditingId(scenario.id);
    setSaving(true);
    setResult(null);
  }

  async function runScenario(scenario: SandboxScenario): Promise<SandboxResult | null> {
    const response = await call<SandboxResult>(API + "/scenarios/" + scenario.id + "/run", {
      method: "POST",
      body: "{}",
    });
    if (!response.ok) {
      setNote(scenario.name + ": " + response.message);
      return null;
    }
    const verdict = response.data.verdict;
    setOverview((current) =>
      current
        ? {
            ...current,
            scenarios: current.scenarios.map((s) =>
              s.id === scenario.id
                ? {
                    ...s,
                    last_pass: verdict ? verdict.pass : null,
                    last_run_at: new Date().toISOString(),
                    last_result: {
                      handler: response.data.outcome.handler,
                      replies: response.data.outcome.replies,
                      checks: verdict?.checks ?? [],
                      error: response.data.error,
                    },
                  }
                : s
            ),
          }
        : current
    );
    return response.data;
  }

  async function runOne(scenario: SandboxScenario) {
    if (busy) return;
    setBusy(true);
    setNote(null);
    const data = await runScenario(scenario);
    setBusy(false);
    if (data) setResult(data);
  }

  async function runAll() {
    if (!overview || busy || overview.scenarios.length === 0) return;
    setBusy(true);
    setNote(null);
    const list = overview.scenarios;
    let passed = 0;
    setBatch({ done: 0, total: list.length, passed: 0 });
    for (let i = 0; i < list.length; i += 1) {
      const data = await runScenario(list[i]);
      if (data?.verdict?.pass) passed += 1;
      setBatch({ done: i + 1, total: list.length, passed });
      if (!data) break;
    }
    setBusy(false);
  }

  async function remove(scenario: SandboxScenario) {
    if (busy || !window.confirm('Delete the saved test "' + scenario.name + '"?')) return;
    const response = await call<{ ok: boolean }>(API + "/scenarios/" + scenario.id, { method: "DELETE" });
    if (!response.ok) {
      setNote(response.message);
      return;
    }
    if (editingId === scenario.id) setEditingId(null);
    setOverview((current) =>
      current ? { ...current, scenarios: current.scenarios.filter((s) => s.id !== scenario.id) } : current
    );
  }

  if (!overview) {
    return (
      <div className="rounded-2xl border border-line bg-white p-5 text-sm text-ink-2 shadow-card">
        {note || "Loading..."}
      </div>
    );
  }

  const { settings, limits } = overview;
  const setTurn = (index: number, turn: SandboxTurn | null) =>
    setDraft((d) => ({
      ...d,
      history: turn ? d.history.map((t, i) => (i === index ? turn : t)) : d.history.filter((_, i) => i !== index),
    }));

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-brand/20 bg-brand-soft px-4 py-3 text-xs text-ink-2">
        <span className="font-semibold text-ink">Nothing is sent or saved.</span> Replies, tags,
        handoffs and workflow steps are worked out for real and then thrown away; outside web
        requests and emails are blocked. Real AI calls still run and count toward your AI usage
        ({limits.runs_per_hour} runs per hour).
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="space-y-4 rounded-2xl border border-line bg-white p-5 shadow-card lg:self-start">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">Test a message</h2>
            <span className="text-[11px] text-ink-3">
              AI autonomy: <span className="font-medium text-ink-2">{settings.effective}</span>
              {settings.kill_switch && " (paused by the platform)"} ·{" "}
              <Link href="/dashboard/bot" className="text-brand hover:underline">
                Configure AI
              </Link>
            </span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-ink-2">
              Channel
              <select
                value={draft.channel}
                onChange={(event) => setDraft({ ...draft, channel: event.target.value as SandboxChannel })}
                className={field + " mt-1"}
              >
                {overview.channels.map((channel) => (
                  <option key={channel} value={channel}>
                    {CHANNEL_LABELS[channel] ?? channel}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-2">
              Customer name (optional)
              <input
                value={draft.customer_name}
                onChange={(event) => setDraft({ ...draft, customer_name: event.target.value.slice(0, 80) })}
                placeholder="Test Customer"
                className={field + " mt-1"}
              />
            </label>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between text-xs text-ink-2">
              <span>Earlier messages in this chat (optional)</span>
              <button
                type="button"
                disabled={draft.history.length >= limits.max_history}
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    history: [
                      ...d.history,
                      { role: d.history.at(-1)?.role === "customer" ? "business" : "customer", text: "" },
                    ],
                  }))
                }
                className={secondary}
              >
                Add earlier message
              </button>
            </div>
            <div className="space-y-2">
              {draft.history.map((turn, index) => (
                <div key={index} className="flex items-start gap-2">
                  <select
                    value={turn.role}
                    onChange={(event) =>
                      setTurn(index, { ...turn, role: event.target.value as SandboxTurn["role"] })
                    }
                    className="rounded-xl border border-line bg-soft px-2 py-2 text-xs text-ink"
                  >
                    <option value="customer">Customer</option>
                    <option value="business">You</option>
                  </select>
                  <input
                    value={turn.text}
                    onChange={(event) => setTurn(index, { ...turn, text: event.target.value.slice(0, 2000) })}
                    className={field}
                  />
                  <button type="button" onClick={() => setTurn(index, null)} className={secondary} aria-label="Remove">
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>

          <label className="block text-xs text-ink-2">
            Customer message
            <textarea
              value={draft.message}
              onChange={(event) => setDraft({ ...draft, message: event.target.value.slice(0, limits.message_max) })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void run();
                }
              }}
              rows={3}
              placeholder="e.g. COD available hai? Lahore delivery kitne din mein hogi?"
              className={field + " mt-1 resize-none"}
            />
          </label>

          <div className="space-y-2 text-xs text-ink-2">
            {settings.autonomy === "suggest" && (
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={draft.force_auto}
                  onChange={(event) => setDraft({ ...draft, force_auto: event.target.checked })}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium text-ink">Pretend AI is on Auto</span> - preview the answer
                  the AI would send by itself (your setting stays on Suggest).
                </span>
              </label>
            )}
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={draft.simulate_workflows}
                onChange={(event) => setDraft({ ...draft, simulate_workflows: event.target.checked })}
                className="mt-0.5"
              />
              <span>Run workflow steps that are due right away</span>
            </label>
          </div>

          {note && <p className="text-xs text-danger">{note}</p>}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void run()} disabled={busy || !draft.message.trim()} className={primary}>
              {busy && !batch ? "Running..." : "Run test"}
            </button>
            <button type="button" onClick={() => setSaving((v) => !v)} disabled={busy} className={secondary}>
              {editingId ? "Edit saved test" : "Save as test"}
            </button>
            {(editingId || draft.message) && (
              <button
                type="button"
                onClick={() => {
                  setDraft(EMPTY_DRAFT);
                  setExpect(EMPTY_EXPECT);
                  setEditingId(null);
                  setSaving(false);
                  setResult(null);
                }}
                disabled={busy}
                className={secondary}
              >
                Clear
              </button>
            )}
          </div>

          {saving && (
            <div className="space-y-3 rounded-xl border border-line p-4">
              <input
                value={expect.name}
                onChange={(event) => setExpect({ ...expect, name: event.target.value.slice(0, 80) })}
                placeholder="Test name, e.g. COD question"
                className={field}
              />
              <label className="block text-xs text-ink-2">
                Expected outcome
                <select
                  value={expect.expect_handler}
                  onChange={(event) =>
                    setExpect({ ...expect, expect_handler: event.target.value as SandboxExpectHandler })
                  }
                  className={field + " mt-1"}
                >
                  {(["", ...overview.expect_handlers] as SandboxExpectHandler[]).map((handler) => (
                    <option key={handler || "none"} value={handler}>
                      {EXPECT_LABELS[handler] ?? handler}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  value={expect.expect_contains}
                  onChange={(event) => setExpect({ ...expect, expect_contains: event.target.value.slice(0, 200) })}
                  placeholder="Reply must mention (optional)"
                  className={field}
                />
                <input
                  value={expect.expect_absent}
                  onChange={(event) => setExpect({ ...expect, expect_absent: event.target.value.slice(0, 200) })}
                  placeholder="Reply must never say (optional)"
                  className={field}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void save()} disabled={busy} className={primary}>
                  {editingId ? "Update test" : "Save test"}
                </button>
                {editingId && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(null);
                      setExpect({ ...expect, name: expect.name + " (copy)" });
                    }}
                    disabled={busy}
                    className={secondary}
                  >
                    Save as a new test instead
                  </button>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-line bg-white p-5 shadow-card lg:self-start">
          <h2 className="mb-3 text-sm font-semibold text-ink">What happened</h2>
          {result ? (
            <Result result={result} />
          ) : (
            <p className="text-sm text-ink-2">
              {busy ? "Running the message through your setup..." : "Run a test to see the reply and every step behind it."}
            </p>
          )}
        </section>
      </div>

      <section className="rounded-2xl border border-line bg-white p-5 shadow-card">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-ink">Saved tests</h2>
            <p className="text-xs text-ink-2">
              Re-run these after changing rules, knowledge or AI settings ({overview.scenarios.length} of{" "}
              {limits.scenarios_max}).
            </p>
          </div>
          <div className="flex items-center gap-3">
            {batch && (
              <span className="text-xs text-ink-2">
                {batch.done < batch.total
                  ? "Running " + batch.done + " / " + batch.total + "..."
                  : batch.passed + " of " + batch.total + " passed"}
              </span>
            )}
            <button
              type="button"
              onClick={() => void runAll()}
              disabled={busy || overview.scenarios.length === 0}
              className={primary}
            >
              Run all
            </button>
          </div>
        </div>
        {overview.scenarios.length === 0 ? (
          <p className="text-sm text-ink-2">
            No saved tests yet. Type a message above, then use &quot;Save as test&quot; with the outcome you expect.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {overview.scenarios.map((scenario) => (
              <li key={scenario.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{scenario.name}</span>
                    {scenario.last_pass === null ? (
                      <Pill tone="soft">Not run</Pill>
                    ) : (
                      <Pill tone={scenario.last_pass ? "ok" : "danger"}>{scenario.last_pass ? "Passed" : "Failed"}</Pill>
                    )}
                    <span className="text-[11px] text-ink-3">{CHANNEL_LABELS[scenario.channel]}</span>
                  </div>
                  <p className="truncate text-xs text-ink-2">&ldquo;{scenario.message}&rdquo;</p>
                  <p className="text-[11px] text-ink-3">
                    Expect: {EXPECT_LABELS[scenario.expect_handler]}
                    {scenario.expect_contains && ' · mentions "' + scenario.expect_contains + '"'}
                    {scenario.expect_absent && ' · never "' + scenario.expect_absent + '"'}
                  </p>
                  {scenario.last_pass === false && scenario.last_result?.checks && (
                    <p className="text-[11px] text-danger">
                      {scenario.last_result.checks
                        .filter((c) => !c.ok)
                        .map((c) => c.label)
                        .join(" · ")}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => void runOne(scenario)} disabled={busy} className={secondary}>
                    Run
                  </button>
                  <button type="button" onClick={() => open(scenario)} disabled={busy} className={secondary}>
                    Open
                  </button>
                  <button type="button" onClick={() => void remove(scenario)} disabled={busy} className={secondary}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
