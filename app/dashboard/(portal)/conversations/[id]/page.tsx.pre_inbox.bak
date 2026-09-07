"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";


interface ConversationSummary {
  id: number;
  channel: string;
  contactId: string | null;
  contactName: string | null;
  status: string;
}

interface ConversationMessage {
  id: number;
  direction: "in" | "out";
  body: string;
  status: string;
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
      } | null;
      if (mounted.current && payload?.conversation && Array.isArray(payload.messages)) {
        setConversation(payload.conversation);
        setMessages(payload.messages);
      }
    } catch {
      // Transient network issue — next poll retries.
    }
  }, [id]);

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
            <span
              className={`shrink-0 rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                conversation.status === "open"
                  ? "border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-300"
                  : "border-white/[0.06] bg-white/[0.02] text-slate-500"
              }`}
            >
              {conversation.status}
            </span>
          )}
        </div>
      </div>

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
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="space-y-3"
        >
          {messages.map((message) => (
            <div
              key={message.id}
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
                </p>
              </div>
            </div>
          ))}
        </motion.div>
      )}
    </div>
  );
}
