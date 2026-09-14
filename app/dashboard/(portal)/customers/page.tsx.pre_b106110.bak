"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

interface CustomerSummary {
  contactId: string;
  name: string;
  channels: string[];
  conversationCount: number;
  openCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  leadTemp: string;
  tags: string[];
}

const POLL_MS = 30_000;

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

function tagHue(tag: string): number {
  let hash = 0;
  for (let index = 0; index < tag.length; index++) {
    hash = (hash * 31 + tag.charCodeAt(index)) % 360;
  }
  return hash;
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<CustomerSummary[] | null>(null);
  const [expired, setExpired] = useState(false);
  const [pending, setPending] = useState(false);
  const [search, setSearch] = useState("");
  const [notesOpenFor, setNotesOpenFor] = useState<string | null>(null);
  const [notesByContact, setNotesByContact] = useState<
    Record<
      string,
      { id: number; body: string; authorEmail: string; authorName: string; createdAt: string | null }[]
    >
  >({});
  const [noteDraft, setNoteDraft] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [msgOpenFor, setMsgOpenFor] = useState<string | null>(null);
  const [msgDraft, setMsgDraft] = useState("");
  const [msgBusy, setMsgBusy] = useState(false);
  const [msgStatus, setMsgStatus] = useState<string | null>(null);
  const searchRef = useRef("");
  const debounceRef = useRef<number | null>(null);
  const [channelFilter, setChannelFilter] = useState<
    "all" | "whatsapp" | "website"
  >("all");
  const channelRef = useRef<"all" | "whatsapp" | "website">("all");
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (searchRef.current) params.set("q", searchRef.current);
      if (channelRef.current !== "all") {
        params.set("channel", channelRef.current);
      }
      const qs = params.toString();
      const response = await fetch(
        "/api/omniflow/portal/customers" + (qs ? "?" + qs : ""),
        { credentials: "same-origin", cache: "no-store" }
      );
      if (response.status === 401) {
        if (mounted.current) setExpired(true);
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        customers?: CustomerSummary[];
        error?: { code?: string };
      } | null;
      if (!mounted.current || !payload) return;
      if (Array.isArray(payload.customers)) {
        setCustomers(payload.customers);
        setPending(false);
      } else if (payload.error?.code === "portal_pending") {
        setPending(true);
        setCustomers([]);
      }
    } catch {
      // Transient network issue — the next poll retries.
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

  function onSearchChange(value: string) {
    setSearch(value);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      searchRef.current = value.trim();
      void refresh();
    }, 300);
  }

  function copyContact(contactId: string) {
    void navigator.clipboard.writeText(contactId);
  }

  function exportCustomers() {
    if (!customers || customers.length === 0) return;
    const headers = [
      "contact_id",
      "name",
      "channels",
      "chats",
      "open",
      "lead_temp",
      "tags",
      "last_message_at",
      "last_message_preview",
    ];
    const csvCell = (value: unknown): string => {
      const text = value === null || value === undefined ? "" : String(value);
      return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    };
    const lines = [headers.join(",")];
    for (const customer of customers) {
      lines.push(
        [
          customer.contactId,
          customer.name,
          customer.channels.join(" | "),
          customer.conversationCount,
          customer.openCount,
          customer.leadTemp,
          customer.tags.join(" | "),
          customer.lastMessageAt,
          customer.lastMessagePreview,
        ]
          .map(csvCell)
          .join(",")
      );
    }
    const blob = new Blob(["\ufeff" + lines.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "omniflow-customers.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function toggleNotes(contactId: string) {
    if (notesOpenFor === contactId) {
      setNotesOpenFor(null);
      return;
    }
    setNotesOpenFor(contactId);
    setNoteError(null);
    if (notesByContact[contactId] !== undefined) return;
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
      const notes = (payload?.notes || [])
        .map((note) => ({
          id: typeof note.id === "number" ? note.id : 0,
          body: typeof note.body === "string" ? note.body : "",
          authorEmail: typeof note.author_email === "string" ? note.author_email : "",
          authorName: typeof note.author_name === "string" ? note.author_name : "",
          createdAt: typeof note.created_at === "string" ? note.created_at : null,
        }))
        .filter((note) => note.id > 0 && note.body);
      setNotesByContact((prev) => ({ ...prev, [contactId]: notes }));
    } catch {
      setNotesByContact((prev) => ({ ...prev, [contactId]: [] }));
    }
  }

  async function addNote(contactId: string) {
    const body = noteDraft.trim();
    if (noteBusy || !body) return;
    setNoteBusy(true);
    setNoteError(null);
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
        setNotesByContact((prev) => ({
          ...prev,
          [contactId]: [note, ...(prev[contactId] || [])],
        }));
        setNoteDraft("");
      } else {
        setNoteError(payload?.error?.message || "Could not save the note. Try again shortly.");
      }
    } catch {
      setNoteError("Network error — try again.");
    } finally {
      setNoteBusy(false);
    }
  }

  async function removeNote(contactId: string, noteId: number) {
    if (noteBusy) return;
    setNoteBusy(true);
    setNoteError(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/customers/notes/" + String(noteId),
        { method: "DELETE", credentials: "same-origin" }
      );
      if (response.ok) {
        setNotesByContact((prev) => ({
          ...prev,
          [contactId]: (prev[contactId] || []).filter((note) => note.id !== noteId),
        }));
      } else {
        setNoteError("Could not delete the note. Try again shortly.");
      }
    } catch {
      setNoteError("Network error — try again.");
    } finally {
      setNoteBusy(false);
    }
  }

  async function sendMessage(contactId: string) {
    const text = msgDraft.trim();
    if (msgBusy || !text) return;
    setMsgBusy(true);
    setMsgStatus(null);
    try {
      const response = await fetch("/api/omniflow/portal/customers/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ contact_id: contactId, body: text }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMsgStatus("Message queued. It goes out from your connected number.");
        setMsgDraft("");
      } else {
        setMsgStatus(payload?.error?.message || "Could not send. Try again shortly.");
      }
    } catch {
      setMsgStatus("Network error, try again.");
    } finally {
      setMsgBusy(false);
    }
  }

  if (expired) {
    return (
      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
        <p className="text-sm text-slate-300">Session expired.</p>
        <Link
          href="/dashboard"
          className="mt-3 inline-block rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200"
        >
          Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-base font-semibold text-white">Customers</h1>
      <p className="mt-0.5 text-xs text-slate-500">
        Every contact across WhatsApp and the website — search, filter, and
        jump straight into their chats.
      </p>

      <div className="mt-4">
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search by name or contact…"
          className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
        />
      </div>

      <div className="mb-4 mt-3 flex flex-wrap items-center gap-2">
        {(["all", "whatsapp", "website"] as const).map((value) => (
          <button
            key={value}
            onClick={() => {
              channelRef.current = value;
              setChannelFilter(value);
              void refresh();
            }}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              channelFilter === value
                ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
                : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
            }`}
          >
            {value === "all" ? "All channels" : value}
          </button>
        ))}
        <button
          type="button"
          onClick={() => exportCustomers()}
          disabled={!customers || customers.length === 0}
          className="ml-auto rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors duration-300 hover:text-white disabled:opacity-40"
        >
          Export CSV
        </button>
      </div>

      {!customers ? (
        <div className="animate-pulse space-y-3">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="h-20 rounded-2xl border border-white/[0.06] bg-white/[0.015]"
            />
          ))}
        </div>
      ) : customers.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-sm text-slate-300">
            {pending
              ? "Connecting to the inbox — customers appear in a minute."
              : search
                ? "No customers match that search."
                : "No customers yet — they appear with the first message."}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {customers.map((customer) => (
            <li
              key={customer.contactId}
              className="overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.015]"
            >
              <div className="flex items-stretch">
              <Link
                href={
                  "/dashboard/conversations?q=" +
                  encodeURIComponent(customer.contactId)
                }
                className="min-w-0 flex-1 p-4 transition-colors duration-300 hover:bg-white/[0.03]"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-cyan-400/20 bg-cyan-400/[0.06] text-sm font-semibold text-cyan-200">
                      {(customer.name || customer.contactId || "?")
                        .trim()
                        .charAt(0)
                        .toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-white">
                        {customer.name || customer.contactId}
                      </p>
                      {customer.name && (
                        <button
                          type="button"
                          onClick={() => copyContact(customer.contactId)}
                          title="Copy number"
                          className="truncate text-left text-[11px] text-slate-500 transition-colors hover:text-slate-300"
                        >
                          {customer.contactId}
                        </button>
                      )}
                      {customer.tags.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {customer.tags.slice(0, 3).map((tag) => (
                            <span
                              key={"cust-tag-" + tag}
                              className="inline-block rounded-md border px-1.5 py-0.5 text-[9px] font-medium tracking-wide"
                              style={{
                                borderColor:
                                  `hsl(${tagHue(tag)} 70% 50% / 0.3)`,
                                backgroundColor:
                                  `hsl(${tagHue(tag)} 70% 50% / 0.10)`,
                                color: `hsl(${tagHue(tag)} 80% 72%)`,
                              }}
                            >
                              #{tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 sm:text-right">
                    <p className="text-[11px] text-slate-400">
                      {customer.conversationCount}{" "}
                      {customer.conversationCount === 1 ? "chat" : "chats"}
                      {customer.openCount > 0 &&
                        " · " + customer.openCount + " open"}
                      {" · "}
                      {customer.channels.join(", ")}
                    </p>
                    {customer.lastMessagePreview && (
                      <p className="mt-0.5 max-w-xs truncate text-xs text-slate-300 sm:ml-auto">
                        {customer.lastMessagePreview}
                      </p>
                    )}
                    <p className="mt-0.5 text-[10px] text-slate-600">
                      {formatWhen(customer.lastMessageAt)}
                    </p>
                  </div>
                </div>
                {customer.leadTemp !== "cold" && (
                  <div className="mt-2 flex">
                    <span
                      className={
                        "inline-block rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider " +
                        (customer.leadTemp === "hot"
                          ? "border-orange-400/25 bg-orange-400/[0.08] text-orange-300"
                          : "border-amber-400/20 bg-amber-400/[0.05] text-amber-200/80")
                      }
                    >
                      {customer.leadTemp} lead
                    </span>
                  </div>
                )}
              </Link>
                <div className="flex w-14 shrink-0 flex-col border-l border-white/[0.05] sm:w-16">
                  <a
                    href={`https://wa.me/${customer.contactId.replace(/[^0-9]/g, "")}`}
                    target="_blank"
                    rel="noreferrer"
                    title="Open in WhatsApp"
                    className="flex-1 border-b border-white/[0.05] text-[10px] font-semibold uppercase tracking-wider text-emerald-300/90 transition-colors duration-300 hover:text-emerald-200"
                  >
                    Chat
                  </a>
                  <button
                    type="button"
                    onClick={() => void toggleNotes(customer.contactId)}
                    className={
                      "flex-1 text-[10px] font-semibold uppercase tracking-wider transition-colors duration-300 " +
                      (notesOpenFor === customer.contactId
                        ? "bg-cyan-400/[0.08] text-cyan-200"
                        : "text-slate-500 hover:text-white")
                    }
                  >
                    Notes
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setNotesOpenFor(null);
                      setMsgStatus(null);
                      setMsgOpenFor(msgOpenFor === customer.contactId ? null : customer.contactId);
                    }}
                    className={
                      "flex-1 border-t border-white/[0.05] text-[10px] font-semibold uppercase tracking-wider transition-colors duration-300 " +
                      (msgOpenFor === customer.contactId
                        ? "bg-cyan-400/[0.08] text-cyan-200"
                        : "text-slate-500 hover:text-white")
                    }
                  >
                    Message
                  </button>
                </div>
              </div>
              {notesOpenFor === customer.contactId && (
                <div className="border-t border-white/[0.05] p-4">
                  {notesByContact[customer.contactId] === undefined ? (
                    <p className="text-[11px] text-slate-600">Loading notes…</p>
                  ) : (notesByContact[customer.contactId] || []).length === 0 ? (
                    <p className="text-[11px] text-slate-600">
                      No notes yet — add context your team should always see
                      for this customer.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {(notesByContact[customer.contactId] || []).map((note) => (
                        <li
                          key={"note-" + String(note.id)}
                          className="rounded-xl border border-white/[0.05] bg-white/[0.01] px-3 py-2"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="min-w-0 whitespace-pre-wrap break-words text-xs text-slate-300">
                              {note.body}
                            </p>
                            <button
                              type="button"
                              onClick={() => void removeNote(customer.contactId, note.id)}
                              className="shrink-0 text-[10px] text-slate-600 transition-colors duration-300 hover:text-red-300"
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
                      value={noteDraft}
                      onChange={(event) => setNoteDraft(event.target.value)}
                      maxLength={1000}
                      placeholder="Add a note about this customer…"
                      className="flex-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
                    />
                    <button
                      type="button"
                      onClick={() => void addNote(customer.contactId)}
                      disabled={noteBusy || !noteDraft.trim()}
                      className="rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-3 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50"
                    >
                      {noteBusy ? "Saving…" : "Add note"}
                    </button>
                  </div>
                  {noteError && (
                    <p className="mt-2 text-[11px] text-red-300">{noteError}</p>
                  )}
                </div>
              )}
              {msgOpenFor === customer.contactId && (
                <div className="border-t border-white/[0.05] p-4">
                  <textarea
                    value={msgDraft}
                    onChange={(event) => setMsgDraft(event.target.value)}
                    maxLength={1000}
                    rows={3}
                    placeholder="Type your message..."
                    className="w-full resize-none rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
                  />
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[10px] text-slate-600">
                      {msgDraft.trim().length}/1000
                    </span>
                    <button
                      type="button"
                      onClick={() => void sendMessage(customer.contactId)}
                      disabled={msgBusy || !msgDraft.trim()}
                      className="rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50"
                    >
                      {msgBusy ? "Sending..." : "Send message"}
                    </button>
                  </div>
                  {msgStatus && (
                    <p className="mt-2 text-[11px] text-slate-400">{msgStatus}</p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
