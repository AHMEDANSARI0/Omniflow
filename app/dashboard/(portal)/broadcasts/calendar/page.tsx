"use client";

import { useCallback, useEffect, useState } from "react";

interface CalendarItem {
  id: number;
  day: string;
  audience: string;
  body: string;
  recipients: number;
  scheduled: boolean;
}

interface CalendarData {
  month: string;
  days: { date: string; sent: number; scheduled: number }[];
  items: CalendarItem[];
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function shiftMonth(month: string, delta: number): string {
  const [year, mon] = month.split("-").map(Number);
  const total = year * 12 + (mon - 1) + delta;
  const nextYear = Math.floor(total / 12);
  const nextMon = (total % 12) + 1;
  return nextYear + "-" + String(nextMon).padStart(2, "0");
}

function monthTitle(month: string): string {
  const stamp = Date.parse(month + "-01T00:00:00Z");
  if (Number.isNaN(stamp)) return month;
  return new Intl.DateTimeFormat("en", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(stamp);
}

function gridFor(month: string): (string | null)[] {
  const first = Date.parse(month + "-01T00:00:00Z");
  if (Number.isNaN(first)) return [];
  const start = new Date(first);
  const startWeekday = (start.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(
    start.getUTCFullYear(),
    start.getUTCMonth() + 1,
    0
  ).getUTCDate();
  const cells: (string | null)[] = Array(startWeekday).fill(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(month + "-" + String(day).padStart(2, "0"));
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export default function BroadcastCalendarPage() {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [data, setData] = useState<CalendarData | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (target: string) => {
    setFailed(false);
    try {
      const response = await fetch(
        "/api/omniflow/portal/insights/calendar?month=" +
          encodeURIComponent(target),
        { credentials: "same-origin", cache: "no-store" }
      );
      if (!response.ok) {
        setFailed(true);
        setData(null);
        return;
      }
      const payload = (await response.json().catch(() => null)) as
        | (CalendarData & { items?: CalendarItem[] })
        | null;
      if (payload && typeof payload === "object" && Array.isArray(payload.items)) {
        setData({
          month: payload.month ?? target,
          days: Array.isArray(payload.days) ? payload.days : [],
          items: payload.items,
        });
      } else {
        setFailed(true);
        setData(null);
      }
    } catch {
      setFailed(true);
      setData(null);
    }
  }, []);

  useEffect(() => {
    void load(month);
  }, [load, month]);

  const byDay = new Map<string, { sent: number; scheduled: number }>();
  for (const day of data?.days ?? []) byDay.set(day.date, day);

  return (
    <main className="min-h-screen bg-canvas px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink">
              Broadcast calendar
            </h1>
            <p className="mt-1 text-sm text-ink-3">
              Sent and scheduled broadcasts by day.
            </p>
          </div>
          <a
            href="/dashboard/broadcasts"
            className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-3 transition hover:text-ink"
          >
            Back
          </a>
        </div>

        <div className="mt-4 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setMonth((current) => shiftMonth(current, -1))}
            className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 transition hover:text-ink"
          >
            \\u2190 Prev
          </button>
          <p className="text-sm font-medium text-ink">{monthTitle(month)}</p>
          <button
            type="button"
            onClick={() => setMonth((current) => shiftMonth(current, 1))}
            className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 transition hover:text-ink"
          >
            Next \\u2192
          </button>
        </div>

        {failed ? (
          <p className="mt-6 text-sm text-ink-3">
            The calendar is unavailable right now.
          </p>
        ) : data === null ? (
          <p className="mt-6 text-sm text-ink-3">Loading\\u2026</p>
        ) : (
          <>
            <div className="mt-4 grid grid-cols-7 gap-1 text-center">
              {WEEKDAYS.map((label) => (
                <p key={label} className="pb-1 text-[10px] uppercase text-ink-3">
                  {label}
                </p>
              ))}
              {gridFor(month).map((date, index) => {
                if (date === null) {
                  return <div key={"pad" + index} className="min-h-16" />;
                }
                const entry = byDay.get(date);
                const dayNumber = Number(date.slice(8, 10));
                return (
                  <div
                    key={date}
                    className="min-h-16 rounded-lg border border-line bg-white/[0.01] p-1"
                  >
                    <p className="text-[10px] text-ink-3">{dayNumber}</p>
                    {entry && entry.sent > 0 ? (
                      <p className="mt-0.5 rounded bg-emerald-400/10 px-0.5 text-[9px] text-ok">
                        {entry.sent} sent
                      </p>
                    ) : null}
                    {entry && entry.scheduled > 0 ? (
                      <p className="mt-0.5 rounded bg-amber-400/10 px-0.5 text-[9px] text-amber-600">
                        {entry.scheduled} queued
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {data.items.length > 0 ? (
              <section className="mt-4 rounded-2xl border border-line bg-soft p-4">
                <p className="text-xs font-semibold text-ink">This month</p>
                <ul className="mt-2 space-y-1.5">
                  {data.items.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="truncate text-ink-2">
                        {item.day.slice(8, 10)}
                        {" \\u00b7 "}
                        {item.body || "(no text)"}
                      </span>
                      <span
                        className={
                          "shrink-0 " +
                          (item.scheduled ? "text-amber-600" : "text-ok")
                        }
                      >
                        {item.scheduled ? "queued" : "sent"} \\u00b7 {item.recipients}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}
