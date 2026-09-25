"use client";

import { useCallback, useEffect, useState } from "react";

interface TeamMemberLite {
  id: number;
  email: string;
  name: string;
  status: string;
}

interface NoteEntry {
  id: number;
  authorEmail: string;
  authorName: string;
  body: string;
  createdAt: string | null;
}

function formatWhen(value: string | null): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function TeamCard({
  conversationId,
  initialAssignedTo,
}: {
  conversationId: number;
  initialAssignedTo: string | null;
}) {
  const [members, setMembers] = useState<TeamMemberLite[]>([]);
  const [assignedTo, setAssignedTo] = useState<string | null>(initialAssignedTo);
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [busyAssign, setBusyAssign] = useState(false);
  const [busyNote, setBusyNote] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );

  const loadNotes = useCallback(async () => {
    if (!conversationId) return;
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/" + String(conversationId) + "/notes",
        { credentials: "same-origin", cache: "no-store" }
      );
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        notes?: NoteEntry[];
      } | null;
      if (payload && Array.isArray(payload.notes)) {
        setNotes(payload.notes);
        setNotesLoaded(true);
      }
    } catch {
      // Transient network issue — reopening the thread retries.
    }
  }, [conversationId]);

  useEffect(() => {
    let alive = true;
    async function loadTeam() {
      try {
        const response = await fetch("/api/omniflow/portal/team", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok || !alive) return;
        const payload = (await response.json().catch(() => null)) as {
          members?: TeamMemberLite[];
        } | null;
        if (alive && payload && Array.isArray(payload.members)) {
          setMembers(payload.members);
        }
      } catch {
        // The selector still works with the current assignee only.
      }
    }
    void loadTeam();
    void loadNotes();
    return () => {
      alive = false;
    };
  }, [loadNotes]);

  async function assign(email: string) {
    if (busyAssign) return;
    setBusyAssign(true);
    setMessage(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/" + String(conversationId) + "/assign",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ assigneeEmail: email || null }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        assigned_to?: string | null;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setAssignedTo(payload.assigned_to ?? null);
        setMessage({
          kind: "ok",
          text: email ? "Conversation assigned." : "Assignment cleared.",
        });
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not assign. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusyAssign(false);
    }
  }

  async function addNote() {
    if (busyNote || !draft.trim()) return;
    setBusyNote(true);
    setMessage(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/" + String(conversationId) + "/notes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ body: draft.trim() }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        note?: NoteEntry | null;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        if (payload.note) {
          setNotes((current) => [payload.note as NoteEntry, ...current]);
        } else {
          await loadNotes();
        }
        setDraft("");
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not save the note. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusyNote(false);
    }
  }

  const activeMembers = members.filter((member) => member.status === "active");

  return (
    <div className="mb-4 rounded-2xl border border-line bg-soft p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold text-ink">Team</h2>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">
            Assign this conversation and keep internal notes — notes stay
            private to your team.
          </p>
        </div>
        <select
          value={assignedTo ?? ""}
          onChange={(event) => assign(event.target.value)}
          disabled={busyAssign}
          className="w-full shrink-0 rounded-xl border border-line bg-soft px-3 py-2 text-xs text-ink outline-none transition-colors duration-300 focus:border-brand/40 disabled:opacity-50 sm:w-56"
        >
          <option value="">Unassigned</option>
          {activeMembers.map((member) => (
            <option key={member.id} value={member.email}>
              {member.name || member.email}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4 border-t border-line pt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
          Internal notes
        </h3>
        {notesLoaded && notes.length === 0 ? (
          <p className="mt-2 text-[11px] text-ink-3">No notes yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {notes.map((note) => (
              <li
                key={note.id}
                className="rounded-xl border border-line bg-soft px-3 py-2"
              >
                <p className="text-[10px] uppercase tracking-wider text-ink-3">
                  {note.authorName || note.authorEmail}
                  {note.createdAt ? " · " + formatWhen(note.createdAt) : ""}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-xs text-ink-2">
                  {note.body}
                </p>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Internal note — never sent to the customer"
            className="w-full resize-none rounded-xl border border-line bg-soft px-3.5 py-2.5 text-xs text-ink placeholder-slate-400 outline-none transition-colors duration-300 focus:border-brand/40"
          />
          <button
            type="button"
            onClick={addNote}
            disabled={busyNote || !draft.trim()}
            className="shrink-0 rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors duration-300 hover:bg-brand-soft disabled:opacity-50 sm:w-auto"
          >
            {busyNote ? "Saving…" : "Add note"}
          </button>
        </div>
        {message && (
          <p
            className={
              "mt-2 text-[11px] " +
              (message.kind === "ok" ? "text-ok" : "text-danger")
            }
          >
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
}
