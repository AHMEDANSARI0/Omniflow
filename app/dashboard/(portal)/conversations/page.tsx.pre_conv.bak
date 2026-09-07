"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";


interface ConversationSummary {
  id: number;
  channel: string;
  contactId: string | null;
  contactName: string | null;
  status: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
}

const POLL_MS = 10_000;

function formatTime(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

export default function ConversationsPage() {
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [pending, setPending] = useState(false);
  const [expired, setExpired] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/conversations", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        if (mounted.current) setExpired(true);
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        conversations?: ConversationSummary[];
        error?: { code?: string };
      } | null;
      if (!mounted.current || !payload) return;
      if (Array.isArray(payload.conversations)) {
        setItems(payload.conversations);
        setPending(false);
      } else if (payload.error?.code === "portal_pending") {
        setPending(true);
        setItems([]);
      }
    } catch {
      // Transient network issue — next poll retries.
    }
  }, []);

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

  if (expired) {
    return (
      <div className="mx-auto max-w-2xl">
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-sm text-slate-300">Your session expired.</p>
          <a
            href="/dashboard/reauth"
            className="mt-3 inline-block text-xs text-cyan-300 transition-colors hover:text-cyan-200"
          >
            Re-authenticate →
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Conversations
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Tenant-isolated WhatsApp conversations with AI outcomes.
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          className="shrink-0 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-cyan-400/40"
        >
          Refresh
        </button>
      </div>

      {!items ? (
        <div className="animate-pulse space-y-3">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="h-20 rounded-2xl border border-white/[0.06] bg-white/[0.015]"
            />
          ))}
        </div>
      ) : items.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center"
        >
          <p className="text-sm font-medium text-slate-200">
            {pending
              ? "The conversations module is rolling out on the server."
              : "No conversations yet."}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            {pending
              ? "It lights up automatically right after the backend deploy."
              : "Messages appear here as soon as your WhatsApp connector is linked and customers start chatting."}
          </p>
        </motion.div>
      ) : (
        <motion.ul
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="space-y-3"
        >
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={`/dashboard/conversations/${item.id}`}
                className="block rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 transition-colors duration-300 hover:border-cyan-400/30 hover:bg-white/[0.025]"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] text-xs font-semibold text-cyan-300">
                      {(item.contactName || item.contactId || "?").slice(0, 2).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-white">
                        {item.contactName || item.contactId || "Unknown contact"}
                      </p>
                      <p className="truncate text-xs text-slate-500">
                        {item.contactId ?? "—"}
                      </p>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <span
                      className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                        item.status === "open"
                          ? "border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-300"
                          : "border-white/[0.06] bg-white/[0.02] text-slate-500"
                      }`}
                    >
                      {item.status}
                    </span>
                    <p className="mt-1 text-[10px] text-slate-600">
                      {formatTime(item.lastMessageAt)}
                    </p>
                  </div>
                </div>
                {item.lastMessagePreview && (
                  <p className="mt-3 truncate text-xs text-slate-400">
                    {item.lastMessagePreview}
                  </p>
                )}
              </Link>
            </li>
          ))}
        </motion.ul>
      )}
    </div>
  );
}
