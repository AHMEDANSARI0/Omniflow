"use client";

import { useCallback, useEffect, useState } from "react";

interface PortalAlert {
  id: number;
  kind: string;
  severity: string;
  title: string;
  detail: string;
  is_read: boolean;
  created_at: string | null;
}

function formatWhen(value: string | null): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Dashboard bell: unread failure-alert badge + a small dropdown with the
 * recent alerts. Polls every 60s; alerts come from the Control Plane
 * (dead deliveries and other revenue-critical failures).
 */
export default function AlertsBell() {
  const [alerts, setAlerts] = useState<PortalAlert[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [alertsOn, setAlertsOn] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/alerts", {
        cache: "no-store",
      });
      if (response.ok) {
        const payload = (await response.json()) as {
          alerts?: PortalAlert[];
          unread?: number;
        };
        setAlerts(payload.alerts ?? []);
        setUnread(payload.unread ?? 0);
      }
    } catch {
      /* keep the last known state */
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  async function markAll() {
    setBusy(true);
    try {
      await fetch("/api/omniflow/portal/alerts/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function toggleAlerts() {
    setBusy(true);
    const next = !alertsOn;
    try {
      const response = await fetch("/api/omniflow/portal/alerts/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (response.ok) {
        setAlertsOn(next);
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-label="Alerts"
        className="relative flex h-9 w-9 items-center justify-center rounded-xl text-ink-3 transition-colors duration-200 hover:bg-soft hover:text-ink"
      >
        <span aria-hidden>(&#8977;)</span>
        {unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-semibold text-ink">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="absolute bottom-10 right-0 z-50 w-80 rounded-2xl border border-line bg-white p-3 shadow-2xl">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-ink">Alerts</p>
            <div className="flex gap-2 text-[10px]">
              <button
                onClick={() => void markAll()}
                disabled={busy || unread === 0}
                className="text-brand hover:underline disabled:opacity-40"
              >
                Mark all read
              </button>
              <button
                onClick={() => void toggleAlerts()}
                disabled={busy}
                className="text-ink-3 hover:underline disabled:opacity-40"
              >
                {alertsOn ? "Turn off" : "Turn on"}
              </button>
            </div>
          </div>
          <div className="mt-2 max-h-72 space-y-1.5 overflow-y-auto">
            {alerts.length === 0 ? (
              <p className="rounded-xl border border-line px-3 py-4 text-center text-[11px] text-ink-3">
                All clear — no failure alerts.
              </p>
            ) : (
              alerts.map((alert) => (
                <div
                  key={alert.id}
                  className={
                    "rounded-xl border px-3 py-2 " +
                    (alert.is_read
                      ? "border-line bg-transparent"
                      : "border-line-2 bg-soft")
                  }
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-xs text-ink">
                      {alert.severity === "revenue" ? (
                        <span className="mr-1 text-danger">&#9679;</span>
                      ) : null}
                      {alert.title}
                    </p>
                    <span className="shrink-0 text-[9px] text-ink-3">
                      {formatWhen(alert.created_at)}
                    </span>
                  </div>
                  {alert.detail ? (
                    <p className="mt-0.5 truncate text-[10px] text-ink-3">
                      {alert.detail}
                    </p>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
