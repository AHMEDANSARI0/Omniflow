"use client";

import { useCallback, useEffect, useState } from "react";

interface SavedReply {
  id: number;
  shortcut: string;
  body: string;
  createdAt: string | null;
  useCount: number;
  lastUsedAt: string | null;
}

function when(value: string | null): string {
  if (!value) return "\\u2014";
  const stamp = Date.parse(value);
  if (Number.isNaN(stamp)) return "\\u2014";
  const minutes = Math.round((Date.now() - stamp) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  if (days < 30) return days + "d ago";
  return Math.floor(days / 30) + "mo ago";
}

export default function SavedRepliesPage() {
  const [replies, setReplies] = useState<SavedReply[] | null>(null);
  const [shortcut, setShortcut] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [noteTone, setNoteTone] = useState("neutral");
  const [editId, setEditId] = useState<number | null>(null);
  const [editShortcut, setEditShortcut] = useState("");
  const [editBody, setEditBody] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/saved-replies", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) {
        setReplies(null);
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        replies?: SavedReply[];
      } | null;
      setReplies(Array.isArray(payload?.replies) ? payload.replies : []);
    } catch {
      setReplies(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function setFlash(text: string, tone: string) {
    setNote(text);
    setNoteTone(tone);
  }

  async function createReply() {
    if (busy) return;
    if (!shortcut.trim() || !body.trim()) {
      setFlash("A shortcut and message text are both required.", "amber");
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/saved-replies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ shortcut: shortcut.trim(), body: body.trim() }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        reply?: SavedReply;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok && payload.reply) {
        setReplies((current) => [payload.reply as SavedReply, ...(current ?? [])]);
        setShortcut("");
        setBody("");
        setFlash("Saved. Type / in any conversation to use it.", "emerald");
      } else {
        setFlash(payload?.error?.message || "Could not save the reply.", "amber");
      }
    } catch {
      setFlash("Network error — try again.", "amber");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(reply: SavedReply) {
    setEditId(reply.id);
    setEditShortcut(reply.shortcut);
    setEditBody(reply.body);
    setNote("");
  }

  function cancelEdit() {
    setEditId(null);
    setEditShortcut("");
    setEditBody("");
  }

  async function saveEdit() {
    if (busy || editId === null) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch(
        "/api/omniflow/portal/saved-replies/" + editId,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            shortcut: editShortcut.trim(),
            body: editBody.trim(),
          }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        reply?: SavedReply | null;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        const updated = payload.reply ?? null;
        setReplies((current) =>
          (current ?? []).map((item) =>
            item.id === editId && updated ? updated : item
          )
        );
        cancelEdit();
        setFlash("Reply updated.", "emerald");
      } else {
        setFlash(payload?.error?.message || "Could not update the reply.", "amber");
      }
    } catch {
      setFlash("Network error — try again.", "amber");
    } finally {
      setBusy(false);
    }
  }

  async function removeReply(reply: SavedReply) {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch(
        "/api/omniflow/portal/saved-replies/" + reply.id,
        { method: "DELETE", credentials: "same-origin" }
      );
      if (response.ok) {
        setReplies((current) =>
          (current ?? []).filter((item) => item.id !== reply.id)
        );
        setFlash("Reply deleted.", "emerald");
      } else {
        setFlash("Could not delete the reply.", "amber");
      }
    } catch {
      setFlash("Network error — try again.", "amber");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#07111f] px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-400/70">
          Workspace
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Quick replies
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Canned messages your team types as /shortcut in any conversation. Up to
          30 per workspace.
        </p>

        {note ? (
          <p
            className={
              "mt-4 rounded-lg border px-3 py-2 text-xs " +
              (noteTone === "emerald"
                ? "border-emerald-400/20 bg-emerald-400/[0.05] text-emerald-200"
                : "border-amber-400/20 bg-amber-400/[0.05] text-amber-200")
            }
          >
            {note}
          </p>
        ) : null}

        <section className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
          <p className="text-xs font-semibold text-white">Add a reply</p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              value={shortcut}
              onChange={(event) => setShortcut(event.target.value)}
              placeholder="shortcut e.g. pricing"
              className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-400/40 sm:w-56"
            />
            <input
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Message text (max 1000 characters)"
              className="flex-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-400/40"
            />
          </div>
          <button
            type="button"
            onClick={() => void createReply()}
            disabled={busy}
            className="mt-2 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition hover:bg-cyan-400/[0.14] disabled:opacity-40"
          >
            {busy ? "Saving\\u2026" : "Save reply"}
          </button>
        </section>

        {replies === null ? (
          <p className="mt-4 text-sm text-slate-500">
            Quick replies are unavailable right now.
          </p>
        ) : replies.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">
            No quick replies yet — add your first one above.
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {replies.map((reply) => (
              <li
                key={reply.id}
                className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4"
              >
                {editId === reply.id ? (
                  <div className="flex flex-col gap-2">
                    <input
                      value={editShortcut}
                      onChange={(event) => setEditShortcut(event.target.value)}
                      className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-sm text-white outline-none focus:border-cyan-400/40 sm:w-56"
                    />
                    <textarea
                      value={editBody}
                      onChange={(event) => setEditBody(event.target.value)}
                      rows={3}
                      className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-sm text-white outline-none focus:border-cyan-400/40"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void saveEdit()}
                        disabled={busy}
                        className="rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] px-3 py-1.5 text-xs text-cyan-200 transition hover:bg-cyan-400/[0.14] disabled:opacity-40"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-400 transition hover:text-white"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <span className="rounded-md border border-cyan-400/20 bg-cyan-400/[0.06] px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300">
                        /{reply.shortcut}
                      </span>
                      <p className="mt-1 line-clamp-2 text-xs text-slate-400">
                        {reply.body}
                      </p>
                      <p className="mt-1 text-[10px] text-slate-600">
                        Used {reply.useCount} time{reply.useCount === 1 ? "" : "s"}
                        {" \\u00b7 "}last {when(reply.lastUsedAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        onClick={() => startEdit(reply)}
                        className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-[11px] text-slate-300 transition hover:text-white"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeReply(reply)}
                        disabled={busy}
                        className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-[11px] text-slate-400 transition hover:text-rose-300 disabled:opacity-40"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
