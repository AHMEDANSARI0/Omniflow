// add_customer_context_card.mjs — Phase 25: Customer context in the inbox.
//
// Zero AI, ZERO Control Plane changes -> NO backend commit, NO bot restart.
// Phase 24 put customer notes on the Customers page; this puts them where the
// team actually replies: the conversation thread. A new CustomerCard (same
// pattern as TagsCard/TeamCard) renders inside every thread and reuses the
// existing customers/notes BFF:
//
//   - contact id + "All chats" link (pre-filtered inbox search)
//   - the customer's notes with author + age, add + delete inline
//
// Website-only: 2 swaps in conversations/[id]/page.tsx (import + render) and
// 1 new file CustomerCard.tsx.
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_customer_context_card.mjs
//
// Requires Phase 24 (add_customer_notes.mjs) to be applied first.
//
// CRLF-tolerant, idempotent, backups: *.pre_ccard.bak
// Expected first run: 3 applied, 0 warnings (2 swaps + 1 new file).
// Expected rerun:     0 applied, 2 already done, 0 warnings.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CARD_PATH =
  "Omniflow/app/dashboard/(portal)/conversations/[id]/CustomerCard.tsx";
const PAGE_PATH = "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx";

// --------------------------------------------------------------------------
// Website: CustomerCard.tsx (new file)
// --------------------------------------------------------------------------

const CARD_FILE = `"use client";

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
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold text-white">Customer</h2>
        <Link
          href={"/dashboard/conversations?q=" + encodeURIComponent(contactId)}
          className="text-[10px] font-medium text-cyan-300 transition-colors hover:text-cyan-200"
        >
          All chats →
        </Link>
      </div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
        Notes follow this customer across every chat — {contactId}
      </p>

      {notes === null ? (
        <p className="mt-3 text-[11px] text-slate-600">Loading notes…</p>
      ) : notes.length === 0 ? (
        <p className="mt-3 text-[11px] text-slate-600">
          No notes yet — anything you add shows here and on the Customers page.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {notes.map((note) => (
            <li
              key={"ccard-note-" + String(note.id)}
              className="rounded-xl border border-white/[0.05] bg-white/[0.01] px-3 py-2"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 whitespace-pre-wrap break-words text-xs text-slate-300">
                  {note.body}
                </p>
                <button
                  type="button"
                  onClick={() => void removeNote(note.id)}
                  disabled={busy}
                  className="shrink-0 text-[10px] text-slate-600 transition-colors duration-300 hover:text-red-300 disabled:opacity-40"
                >
                  Delete
                </button>
              </div>
              <p className="mt-1 text-[10px] text-slate-600">
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
          className="flex-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
        />
        <button
          type="button"
          onClick={() => void addNote()}
          disabled={busy || !draft.trim()}
          className="rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-3 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50"
        >
          {busy ? "Saving…" : "Add note"}
        </button>
      </div>
      {message && <p className="mt-2 text-[11px] text-red-300">{message}</p>}
    </div>
  );
}
`;

// --------------------------------------------------------------------------
// Website: conversations/[id]/page.tsx (2 swaps)
// --------------------------------------------------------------------------

const PAGE_IMPORT_FROM = `import RatingCard from "./RatingCard";`;

const PAGE_IMPORT_TO = `import RatingCard from "./RatingCard";
import CustomerCard from "./CustomerCard";`;

const PAGE_RENDER_FROM = `      {!expired && !notFound && (
        <TagsCard conversationId={Number(id)} initialTags={conversation?.tags ?? []} />
      )}`;

const PAGE_RENDER_TO = `      {!expired && !notFound && (
        <TagsCard conversationId={Number(id)} initialTags={conversation?.tags ?? []} />
      )}
      {!expired && !notFound && (
        <CustomerCard contactId={conversation?.contactId ?? null} />
      )}`;

// --------------------------------------------------------------------------
// Driver
// --------------------------------------------------------------------------

const TARGETS = [
  {
    file: PAGE_PATH,
    swaps: [
      { name: "page-import", from: PAGE_IMPORT_FROM, to: PAGE_IMPORT_TO },
      { name: "page-render", from: PAGE_RENDER_FROM, to: PAGE_RENDER_TO },
    ],
  },
];

let appliedTotal = 0;
let alreadyTotal = 0;
let warnTotal = 0;

function compilePython(pathArg) {
  for (const py of ["python", "python3"]) {
    try {
      execFileSync(py, ["-m", "py_compile", pathArg], { stdio: "pipe" });
      return true;
    } catch {
      /* try next interpreter */
    }
  }
  return false;
}

function writeFileEnsuringDir(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.replace(/\r\n/g, "\n"), "utf8");
}

for (const target of TARGETS) {
  if (!fs.existsSync(target.file)) {
    console.log("SKIP (file not found): " + target.file);
    warnTotal++;
    continue;
  }

  const original = fs.readFileSync(target.file, "utf8");
  let text = original.replace(/\r\n/g, "\n");
  let changed = false;
  const fileApplied = [];

  for (const swap of target.swaps) {
    const fromCount = text.split(swap.from).length - 1;
    const toCount = text.split(swap.to).length - 1;

    if (fromCount === 1 && toCount === 0) {
      text = text.split(swap.from).join(swap.to);
      changed = true;
      appliedTotal++;
      fileApplied.push(swap.name);
    } else if (toCount > 0) {
      alreadyTotal++;
    } else {
      warnTotal++;
      console.log("  ? " + target.file + " :: " + swap.name + " NOT FOUND — report this");
    }
  }

  if (!changed) {
    console.log("= " + target.file + " (already patched)");
    continue;
  }

  const backup = target.file + ".pre_ccard.bak";
  if (!fs.existsSync(backup)) fs.copyFileSync(target.file, backup);

  if (target.file.endsWith(".py")) {
    fs.writeFileSync(target.file, text, "utf8");
    if (!compilePython(target.file)) {
      fs.copyFileSync(backup, target.file);
      console.log("FAIL (compile failed, restored): " + target.file);
      warnTotal++;
      continue;
    }
  } else {
    fs.writeFileSync(target.file, text, "utf8");
  }

  console.log("+ " + target.file + " (" + fileApplied.length + "): " + fileApplied.join(", "));
}

// New files (written only when missing).
const NEW_FILES = [[CARD_PATH, CARD_FILE]];
for (const [newPath, newContent] of NEW_FILES) {
  if (fs.existsSync(newPath)) {
    console.log("= " + newPath + " (already present)");
  } else {
    writeFileEnsuringDir(newPath, newContent);
    appliedTotal++;
    console.log("+ " + newPath);
  }
}

console.log("");
console.log(
  "SUMMARY: " +
    appliedTotal +
    " applied, " +
    alreadyTotal +
    " already done, " +
    warnTotal +
    " warnings"
);