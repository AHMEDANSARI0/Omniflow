"use client";

import Link from "next/link";
import PortalIcon from "../../components/PortalIcon";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AssistantAskResult,
  AssistantDecision,
  AssistantMessage,
  AssistantOverview,
  AssistantProposal,
  AssistantThread,
} from "../../../../lib/omniflow/portal";

// §227: answers come from the workspace's own data through read-only
// lookups; changes are proposals the server validates, applies or holds.

const API = "/api/omniflow/portal/assistant";

const STARTERS = [
  "How did the last 7 days go?",
  "Which handoffs are open right now?",
  "Show my AI setup and business facts",
  "Add a business fact: delivery takes 3-5 working days",
];

const TOOL_LABELS: Record<string, string> = {
  business_report: "business report",
  handoffs: "handoffs",
  find_conversations: "conversations",
  conversation_messages: "conversation messages",
  ai_setup: "AI setup",
  ai_usage: "AI usage",
  search_knowledge: "knowledge base",
};

const RISK_STYLE: Record<AssistantProposal["risk"], string> = {
  low: "bg-ok-soft text-ok",
  medium: "bg-warn-soft text-warn",
  high: "bg-danger-soft text-danger",
};

const STATUS_LABEL: Record<AssistantProposal["status"], string> = {
  pending: "Waiting for you",
  applied: "Applied",
  done: "Done",
  approval: "Sent for approval",
  rejected: "Dismissed",
  failed: "Not applied",
  undone: "Undone",
  expired: "Expired",
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

function Answer({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="space-y-2">
      {blocks.map((block, i) => {
        const lines = block.split("\n").filter((line) => line.trim());
        const bullets = lines.length > 0 && lines.every((line) => /^\s*[-*] /.test(line));
        if (bullets) {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {lines.map((line, j) => (
                <li key={j}>{line.replace(/^\s*[-*] /, "")}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="whitespace-pre-line">
            {block}
          </p>
        );
      })}
    </div>
  );
}

function ProposalCard({
  proposal,
  busy,
  onDecide,
}: {
  proposal: AssistantProposal;
  busy: boolean;
  onDecide: (id: number, decision: AssistantDecision) => void;
}) {
  const done = proposal.status !== "pending";
  return (
    <div className="rounded-xl border border-line bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-ink">{proposal.summary}</span>
        <span className={"rounded-full px-2 py-0.5 text-[11px] font-medium " + RISK_STYLE[proposal.risk]}>
          {proposal.risk === "low" ? "Low risk" : proposal.risk === "medium" ? "Medium risk" : "High risk"}
        </span>
        <span className="rounded-full bg-soft px-2 py-0.5 text-[11px] text-ink-2">
          {STATUS_LABEL[proposal.status]}
        </span>
      </div>
      {proposal.diff.length > 0 && (
        <dl className="mt-3 space-y-2 text-xs">
          {proposal.diff.map((row) => (
            <div key={row.field} className="grid gap-1 sm:grid-cols-[120px_1fr]">
              <dt className="text-ink-3">{row.field}</dt>
              <dd className="space-y-1">
                {row.before && (
                  <div className="rounded-lg bg-danger-soft px-2 py-1 text-danger line-through">
                    {row.before}
                  </div>
                )}
                <div className="rounded-lg bg-ok-soft px-2 py-1 text-ink">{row.after || "(empty)"}</div>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {proposal.note && <p className="mt-2 text-xs text-ink-2">{proposal.note}</p>}
      {proposal.tainted && proposal.status === "pending" && (
        <p className="mt-2 text-xs text-warn">
          This was suggested after reading customer or website text. Check it before confirming.
        </p>
      )}
      {proposal.result.message && done && (
        <p className="mt-2 text-xs text-ink-2">
          {proposal.result.message}
          {proposal.result.refCode ? " Reference " + proposal.result.refCode + "." : ""}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {proposal.status === "pending" && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => onDecide(proposal.id, "confirm")}
              className="rounded-xl bg-brand px-4 py-1.5 text-xs font-semibold text-white transition-opacity duration-300 hover:opacity-90 disabled:opacity-50"
            >
              Confirm
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onDecide(proposal.id, "reject")}
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-soft disabled:opacity-50"
            >
              Dismiss
            </button>
          </>
        )}
        {proposal.canUndo && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide(proposal.id, "undo")}
            className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-soft disabled:opacity-50"
          >
            Undo
          </button>
        )}
        {proposal.snapshotId && (
          <Link
            href="/dashboard/settings#config-history"
            className="text-[11px] text-ink-3 underline-offset-2 hover:underline"
          >
            Configuration history
          </Link>
        )}
        {proposal.status === "approval" && (
          <Link
            href="/dashboard/approvals"
            className="text-[11px] text-brand underline-offset-2 hover:underline"
          >
            Open approvals
          </Link>
        )}
      </div>
    </div>
  );
}

// §246: "page" is the full /dashboard/assistant screen; "panel" is the Ask
// Omni bubble, where the chat list collapses into a picker above the chat.
export default function AssistantClient({ variant = "page" }: { variant?: "page" | "panel" }) {
  const panel = variant === "panel";
  const [overview, setOverview] = useState<AssistantOverview | null>(null);
  const [thread, setThread] = useState<AssistantThread | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const loadOverview = useCallback(async () => {
    const res = await call<AssistantOverview>(API);
    if (res.ok) setOverview(res.data);
    else setNote(res.message);
  }, []);

  const openThread = useCallback(async (threadId: number) => {
    setNote(null);
    const res = await call<AssistantThread>(API + "/threads/" + threadId);
    if (res.ok) setThread(res.data);
    else setNote(res.message);
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [thread, pending]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setNote(null);
    setPending(message);
    setDraft("");
    const res = await call<AssistantAskResult>(API + "/ask", {
      method: "POST",
      body: JSON.stringify(thread ? { message, threadId: thread.thread.id } : { message }),
    });
    setPending(null);
    setBusy(false);
    if (!res.ok) {
      setDraft(message);
      setNote(res.message);
      return;
    }
    const data = res.data;
    setThread((current) =>
      current && current.thread.id === data.thread.id
        ? {
            thread: data.thread,
            messages: [...current.messages, ...data.messages],
            proposals: [...current.proposals, ...data.proposals],
          }
        : { thread: data.thread, messages: data.messages, proposals: data.proposals }
    );
    setOverview((current) =>
      current
        ? {
            ...current,
            usedToday: data.usedToday,
            threads: [data.thread, ...current.threads.filter((t) => t.id !== data.thread.id)],
          }
        : current
    );
  }

  async function decide(proposalId: number, decision: AssistantDecision) {
    setBusy(true);
    setNote(null);
    const res = await call<{ proposal: AssistantProposal }>(
      API + "/proposals/" + proposalId + "/" + decision,
      { method: "POST", body: "{}" }
    );
    setBusy(false);
    if (res.ok) {
      const updated = res.data.proposal;
      setThread((current) =>
        current
          ? { ...current, proposals: current.proposals.map((p) => (p.id === updated.id ? updated : p)) }
          : current
      );
      return;
    }
    setNote(res.message);
    if (thread) void openThread(thread.thread.id);
  }

  async function removeThread(threadId: number) {
    const res = await call<{ ok: boolean }>(API + "/threads/" + threadId, { method: "DELETE" });
    if (!res.ok) {
      setNote(res.message);
      return;
    }
    if (thread?.thread.id === threadId) setThread(null);
    setOverview((current) =>
      current ? { ...current, threads: current.threads.filter((t) => t.id !== threadId) } : current
    );
  }

  if (!overview) {
    return (
      <div className={panel ? "p-5 text-sm text-ink-2" : "rounded-2xl border border-line bg-white p-5 text-sm text-ink-2 shadow-card"}>
        {note || "Loading..."}
      </div>
    );
  }

  const messages: AssistantMessage[] = thread?.messages ?? [];
  const byMessage = (id: number) => (thread?.proposals ?? []).filter((p) => p.messageId === id);
  const limitReached = overview.dailyLimit > 0 && overview.usedToday >= overview.dailyLimit;

  const startNewChat = () => {
    setThread(null);
    setNote(null);
  };

  const chat = (
      <section
        className={
          panel
            ? "flex min-h-0 flex-1 flex-col"
            : "flex min-h-[60vh] flex-col rounded-2xl border border-line bg-white shadow-card"
        }
      >
        <div className={"flex-1 space-y-4 overflow-y-auto " + (panel ? "p-4" : "p-5")}>
          {!overview.available && (
            <div className="rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn">{overview.reason}</div>
          )}
          {messages.length === 0 && !pending && overview.available && (
            <div>
              <p className="text-sm text-ink-2">
                Try one of these, or ask anything about your workspace.
                {!overview.canChange &&
                  " You can ask questions and propose conversation actions; only " +
                    overview.changeRoles.join(" / ") +
                    " can change the AI setup."}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {STARTERS.map((starter) => (
                  <button
                    key={starter}
                    type="button"
                    onClick={() => void send(starter)}
                    className="rounded-full border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-soft"
                  >
                    {starter}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[80%] whitespace-pre-line rounded-2xl bg-brand px-4 py-2.5 text-sm text-white">
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={m.id} className="max-w-[90%] space-y-2">
                <div className="rounded-2xl bg-soft px-4 py-3 text-sm text-ink">
                  <Answer text={m.content} />
                </div>
                {m.tools.length > 0 && (
                  <p className="text-[11px] text-ink-3">
                    Checked: {m.tools.map((t) => (TOOL_LABELS[t.tool] || t.tool.replace(/_/g, " ")) + (t.ok ? "" : " (unavailable)")).join(", ")}
                  </p>
                )}
                {m.links.filter((l) => l.href.startsWith("/dashboard")).length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {m.links
                      .filter((l) => l.href.startsWith("/dashboard"))
                      .map((l) => (
                        <Link
                          key={l.href}
                          href={l.href}
                          className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink-2 hover:bg-soft"
                        >
                          {l.label} &rarr;
                        </Link>
                      ))}
                  </div>
                )}
                {byMessage(m.id).map((p) => (
                  <ProposalCard key={p.id} proposal={p} busy={busy} onDecide={decide} />
                ))}
              </div>
            )
          )}
          {pending && (
            <>
              <div className="flex justify-end">
                <div className="max-w-[80%] whitespace-pre-line rounded-2xl bg-brand px-4 py-2.5 text-sm text-white opacity-80">
                  {pending}
                </div>
              </div>
              <p className="text-xs text-ink-3">Looking at your workspace...</p>
            </>
          )}
          <div ref={endRef} />
        </div>

        <form
          className="border-t border-line p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void send(draft);
          }}
        >
          {note && <p className="mb-2 text-xs text-danger">{note}</p>}
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value.slice(0, 2000))}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send(draft);
                }
              }}
              rows={2}
              disabled={!overview.available || limitReached}
              placeholder={
                limitReached
                  ? "Today's question limit is reached."
                  : "Ask about orders, handoffs, your AI setup... or ask for a change"
              }
              className="flex-1 resize-none rounded-xl border border-line bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-3 outline-none focus:border-brand/40 disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={busy || !draft.trim() || !overview.available || limitReached}
              className="rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white transition-opacity duration-300 hover:opacity-90 disabled:opacity-50"
            >
              {busy && pending ? "Thinking..." : "Send"}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-ink-3">
            Answers come from your workspace data. The AI can be wrong; check numbers that matter.
          </p>
        </form>
      </section>
  );

  if (panel) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <label className="sr-only" htmlFor="ask-omni-thread">
            Chat
          </label>
          <select
            id="ask-omni-thread"
            value={thread ? String(thread.thread.id) : ""}
            onChange={(event) => {
              const id = Number(event.target.value);
              if (id > 0) void openThread(id);
              else startNewChat();
            }}
            className="min-w-0 flex-1 truncate rounded-lg border border-line bg-soft px-2 py-1.5 text-xs text-ink outline-none focus:border-brand/40"
          >
            <option value="">New chat</option>
            {overview.threads.map((t) => (
              <option key={t.id} value={String(t.id)}>
                {t.title}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={startNewChat}
            title="New chat"
            aria-label="New chat"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line text-ink-2 hover:bg-soft"
          >
            <PortalIcon name="plus" />
          </button>
        </div>
        {chat}
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
      <aside className="rounded-2xl border border-line bg-white p-4 shadow-card lg:self-start">
        <button
          type="button"
          onClick={startNewChat}
          className="w-full rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white transition-opacity duration-300 hover:opacity-90"
        >
          New chat
        </button>
        <ul className="mt-3 space-y-1">
          {overview.threads.map((t) => (
            <li key={t.id} className="group flex items-center gap-1">
              <button
                type="button"
                onClick={() => void openThread(t.id)}
                className={
                  "min-w-0 flex-1 truncate rounded-lg px-2 py-1.5 text-left text-sm " +
                  (thread?.thread.id === t.id ? "bg-brand-soft text-brand" : "text-ink hover:bg-soft")
                }
              >
                {t.title}
              </button>
              <button
                type="button"
                aria-label={"Delete chat " + t.title}
                onClick={() => void removeThread(t.id)}
                className="rounded px-1.5 text-xs text-ink-3 opacity-0 hover:text-danger group-hover:opacity-100"
              >
                &times;
              </button>
            </li>
          ))}
          {overview.threads.length === 0 && (
            <li className="px-2 py-1.5 text-xs text-ink-3">Your chats appear here.</li>
          )}
        </ul>
        {overview.dailyLimit > 0 && (
          <p className="mt-3 text-[11px] text-ink-3">
            {overview.usedToday} of {overview.dailyLimit} questions used today (whole workspace).
          </p>
        )}
      </aside>

      {chat}
    </div>
  );
}
