"use client";

import { useCallback, useEffect, useState } from "react";

interface TeamMember {
  id: number;
  email: string;
  name: string;
  role: "owner" | "admin" | "agent";
  status: string;
}

interface PerfMember {
  id: number;
  name: string;
  email: string;
  role: "owner" | "admin" | "agent";
  repliesSent: number;
  conversationsTouched: number;
  notesAdded: number;
  assignedOpen: number;
}

interface PerfData {
  windowDays: number;
  members: PerfMember[];
  board: {
    openConversations: number;
    unassignedOpen: number;
    repliesSent: number;
    csatAvg: number | null;
    csatAnswered: number;
    csatDist: number[];
    csatLow: { score: number; count: number }[];
    csatRecent: { score: number; at: string }[];
  };
}

function perfStatClass(value: number): string {
  return value > 0 ? "text-ink" : "text-ink-3";
}

const inputClass =
  "w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder-slate-400 outline-none transition-colors duration-300 focus:border-brand/40";

const primaryBtn =
  "rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors duration-300 hover:bg-brand-soft disabled:opacity-50";

function roleChipClass(role: string): string {
  if (role === "owner") {
    return "border-brand/25 bg-brand-soft text-brand";
  }
  if (role === "admin") {
    return "border-violet-400/25 bg-violet-400/[0.08] text-ai";
  }
  return "border-line bg-soft text-ink-3";
}

export default function TeamClient({
  initialMembers,
  initialRole,
}: {
  initialMembers?: TeamMember[] | null;
  initialRole?: string | null;
}) {
  const [members, setMembers] = useState<TeamMember[]>(initialMembers ?? []);
  const [myRole, setMyRole] = useState<string | null>(initialRole ?? null);
  const [loading, setLoading] = useState(initialMembers === null);
  const [expired, setExpired] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("agent");
  const [busy, setBusy] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<number | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );
  const [perf, setPerf] = useState<PerfData | null>(null);

  const canManage = myRole === "owner" || myRole === "admin";

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const response = await fetch("/api/omniflow/portal/team", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        setExpired(true);
        return;
      }
      if (!response.ok) {
        setLoadError(true);
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        members?: TeamMember[];
        myRole?: string | null;
      } | null;
      if (payload) {
        setMembers(Array.isArray(payload.members) ? payload.members : []);
        setMyRole(
          payload.myRole === "owner" || payload.myRole === "admin" || payload.myRole === "agent"
            ? payload.myRole
            : null
        );
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPerf = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/team/performance", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        setExpired(true);
        return;
      }
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as PerfData | null;
      if (payload && Array.isArray(payload.members)) setPerf(payload);
    } catch {
      // Performance is additive — never block the team page on it.
    }
  }, []);

  useEffect(() => {
    void load();
    void loadPerf();
  }, [load, loadPerf]);

  async function addMember() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name: name.trim(), email: email.trim(), role }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({ kind: "ok", text: "Teammate added." });
        setName("");
        setEmail("");
        setRole("agent");
        await load();
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not add the teammate. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  async function patchMember(memberId: number, patch: Record<string, string>) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/team/" + String(memberId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(patch),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        await load();
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not update the teammate. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(memberId: number) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/team/" + String(memberId), {
        method: "DELETE",
        credentials: "same-origin",
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({ kind: "ok", text: "Teammate removed." });
        setConfirmRemoveId(null);
        await load();
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not remove the teammate. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  if (expired) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="rounded-2xl border border-line bg-soft px-6 py-12 text-center">
          <p className="text-sm text-ink-2">Your session expired.</p>
          <a
            href="/dashboard/reauth"
            className="mt-3 inline-block text-xs text-brand transition-colors hover:text-brand"
          >
            Re-authenticate →
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Team</h1>
        <p className="mt-1 text-sm text-ink-3">
          Add teammates, assign conversations and keep internal notes — notes
          are never sent to customers.
        </p>
      </div>

      {perf && (
        <div className="rounded-2xl border border-line bg-soft p-4 sm:p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-3">
              Performance
            </h2>
            <span className="text-[10px] text-ink-3">
              Last {perf.windowDays} {perf.windowDays === 1 ? "day" : "days"}
            </span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-xl border border-line bg-white/[0.01] px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-wider text-ink-3">
                Open chats
              </p>
              <p className={"mt-0.5 text-lg font-semibold " + perfStatClass(perf.board.openConversations)}>
                {perf.board.openConversations}
              </p>
            </div>
            <div className="rounded-xl border border-line bg-white/[0.01] px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-wider text-ink-3">
                Unassigned
              </p>
              <p className={"mt-0.5 text-lg font-semibold " + perfStatClass(perf.board.unassignedOpen)}>
                {perf.board.unassignedOpen}
              </p>
            </div>
            <div className="rounded-xl border border-line bg-white/[0.01] px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-wider text-ink-3">
                Team replies
              </p>
              <p className={"mt-0.5 text-lg font-semibold " + perfStatClass(perf.board.repliesSent)}>
                {perf.board.repliesSent}
              </p>
            </div>
            <div className="rounded-xl border border-line bg-white/[0.01] px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-wider text-ink-3">
                CSAT avg
              </p>
              <p className="mt-0.5 text-lg font-semibold text-ink">
                {perf.board.csatAvg !== null ? perf.board.csatAvg.toFixed(1) : "—"}
                <span className="ml-1 text-[10px] font-normal text-ink-3">
                  {perf.board.csatAnswered > 0
                    ? "(" + perf.board.csatAnswered + ")"
                    : ""}
                </span>
              </p>
            </div>
          </div>
          {perf.board.csatAnswered > 0 && (
            <div className="mt-3">
              <div className="flex h-2 w-full overflow-hidden rounded-full bg-soft">
                {[0, 1, 2, 3, 4].map((index) => {
                  const share =
                    (perf.board.csatDist[index] / perf.board.csatAnswered) * 100;
                  const colors = [
                    "bg-red-400/70",
                    "bg-orange-400/70",
                    "bg-yellow-400/70",
                    "bg-lime-400/70",
                    "bg-emerald-400/70",
                  ];
                  return share > 0 ? (
                    <div
                      key={"star-" + String(index)}
                      className={colors[index]}
                      style={{ width: share + "%" }}
                    />
                  ) : null;
                })}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-ink-3">
                {[1, 2, 3, 4, 5].map((star) => (
                  <span key={"star-label-" + String(star)}>
                    {star}★ {perf.board.csatDist[star - 1]}
                  </span>
                ))}
              </div>
              {perf.board.csatLow.length > 0 && (
                <p className="mt-2 text-[11px] text-danger">
                  {perf.board.csatLow
                    .map((bucket) => bucket.count + "× " + bucket.score + "★")
                    .join(", ")}
                  {" "}— worth a personal follow-up.
                </p>
              )}
              {perf.board.csatRecent.length > 0 && (
                <p className="mt-1 text-[10px] text-ink-3">
                  Latest:{" "}
                  {perf.board.csatRecent
                    .map(
                      (entry) =>
                        entry.score + "★ · " + entry.at.slice(0, 10)
                    )
                    .join("  ")}
                </p>
              )}
            </div>
          )}
          {perf.members.length > 0 && (
            <ul className="mt-3 space-y-2">
              {perf.members.map((member) => (
                <li
                  key={"perf-" + String(member.id)}
                  className="rounded-xl border border-line bg-white/[0.01] p-3"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-soft text-xs font-semibold text-ink-2">
                        {(member.name || member.email).slice(0, 1).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-ink">
                          {member.name || member.email}
                          {member.role === "owner" && (
                            <span className="ml-1.5 text-[9px] font-semibold uppercase tracking-wider text-brand">
                              owner
                            </span>
                          )}
                        </p>
                        <p className="truncate text-[10px] text-ink-3">
                          {member.email}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-3 sm:justify-end">
                      <span>
                        <span className={perfStatClass(member.repliesSent) + " font-semibold"}>
                          {member.repliesSent}
                        </span>{" "}
                        replies
                      </span>
                      <span>
                        <span className={perfStatClass(member.conversationsTouched) + " font-semibold"}>
                          {member.conversationsTouched}
                        </span>{" "}
                        chats touched
                      </span>
                      <span>
                        <span className={perfStatClass(member.notesAdded) + " font-semibold"}>
                          {member.notesAdded}
                        </span>{" "}
                        notes
                      </span>
                      <span>
                        <span className={perfStatClass(member.assignedOpen) + " font-semibold"}>
                          {member.assignedOpen}
                        </span>{" "}
                        assigned
                      </span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {canManage && (
        <div className="rounded-2xl border border-line bg-soft p-4 sm:p-5">
          <h2 className="text-xs font-semibold text-ink">Add teammate</h2>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Name (e.g. Ahmed)"
              maxLength={80}
              className={inputClass}
            />
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Email (e.g. ali@gmail.com)"
              maxLength={120}
              type="email"
              className={inputClass}
            />
            <select
              value={role}
              onChange={(event) => setRole(event.target.value)}
              className={inputClass}
            >
              <option value="agent">Agent — assigned chats + notes</option>
              <option value="admin">Admin — manages the team too</option>
            </select>
            <button
              type="button"
              onClick={addMember}
              disabled={busy || !email.trim()}
              className={primaryBtn + " w-full sm:w-auto sm:justify-self-end"}
            >
              {busy ? "Working…" : "Add teammate"}
            </button>
          </div>
        </div>
      )}

      {message && (
        <p
          className={
            "mt-4 text-xs " +
            (message.kind === "ok" ? "text-ok" : "text-danger")
          }
        >
          {message.text}
        </p>
      )}

      <div className="mt-6">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-3">
          Members
        </h2>
        {loading ? (
          <div className="mt-3 animate-pulse space-y-3">
            <div className="h-16 rounded-2xl border border-line bg-soft" />
            <div className="h-16 rounded-2xl border border-line bg-soft" />
          </div>
        ) : loadError ? (
          <div className="mt-3 rounded-2xl border border-line bg-soft px-5 py-6 text-center">
            <p className="text-sm text-ink-2">
              The team module is rolling out on the server — try again in a
              couple of minutes.
            </p>
          </div>
        ) : (
          <ul className="mt-3 space-y-3">
            {members.map((member) => {
              const locked = member.role === "owner";
              return (
                <li
                  key={member.id}
                  className="rounded-2xl border border-line bg-soft p-4"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-soft text-sm font-semibold text-ink-2">
                        {(member.name || member.email).slice(0, 1).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-ink">
                          {member.name || member.email}
                        </p>
                        <p className="truncate text-[11px] text-ink-3">{member.email}</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={
                          "rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider " +
                          roleChipClass(member.role)
                        }
                      >
                        {member.role}
                      </span>
                      <span
                        className={
                          "rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider " +
                          (member.status === "active"
                            ? "border-emerald-400/20 bg-emerald-400/[0.06] text-ok"
                            : "border-line bg-soft text-ink-3")
                        }
                      >
                        {member.status}
                      </span>
                    </div>
                  </div>
                  {canManage && !locked && (
                    <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3 sm:flex-row sm:items-center sm:justify-end">
                      <select
                        value={member.role}
                        onChange={(event) =>
                          patchMember(member.id, { role: event.target.value })
                        }
                        disabled={busy}
                        className="w-full rounded-xl border border-line bg-soft px-3 py-2 text-xs text-ink outline-none transition-colors duration-300 focus:border-brand/40 disabled:opacity-50 sm:w-44"
                      >
                        <option value="agent">Agent</option>
                        <option value="admin">Admin</option>
                      </select>
                      <button
                        type="button"
                        onClick={() =>
                          patchMember(member.id, {
                            status: member.status === "active" ? "disabled" : "active",
                          })
                        }
                        disabled={busy}
                        className="w-full rounded-xl border border-line bg-soft px-4 py-2 text-xs font-medium text-ink-2 transition-colors duration-300 hover:bg-soft disabled:opacity-50 sm:w-auto"
                      >
                        {member.status === "active" ? "Disable" : "Enable"}
                      </button>
                      {confirmRemoveId === member.id ? (
                        <button
                          type="button"
                          onClick={() => removeMember(member.id)}
                          disabled={busy}
                          className="w-full rounded-xl border border-red-400/25 bg-red-400/[0.08] px-4 py-2 text-xs font-medium text-danger transition-colors duration-300 hover:bg-red-400/[0.14] disabled:opacity-50 sm:w-auto"
                        >
                          Confirm remove
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmRemoveId(member.id)}
                          disabled={busy}
                          className="w-full rounded-xl border border-line bg-soft px-4 py-2 text-xs font-medium text-ink-3 transition-colors duration-300 hover:border-red-400/25 hover:text-danger disabled:opacity-50 sm:w-auto"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-6 rounded-2xl border border-line bg-soft p-4 sm:p-5">
        <h2 className="text-xs font-semibold text-ink">How roles work</h2>
        <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-ink-3">
          <li>
            <span className="font-semibold text-ink-2">Owner</span> — you.
            Manages the team; the owner seat cannot be removed by mistake.
          </li>
          <li>
            <span className="font-semibold text-ink-2">Admin</span> — can
            also add/remove teammates and change roles.
          </li>
          <li>
            <span className="font-semibold text-ink-2">Agent</span> — works
            conversations: assignment and internal notes.
          </li>
        </ul>
      </div>
    </div>
  );
}
