"use client";

import { useCallback, useEffect, useState } from "react";

type Weekday = { value: number; label: string };

const FALLBACK_WEEKDAYS: Weekday[] = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 7, label: "Sunday" },
];

export default function WeeklyProblemsCard() {
  const [enabled, setEnabled] = useState(false);
  const [hour, setHour] = useState(9);
  const [weekday, setWeekday] = useState(1);
  const [weekdays, setWeekdays] = useState<Weekday[]>(FALLBACK_WEEKDAYS);
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/bi/weekly-problems", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        settings?: {
          enabled?: boolean;
          hour?: number;
          weekday?: number;
          last_sent_date?: string | null;
        };
        weekdays?: Weekday[];
      } | null;
      const s = payload?.settings;
      if (!s) return;
      setEnabled(s.enabled === true);
      setHour(typeof s.hour === "number" ? s.hour : 9);
      setWeekday(typeof s.weekday === "number" ? s.weekday : 1);
      if (Array.isArray(payload?.weekdays) && payload!.weekdays!.length) {
        setWeekdays(payload!.weekdays!);
      }
      setLastSent(
        typeof s.last_sent_date === "string" && s.last_sent_date
          ? s.last_sent_date
          : null
      );
    } catch {
      // Transient network issue.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/bi/weekly-problems", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          settings: { enabled, hour, weekday },
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        settings?: {
          enabled?: boolean;
          hour?: number;
          weekday?: number;
          last_sent_date?: string | null;
        };
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        setNote(
          payload?.error?.message ||
            "Could not save right now. Try again shortly."
        );
        return;
      }
      if (payload?.settings) {
        setEnabled(payload.settings.enabled === true);
        if (typeof payload.settings.hour === "number") {
          setHour(payload.settings.hour);
        }
        if (typeof payload.settings.weekday === "number") {
          setWeekday(payload.settings.weekday);
        }
      }
      setNote(
        enabled
          ? "Saved. You will get a weekly problems email on the day and hour you picked (also needs Notifications email on)."
          : "Saved. The weekly problems email is off."
      );
    } catch {
      setNote("Could not save right now. Try again shortly.");
    } finally {
      setSaving(false);
    }
  }

  async function sendNow() {
    setSending(true);
    setNote("");
    try {
      const response = await fetch(
        "/api/omniflow/portal/bi/weekly-problems/send",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        title?: string;
        problem_counts?: { critical?: number; warn?: number };
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        setNote(
          payload?.error?.message ||
            "Could not send right now. Try again shortly."
        );
        return;
      }
      const crit = payload?.problem_counts?.critical ?? 0;
      const warn = payload?.problem_counts?.warn ?? 0;
      setNote(
        (payload?.title || "Weekly summary sent.") +
          " (" +
          crit +
          " critical, " +
          warn +
          " warn)"
      );
    } catch {
      setNote("Could not send right now. Try again shortly.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mt-6 rounded-xl2 border border-line bg-white p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Weekly problems email</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">
            Once a week, get a short email of what the problem detector flagged
            (knowledge gaps, handoffs, delivery issues, and more). Off by
            default. Delivery uses your Notifications email settings.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => setEnabled((prev) => !prev)}
          className={
            "rounded-lg border px-2.5 py-1 text-[11px] " +
            (enabled
              ? "border-emerald-400/25 bg-emerald-400/[0.08] text-ok"
              : "border-line bg-soft text-ink-3")
          }
        >
          {enabled ? "Email on" : "Email off"}
        </button>
      </div>

      {!loaded ? (
        <p className="mt-4 text-xs text-ink-3">Loading schedule...</p>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block text-xs text-ink-2">
            <span className="mb-1 block">Day of week</span>
            <select
              value={weekday}
              onChange={(event) =>
                setWeekday(Number(event.target.value) || 1)
              }
              className="w-full rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none focus:border-brand/40"
            >
              {weekdays.map((day) => (
                <option key={day.value} value={day.value}>
                  {day.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-ink-2">
            <span className="mb-1 block">Send after (hour, 6-21)</span>
            <input
              type="number"
              min={6}
              max={21}
              value={hour}
              onChange={(event) =>
                setHour(Number(event.target.value) || 0)
              }
              className="w-full rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none focus:border-brand/40"
            />
          </label>
        </div>
      )}

      {lastSent ? (
        <p className="mt-3 text-[11px] text-ink-3">
          Last automatic send: {lastSent}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={saving || !loaded}
          onClick={() => void save()}
          className="rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save"}
        </button>
        <button
          type="button"
          disabled={sending || !loaded}
          onClick={() => void sendNow()}
          className="rounded-xl border border-line bg-white px-3 py-2 text-xs font-medium text-ink-2 transition-colors hover:border-line-2 disabled:opacity-50"
        >
          {sending ? "Sending..." : "Send test now"}
        </button>
        {note ? <span className="text-xs text-ink-2">{note}</span> : null}
      </div>
    </div>
  );
}
