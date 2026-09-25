"use client";

import { useCallback, useEffect, useState } from "react";

interface BusinessHoursDay {
  enabled: boolean;
  start: string;
  end: string;
}

interface BusinessHoursConfig {
  enabled: boolean;
  timezone: string;
  days: BusinessHoursDay[];
  away_message: string;
  away_message_ur?: string;
  away_message_roman?: string;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const DEFAULT_CONFIG: BusinessHoursConfig = {
  enabled: false,
  timezone: "Asia/Karachi",
  days: DAY_LABELS.map(() => ({ enabled: true, start: "09:00", end: "17:00" })),
  away_message:
    "Thanks for your message! Our team is currently offline. We will reply during business hours.",
};

function isOpenNow(config: BusinessHoursConfig): boolean {
  if (!config.enabled) return true;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: config.timezone,
      hour12: false,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date());
    const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
    const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
    const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
    const day = config.days[DAY_LABELS.indexOf(weekday)];
    if (!day || !day.enabled) return false;
    const now = hour.padStart(2, "0") + ":" + minute;
    return now >= day.start && now <= day.end;
  } catch {
    return true;
  }
}

export default function BusinessHoursCard() {
  const [config, setConfig] = useState<BusinessHoursConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/business-hours", {
        credentials: "same-origin",
      });
      const payload = (await response.json()) as {
        business_hours?: BusinessHoursConfig;
      };
      if (payload.business_hours) setConfig(payload.business_hours);
    } catch {
      // Transient network issue, the card can be reloaded.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function patchDay(index: number, patch: Partial<BusinessHoursDay>) {
    setConfig((current) => {
      if (!current) return current;
      const days = current.days.map((day, dayIndex) =>
        dayIndex === index ? { ...day, ...patch } : day
      );
      return { ...current, days };
    });
  }

  async function save() {
    if (!config || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/omniflow/portal/business-hours", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ business_hours: config }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: { message?: string };
      };
      if (response.ok && payload.ok) {
        setNotice("Business hours saved.");
      } else {
        setNotice(payload.error?.message ?? "The save did not go through.");
      }
    } catch {
      setNotice("The save did not go through. Check the connection.");
    } finally {
      setBusy(false);
    }
  }

  if (!config) {
    return (
      <section className="rounded-2xl border border-line bg-soft p-5">
        <h2 className="text-sm font-semibold text-ink">Business hours</h2>
        <p className="mt-2 text-xs text-ink-3">Loading…</p>
      </section>
    );
  }

  const open = isOpenNow(config);

  return (
    <section className="rounded-2xl border border-line bg-soft p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">Business hours</h2>
        {config.enabled && (
          <span
            className={
              "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider " +
              (open
                ? "border-emerald-400/25 bg-emerald-400/[0.08] text-ok"
                : "border-amber-400/25 bg-amber-400/[0.08] text-amber-600")
            }
          >
            {open ? "Open now" : "Closed now"}
          </span>
        )}
      </div>
      <label className="mt-4 flex items-center gap-3 text-xs text-ink-2">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(event) =>
            setConfig({ ...config, enabled: event.target.checked })
          }
          className="h-4 w-4 accent-cyan-400"
        />
        Enabled outside these hours, show an away message to customers
      </label>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-ink-3">
          Timezone (IANA name)
          <input
            value={config.timezone}
            onChange={(event) =>
              setConfig({ ...config, timezone: event.target.value })
            }
            className="mt-1 w-full rounded-xl border border-line bg-soft px-3 py-2 text-xs text-ink outline-none transition-colors duration-300 focus:border-brand/40"
          />
        </label>
        <label className="block text-xs text-ink-3">
          Away message
          <textarea
            value={config.away_message}
            onChange={(event) =>
              setConfig({ ...config, away_message: event.target.value })
            }
            rows={3}
            maxLength={500}
            className="mt-1 w-full resize-none rounded-xl border border-line bg-soft px-3 py-2 text-xs text-ink outline-none transition-colors duration-300 focus:border-brand/40"
          />
        </label>
        <label className="block text-xs text-ink-3">
          Away message — Urdu (optional, sent to customers who write in Urdu
          script)
          <textarea
            value={config.away_message_ur ?? ""}
            onChange={(event) =>
              setConfig({ ...config, away_message_ur: event.target.value })
            }
            rows={2}
            maxLength={500}
            placeholder="اگر خالی چھوڑا تو انگریزی والا پیغام جائے گا"
            className="mt-1 w-full resize-none rounded-xl border border-line bg-soft px-3 py-2 text-xs text-ink outline-none transition-colors duration-300 focus:border-brand/40"
          />
        </label>
        <label className="block text-xs text-ink-3">
          Away message — Roman Urdu (optional, sent to customers who write
          Roman Urdu)
          <textarea
            value={config.away_message_roman ?? ""}
            onChange={(event) =>
              setConfig({ ...config, away_message_roman: event.target.value })
            }
            rows={2}
            maxLength={500}
            placeholder="Khali chhora to English wala message jayega"
            className="mt-1 w-full resize-none rounded-xl border border-line bg-soft px-3 py-2 text-xs text-ink outline-none transition-colors duration-300 focus:border-brand/40"
          />
        </label>
      </div>
      <div className="mt-4 space-y-2">
        {config.days.map((day, index) => (
          <div
            key={DAY_LABELS[index]}
            className="flex items-center gap-3 text-xs text-ink-2"
          >
            <input
              type="checkbox"
              checked={day.enabled}
              onChange={(event) =>
                patchDay(index, { enabled: event.target.checked })
              }
              className="h-4 w-4 accent-cyan-400"
            />
            <span className="w-10 font-medium">{DAY_LABELS[index]}</span>
            <input
              type="time"
              value={day.start}
              disabled={!day.enabled}
              onChange={(event) => patchDay(index, { start: event.target.value })}
              className="rounded-lg border border-line bg-soft px-2 py-1 text-xs text-ink outline-none disabled:opacity-40"
            />
            <span className="text-ink-3">to</span>
            <input
              type="time"
              value={day.end}
              disabled={!day.enabled}
              onChange={(event) => patchDay(index, { end: event.target.value })}
              className="rounded-lg border border-line bg-soft px-2 py-1 text-xs text-ink outline-none disabled:opacity-40"
            />
          </div>
        ))}
      </div>
      {notice && <p className="mt-3 text-[11px] text-amber-600">{notice}</p>}
      <button
        type="button"
        onClick={() => void save()}
        disabled={busy}
        className="mt-4 rounded-xl bg-cyan-400 px-5 py-2 text-xs font-semibold text-[#07111f] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Saving…" : "Save business hours"}
      </button>
    </section>
  );
}
