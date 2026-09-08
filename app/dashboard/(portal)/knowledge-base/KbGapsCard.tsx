"use client";

import { useCallback, useEffect, useState } from "react";

interface GapEntry {
  id: number;
  conversationId: number;
  question: string;
  intent: string;
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

export default function KbGapsCard() {
  const [gaps, setGaps] = useState<GapEntry[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/kb/gaps", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        gaps?: GapEntry[];
        openCount?: number;
      } | null;
      if (payload && Array.isArray(payload.gaps)) {
        setGaps(payload.gaps);
        setOpenCount(typeof payload.openCount === "number" ? payload.openCount : 0);
        setLoaded(true);
      }
    } catch {
      // Transient network issue — reopening the page retries.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(gapId: number) {
    if (busyId !== null) return;
    setBusyId(gapId);
    try {
      const response = await fetch("/api/omniflow/portal/kb/gaps/" + String(gapId), {
        method: "PATCH",
        credentials: "same-origin",
      });
      if (response.ok) {
        setGaps((current) => current.filter((gap) => gap.id !== gapId));
        setOpenCount((count) => Math.max(0, count - 1));
      }
    } catch {
      // Leave the gap in place — the next load retries.
    } finally {
      setBusyId(null);
    }
  }

  if (!loaded || (openCount === 0 && gaps.length === 0)) return null;

  return (
    <div className="mb-6 rounded-2xl border border-amber-400/15 bg-amber-400/[0.03] p-4 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-xs font-semibold text-white">
          Knowledge gaps
          <span className="ml-2 rounded-md border border-amber-400/25 bg-amber-400/[0.08] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300">
            {String(openCount)} open
          </span>
        </h2>
        <p className="text-[11px] text-slate-500">
          Customer questions no KB entry could answer — add an answer, then
          resolve.
        </p>
      </div>
      <ul className="mt-3 space-y-2">
        {gaps.slice(0, 5).map((gap) => (
          <li
            key={gap.id}
            className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="break-words text-xs text-slate-200">{gap.question}</p>
                <p className="mt-0.5 text-[10px] uppercase tracking-wider text-slate-600">
                  {gap.intent.replace(/_/g, " ")}
                  {gap.createdAt ? " · " + formatWhen(gap.createdAt) : ""}
                  {" · "}
                  <a
                    href={"/dashboard/conversations/" + String(gap.conversationId)}
                    className="text-cyan-300/80 transition-colors hover:text-cyan-200"
                  >
                    open chat
                  </a>
                </p>
              </div>
              <button
                type="button"
                onClick={() => resolve(gap.id)}
                disabled={busyId !== null}
                className="w-full shrink-0 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-[11px] font-medium text-slate-300 transition-colors duration-300 hover:bg-white/[0.05] disabled:opacity-50 sm:w-auto"
              >
                {busyId === gap.id ? "…" : "Resolve"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
