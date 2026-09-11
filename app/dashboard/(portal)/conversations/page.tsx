"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
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
  starred: boolean;
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
    const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
    if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
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

function waitingLabel(value: string): string {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1000)
  );
  if (seconds < 60) return "just now";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h";
  return Math.floor(seconds / 86400) + "d";
}

export default function ConversationsPage() {
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [pending, setPending] = useState(false);
  const [expired, setExpired] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
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
  const [starredFilter, setStarredFilter] = useState("");
  const starredRef = useRef("");
  const [alertEnabled, setAlertEnabled] = useState(false);
  const alertTotalRef = useRef(0);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [liveMode, setLiveMode] = useState(true);
  const liveModeRef = useRef(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const pageRef = useRef(1);
  const appendRef = useRef(false);
  const lastKeyRef = useRef("");
  const [chipCounts, setChipCounts] = useState({
    needsReply: 0,
    overdue: 0,
    unassigned: 0,
    unread: 0,
  });

  const baseTitleRef = useRef("");

  useEffect(() => {
    if (!baseTitleRef.current) baseTitleRef.current = document.title;
    const total = chipCounts.unread + chipCounts.needsReply;
    document.title =
      total > 0
        ? "(" + total + ") " + baseTitleRef.current
        : baseTitleRef.current;
  }, [chipCounts]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const router = useRouter();
  const [activeRowIndex, setActiveRowIndex] = useState(-1);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.key !== "j" &&
        event.key !== "k" &&
        event.key !== "Enter" &&
        event.key !== "r" &&
        event.key !== "a" &&
        event.key !== "s"
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (!items || items.length === 0) return;
      event.preventDefault();
      if (event.key === "j" || event.key === "k") {
        setActiveRowIndex((current) => {
          const next =
            event.key === "j"
              ? Math.min(items.length - 1, current + 1)
              : Math.max(0, current <= 0 ? 0 : current - 1);
          const row = document.querySelector(
            '[data-conv-row="' + items[next].id + '"]'
          );
          row?.scrollIntoView({ block: "nearest" });
          return next;
        });
        return;
      }
      if (activeRowIndex >= 0 && activeRowIndex < items.length) {
        void router.push("/dashboard/conversations/" + items[activeRowIndex].id);
        return;
      }
      if (event.key === "r") {
        const next = replyFilterRef.current ? "" : "1";
        replyFilterRef.current = next;
        setReplyFilter(next);
        void refresh();
        return;
      }
      if (event.key === "a") {
        const next = assignedRef.current === "me" ? "" : "me";
        assignedRef.current = next;
        setAssignedFilter(next);
        void refresh();
        return;
      }
      if (event.key === "s") {
        const next = starredRef.current ? "" : "1";
        starredRef.current = next;
        setStarredFilter(next);
        void refresh();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [items, activeRowIndex, router]);
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

  useEffect(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (channelFilter !== "all") params.set("channel", channelFilter);
    if (tagFilter !== "all") params.set("tag", tagFilter);
    if (replyFilter) params.set("needs_reply", replyFilter);
    if (unreadFilter) params.set("unread", unreadFilter);
    if (daysFilter) params.set("days", daysFilter);
    if (assignedFilter) params.set("assigned", assignedFilter);
    if (starredFilter) params.set("starred", starredFilter);
    if (oldestFirst) params.set("sort", "oldest");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      query
        ? window.location.pathname + "?" + query
        : window.location.pathname
    );
  }, [
    search,
    statusFilter,
    channelFilter,
    tagFilter,
    replyFilter,
    unreadFilter,
    daysFilter,
    assignedFilter,
    starredFilter,
    oldestFirst,
  ]);

  const refresh = useCallback(async () => {
    try {
      const filtersKey = [
        searchRef.current,
        statusRef.current,
        intentRef.current,
        channelRef.current,
        tagRef.current,
        replyFilterRef.current,
        oldestRef.current ? "oldest" : "",
        assignedRef.current,
        daysRef.current,
        unreadRef.current,
        starredRef.current,
      ].join("|");
      if (filtersKey !== lastKeyRef.current) {
        pageRef.current = 1;
        lastKeyRef.current = filtersKey;
      }
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
      if (starredRef.current) listParams.set("starred", starredRef.current);
      if (pageRef.current > 1) listParams.set("page", String(pageRef.current));
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
        counts?: {
          needsReply?: number;
          overdue?: number;
          unassigned?: number;
          unread?: number;
        };
        error?: { code?: string };
      } | null;
      if (!mounted.current || !payload) return;
      if (Array.isArray(payload.conversations)) {
        const incoming = payload.conversations;
        setItems((current) => {
          if (!appendRef.current || !current) return incoming;
          const seen = new Set(current.map((item) => item.id));
          return [...current, ...incoming.filter((item) => !seen.has(item.id))];
        });
        appendRef.current = false;
        setPending(false);
        setSyncedAt(new Date());
        if (payload.counts) {
          setChipCounts({
            needsReply: payload.counts.needsReply || 0,
            overdue: payload.counts.overdue || 0,
            unassigned: payload.counts.unassigned || 0,
            unread: payload.counts.unread || 0,
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
    if (urlFilters.get("starred") === "1") {
      starredRef.current = "1";
      setStarredFilter("1");
    }
    const statusParam = urlFilters.get("status");
    if (statusParam === "open" || statusParam === "closed") {
      statusRef.current = statusParam;
      setStatusFilter(statusParam);
    }
    if (urlFilters.get("needs_reply") === "1") {
      replyFilterRef.current = "1";
      setReplyFilter("1");
    }
    if (urlFilters.get("unread") === "1") {
      unreadRef.current = "1";
      setUnreadFilter("1");
    }
    const daysParam = urlFilters.get("days");
    if (daysParam === "1" || daysParam === "7" || daysParam === "30") {
      daysRef.current = daysParam;
      setDaysFilter(daysParam);
    }
    if (urlFilters.get("sort") === "oldest") {
      oldestRef.current = true;
      setOldestFirst(true);
    }
    const assignedParam = urlFilters.get("assigned");
    if (assignedParam === "me" || assignedParam === "unassigned") {
      assignedRef.current = assignedParam;
      setAssignedFilter(assignedParam);
    }
    const channelParam = urlFilters.get("channel");
    if (channelParam === "whatsapp" || channelParam === "website") {
      channelRef.current = channelParam;
      setChannelFilter(channelParam);
    }
    const tagParam = urlFilters.get("tag");
    if (tagParam) {
      tagRef.current = tagParam;
      setTagFilter(tagParam);
    }
    try {
      setAlertEnabled(window.localStorage.getItem("ofl_desktop_alert") === "1");
    } catch {
      // Storage unavailable.
    }
    try {
      setSoundEnabled(window.localStorage.getItem("ofl_sound") === "1");
    } catch {
      // Storage unavailable.
    }
    void refresh();
    const timer = window.setInterval(() => {
      if (liveModeRef.current && document.visibilityState === "visible")
        void refresh();
    }, POLL_MS);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setHelpOpen(false);
        return;
      }
      if (event.key !== "?") return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      setHelpOpen((open) => !open);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
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

  async function toggleConversationStatus(id: number, status: string) {
    if (bulkBusy) return;
    setBulkBusy(true);
    try {
      const response = await fetch("/api/omniflow/portal/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          action: status === "open" ? "close" : "reopen",
          ids: [id],
        }),
      });
      if (response.ok) void refresh();
    } catch {
      // Transient network issue, the list updates on the next poll.
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkAction(action: string, assigneeEmail?: string) {
    if (bulkBusy || selectedIds.length === 0) return;
    if (
      !window.confirm(
        "This will " +
          action +
          " " +
          selectedIds.length +
          " conversation" +
          (selectedIds.length === 1 ? "" : "s") +
          ". Continue?"
      )
    ) {
      return;
    }
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

  async function toggleStar(conversationId: number) {
    setItems((current) =>
      current
        ? current.map((item) =>
            item.id === conversationId ? { ...item, starred: !item.starred } : item
          )
        : current
    );
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/" + conversationId + "/star",
        { method: "POST", credentials: "same-origin" }
      );
      if (!response.ok) void refresh();
    } catch {
      void refresh();
    }
  }

  function toggleSound() {
    const next = !soundEnabled;
    setSoundEnabled(next);
    try {
      window.localStorage.setItem("ofl_sound", next ? "1" : "0");
    } catch {
      // Storage can be unavailable in private modes.
    }
  }

  async function toggleAlert() {
    const next = !alertEnabled;
    setAlertEnabled(next);
    try {
      window.localStorage.setItem("ofl_desktop_alert", next ? "1" : "0");
    } catch {
      // Storage can be unavailable in private modes.
    }
    if (
      next &&
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      try {
        await Notification.requestPermission();
      } catch {
        // Permission prompt unavailable.
      }
    }
  }

  useEffect(() => {
    const total = chipCounts.unread + chipCounts.needsReply;
    if (total > alertTotalRef.current && document.hidden) {
      if (
        alertEnabled &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        try {
          new Notification("New customer message", {
            body: "Open the inbox to reply.",
          });
        } catch {
          // Notifications unavailable in this browser.
        }
      }
      if (soundEnabled) {
        try {
          const AudioContextCtor =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext;
          if (AudioContextCtor) {
            const chime = new AudioContextCtor();
            const oscillator = chime.createOscillator();
            const gain = chime.createGain();
            oscillator.type = "sine";
            oscillator.frequency.value = 880;
            gain.gain.setValueAtTime(0.05, chime.currentTime);
            gain.gain.exponentialRampToValueAtTime(
              0.0001,
              chime.currentTime + 0.4
            );
            oscillator.connect(gain);
            gain.connect(chime.destination);
            oscillator.start();
            oscillator.stop(chime.currentTime + 0.4);
            oscillator.onended = () => void chime.close();
          }
        } catch {
          // Audio playback unavailable.
        }
      }
    }
    alertTotalRef.current = total;
  }, [chipCounts, alertEnabled, soundEnabled]);

  async function markAllRead() {
    if (bulkBusy) return;
    setBulkBusy(true);
    try {
      const response = await fetch("/api/omniflow/portal/conversations/read-all", {
        method: "POST",
        credentials: "same-origin",
      });
      if (response.ok) void refresh();
    } catch {
      // Transient network issue, the user can retry.
    } finally {
      setBulkBusy(false);
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (event.key === "/" && !typing) {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
      if (
        event.key === "Escape" &&
        typing &&
        target === searchInputRef.current
      ) {
        searchInputRef.current?.blur();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function resetFilters() {
    searchRef.current = "";
    setSearch("");
    statusRef.current = "all";
    setStatusFilter("all");
    intentRef.current = "all";
    setIntentFilter("all");
    channelRef.current = "all";
    setChannelFilter("all");
    tagRef.current = "all";
    setTagFilter("all");
    replyFilterRef.current = "";
    setReplyFilter("");
    oldestRef.current = false;
    setOldestFirst(false);
    assignedRef.current = "";
    setAssignedFilter("");
    daysRef.current = "";
    setDaysFilter("");
    unreadRef.current = "";
    setUnreadFilter("");
    starredRef.current = "";
    setStarredFilter("");
    void refresh();
  }

  async function exportCsv(selectedIds?: number[]) {
    if (exporting || (selectedIds && selectedIds.length === 0)) return;
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
      if (starredRef.current) params.set("starred", starredRef.current);
      if (selectedIds) params.set("ids", selectedIds.join(","));
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
      link.download = selectedIds
        ? "omniflow-conversations-selected.csv"
        : "omniflow-conversations.csv";
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
          ref={searchInputRef}
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
        <button
          type="button"
          onClick={() => {
            const next = starredFilter === "1" ? "" : "1";
            starredRef.current = next;
            setStarredFilter(next);
            void refresh();
          }}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            starredFilter === "1"
              ? "border-amber-400/30 bg-amber-400/[0.08] text-amber-200"
              : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white"
          }`}
        >
          Starred
        </button>
        <button
          type="button"
          onClick={() => resetFilters()}
          title="Clear every filter and sort back to the default view"
          className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-slate-400 transition-colors hover:text-white"
        >
          Reset
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
          onClick={() => toggleSound()}
          title={
            soundEnabled
              ? "Notification sound is on"
              : "Play a sound when new customer messages arrive"
          }
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors duration-300 ${
            soundEnabled
              ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
              : "border-white/[0.08] bg-white/[0.02] text-slate-300 hover:text-white"
          }`}
        >
          {soundEnabled ? "Sound on" : "Sound off"}
        </button>
        <button
          type="button"
          onClick={() => {
            const next = !liveMode;
            setLiveMode(next);
            liveModeRef.current = next;
          }}
          title={
            liveMode
              ? "The inbox refreshes itself"
              : "Auto-refresh is paused - click Resume to go live again"
          }
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors duration-300 ${
            liveMode
              ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
              : "border-white/[0.08] bg-white/[0.02] text-slate-300 hover:text-white"
          }`}
        >
          {liveMode ? "Live" : "Paused"}
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={pending}
          title="Refresh now"
          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:text-white disabled:opacity-40"
        >
          {pending ? "Refreshing" : "Refresh"}
        </button>
        <span className="text-[10px] text-slate-600">
          {syncedAt ? "Updated " + syncedAt.toLocaleTimeString() : ""}
        </span>
        <button
          type="button"
          onClick={() => setHelpOpen((open) => !open)}
          title="Keyboard shortcuts"
          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:text-white"
        >
          ?
        </button>
        <button
          type="button"
          onClick={() => void toggleAlert()}
          title={
            alertEnabled
              ? "Desktop alerts are on"
              : "Get a desktop alert when new customer messages arrive"
          }
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors duration-300 ${
            alertEnabled
              ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
              : "border-white/[0.08] bg-white/[0.02] text-slate-300 hover:text-white"
          }`}
        >
          {alertEnabled ? "Alerts on" : "Alerts off"}
        </button>
        <button
          type="button"
          onClick={() => void markAllRead()}
          disabled={bulkBusy || !chipCounts.unread}
          title="Mark every open conversation as read"
          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors duration-300 hover:text-white disabled:opacity-40"
        >
          Mark all read
        </button>
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
            onClick={() => setSelectedIds((items ?? []).map((item) => item.id))}
            disabled={bulkBusy}
            title="Select every conversation in the current view"
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:text-white disabled:opacity-40"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds([])}
            disabled={bulkBusy}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:text-white disabled:opacity-40"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => void exportCsv(selectedIds)}
            disabled={bulkBusy || exporting}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:text-white disabled:opacity-40"
          >
            Export selected
          </button>
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
            <li
              key={item.id}
              data-conv-row={item.id}
              className={
                "flex items-start gap-2 rounded-2xl " +
                (item.needsReply && item.status === "open"
                  ? "border-l-2 border-l-amber-400/60 "
                  : "") +
                (activeRowIndex >= 0 && items[activeRowIndex]?.id === item.id
                  ? "ring-1 ring-cyan-400/40"
                  : "")
              }
            >
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
                      {item.contactId ? (
                        <button
                          type="button"
                          onClick={() =>
                            void navigator.clipboard.writeText(item.contactId ?? "")
                          }
                          title="Copy number"
                          className="truncate text-left text-xs text-slate-500 transition-colors hover:text-slate-300"
                        >
                          {item.contactId}
                        </button>
                      ) : (
                        <p className="truncate text-xs text-slate-500">—</p>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      aria-label="Toggle star"
                      onClick={() => void toggleStar(item.id)}
                      className={`text-base leading-none transition-transform hover:scale-110 ${
                        item.starred
                          ? "text-amber-300"
                          : "text-slate-600 hover:text-slate-400"
                      }`}
                    >
                      {item.starred ? "\u2605" : "\u2606"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void toggleConversationStatus(item.id, item.status)}
                      title={
                        item.status === "open"
                          ? "Close this conversation"
                          : "Reopen this conversation"
                      }
                      className="rounded-md border border-white/[0.08] bg-white/[0.02] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-400 transition-colors hover:text-white"
                    >
                      {item.status === "open" ? "Close" : "Reopen"}
                    </button>
                    <div className="text-right">
                    <span
                      className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                        item.status === "open"
                          ? "border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-300"
                          : "border-white/[0.06] bg-white/[0.02] text-slate-500"
                      }`}
                    >
                      {item.status}
                    </span>
                    <p className="mt-1 flex items-center justify-end gap-1 text-[10px] text-slate-600">
                      <span
                        className={
                          "inline-block h-1.5 w-1.5 rounded-full " +
                          (item.channel === "whatsapp"
                            ? "bg-emerald-400"
                            : "bg-cyan-400")
                        }
                      />
                      {item.channel}
                    </p>
                    <p
                      className={`mt-1 text-[10px] ${
                        item.needsReply && item.status === "open" && item.lastMessageAt
                          ? "text-amber-300/80"
                          : "text-slate-600"
                      }`}
                    >
                      {item.needsReply && item.status === "open" && item.lastMessageAt
                        ? "waiting " + waitingLabel(item.lastMessageAt)
                        : formatTime(item.lastMessageAt)}
                    </p>
                    </div>
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
      {helpOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setHelpOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-white/[0.08] bg-[#0b1829] p-5"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-sm font-semibold text-white">
              Keyboard shortcuts
            </h2>
            <ul className="mt-3 space-y-2 text-xs text-slate-300">
              <li className="flex items-center justify-between gap-6">
                <span>Focus search</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">/</kbd>
              </li>
              <li className="flex items-center justify-between gap-6">
                <span>Move down / up the list</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">j / k</kbd>
              </li>
              <li className="flex items-center justify-between gap-6">
                <span>Open the highlighted chat</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">Enter</kbd>
              </li>
              <li className="flex items-center justify-between gap-6">
                <span>Back to the inbox (inside a chat)</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">Esc</kbd>
              </li>
              <li className="flex items-center justify-between gap-6">
                <span>Toggle the needs-reply view</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">r</kbd>
              </li>
              <li className="flex items-center justify-between gap-6">
                <span>Toggle assigned-to-me</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">a</kbd>
              </li>
              <li className="flex items-center justify-between gap-6">
                <span>Toggle the starred view</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">s</kbd>
              </li>
              <li className="flex items-center justify-between gap-6">
                <span>Open or close this panel</span>
                <kbd className="rounded border border-white/[0.12] px-1.5 py-0.5 text-[10px]">?</kbd>
              </li>
            </ul>
            <button
              type="button"
              onClick={() => setHelpOpen(false)}
              className="mt-4 w-full rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-xs font-medium text-slate-300 transition-colors hover:text-white"
            >
              Got it
            </button>
          </div>
        </div>
      )}
      {items && items.length >= 50 && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => {
              appendRef.current = true;
              pageRef.current += 1;
              void refresh();
            }}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-1.5 text-xs font-medium text-slate-300 transition-colors duration-300 hover:text-white"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
