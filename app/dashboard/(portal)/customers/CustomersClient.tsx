"use client";

import Link from "next/link";
import CustomersImport from "./CustomersImport";
import DuplicatesPanel from "./DuplicatesPanel";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePortalEntitlements } from "../../components/usePortalEntitlements";

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

interface TopCustomer {
  contactId: string;
  name: string;
  totalSpent: number;
  orders: number;
}

export default function CustomersClient({
  initialCustomers,
  initialQuery,
}: {
  initialCustomers?: CustomerSummary[] | null;
  initialQuery?: string | null;
}) {
  const { hasFeature, hasConnector, hasPermission } = usePortalEntitlements();
  const canUseAdvancedCrm = hasFeature("sales.advanced_crm");
  const canImportCsv = canUseAdvancedCrm && hasPermission("import");
  const canExportCsv =
    (canUseAdvancedCrm || hasFeature("insights.advanced_analytics")) &&
    hasPermission("export");
  const customerChannels = [
    "whatsapp",
    ...(hasFeature("marketing.growth") ? ["website"] : []),
    ...(hasConnector("instagram") ? ["instagram"] : []),
    ...(hasConnector("messenger") ? ["messenger"] : []),
  ];

  const [customers, setCustomers] = useState<CustomerSummary[] | null>(
    initialCustomers ?? null
  );
  const [expired, setExpired] = useState(false);
  const [pending, setPending] = useState(false);
  const [search, setSearch] = useState(initialQuery ?? "");
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
  const [topCustomers, setTopCustomers] = useState<TopCustomer[]>([]);
  const searchRef = useRef(initialQuery ?? "");
  const debounceRef = useRef<number | null>(null);
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const channelRef = useRef<string>("all");
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

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch(
          "/api/omniflow/portal/value/top?limit=5",
          { cache: "no-store" }
        );
        if (!response.ok || !active) return;
        const payload = (await response.json().catch(() => null)) as {
          customers?: TopCustomer[];
        } | null;
        if (active && payload && Array.isArray(payload.customers)) {
          setTopCustomers(
            payload.customers.filter(
              (entry): entry is TopCustomer =>
                entry !== null && typeof entry === "object" &&
                typeof entry.contactId === "string" && !!entry.contactId
            )
          );
        }
      } catch {
        // Top strip is optional - ignore failures.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  function onSearchChange(value: string) {
    setSearch(value);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      searchRef.current = value.trim();
      void refresh();
    }, 300);
  }

  const [mergeOpenFor, setMergeOpenFor] = useState<string | null>(null);
  const [mergeKeep, setMergeKeep] = useState("");
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeNote, setMergeNote] = useState("");
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);

  useEffect(() => {
    if (!menuOpenFor) return;
    function onDocClick() {
      setMenuOpenFor(null);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpenFor(null);
    }
    window.addEventListener("click", onDocClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onDocClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpenFor]);

  async function mergeContact(duplicate: string) {
    if (mergeBusy || !mergeKeep || mergeKeep === duplicate) {
      setMergeNote(
        mergeKeep === duplicate
          ? "Pick a different contact to keep."
          : "Pick which contact to keep."
      );
      return;
    }
    setMergeBusy(true);
    setMergeNote("");
    try {
      const response = await fetch("/api/omniflow/portal/customers/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keep: mergeKeep, merge: duplicate }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        moved?: number;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMergeOpenFor(null);
        setMergeKeep("");
        void refresh();
      } else {
        setMergeNote(payload?.error?.message || "Could not merge. Try again.");
      }
    } catch {
      setMergeNote("Network error — try again.");
    } finally {
      setMergeBusy(false);
    }
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
      <div className="rounded-2xl border border-line bg-white shadow-card px-6 py-12 text-center">
        <p className="text-sm text-ink-2">Session expired.</p>
        <Link
          href="/dashboard"
          className="mt-3 inline-block rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand"
        >
          Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            Customers
          </h1>
          <p className="mt-0.5 text-xs text-ink-3">
            {customerChannels.length > 1
              ? "Every contact across your enabled channels — search, filter, and jump straight into their chats."
              : "Every WhatsApp contact in your workspace — search, message, and jump straight into their chats."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canImportCsv && <CustomersImport onImported={() => void refresh()} />}
          {canExportCsv && (
            <button
              type="button"
              onClick={() => exportCustomers()}
              disabled={!customers || customers.length === 0}
              className="inline-flex h-9 items-center whitespace-nowrap rounded-xl border border-line bg-white px-3 text-xs font-medium text-ink-2 shadow-2xs transition-colors hover:border-brand/30 hover:text-ink disabled:opacity-40"
            >
              Export CSV
            </button>
          )}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={pending}
            className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-xl border border-line bg-white px-3.5 text-xs font-medium text-ink-2 shadow-2xs transition-colors hover:border-brand/40 hover:text-ink disabled:opacity-40"
          >
            <svg
              className={`h-3.5 w-3.5 ${pending ? "animate-spin" : ""}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
            <span>{pending ? "Syncing…" : "Refresh"}</span>
          </button>
        </div>
      </div>

      {(canUseAdvancedCrm || hasFeature("sales.sales_desk")) &&
      topCustomers.length > 0 ? (
        <div className="mb-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
            Top customers
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {topCustomers.map((entry) => (
              <Link
                key={entry.contactId}
                href={"/dashboard/customers/profile?contact=" +
                  encodeURIComponent(entry.contactId)}
                className="rounded-xl border border-line bg-white shadow-card px-2.5 py-1.5 transition-colors hover:bg-line/60"
              >
                <p className="text-xs text-ink">
                  {entry.name || entry.contactId}
                </p>
                <p className="text-[10px] text-ok">
                  Rs {entry.totalSpent.toLocaleString()} ·{" "}
                  {entry.orders} orders
                </p>
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mb-5 rounded-2xl border border-line bg-white p-3.5 shadow-card space-y-3">
        <div className="relative">
          <svg
            className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search customers by name or phone number..."
            className="w-full rounded-xl border border-line bg-soft pl-10 pr-4 py-2 text-sm text-ink placeholder:text-ink-3 outline-none transition-colors focus:border-brand/40 focus:bg-white"
          />
        </div>

        {customerChannels.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-2.5">
            <span className="mr-1 text-[11px] font-medium text-ink-3">
              Channel:
            </span>
            {(["all", ...customerChannels] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  channelRef.current = value;
                  setChannelFilter(value);
                  void refresh();
                }}
                className={`whitespace-nowrap rounded-lg border px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
                  channelFilter === value
                    ? "border-brand/30 bg-brand-soft text-brand"
                    : "border-line bg-soft text-ink-3 hover:text-ink"
                }`}
              >
                {value === "all" ? "All Channels" : value}
              </button>
            ))}
          </div>
        )}
      </div>

      {canUseAdvancedCrm && <DuplicatesPanel onLinked={() => void refresh()} />}

      {!customers ? (
        <div className="animate-pulse space-y-3">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="h-20 rounded-2xl border border-line bg-white shadow-card"
            />
          ))}
        </div>
      ) : customers.length === 0 ? (
        <div className="rounded-2xl border border-line bg-white shadow-card px-6 py-12 text-center">
          <p className="text-sm text-ink-2">
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
              className="relative rounded-2xl border border-line bg-white shadow-card transition-shadow duration-200 hover:shadow-md"
            >
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
                <Link
                  prefetch={false}
                  href={
                    "/dashboard/conversations?q=" +
                    encodeURIComponent(customer.contactId)
                  }
                  className="min-w-0 flex-1 rounded-t-2xl p-4 transition-colors duration-200 hover:bg-soft/70 sm:rounded-l-2xl sm:rounded-tr-none"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-brand/20 bg-brand-soft text-sm font-semibold text-brand">
                        {(customer.name || customer.contactId || "?")
                          .trim()
                          .charAt(0)
                          .toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-semibold text-ink">
                            {customer.name || customer.contactId}
                          </p>
                          {customer.leadTemp !== "cold" && (
                            <span
                              className={
                                "inline-block shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider " +
                                (customer.leadTemp === "hot"
                                  ? "border-orange-400/25 bg-orange-400/[0.08] text-amber-700"
                                  : "border-amber-400/20 bg-amber-400/[0.05] text-amber-800")
                              }
                            >
                              {customer.leadTemp} lead
                            </span>
                          )}
                        </div>
                        {customer.name && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              copyContact(customer.contactId);
                            }}
                            title="Copy contact ID"
                            className="truncate text-left text-[11px] text-ink-3 transition-colors hover:text-ink-2"
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
                      <p className="text-[11px] font-medium text-ink-3">
                        {customer.conversationCount}{" "}
                        {customer.conversationCount === 1 ? "chat" : "chats"}
                        {customer.openCount > 0 &&
                          " · " + customer.openCount + " open"}
                        {" · "}
                        {customer.channels.join(", ")}
                      </p>
                      {customer.lastMessagePreview && (
                        <p className="mt-0.5 max-w-xs truncate text-xs text-ink-2 sm:ml-auto">
                          {customer.lastMessagePreview}
                        </p>
                      )}
                      <p className="mt-0.5 text-[10px] text-ink-3">
                        {formatWhen(customer.lastMessageAt)}
                      </p>
                    </div>
                  </div>
                </Link>

                {/* Clean horizontal action bar + dropdown menu */}
                <div className="flex shrink-0 items-center justify-end gap-1.5 border-t border-line px-4 py-2.5 sm:border-l sm:border-t-0 sm:py-4">
                  <Link
                    prefetch={false}
                    href={
                      "/dashboard/conversations?q=" +
                      encodeURIComponent(customer.contactId)
                    }
                    title="Open conversation in Inbox"
                    className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-brand/25 bg-brand-soft px-3 text-xs font-semibold text-brand transition-colors hover:bg-brand/15"
                  >
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    <span>Chat</span>
                  </Link>

                  <button
                    type="button"
                    onClick={() => {
                      setNotesOpenFor(null);
                      setMsgStatus(null);
                      setMsgOpenFor(msgOpenFor === customer.contactId ? null : customer.contactId);
                    }}
                    title="Send quick message"
                    className={
                      "inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-lg border px-2.5 text-xs font-medium transition-colors " +
                      (msgOpenFor === customer.contactId
                        ? "border-brand/30 bg-brand-soft text-brand"
                        : "border-line bg-soft text-ink-2 hover:border-line-2 hover:text-ink")
                    }
                  >
                    <span>Message</span>
                  </button>

                  <div
                    className="relative"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <button
                      type="button"
                      aria-haspopup="menu"
                      aria-expanded={menuOpenFor === customer.contactId}
                      onClick={() =>
                        setMenuOpenFor((prev) =>
                          prev === customer.contactId ? null : customer.contactId
                        )
                      }
                      title="More customer actions"
                      className={
                        "inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-lg border px-2.5 text-xs font-medium transition-colors " +
                        (menuOpenFor === customer.contactId ||
                        notesOpenFor === customer.contactId ||
                        mergeOpenFor === customer.contactId
                          ? "border-brand/30 bg-brand-soft text-brand"
                          : "border-line bg-white text-ink-2 hover:border-line-2 hover:text-ink")
                      }
                    >
                      <span>Actions</span>
                      <svg className="h-3.5 w-3.5 text-ink-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </button>

                    {menuOpenFor === customer.contactId && (
                      <div
                        role="menu"
                        className="absolute right-0 top-full z-30 mt-1.5 w-48 rounded-xl border border-line bg-white p-1.5 shadow-xl"
                      >
                        {canUseAdvancedCrm && (
                          <a
                            href={`/dashboard/customers/profile?contact=${encodeURIComponent(customer.contactId)}`}
                            role="menuitem"
                            className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs font-medium text-ink transition-colors hover:bg-soft"
                          >
                            <span>Customer 360 Profile</span>
                            <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold text-brand">
                              360
                            </span>
                          </a>
                        )}
                        <a
                          href={`https://wa.me/${customer.contactId.replace(/[^0-9]/g, "")}`}
                          target="_blank"
                          rel="noreferrer"
                          role="menuitem"
                          onClick={() => setMenuOpenFor(null)}
                          className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs font-medium text-ink transition-colors hover:bg-soft"
                        >
                          <span>Open in WhatsApp</span>
                          <span className="text-[10px] font-semibold text-ok">WA ↗</span>
                        </a>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenuOpenFor(null);
                            void toggleNotes(customer.contactId);
                          }}
                          className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs font-medium text-ink transition-colors hover:bg-soft"
                        >
                          <span>Customer Notes</span>
                          {notesOpenFor === customer.contactId && (
                            <span className="text-[10px] font-semibold text-brand">Open</span>
                          )}
                        </button>
                        {canUseAdvancedCrm && (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenuOpenFor(null);
                              setMergeOpenFor(
                                mergeOpenFor === customer.contactId ? null : customer.contactId
                              );
                              setMergeKeep("");
                              setMergeNote("");
                            }}
                            className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs font-medium text-ink transition-colors hover:bg-soft"
                          >
                            <span>Merge Duplicate</span>
                          </button>
                        )}
                        <div className="my-1 border-t border-line" />
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenuOpenFor(null);
                            copyContact(customer.contactId);
                          }}
                          className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs font-medium text-ink-2 transition-colors hover:bg-soft hover:text-ink"
                        >
                          <span>Copy Contact ID</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {mergeOpenFor === customer.contactId && (
                <div className="border-t border-line p-4">
                  <p className="text-xs font-semibold text-ink">
                    Merge duplicates into {customer.name || customer.contactId}
                  </p>
                  <p className="mt-1 text-[11px] text-ink-3">
                    All chats, pipeline stages and COD orders of the duplicate
                    move here. This cannot be undone.
                  </p>
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <select
                      value={mergeKeep}
                      onChange={(event) => setMergeKeep(event.target.value)}
                      className="w-full rounded-xl border border-line bg-soft px-3 py-2 text-sm text-ink outline-none focus:border-brand/40 sm:w-72"
                    >
                      <option value="" className="bg-soft">
                        Keep which contact?
                      </option>
                      {customers.map((option) => (
                        <option
                          key={option.contactId}
                          value={option.contactId}
                          className="bg-soft"
                        >
                          {option.name || option.contactId}
                          {option.contactId === customer.contactId
                            ? " (this row)"
                            : ""}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => void mergeContact(customer.contactId)}
                      disabled={mergeBusy}
                      className="rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition hover:bg-brand/[0.12] disabled:opacity-40"
                    >
                      {mergeBusy ? "Merging\u2026" : "Merge"}
                    </button>
                  </div>
                  {mergeNote ? (
                    <p className="mt-2 text-[11px] text-amber-700">{mergeNote}</p>
                  ) : null}
                </div>
              )}
              {notesOpenFor === customer.contactId && (
                <div className="border-t border-line p-4">
                  {notesByContact[customer.contactId] === undefined ? (
                    <p className="text-[11px] text-ink-3">Loading notes…</p>
                  ) : (notesByContact[customer.contactId] || []).length === 0 ? (
                    <p className="text-[11px] text-ink-3">
                      No notes yet — add context your team should always see
                      for this customer.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {(notesByContact[customer.contactId] || []).map((note) => (
                        <li
                          key={"note-" + String(note.id)}
                          className="rounded-xl border border-line bg-white px-3 py-2"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="min-w-0 whitespace-pre-wrap break-words text-xs text-ink-2">
                              {note.body}
                            </p>
                            <button
                              type="button"
                              onClick={() => void removeNote(customer.contactId, note.id)}
                              className="shrink-0 text-[10px] text-ink-3 transition-colors duration-300 hover:text-danger"
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
                      value={noteDraft}
                      onChange={(event) => setNoteDraft(event.target.value)}
                      maxLength={1000}
                      placeholder="Add a note about this customer…"
                      className="flex-1 rounded-xl border border-line bg-soft px-3 py-2 text-xs text-ink placeholder:text-ink-3 outline-none transition-colors duration-300 focus:border-brand/40"
                    />
                    <button
                      type="button"
                      onClick={() => void addNote(customer.contactId)}
                      disabled={noteBusy || !noteDraft.trim()}
                      className="rounded-xl border border-brand/25 bg-brand-soft px-3 py-2 text-xs font-medium text-brand transition-colors duration-300 hover:bg-brand/[0.12] disabled:opacity-50"
                    >
                      {noteBusy ? "Saving…" : "Add note"}
                    </button>
                  </div>
                  {noteError && (
                    <p className="mt-2 text-[11px] text-danger">{noteError}</p>
                  )}
                </div>
              )}
              {msgOpenFor === customer.contactId && (
                <div className="border-t border-line p-4">
                  <textarea
                    value={msgDraft}
                    onChange={(event) => setMsgDraft(event.target.value)}
                    maxLength={1000}
                    rows={3}
                    placeholder="Type your message..."
                    className="w-full resize-none rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-3 outline-none transition-colors duration-300 focus:border-brand/40"
                  />
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[10px] text-ink-3">
                      {msgDraft.trim().length}/1000
                    </span>
                    <button
                      type="button"
                      onClick={() => void sendMessage(customer.contactId)}
                      disabled={msgBusy || !msgDraft.trim()}
                      className="rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors duration-300 hover:bg-brand/[0.12] disabled:opacity-50"
                    >
                      {msgBusy ? "Sending..." : "Send message"}
                    </button>
                  </div>
                  {msgStatus && (
                    <p className="mt-2 text-[11px] text-ink-3">{msgStatus}</p>
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
