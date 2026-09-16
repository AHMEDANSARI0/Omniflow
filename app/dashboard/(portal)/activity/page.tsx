"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface ActivityRow {
  id: number;
  action: string;
  label: string;
  note: string;
  conversationId: number | null;
  createdAt: string;
  timeAgo: string;
}

const FAMILIES: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "sequence", label: "Sequences" },
  { key: "cod", label: "COD" },
  { key: "broadcast", label: "Broadcasts" },
  { key: "webhooks", label: "Webhooks" },
  { key: "kb", label: "Knowledge base" },
  { key: "customers", label: "Customers" },
  { key: "conversation", label: "Inbox" },
  { key: "bot", label: "Escalations" },
];

export default function ActivityPage() {
  const [items, setItems] = useState<ActivityRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [family, setFamily] = useState("all");

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const response = await fetch("/api/omniflow/portal/activity", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) {
        setFailed(true);
        setItems([]);
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        items?: ActivityRow[];
      } | null;
      setItems(Array.isArray(payload?.items) ? payload.items : []);
    } catch {
      setFailed(true);
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = (items ?? []).filter(
    (item) => family === "all" || item.action.startsWith(family)
  );

  return (
    <main className="min-h-screen bg-[#07111f] px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-400/70">
            Workspace
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-white">Activity</h1>
          <p className="mt-1.5 text-sm text-slate-400">
            Everything your team and automations did, newest first.
          </p>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          {FAMILIES.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => setFamily(entry.key)}
              className={
                "rounded-lg border px-3 py-1.5 text-xs transition " +
                (family === entry.key
                  ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
                  : "border-white/[0.08] text-slate-400 hover:text-white")
              }
            >
              {entry.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void load()}
            className="ml-auto rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
          >
            Refresh
          </button>
          <a
            href="/api/omniflow/portal/activity/export"
            className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-400 transition hover:text-white"
          >
            Export CSV
          </a>
        </div>

        {items === null ? (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] px-6 py-12 text-center">
            <p className="text-sm text-slate-400">Loading activity...</p>
          </div>
        ) : failed ? (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] px-6 py-12 text-center">
            <p className="text-sm text-slate-400">
              Activity is unavailable right now.
            </p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-3 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition hover:bg-cyan-400/[0.14]"
            >
              Try again
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] px-6 py-12 text-center">
            <p className="text-sm text-slate-400">Nothing here yet.</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {visible.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.015] px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-white">{item.label}</p>
                  {item.note ? (
                    <p className="mt-0.5 truncate text-xs text-slate-500">{item.note}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {item.conversationId ? (
                    <Link
                      href={
                        "/dashboard/conversations/" + String(item.conversationId)
                      }
                      className="text-xs text-cyan-300 transition hover:text-cyan-200"
                    >
                      Open chat
                    </Link>
                  ) : null}
                  <span className="text-[11px] text-slate-600">{item.timeAgo}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
