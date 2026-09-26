import { useCallback, useEffect, useState } from "react";

interface NoteEntrySummary {
  id: number;
  authorName: string;
  body: string;
  createdAt: string | null;
}

function formatNoteWhen(value: string | null): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleString();
}

export default function NotesCard({
  conversationId,
}: {
  conversationId: number;
}) {
  const [notes, setNotes] = useState<NoteEntrySummary[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/" + conversationId + "/notes",
        { credentials: "same-origin" }
      );
      const payload = (await response.json()) as { notes?: NoteEntrySummary[] };
      setNotes(payload.notes ?? []);
    } catch {
      setNotes([]);
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addNote() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/" + conversationId + "/notes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ body }),
        }
      );
      if (response.ok) {
        setDraft("");
        void load();
      }
    } catch {
      // Transient network issue, the note can be retried.
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-line bg-soft p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-3">
        Internal notes
      </h2>
      {notes === null ? (
        <p className="mt-3 text-[11px] text-ink-3">Loading notes…</p>
      ) : notes.length === 0 ? (
        <p className="mt-3 text-[11px] text-ink-3">
          No notes yet. Anything the team should remember about this chat goes here.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {notes.map((note) => (
            <li
              key={note.id}
              className="rounded-xl border border-line bg-soft px-3 py-2"
            >
              <p className="whitespace-pre-wrap break-words text-xs text-ink">
                {note.body}
              </p>
              <p className="mt-1 text-[10px] text-ink-3">
                {note.authorName}
                {note.createdAt ? " · " + formatNoteWhen(note.createdAt) : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          maxLength={1000}
          placeholder="Add an internal note…"
          className="flex-1 resize-none rounded-xl border border-line bg-soft px-3 py-2 text-xs text-ink placeholder-slate-400 outline-none transition-colors duration-300 focus:border-brand/40"
        />
        <button
          type="button"
          onClick={() => void addNote()}
          disabled={busy || !draft.trim()}
          className="rounded-xl border border-line bg-soft px-3 py-2 text-xs font-medium text-ink-2 transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </section>
  );
}
