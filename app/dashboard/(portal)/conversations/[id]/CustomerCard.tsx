"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface NoteItem {
  id: number;
  body: string;
  authorEmail: string;
  authorName: string;
  createdAt: string | null;
}

function formatWhen(value: string | null): string {
  if (!value) return "";
  const stamp = Date.parse(value);
  if (Number.isNaN(stamp)) return "";
  const minutes = Math.round((Date.now() - stamp) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  return Math.floor(hours / 24) + "d ago";
}

export default function CustomerCard({ contactId }: { contactId: string | null }) {
  const [notes, setNotes] = useState<NoteItem[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!contactId) return;
    try {
      const response = await fetch(
        "/api/omniflow/portal/customers/notes?contact_id=" +
          encodeURIComponent(contactId),
        { credentials: "same-origin", cache: "no-store" }
      );
      const payload = (await response.json().catch(() => null)) as {
        notes?: {
          id?: number;
          body?: string;
          author_email?: string;
          author_name?: string;
          created_at?: string | null;
        }[];
      } | null;
      const mapped = (payload?.notes || [])
        .map((note) => ({
          id: typeof note.id === "number" ? note.id : 0,
          body: typeof note.body === "string" ? note.body : "",
          authorEmail: typeof note.author_email === "string" ? note.author_email : "",
          authorName: typeof note.author_name === "string" ? note.author_name : "",
          createdAt: typeof note.created_at === "string" ? note.created_at : null,
        }))
        .filter((note) => note.id > 0 && note.body);
      setNotes(mapped);
    } catch {
      setNotes([]);
    }
  }, [contactId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addNote() {
    const body = draft.trim();
    if (busy || !body || !contactId) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/customers/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ contact_id: contactId, body }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        note?: {
          id?: number;
          body?: string;
          author_email?: string;
          author_name?: string;
          created_at?: string | null;
        };
        error?: { message?: string };
      } | null;
      if (
        response.ok &&
        payload?.ok &&
        typeof payload.note?.id === "number" &&
        typeof payload.note?.body === "string"
      ) {
        const note = {
          id: payload.note.id,
          body: payload.note.body,
          authorEmail:
            typeof payload.note.author_email === "string" ? payload.note.author_email : "",
          authorName:
            typeof payload.note.author_name === "string" ? payload.note.author_name : "",
          createdAt:
            typeof payload.note.created_at === "string" ? payload.note.created_at : null,
        };
        setNotes((current) => [note, ...(current || [])]);
        setDraft("");
      } else {
        setMessage(payload?.error?.message || "Could not save the note. Try again shortly.");
      }
    } catch {
      setMessage("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function removeNote(noteId: number) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/customers/notes/" + String(noteId),
        { method: "DELETE", credentials: "same-origin" }
      );
      if (response.ok) {
        setNotes((current) => (current || []).filter((note) => note.id !== noteId));
      } else {
        setMessage("Could not delete the note. Try again shortly.");
      }
    } catch {
      setMessage("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!contactId) return null;

  return (
    <div className="rounded-2xl border border-line bg-soft p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold text-ink">Customer</h2>
        <div className="flex items-center gap-3">
          {contactId && (
            <Link
              prefetch={false}
              href={`/dashboard/customers/profile?contact=${encodeURIComponent(contactId)}`}
              className="text-[10px] font-semibold uppercase tracking-wider text-brand/90 transition-colors duration-300 hover:text-brand"
            >
              360
            </Link>)}
          {contactId && (
            <a
              href={`https://wa.me/${contactId.replace(/[^0-9]/g, "")}`}
              target="_blank"
              rel="noreferrer"
              className="text-[10px] font-medium text-ok transition-colors hover:text-ok"
            >
              WhatsApp →
            </a>
          )}
          <Link
            href={"/dashboard/conversations?q=" + encodeURIComponent(contactId)}
            className="text-[10px] font-medium text-brand transition-colors hover:text-brand"
          >
            All chats →
          </Link>
        </div>
      </div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">
        Notes follow this customer across every chat — {contactId}
      </p>

      {notes === null ? (
        <p className="mt-3 text-[11px] text-ink-3">Loading notes…</p>
      ) : notes.length === 0 ? (
        <p className="mt-3 text-[11px] text-ink-3">
          No notes yet — anything you add shows here and on the Customers page.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {notes.map((note) => (
            <li
              key={"ccard-note-" + String(note.id)}
              className="rounded-xl border border-line bg-white/[0.01] px-3 py-2"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 whitespace-pre-wrap break-words text-xs text-ink-2">
                  {note.body}
                </p>
                <button
                  type="button"
                  onClick={() => void removeNote(note.id)}
                  disabled={busy}
                  className="shrink-0 text-[10px] text-ink-3 transition-colors duration-300 hover:text-danger disabled:opacity-40"
                >
                  Delete
                </button>
              </div>
              <p className="mt-1 text-[10px] text-ink-3">
                {note.authorName || note.authorEmail || "Team"}
                {note.createdAt ? " · " + formatWhen(note.createdAt) : ""}
              </p>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={1000}
          placeholder="Add a note about this customer…"
          className="flex-1 rounded-xl border border-line bg-soft px-3 py-2 text-xs text-ink placeholder-slate-400 outline-none transition-colors duration-300 focus:border-brand/40"
        />
        <button
          type="button"
          onClick={() => void addNote()}
          disabled={busy || !draft.trim()}
          className="rounded-xl border border-brand/25 bg-brand-soft px-3 py-2 text-xs font-medium text-brand transition-colors duration-300 hover:bg-brand-soft disabled:opacity-50"
        >
          {busy ? "Saving…" : "Add note"}
        </button>
      </div>
      {message && <p className="mt-2 text-[11px] text-danger">{message}</p>}
    </div>
  );
}
