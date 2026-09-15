"use client";

import { useCallback, useEffect, useState } from "react";

interface SegmentFilters {
  lead_temp?: string;
  status?: string;
  stage?: string;
  idle_days?: number;
  tag?: string;
}

interface Segment {
  id: number;
  name: string;
  filters: SegmentFilters;
  memberCount: number;
}

interface Member {
  contactId: string;
  name: string;
  chats: number;
  lastAt: string | null;
}

const LEAD_OPTIONS = [
  { value: "", label: "Any lead temperature" },
  { value: "hot", label: "Hot leads" },
  { value: "warm", label: "Warm leads" },
  { value: "cold", label: "Cold leads" },
];

const STATUS_OPTIONS = [
  { value: "", label: "Any chat status" },
  { value: "open", label: "Has an open chat" },
  { value: "closed", label: "Only closed chats" },
];

const STAGE_OPTIONS = [
  { value: "", label: "Any pipeline stage" },
  { value: "new", label: "Stage: New" },
  { value: "interested", label: "Stage: Interested" },
  { value: "negotiating", label: "Stage: Negotiating" },
  { value: "won", label: "Stage: Won" },
  { value: "lost", label: "Stage: Lost" },
];

function describe(filters: SegmentFilters): string {
  const parts: string[] = [];
  if (filters.lead_temp) parts.push(filters.lead_temp + " leads");
  if (filters.status === "open") parts.push("open chat");
  if (filters.status === "closed") parts.push("closed chats");
  if (filters.stage) parts.push("stage: " + filters.stage);
  if (filters.idle_days) parts.push("quiet for " + filters.idle_days + "d");
  if (filters.tag) parts.push("tagged " + filters.tag);
  return parts.join(" \u00b7 ");
}

export default function SegmentsPage() {
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [name, setName] = useState("");
  const [leadTemp, setLeadTemp] = useState("");
  const [status, setStatus] = useState("");
  const [stage, setStage] = useState("");
  const [idleDays, setIdleDays] = useState("");
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [noteTone, setNoteTone] = useState("neutral");
  const [openMembers, setOpenMembers] = useState<number | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [castOpenFor, setCastOpenFor] = useState<number | null>(null);
  const [castDraft, setCastDraft] = useState("");
  const [castBusy, setCastBusy] = useState(false);
  const [castNote, setCastNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/segments", {
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (payload !== null && typeof payload === "object") {
        const list = (payload as { segments?: Segment[] }).segments;
        setSegments(Array.isArray(list) ? list : []);
      }
    } catch {
      setSegments([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(async () => {
    if (busy) return;
    const filters: SegmentFilters = {};
    if (leadTemp) filters.lead_temp = leadTemp;
    if (status) filters.status = status;
    if (stage) filters.stage = stage;
    if (idleDays) {
      const days = Number(idleDays);
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        setNoteTone("amber");
        setNote("Idle days must be 1-365.");
        return;
      }
      filters.idle_days = days;
    }
    if (tag.trim()) filters.tag = tag.trim();
    if (!name.trim() || Object.keys(filters).length === 0) {
      setNoteTone("amber");
      setNote("Give the segment a name and at least one filter.");
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/segments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), filters }),
      });
      if (response.ok) {
        setNoteTone("emerald");
        setNote("Segment saved. Counts update live.");
        setName("");
        setLeadTemp("");
        setStatus("");
        setIdleDays("");
        setTag("");
        void load();
        return;
      }
      setNoteTone("amber");
      setNote("Could not save. Check the filters.");
    } catch {
      setNoteTone("amber");
      setNote("Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, idleDays, leadTemp, load, name, status, tag]);

  const showMembers = useCallback(
    async (id: number) => {
      if (openMembers === id) {
        setOpenMembers(null);
        return;
      }
      setOpenMembers(id);
      setMembers([]);
      try {
        const response = await fetch(
          "/api/omniflow/portal/segments/" + String(id) + "/members",
          { cache: "no-store" }
        );
        const payload: unknown = await response.json().catch(() => null);
        if (payload !== null && typeof payload === "object") {
          const list = (payload as { members?: Member[] }).members;
          setMembers(Array.isArray(list) ? list : []);
        }
      } catch {
        setMembers([]);
      }
    },
    [openMembers]
  );

  const remove = useCallback(
    async (row: Segment) => {
      setBusy(true);
      try {
        await fetch("/api/omniflow/portal/segments/" + String(row.id), {
          method: "DELETE",
        });
        void load();
      } catch {
        void load();
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  const openCast = useCallback((row: Segment) => {
    setCastOpenFor(row.id);
    setCastDraft("");
    setCastNote(null);
  }, []);

  const sendCast = useCallback(
    async (row: Segment) => {
      if (castBusy || !castDraft.trim()) return;
      setCastBusy(true);
      setCastNote(null);
      try {
        const response = await fetch(
          "/api/omniflow/portal/segments/" + String(row.id) + "/broadcast",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body: castDraft.trim() }),
          }
        );
        const payload = (await response.json().catch(() => null)) as {
          sent?: number;
        } | null;
        if (response.ok && payload && typeof payload.sent === "number") {
          setCastOpenFor(null);
          setNoteTone("emerald");
          setNote("Broadcast queued to " + payload.sent + " member(s).");
          void load();
          return;
        }
        setCastNote(
          response.status === 400
            ? "No members match this segment right now."
            : "Could not send. Try again."
        );
      } catch {
        setCastNote("Could not send. Try again.");
      } finally {
        setCastBusy(false);
      }
    },
    [castBusy, castDraft, load]
  );

  return (
    <main className="min-h-screen bg-[#07111f] px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-400/70">
            OmniFlow
          </p>
          <h1 className="text-2xl font-semibold text-white">Segments</h1>
          <p className="mt-1 text-sm text-slate-500">
            Save customer groups with simple filters, then message the whole
            group. Counts stay live.
          </p>
        </div>

        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5">
          <p className="text-sm font-medium text-slate-200">New segment</p>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Group name, e.g. Hot leads gone quiet"
            className="mt-3 w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
          />
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <select
              value={leadTemp}
              onChange={(event) => setLeadTemp(event.target.value)}
              className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-400/40"
            >
              {LEAD_OPTIONS.map((option) => (
                <option key={option.value} value={option.value} className="bg-slate-900">
                  {option.label}
                </option>
              ))}
            </select>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-400/40"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value} className="bg-slate-900">
                  {option.label}
                </option>
              ))}
            </select>
            <select
              value={stage}
              onChange={(event) => setStage(event.target.value)}
              className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-400/40"
            >
              {STAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value} className="bg-slate-900">
                  {option.label}
                </option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              max={365}
              value={idleDays}
              onChange={(event) => setIdleDays(event.target.value)}
              placeholder="Quiet for N days (optional)"
              className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-600 outline-none focus:border-cyan-400/40"
            />
            <input
              value={tag}
              onChange={(event) => setTag(event.target.value)}
              placeholder="Tagged with (optional)"
              className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-600 outline-none focus:border-cyan-400/40"
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void create()}
              disabled={busy}
              className="rounded-xl bg-cyan-400/15 px-4 py-2 text-sm font-medium text-cyan-200 transition hover:bg-cyan-400/25 disabled:opacity-50"
            >
              {busy ? "Working\u2026" : "Save segment"}
            </button>
            {note ? (
              <p
                className={
                  "text-xs " +
                  (noteTone === "emerald" ? "text-emerald-300" : "text-amber-300")
                }
              >
                {note}
              </p>
            ) : null}
          </div>
        </div>

        {segments === null ? (
          <p className="text-sm text-slate-500">Loading\u2026</p>
        ) : segments.length === 0 ? (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] px-5 py-8 text-center">
            <p className="text-sm text-slate-400">No segments yet.</p>
            <p className="mt-1 text-xs text-slate-600">
              Save your first group above \u2014 hot leads, quiet customers, tagged VIPs.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {segments.map((row) => (
              <li
                key={row.id}
                className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-200">
                      {row.name}
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {describe(row.filters) || "No filters"} \u00b7{" "}
                      <span className="text-cyan-300">{row.memberCount}</span>{" "}
                      member{row.memberCount === 1 ? "" : "s"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void showMembers(row.id)}
                      className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
                    >
                      {openMembers === row.id ? "Hide people" : "People"}
                    </button>
                    <button
                      type="button"
                      onClick={() => openCast(row)}
                      className="rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] px-3 py-1.5 text-xs font-medium text-cyan-200 transition hover:bg-cyan-400/[0.14]"
                    >
                      Send broadcast
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(row)}
                      className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:border-rose-400/40 hover:text-rose-300"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {openMembers === row.id ? (
                  <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.01] p-3">
                    {members.length === 0 ? (
                      <p className="text-xs text-slate-500">
                        No members match right now.
                      </p>
                    ) : (
                      <ul className="space-y-1.5">
                        {members.map((member) => (
                          <li
                            key={member.contactId}
                            className="flex items-center justify-between gap-2 text-xs"
                          >
                            <span className="truncate text-slate-300">
                              {member.name || "Customer"}
                            </span>
                            <span className="shrink-0 text-slate-500">
                              {member.chats} chat{member.chats === 1 ? "" : "s"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
                {castOpenFor === row.id ? (
                  <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.01] p-3">
                    <p className="text-[11px] uppercase tracking-wider text-slate-500">
                      Message everyone in {row.name}
                    </p>
                    <textarea
                      value={castDraft}
                      onChange={(event) => setCastDraft(event.target.value)}
                      rows={2}
                      maxLength={1000}
                      placeholder="Use {name} for the customer's first name."
                      className="mt-2 w-full rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-sm text-white placeholder:text-slate-600 outline-none focus:border-cyan-400/40"
                    />
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void sendCast(row)}
                        disabled={castBusy}
                        className="rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] px-3 py-1.5 text-xs font-medium text-cyan-200 transition hover:bg-cyan-400/[0.14] disabled:opacity-50"
                      >
                        {castBusy ? "Sending..." : "Send now"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setCastOpenFor(null)}
                        className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
                      >
                        Close
                      </button>
                      {castNote ? (
                        <p className="text-xs text-amber-300">{castNote}</p>
                      ) : null}
                    </div>
                    <p className="mt-2 text-[10px] text-slate-600">
                      Delivered through your WhatsApp queue, up to 200 members per
                      send.
                    </p>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
