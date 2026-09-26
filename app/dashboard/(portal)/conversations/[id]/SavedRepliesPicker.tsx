"use client";

import { useCallback, useEffect, useState } from "react";

interface SavedReply {
  id: number;
  shortcut: string;
  body: string;
  createdAt: string | null;
  useCount?: number;
  lastUsedAt?: string | null;
}

export default function SavedRepliesPicker({
  onPick,
}: {
  onPick: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [replies, setReplies] = useState<SavedReply[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [shortcut, setShortcut] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/saved-replies", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status !== 200) return;
      const payload = (await response.json().catch(() => null)) as {
        replies?: {
          id?: number;
          shortcut?: string;
          body?: string;
          createdAt?: string | null;
        }[];
      } | null;
      if (payload && Array.isArray(payload.replies)) {
        const next: SavedReply[] = [];
        for (const row of payload.replies) {
          if (row && typeof row.id === "number" &&
              typeof row.shortcut === "string" && typeof row.body === "string") {
            next.push({
              id: row.id,
              shortcut: row.shortcut,
              body: row.body,
              createdAt: typeof row.createdAt === "string" ? row.createdAt : null,
            });
          }
        }
        setReplies(next);
      }
      setLoaded(true);
    } catch {
      // Transient network issue — retry on next open.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function addReply() {
    const trimmedShortcut = shortcut.trim();
    const trimmedBody = body.trim();
    if (!trimmedShortcut || !trimmedBody || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/saved-replies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ shortcut: trimmedShortcut, body: trimmedBody }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        reply?: SavedReply;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok && payload.reply) {
        setReplies((current) => [payload.reply as SavedReply, ...current]);
        setShortcut("");
        setBody("");
        setMessage(null);
      } else {
        setMessage(payload?.error?.message || "Could not save the reply.");
      }
    } catch {
      setMessage("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function removeReply(reply: SavedReply) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/omniflow/portal/saved-replies/${reply.id}`,
        { method: "DELETE", credentials: "same-origin" }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
      } | null;
      if (response.ok && payload?.ok) {
        setReplies((current) => current.filter((item) => item.id !== reply.id));
      } else {
        setMessage("Could not delete the reply.");
      }
    } catch {
      setMessage("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  function useReply(reply: SavedReply) {
    onPick(reply.body);
    setOpen(false);
    setMessage("Template inserted into the reply box — edit if needed, then send.");
    setReplies((current) =>
      current.map((item) =>
        item.id === reply.id
          ? { ...item, useCount: (item.useCount ?? 0) + 1 }
          : item
      )
    );
    void fetch(`/api/omniflow/portal/saved-replies/${reply.id}/use`, {
      method: "POST",
      credentials: "same-origin",
    }).catch(() => undefined);
  }

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={() => {
          setOpen((value) => !value);
          if (!open && !loaded) void load();
        }}
        className="inline-flex items-center gap-2 rounded-xl border border-line bg-soft px-3.5 py-2 text-xs font-medium text-ink-2 transition-colors duration-300 hover:text-ink"
      >
        <span aria-hidden>⚡</span>
        Saved replies
        <span className="rounded-md border border-line bg-soft px-1.5 py-0.5 text-[10px] text-ink-3">
          {replies.length}
        </span>
        <span aria-hidden className="text-[10px] text-ink-3">
          {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <div className="mt-3 rounded-2xl border border-line bg-soft p-4">
          {replies.length > 0 && (
            <ul className="space-y-2">
              {replies.map((reply) => (
                <li
                  key={reply.id}
                  className="flex flex-col gap-2 rounded-xl border border-line bg-soft p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <span className="rounded-md border border-brand/20 bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold text-brand">
                      /{reply.shortcut}
                    </span>
                    {(reply.useCount ?? 0) > 0 ? (
                      <span className="ml-1.5 text-[10px] text-ink-3">
                        used {reply.useCount}\u00d7
                      </span>
                    ) : null}
                    <p className="mt-1 line-clamp-2 text-xs text-ink-3">
                      {reply.body}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => useReply(reply)}
                      className="rounded-lg border border-brand/25 bg-brand-soft px-3 py-1.5 text-[11px] font-medium text-brand transition-colors duration-300 hover:bg-brand-soft"
                    >
                      Use
                    </button>
                    <button
                      type="button"
                      onClick={() => removeReply(reply)}
                      disabled={busy}
                      aria-label={`Delete saved reply ${reply.shortcut}`}
                      className="rounded-lg border border-line bg-soft px-2.5 py-1.5 text-[11px] text-ink-3 transition-colors duration-300 hover:text-ink disabled:opacity-40"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {replies.length === 0 && loaded && (
            <p className="text-xs text-ink-3">
              No saved replies yet — add your first template below (for example
              /thanks for a quick thank-you message).
            </p>
          )}

          <div className="mt-3 space-y-2 border-t border-line pt-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={shortcut}
                onChange={(event) => setShortcut(event.target.value)}
                maxLength={24}
                placeholder="shortcut, e.g. thanks"
                className="w-full sm:w-56 rounded-xl border border-line bg-soft px-3.5 py-2 text-sm text-ink placeholder-slate-400 outline-none transition-colors duration-300 focus:border-brand/40"
              />
              <input
                value={body}
                onChange={(event) => setBody(event.target.value)}
                maxLength={1000}
                placeholder="Message text — what gets inserted"
                className="w-full flex-1 rounded-xl border border-line bg-soft px-3.5 py-2 text-sm text-ink placeholder-slate-400 outline-none transition-colors duration-300 focus:border-brand/40"
              />
              <button
                type="button"
                onClick={() => void addReply()}
                disabled={busy || !shortcut.trim() || !body.trim()}
                className="shrink-0 rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors duration-300 hover:bg-brand-soft disabled:opacity-50"
              >
                {busy ? "Working…" : "Add reply"}
              </button>
            </div>
            {message && <p className="text-xs text-ink-3">{message}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
