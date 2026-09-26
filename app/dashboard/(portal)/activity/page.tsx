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
    <main className="min-h-screen bg-canvas px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-brand/70">
            Workspace
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Activity</h1>
          <p className="mt-1.5 text-sm text-ink-3">
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
                  ? "border-brand/30 bg-brand-soft text-brand"
                  : "border-line text-ink-3 hover:text-ink")
              }
            >
              {entry.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void load()}
            className="ml-auto rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 transition hover:text-ink"
          >
            Refresh
          </button>
          <a
            href="/api/omniflow/portal/activity/export"
            className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-3 transition hover:text-ink"
          >
            Export CSV
          </a>
        </div>

        {items === null ? (
          <div className="rounded-2xl border border-line bg-soft px-6 py-12 text-center">
            <p className="text-sm text-ink-3">Loading activity...</p>
          </div>
        ) : failed ? (
          <div className="rounded-2xl border border-line bg-soft px-6 py-12 text-center">
            <p className="text-sm text-ink-3">
              Activity is unavailable right now.
            </p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-3 rounded-lg border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition hover:bg-brand-soft"
            >
              Try again
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-2xl border border-line bg-soft px-6 py-12 text-center">
            <p className="text-sm text-ink-3">Nothing here yet.</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {visible.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-line bg-soft px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">{item.label}</p>
                  {item.note ? (
                    <p className="mt-0.5 truncate text-xs text-ink-3">{item.note}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {item.conversationId ? (
                    <Link
                      href={
                        "/dashboard/conversations/" + String(item.conversationId)
                      }
                      className="text-xs text-brand transition hover:text-brand"
                    >
                      Open chat
                    </Link>
                  ) : null}
                  <span className="text-[11px] text-ink-3">{item.timeAgo}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
