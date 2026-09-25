"use client";

import { useCallback, useEffect, useState } from "react";

interface ScheduledRow {
  id: number;
  audience: string;
  body: string;
  recipientCount: number;
  sendAt: string;
}

const AUDIENCES = [
  { value: "all", label: "All customers" },
  { value: "open", label: "Open chats" },
  { value: "hot", label: "Hot leads" },
];

function formatWhen(value: string): string {
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

function minLocalValue(): string {
  const soon = new Date(Date.now() + 10 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    String(soon.getFullYear()) +
    "-" + pad(soon.getMonth() + 1) +
    "-" + pad(soon.getDate()) +
    "T" + pad(soon.getHours()) +
    ":" + pad(soon.getMinutes())
  );
}

interface SegmentOption {
  id: number;
  name: string;
}

export default function ScheduleCard() {
  const [rows, setRows] = useState<ScheduledRow[]>([]);
  const [segmentList, setSegmentList] = useState<SegmentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [audience, setAudience] = useState("all");
  const [body, setBody] = useState("");
  const [when, setWhen] = useState("");
  const [note, setNote] = useState("");
  const [noteTone, setNoteTone] = useState("neutral");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/omniflow/portal/broadcasts/schedule", {
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);
      const list =
        payload !== null && typeof payload === "object"
          ? (payload as { scheduled?: unknown }).scheduled
          : null;
      setRows(
        Array.isArray(list)
          ? list.filter(
              (row): row is ScheduledRow =>
                row !== null &&
                typeof row === "object" &&
                typeof (row as ScheduledRow).id === "number"
            )
          : []
      );
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/omniflow/portal/segments", {
          cache: "no-store",
        });
        const payload: unknown = await response.json().catch(() => null);
        const list =
          payload !== null && typeof payload === "object"
            ? (payload as { segments?: unknown }).segments
            : null;
        if (cancelled) return;
        setSegmentList(
          Array.isArray(list)
            ? list
                .filter(
                  (row): row is Record<string, unknown> =>
                    row !== null && typeof row === "object"
                )
                .filter(
                  (row) =>
                    typeof row.id === "number" && typeof row.name === "string"
                )
                .map((row) => ({
                  id: row.id as number,
                  name: row.name as string,
                }))
                .slice(0, 30)
            : []
        );
      } catch {
        if (!cancelled) setSegmentList([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = useCallback(async () => {
    if (!body.trim() || !when) {
      setNoteTone("amber");
      setNote("Write the message and pick a future time.");
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/broadcasts/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audience, body, send_at: new Date(when).toISOString() }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.ok) {
        setNoteTone("emerald");
        setNote("Scheduled. It will send on its own.");
        setBody("");
        setWhen("");
        void load();
        return;
      }
      const code =
        payload !== null && typeof payload === "object"
          ? ((payload as { error?: { code?: string } }).error?.code ?? "")
          : "";
      setNoteTone("amber");
      if (code === "no_recipients") setNote("No customers match this audience yet.");
      else if (code === "too_many_recipients") setNote("More than 200 customers match — narrow the audience.");
      else if (code === "bad_request") setNote("Pick a valid future time (within 30 days).");
      else setNote("Could not schedule right now. Try again.");
    } catch {
      setNoteTone("amber");
      setNote("Could not schedule right now. Try again.");
    } finally {
      setBusy(false);
    }
  }, [audience, body, when, load]);

  const cancel = useCallback(
    async (id: number) => {
      setBusy(true);
      try {
        const response = await fetch(
          "/api/omniflow/portal/broadcasts/schedule/" + String(id),
          { method: "DELETE" }
        );
        if (response.ok) {
          setNoteTone("emerald");
          setNote("Cancelled.");
          void load();
        } else {
          setNoteTone("amber");
          setNote("Could not cancel. It may have already sent.");
        }
      } catch {
        setNoteTone("amber");
        setNote("Could not cancel. Try again.");
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  return (
    <div className="mb-5 rounded-2xl border border-cyan-400/15 bg-cyan-400/[0.025] p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-ink">Schedule for later</h2>
      <p className="mt-1 text-xs text-ink-3">
        Queue a broadcast for a future date and time. It sends automatically, as long as your
        connector laptop is online.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <select
          value={audience}
          onChange={(event) => setAudience(event.target.value)}
          className="w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink outline-none transition-colors duration-300 focus:border-brand/40"
        >
          {AUDIENCES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
          {segmentList.length > 0 ? (
            <optgroup label="Saved segments">
              {segmentList.map((segment) => (
                <option key={"segment:" + String(segment.id)} value={"segment:" + String(segment.id)}>
                  Segment: {segment.name}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        <input
          type="datetime-local"
          value={when}
          min={minLocalValue()}
          onChange={(event) => setWhen(event.target.value)}
          className="w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink outline-none transition-colors duration-300 focus:border-brand/40"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className="w-full rounded-xl bg-cyan-400/15 px-4 py-2.5 text-sm font-medium text-brand transition hover:bg-cyan-400/25 disabled:opacity-50"
        >
          {busy ? "Working…" : "Schedule broadcast"}
        </button>
      </div>

      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={2}
        maxLength={1000}
        placeholder={"Use {name} and it becomes each customer's first name."}
        className="mt-3 w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-3 outline-none transition-colors duration-300 focus:border-brand/40"
      />

      {note ? (
        <p
          className={
            "mt-2 text-xs " +
            (noteTone === "emerald" ? "text-ok" : "text-amber-600")
          }
        >
          {note}
        </p>
      ) : null}

      <div className="mt-4">
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-ink-3">
          Pending schedule
        </p>
        {loading ? (
          <p className="text-sm text-ink-3">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-ink-3">Nothing scheduled yet.</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-2 rounded-xl border border-line bg-soft px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">{row.body}</p>
                  <p className="mt-0.5 text-[11px] text-ink-3">
                    {formatWhen(row.sendAt)} \u00b7 {row.audience} \u00b7 {row.recipientCount} customers
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void cancel(row.id)}
                  disabled={busy}
                  className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 transition hover:border-rose-400/40 hover:text-danger disabled:opacity-50"
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
