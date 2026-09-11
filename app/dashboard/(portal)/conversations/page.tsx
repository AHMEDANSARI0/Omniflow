"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";


interface ConversationSummary {
  id: number;
  channel: string;
  contactId: string | null;
  contactName: string | null;
  status: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unread: boolean;
  needsReply: boolean;
  lastIntent: string | null;
  leadTemp: string;
  leadScore: number;
  assignedTo: string | null;
  assigneeName: string | null;
  tags: string[];
}

function tagHue(tag: string): number {
  let hash = 0;
  for (let index = 0; index < tag.length; index++) {
    hash = (hash * 31 + tag.charCodeAt(index)) % 360;
  }
  return hash;
}

const POLL_MS = 10_000;

function formatTime(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

export default function ConversationsPage() {
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [pending, setPending] = useState(false);
  const [expired, setExpired] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef("");
  const debounceRef = useRef<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "closed">("all");
  const statusRef = useRef<"all" | "open" | "closed">("all");
  const [intentFilter, setIntentFilter] = useState("all");
  const intentRef = useRef("all");
  const [channelFilter, setChannelFilter] = useState<"all" | "whatsapp" | "website">("all");
  const channelRef = useRef<"all" | "whatsapp" | "website">("all");
  const [replyFilter, setReplyFilter] = useState("");
  const replyFilterRef = useRef("");
  const [oldestFirst, setOldestFirst] = useState(false);
  const oldestRef = useRef(false);
  const [assignedFilter, setAssignedFilter] = useState("");
  const assignedRef = useRef("");
  const [daysFilter, setDaysFilter] = useState("");
  const daysRef = useRef("");
  const [unreadFilter, setUnreadFilter] = useState("");
  const unreadRef = useRef("");
  const [chipCounts, setChipCounts] = useState({
    needsReply: 0,
    overdue: 0,
    unassigned: 0,
  });
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [assignTarget, setAssignTarget] = useState("");
  const [tagFilter, setTagFilter] = useState("all");
  const tagRef = useRef("all");
  const [tagOptions, setTagOptions] = useState<{ tag: string; count: number }[]>([]);
  const [teamMembers, setTeamMembers] = useState<{ email: string; name: string }[]>([]);
  const [exporting, setExporting] = useState(false);
  const [intentCounts, setIntentCounts] = useState<
    { intent: string; conversations: number }[]
  >([]);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const listParams = new URLSearchParams();
      if (searchRef.current) listParams.set("q", searchRef.current);
      if (statusRef.current !== "all") listParams.set("status", statusRef.current);
      if (intentRef.current !== "all") listParams.set("intent", intentRef.current);
      if (channelRef.current !== "all") listParams.set("channel", channelRef.current);
      if (tagRef.current !== "all") listParams.set("tag", tagRef.current);
      if (replyFilterRef.current) listParams.set("needs_reply", replyFilterRef.current);
      if (oldestRef.current) listParams.set("sort", "oldest");
      if (assignedRef.current) listParams.set("assigned", assignedRef.current);
      if (daysRef.current) listParams.set("days", daysRef.current);
      if (unreadRef.current) listParams.set("unread", unreadRef.current);
      const listQs = listParams.toString();
      const response = await fetch(
        "/api/omniflow/portal/conversations" + (listQs ? "?" + listQs : ""),
        {
          credentials: "same-origin",
          cache: "no-store",
        }
      );
      if (response.status === 401) {
        if (mounted.current) setExpired(true);
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        conversations?: ConversationSummary[];
        counts?: { needsReply?: number; overdue?: number; unassigned?: number };
        error?: { code?: string };
      } | null;
      if (!mounted.current || !payload) return;
      if (Array.isArray(payload.conversations)) {
        setItems(payload.conversations);
        setPending(false);
        if (payload.counts) {
          setChipCounts({
            needsReply: payload.counts.needsReply || 0,
            overdue: payload.counts.overdue || 0,
            unassigned: payload.counts.unassigned || 0,
          });
        }
      } else if (payload.error?.code === "portal_pending") {
        setPending(true);
        setItems([]);
      }
    } catch {
      // Transient network issue — next poll retries.
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const urlFilters = new URLSearchParams(window.location.search);
    const urlQuery = (urlFilters.get("q") || "").trim();
    if (urlQuery) {
      searchRef.current = urlQuery;
      setSearch(urlQuery);
    }
    const urlReply = urlFilters.get("needs_reply");
    if (urlReply === "1" || urlReply === "overdue") {
      replyFilterRef.current = urlReply;
      setReplyFilter(urlReply);
    }
    if ((urlFilters.get("sort") || "") === "oldest") {
      oldestRef.current = true;
      setOldestFirst(true);
    }
    const urlAssigned = urlFilters.get("assigned");
    if (urlAssigned === "unassigned" || urlAssigned === "me") {
      assignedRef.current = urlAssigned;
      setAssignedFilter(urlAssigned);
    }
    const urlDays = urlFilters.get("days");
    if (urlDays === "1" || urlDays === "7" || urlDays === "30") {
      daysRef.current = urlDays;
      setDaysFilter(urlDays);
    }
    if (urlFilters.get("unread") === "1") {
      unreadRef.current = "1";
      setUnreadFilter("1");
    }
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [refresh]);

  async function quickAssign(conversationId: number, assigneeEmail: string) {
    const previous = items;
    setItems((current) =>
      current
        ? current.map((item) =>
            item.id === conversationId
              ? {
                  ...item,
                  assignedTo: assigneeEmail || null,
                  assigneeName:
                    teamMembers.find((member) => member.email === assigneeEmail)
                      ?.name || (assigneeEmail || null),
                }
              : item
          )
        : current
    );
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/" + conversationId + "/assign",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ assigneeEmail: assigneeEmail || null }),
        }
      );
      if (!response.ok) setItems(previous);
    } catch {
      setItems(previous);
    }
  }

  function toggleSelected(conversationId: number) {
    setSelectedIds((current) =>
      current.includes(conversationId)
        ? current.filter((value) => value !== conversationId)
        : [...current, conversationId]
    );
  }

  async function bulkAction(action: string, assigneeEmail?: string) {
    if (bulkBusy || selectedIds.length === 0) return;
    setBulkBusy(true);
    try {
      const response = await fetch("/api/omniflow/portal/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(
          action === "assign"
            ? { action, ids: selectedIds, assignee_email: assigneeEmail || "" }
            : { action, ids: selectedIds }
        ),
      });
      if (response.ok) {
        setSelectedIds([]);
        void refresh();
      }
    } catch {
      // Transient network issue, the user can retry.
    } finally {
      setBulkBusy(false);
    }
  }

  async function exportCsv() {
    if (exporting) return;
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (searchRef.current) params.set("q", searchRef.current);
      if (statusRef.current !== "all") params.set("status", statusRef.current);
      if (intentRef.current !== "all") params.set("intent", intentRef.current);
      if (channelRef.current !== "all") params.set("channel", channelRef.current);
      if (tagRef.current !== "all") params.set("tag", tagRef.current);
      if (replyFilterRef.current) params.set("needs_reply", replyFilterRef.current);
      if (oldestRef.current) params.set("sort", "oldest");
      if (assignedRef.current) params.set("assigned", assignedRef.current);
      if (daysRef.current) params.set("days", daysRef.current);
      if (unreadRef.current) params.set("unread", unreadRef.current);
      const qs = params.toString();
      const response = await fetch(
        "/api/omniflow/portal/conversations/export" + (qs ? "?" + qs : ""),
        { credentials: "same-origin", cache: "no-store" }
      );
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        conversations?: ConversationSummary[];
      } | null;
      const rows = Array.isArray(payload?.conversations)
        ? payload.conversations
        : [];
      const headers = [
        "id",
        "channel",
        "contact_name",
        "contact_id",
        "status",
        "last_intent",
        "lead_temp",
        "lead_score",
        "assignee",
        "labels",
        "last_message_at",
        "last_message_preview",
      ];
      const csvCell = (value: unknown): string => {
        const text = value === null || value === undefined ? "" : String(value);
        return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
      };
      const lines = [headers.join(",")];
      for (const row of rows) {
        lines.push(
          [
            row.id,
            row.channel,
            row.contactName,
            row.contactId,
            row.status,
            row.lastIntent,
            row.leadTemp,
            row.leadScore,
            row.assigneeName,
            row.tags.join(" | "),
            row.lastMessageAt,
            row.lastMessagePreview,
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
      link.download = "omniflow-conversations.csv";
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      // Export is best-effort — the merchant can retry.
    } finally {
      setExporting(false);
    }
  }

  const loadIntentSummary = useCallback(async () => {
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/intents",
        {
          credentials: "same-origin",
          cache: "no-store",
        }
      );
      if (response.status !== 200) return;
      const payload = (await response.json().catch(() => null)) as {
        intents?: { intent: string; conversations: number }[];
      } | null;
      if (mounted.current && payload && Array.isArray(payload.intents)) {
        setIntentCounts(payload.intents.slice(0, 6));
      }
    } catch {
      // Transient network issue — the next poll retries.
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/omniflow/portal/conversations/tags", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (response.status !== 200) return;
        const payload = (await response.json().catch(() => null)) as {
          tags?: { tag: string; count: number }[];
        } | null;
        if (mounted.current && payload && Array.isArray(payload.tags)) {
          setTagOptions(payload.tags.slice(0, 6));
        }
      } catch {
        // Transient network issue — the next visit retries.
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/omniflow/portal/team", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (response.status !== 200) return;
        const payload = (await response.json().catch(() => null)) as {
          members?: { email?: string; name?: string; status?: string }[];
        } | null;
        if (mounted.current && payload && Array.isArray(payload.members)) {
          setTeamMembers(
            payload.members
              .filter(
                (member): member is { email: string; name?: string; status?: string } =>
                  member !== null &&
                  typeof member === "object" &&
                  typeof member.email === "string" &&
                  member.status === "active"
              )
              .map((member) => ({
                email: member.email,
                name: typeof member.name === "string" ? member.name : "",
              }))
          );
        }
      } catch {
        // The team list is optional here — the thread page still manages assignment.
      }
    })();
  }, []);

  useEffect(() => {
    void loadIntentSummary();
    const summaryTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadIntentSummary();
    }, 30_000);
    return () => window.clearInterval(summaryTimer);
  }, [loadIntentSummary]);

  function onSearchChange(value: string) {
    setSearch(value);
    searchRef.current = value;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void refresh();
    }, 350);
  }

  if (expired) {
    return (
      <div className="mx-auto max-w-2xl">
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-sm text-slate-300">Your session expired.</p>
          <a
            href="/dashboard/reauth"
            className="mt-3 inline-block text-xs text-cyan-300 transition-colors hover:text-cyan-200"
          >
            Re-authenticate →
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Conversations
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Tenant-isolated WhatsApp conversations with AI outcomes.
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          className="shrink-0 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-cyan-400/40"
        >
          Refresh
        </button>
      </div>

      {(intentCounts.length > 0 || intentFilter !== "all") && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {intentCounts.map((entry) => (
            <button
              key={entry.intent}
              onClick={() => {
                const next = intentFilter === entry.intent ? "all" : entry.intent;
                intentRef.current = next;
                setIntentFilter(next);
                void refresh();
              }}
              className={`rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors ${
                intentFilter === entry.intent
                  ? "border-cyan-400/40 bg-cyan-400/[0.12] text-cyan-200"
                  : "border-cyan-400/15 bg-cyan-400/[0.04] text-cyan-300/70 hover:bg-cyan-400/[0.09]"
              }`}
            >
              {entry.intent.replace(/_/g, " ")} · {entry.conversations}
            </button>
          ))}
          {intentFilter !== "all" && (
            <button
              onClick={() => {
                intentRef.current = "all";
                setIntentFilter("all");
                void refresh();
              }}
              className="rounded-full border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[10px] font-medium text-slate-400 transition-colors hover:text-white"
            >
              Clear ✕
            </button>
          )}
        </div>
      )}

      <div className="mb-5">
        <input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search by contact name, number, or message text"
          className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(["all", "whatsapp", "website"] as const).map((value) => (
          <button
            key={"channel-" + value}
            onClick={() => {
              channelRef.current = value;
              setChannelFilter(value);
              void refresh();
            }}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
              channelFilter === value
                ? "border-violet-400/30 bg-violet-400/[0.08] text-violet-200"
                : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
            }`}
          >
            {value === "all" ? "All channels" : value}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            const next = replyFilter === "1" ? "" : "1";
            replyFilterRef.current = next;
            setReplyFilter(next);
            void refresh();
          }}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            replyFilter === "1"
              ? "border-amber-400/30 bg-amber-400/[0.08] text-amber-200"
              : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
          }`}
        >
          Needs reply
          {chipCounts.needsReply > 0 && (
            <span className="ml-1.5 rounded-md bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
              {chipCounts.needsReply}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => {
            const next = replyFilter === "overdue" ? "" : "overdue";
            replyFilterRef.current = next;
            setReplyFilter(next);
            void refresh();
          }}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            replyFilter === "overdue"
              ? "border-red-400/30 bg-red-400/[0.08] text-red-200"
              : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
          }`}
        >
          Overdue
          {chipCounts.overdue > 0 && (
            <span className="ml-1.5 rounded-md bg-red-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">
              {chipCounts.overdue}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => {
            oldestRef.current = !oldestRef.current;
            setOldestFirst(oldestRef.current);
            void refresh();
          }}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            oldestFirst
              ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
              : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
          }`}
        >
          Oldest first
        </button>
        <button
          type="button"
          onClick={() => {
            const next = assignedFilter === "unassigned" ? "" : "unassigned";
            assignedRef.current = next;
            setAssignedFilter(next);
            void refresh();
          }}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            assignedFilter === "unassigned"
              ? "border-sky-400/30 bg-sky-400/[0.08] text-sky-200"
              : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
          }`}
        >
          Unassigned
          {chipCounts.unassigned > 0 && (
            <span className="ml-1.5 rounded-md bg-sky-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300">
              {chipCounts.unassigned}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => {
            const next = assignedFilter === "me" ? "" : "me";
            assignedRef.current = next;
            setAssignedFilter(next);
            void refresh();
          }}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            assignedFilter === "me"
              ? "border-indigo-400/30 bg-indigo-400/[0.08] text-indigo-200"
              : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
          }`}
        >
          Mine
        </button>
        <select
          value={daysFilter}
          onChange={(event) => {
            daysRef.current = event.target.value;
            setDaysFilter(event.target.value);
            void refresh();
          }}
          className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 text-xs font-medium text-slate-300 outline-none transition-colors focus:border-cyan-400/40"
        >
          <option value="">Any time</option>
          <option value="1">Last 24 hours</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
        </select>
        <button
          type="button"
          onClick={() => {
            const next = unreadFilter === "1" ? "" : "1";
            unreadRef.current = next;
            setUnreadFilter(next);
            void refresh();
          }}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            unreadFilter === "1"
              ? "border-violet-400/30 bg-violet-400/[0.08] text-violet-200"
              : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
          }`}
        >
          Unread
        </button>
      </div>

      {tagOptions.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {tagOptions.map((entry) => (
            <button
              key={"tag-" + entry.tag}
              onClick={() => {
                const next = tagFilter === entry.tag ? "all" : entry.tag;
                tagRef.current = next;
                setTagFilter(next);
                void refresh();
              }}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                tagFilter === entry.tag
                  ? "border-amber-400/30 bg-amber-400/[0.08] text-amber-200"
                  : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
              }`}
            >
              #{entry.tag} · {entry.count}
            </button>
          ))}
        </div>
      )}

      <div className="mb-4 flex items-center gap-2">
        {(["all", "open", "closed"] as const).map((value) => (
          <button
            key={value}
            onClick={() => {
              statusRef.current = value;
              setStatusFilter(value);
              void refresh();
            }}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
              statusFilter === value
                ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
                : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
            }`}
          >
            {value}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void exportCsv()}
          disabled={exporting || !items || items.length === 0}
          className="ml-auto rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors duration-300 hover:text-white disabled:opacity-40"
        >
          {exporting ? "Preparing…" : "Export CSV"}
        </button>
      </div>

      {selectedIds.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.04] px-3 py-2">
          <span className="text-xs font-medium text-cyan-200">
            {selectedIds.length} selected
          </span>
          <button
            type="button"
            onClick={() => void bulkAction("close")}
            disabled={bulkBusy}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:text-white disabled:opacity-40"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => void bulkAction("reopen")}
            disabled={bulkBusy}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:text-white disabled:opacity-40"
          >
            Reopen
          </button>
          <select
            value={assignTarget}
            disabled={bulkBusy || teamMembers.length === 0}
            onChange={(event) => {
              const email = event.target.value;
              setAssignTarget("");
              if (email) void bulkAction("assign", email);
            }}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-xs font-medium text-slate-300 disabled:opacity-40"
          >
            <option value="">Assign to...</option>
            {teamMembers.map((member) => (
              <option key={member.email} value={member.email}>
                {member.name || member.email}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void bulkAction("unassign")}
            disabled={bulkBusy}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:text-white disabled:opacity-40"
          >
            Unassign
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds([])}
            className="ml-auto rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-xs font-medium text-slate-400 transition-colors hover:text-white"
          >
            Clear
          </button>
        </div>
      )}

      {!items ? (
        <div className="animate-pulse space-y-3">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="h-20 rounded-2xl border border-white/[0.06] bg-white/[0.015]"
            />
          ))}
        </div>
      ) : items.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center"
        >
          <p className="text-sm font-medium text-slate-200">
            {pending
              ? "The conversations module is rolling out on the server."
              : search
                ? "No conversations match your search."
                : "No conversations yet."}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            {pending
              ? "It lights up automatically right after the backend deploy."
              : "Messages appear here as soon as your WhatsApp connector is linked and customers start chatting."}
          </p>
        </motion.div>
      ) : (
        <motion.ul
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="space-y-3"
        >
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-2">
              <input
                type="checkbox"
                aria-label={
                  "Select conversation " + (item.contactName || item.contactId || "")
                }
                checked={selectedIds.includes(item.id)}
                onChange={() => toggleSelected(item.id)}
                className="mt-4 h-5 w-5 shrink-0 accent-cyan-400"
              />
              <Link
                href={`/dashboard/conversations/${item.id}`}
                className="block min-w-0 flex-1 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 transition-colors duration-300 hover:border-cyan-400/30 hover:bg-white/[0.025]"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] text-xs font-semibold text-cyan-300">
                      {(item.contactName || item.contactId || "?").slice(0, 2).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 truncate text-sm font-medium text-white">
                        <span className="truncate">
                          {item.contactName || item.contactId || "Unknown contact"}
                        </span>
                        {item.unread && (
                          <span
                            className="h-2 w-2 shrink-0 rounded-full bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.8)]"
                            title="Unread messages"
                          />
                        )}
                        {item.needsReply && (
                          <span
                            className="shrink-0 rounded-md border border-amber-400/25 bg-amber-400/[0.08] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300"
                            title="Customer sent the last message — waiting for a reply"
                          >
                            awaiting reply
                          </span>
                        )}
                      </p>
                      <p className="truncate text-xs text-slate-500">
                        {item.contactId ?? "—"}
                      </p>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <span
                      className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                        item.status === "open"
                          ? "border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-300"
                          : "border-white/[0.06] bg-white/[0.02] text-slate-500"
                      }`}
                    >
                      {item.status}
                    </span>
                    <p className="mt-1 text-[10px] text-slate-600">
                      {formatTime(item.lastMessageAt)}
                    </p>
                  </div>
                </div>
                {item.lastMessagePreview && (
                  <p className="mt-3 truncate text-xs text-slate-400">
                    {item.lastMessagePreview}
                  </p>
                )}
                {((item.lastIntent && item.lastIntent !== "general") ||
                  item.leadTemp === "hot" ||
                  Boolean(item.assigneeName) ||
                  item.tags.length > 0) && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {item.lastIntent && item.lastIntent !== "general" && (
                      <span className="inline-block rounded-md border border-cyan-400/15 bg-cyan-400/[0.04] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-cyan-300/70">
                        {item.lastIntent.replace(/_/g, " ")}
                      </span>
                    )}
                    {item.leadTemp === "hot" && (
                      <span className="inline-block rounded-md border border-orange-400/25 bg-orange-400/[0.08] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-orange-300">
                        Hot lead
                      </span>
                    )}
                    {item.assigneeName && (
                      <span className="inline-block rounded-md border border-violet-400/25 bg-violet-400/[0.08] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-violet-300">
                        {item.assigneeName}
                      </span>
                    )}
                    {item.tags.slice(0, 2).map((tag) => (
                      <span
                        key={"row-tag-" + tag}
                        className="inline-block rounded-md border px-1.5 py-0.5 text-[9px] font-medium tracking-wide"
                        style={{
                          borderColor: `hsl(${tagHue(tag)} 70% 50% / 0.3)`,
                          backgroundColor: `hsl(${tagHue(tag)} 70% 50% / 0.10)`,
                          color: `hsl(${tagHue(tag)} 80% 72%)`,
                        }}
                      >
                        #{tag}
                      </span>
                    ))}
                    {item.tags.length > 2 && (
                      <span className="inline-block rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[9px] text-slate-400">
                        +{item.tags.length - 2}
                      </span>
                    )}
                    {teamMembers.length > 0 && (
                      <span
                        className="inline-flex"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                      >
                        <select
                          value={item.assignedTo ?? ""}
                          onChange={(event) =>
                            void quickAssign(item.id, event.target.value)
                          }
                          aria-label="Assign conversation"
                          className="max-w-[130px] rounded-md border border-violet-400/25 bg-violet-400/[0.06] px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-violet-300 outline-none"
                        >
                          <option value="">Unassigned</option>
                          {teamMembers.map((member) => (
                            <option key={member.email} value={member.email}>
                              {member.name || member.email}
                            </option>
                          ))}
                        </select>
                      </span>
                    )}
                  </div>
                )}
              </Link>
            </li>
          ))}
        </motion.ul>
      )}
    </div>
  );
}
