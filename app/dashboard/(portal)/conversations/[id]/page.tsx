"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import CodCard from "./CodCard";
import TeamCard from "./TeamCard";
import TagsCard from "./TagsCard";
import RatingCard from "./RatingCard";
import CustomerCard from "./CustomerCard";
import SavedRepliesPicker from "./SavedRepliesPicker";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";


interface ConversationSummary {
  id: number;
  channel: string;
  contactId: string | null;
  contactName: string | null;
  status: string;
  assignedTo: string | null;
  tags: string[];
}

interface ConversationMessage {
  id: number;
  direction: "in" | "out";
  body: string;
  status: string;
  intent: string | null;
  createdAt: string | null;
}

const POLL_MS = 10_000;

function formatTime(value: string | null): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function ConversationThreadPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? params.id : "";

  const [conversation, setConversation] = useState<ConversationSummary | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[] | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [expired, setExpired] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const response = await fetch(
        `/api/omniflow/portal/conversations/${encodeURIComponent(id)}`,
        { credentials: "same-origin", cache: "no-store" }
      );
      if (response.status === 401) {
        if (mounted.current) setExpired(true);
        return;
      }
      if (response.status === 404) {
        if (mounted.current) setNotFound(true);
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        conversation?: ConversationSummary;
        messages?: ConversationMessage[];
        has_more?: boolean;
      } | null;
      if (mounted.current && payload?.conversation && Array.isArray(payload.messages)) {
        setConversation(payload.conversation);
        setMessages(payload.messages);
        setHasMore(payload.has_more === true);
      }
    } catch {
      // Transient network issue — next poll retries.
    }
  }, [id]);

  function copyNumber() {
    const value = conversation?.contactId || "";
    if (value) void navigator.clipboard.writeText(value);
  }

  function downloadTranscript() {
    if (!messages || !conversation) return;
    const agentLabel = "Agent";
    const customerLabel = conversation.contactName || conversation.contactId || "Customer";
    const lines = messages.map((message) =>
      "[" + (message.createdAt || "unknown") + "] " +
      (message.direction === "out" ? agentLabel : customerLabel) +
      ": " + message.body
    );
    const blob = new Blob(
      ["Conversation with " + customerLabel + "\n\n" + lines.join("\n")],
      { type: "text/plain;charset=utf-8" }
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "conversation-" + conversation.id + ".txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function loadOlder() {
    if (loadingOlder || !messages || messages.length === 0) return;
    const oldestId = messages[0].id;
    if (!oldestId) return;
    setLoadingOlder(true);
    try {
      const response = await fetch(
        `/api/omniflow/portal/conversations/${encodeURIComponent(id)}/messages?before_id=${oldestId}`,
        { credentials: "same-origin", cache: "no-store" }
      );
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        messages?: ConversationMessage[];
        has_more?: boolean;
      } | null;
      if (!mounted.current || !payload || !Array.isArray(payload.messages)) return;
      const older = payload.messages;
      setMessages((current) => (current ? [...older, ...current] : current));
      setHasMore(payload.has_more === true);
    } catch {
      // Transient network issue, the next click retries.
    } finally {
      setLoadingOlder(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const [statusBusy, setStatusBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [threadQuery, setThreadQuery] = useState("");

  const visibleMessages =
    threadQuery.trim() && messages
      ? messages.filter((message) =>
          message.body.toLowerCase().includes(threadQuery.trim().toLowerCase())
        )
      : messages;

  const threadMessages: ConversationMessage[] = visibleMessages ?? messages ?? [];

  const threadDayLabel = (index: number): string | null => {
    const current = threadMessages[index];
    if (!current || !current.createdAt) return null;
    const key = new Date(current.createdAt).toDateString();
    const previous = index > 0 ? threadMessages[index - 1] : null;
    if (previous && previous.createdAt &&
      new Date(previous.createdAt).toDateString() === key
    ) {
      return null;
    }
    const date = new Date(current.createdAt);
    if (date.toDateString() === new Date().toDateString()) return "Today";
    if (date.toDateString() === new Date(Date.now() - 86400000).toDateString()) {
      return "Yesterday";
    }
    return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  };
  const [sending, setSending] = useState(false);

  async function toggleStatus() {
    if (!conversation || statusBusy) return;
    const next = conversation.status === "open" ? "closed" : "open";
    setStatusBusy(true);
    try {
      const response = await fetch(
        `/api/omniflow/portal/conversations/${encodeURIComponent(id)}/status`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ status: next }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        conversation?: ConversationSummary;
      } | null;
      if (mounted.current && payload?.conversation) {
        setConversation(payload.conversation);
      }
    } catch {
      // Transient network issue — the badge updates on the next poll.
    } finally {
      if (mounted.current) setStatusBusy(false);
    }
  }

  async function sendReply() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const response = await fetch(
        `/api/omniflow/portal/conversations/${encodeURIComponent(id)}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ body }),
        }
      );
      if (response.ok) {
        setDraft("");
        void refresh();
      }
    } catch {
      // Transient network issue — the reply can be retried.
    } finally {
      if (mounted.current) setSending(false);
    }
  }

  const title = conversation?.contactName || conversation?.contactId || "Conversation";

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <Link
          href="/dashboard/conversations"
          className="text-xs text-slate-500 transition-colors hover:text-cyan-300"
        >
          ← Conversations
        </Link>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-white">
              {title}
            </h1>
            <p className="mt-0.5 truncate text-xs text-slate-500">
              {conversation?.contactId ?? (id ? `#${id}` : "")}
            </p>
          </div>
          {conversation && (
            <div className="flex shrink-0 items-center gap-2">
              <span
                className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                  conversation.status === "open"
                    ? "border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-300"
                    : "border-white/[0.06] bg-white/[0.02] text-slate-500"
                }`}
              >
                {conversation.status}
              </span>
              <button
                onClick={() => void toggleStatus()}
                disabled={statusBusy}
                className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  conversation.status === "open"
                    ? "border-red-400/25 bg-red-400/[0.06] text-red-300 hover:bg-red-400/[0.12]"
                    : "border-cyan-400/25 bg-cyan-400/[0.06] text-cyan-300 hover:bg-cyan-400/[0.12]"
                }`}
              >
                {statusBusy
                  ? "Working…"
                  : conversation.status === "open"
                    ? "Close"
                    : "Reopen"}
              </button>
              {conversation.contactId && (
                <>
                  <a
                    href={`https://wa.me/${conversation.contactId.replace(/[^0-9]/g, "")}`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border border-emerald-400/25 bg-emerald-400/[0.06] px-2.5 py-1 text-[11px] font-medium text-emerald-300 transition-colors hover:bg-emerald-400/[0.12]"
                  >
                    WhatsApp
                  </a>
                  <button
                    type="button"
                    onClick={() => copyNumber()}
                    title="Copy number"
                    className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:text-white"
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadTranscript()}
                    title="Download the loaded messages as a text file"
                    className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:text-white"
                  >
                    Transcript
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {!expired && !notFound && conversation?.channel !== "website" && (
        <CodCard conversationId={Number(id)} />
      )}
      {!expired && !notFound && (
        <TeamCard
          conversationId={Number(id)}
          initialAssignedTo={conversation?.assignedTo ?? null}
        />
      )}
      {!expired && !notFound && (
        <TagsCard conversationId={Number(id)} initialTags={conversation?.tags ?? []} />
      )}
      {!expired && !notFound && (
        <CustomerCard contactId={conversation?.contactId ?? null} />
      )}
      {!expired && !notFound && conversation?.channel !== "website" && (
        <RatingCard conversationId={Number(id)} />
      )}

      {expired ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-sm text-slate-300">Your session expired.</p>
          <a
            href="/dashboard/reauth"
            className="mt-3 inline-block text-xs text-cyan-300 transition-colors hover:text-cyan-200"
          >
            Re-authenticate →
          </a>
        </div>
      ) : notFound ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-sm text-slate-300">Conversation not found.</p>
        </div>
      ) : !messages ? (
        <div className="animate-pulse space-y-3">
          {[0, 1, 2, 3].map((index) => (
            <div
              key={index}
              className="h-10 w-2/3 rounded-2xl border border-white/[0.06] bg-white/[0.015]"
            />
          ))}
        </div>
      ) : messages.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-sm text-slate-300">No messages in this conversation yet.</p>
        </div>
      ) : visibleMessages && visibleMessages.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-sm text-slate-300">No messages match your search.</p>
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="space-y-3"
        >
          {messages.length > 3 && (
            <div className="sticky top-0 z-10 -mx-1 bg-[#06101d]/90 px-1 py-2 backdrop-blur">
              <input
                type="search"
                value={threadQuery}
                onChange={(event) => setThreadQuery(event.target.value)}
                placeholder="Search in this conversation"
                className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2 text-xs text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
              />
            </div>
          )}
          {hasMore && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => void loadOlder()}
                disabled={loadingOlder}
                className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-1.5 text-xs font-medium text-slate-300 transition-colors duration-300 hover:text-white disabled:opacity-40"
              >
                {loadingOlder ? "Loading..." : "Load older messages"}
              </button>
            </div>
          )}
          {threadMessages.map((message, index) => (
            <Fragment key={message.id}>
            {threadDayLabel(index) && (
              <div className="flex justify-center">
                <span className="rounded-full border border-white/[0.06] bg-white/[0.02] px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                  {threadDayLabel(index)}
                </span>
              </div>
            )}
            <div
              className={`flex ${message.direction === "out" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl border px-4 py-2.5 sm:max-w-[70%] ${
                  message.direction === "out"
                    ? "border-cyan-400/20 bg-cyan-400/[0.08]"
                    : "border-white/[0.06] bg-white/[0.03]"
                }`}
              >
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-100">
                  {message.body}
                </p>
                <p className="mt-1 text-[10px] text-slate-500">
                  {message.direction === "out" ? "Bot / you" : "Customer"}
                  {formatTime(message.createdAt) ? ` · ${formatTime(message.createdAt)}` : ""}
                  {message.direction === "in" &&
                  message.intent &&
                  message.intent !== "general"
                    ? ` · ${message.intent.replace(/_/g, " ")}`
                    : ""}
                </p>
              </div>
            </div>
            </Fragment>
          ))}
        </motion.div>
      )}

      {!expired && !notFound && (
        <SavedRepliesPicker onPick={(text) => setDraft(text)} />
      )}
      {!expired && !notFound && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void sendReply();
          }}
          className="mt-6 flex items-end gap-3"
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void sendReply();
              }
            }}
            rows={2}
            maxLength={4096}
            placeholder="Reply as a human agent — Enter to send, Shift+Enter for a new line"
            className="flex-1 resize-none rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
          />
          <button
            type="submit"
            disabled={sending || !draft.trim()}
            className="shrink-0 rounded-xl bg-cyan-400 px-5 py-3 text-sm font-semibold text-[#07111f] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </form>
      )}
    </div>
  );
}
