"use client";

import { useCallback, useEffect, useState } from "react";

interface Webhook {
  id: number;
  url: string;
  events: string;
  enabled: boolean;
  lastStatusCode: number | null;
}

interface Delivery {
  id: number;
  event: string;
  statusCode: number | null;
  error: string | null;
  attempts: number;
  createdAt: string | null;
  deliveredAt: string | null;
}

const EVENT_OPTIONS = [
  { value: "cod", label: "COD confirmed / declined" },
  { value: "broadcast", label: "Broadcast sent" },
];

function eventsLabel(events: string): string {
  return events === "all" ? "All events" : events.split(",").join(" + ");
}

export default function IntegrationsPage() {
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
  const [url, setUrl] = useState("");
  const [picked, setPicked] = useState<string[]>(["cod", "broadcast"]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [noteTone, setNoteTone] = useState("neutral");
  const [newSecret, setNewSecret] = useState("");
  const [openLog, setOpenLog] = useState<number | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/webhooks", {
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (payload !== null && typeof payload === "object") {
        const list = (payload as { webhooks?: Webhook[] }).webhooks;
        setWebhooks(Array.isArray(list) ? list : []);
      }
    } catch {
      setWebhooks([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleEvent = (value: string) => {
    setPicked((current) =>
      current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value]
    );
  };

  const create = useCallback(async () => {
    if (!url.trim().startsWith("https://")) {
      setNoteTone("amber");
      setNote("Enter an https:// URL.");
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          events: picked.length === 0 ? "all" : picked.join(","),
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || payload === null || typeof payload !== "object") {
        setNoteTone("amber");
        setNote("Could not add the endpoint. Check the URL.");
        return;
      }
      const secret = (payload as { secret?: string }).secret;
      if (typeof secret === "string" && secret) {
        setNewSecret(secret);
        setNoteTone("emerald");
        setNote("Endpoint added. Copy the signing secret now - it is shown once.");
      } else {
        setNoteTone("emerald");
        setNote("Endpoint added.");
      }
      setUrl("");
      void load();
    } catch {
      setNoteTone("amber");
      setNote("Could not add the endpoint. Try again.");
    } finally {
      setBusy(false);
    }
  }, [url, picked, load]);

  const setEnabled = useCallback(
    async (row: Webhook, enabled: boolean) => {
      setBusy(true);
      try {
        await fetch("/api/omniflow/portal/webhooks/" + String(row.id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
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

  const remove = useCallback(
    async (row: Webhook) => {
      setBusy(true);
      try {
        await fetch("/api/omniflow/portal/webhooks/" + String(row.id), {
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

  const showLog = useCallback(async (id: number) => {
    if (openLog === id) {
      setOpenLog(null);
      return;
    }
    setOpenLog(id);
    setDeliveries([]);
    try {
      const response = await fetch(
        "/api/omniflow/portal/webhooks/" + String(id) + "/deliveries",
        { cache: "no-store" }
      );
      const payload: unknown = await response.json().catch(() => null);
      if (payload !== null && typeof payload === "object") {
        const list = (payload as { deliveries?: Delivery[] }).deliveries;
        setDeliveries(Array.isArray(list) ? list : []);
      }
    } catch {
      setDeliveries([]);
    }
  }, [openLog]);

  return (
    <main className="min-h-screen bg-[#07111f] px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-400/70">
            Workspace
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-white">Integrations</h1>
          <p className="mt-1.5 text-sm text-slate-400">
            Get OmniFlow events pushed to your own endpoint - Google Sheets
            bridges, Zapier, or your own tools. Every request is signed.
          </p>
        </div>

        <div className="mb-6 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-white">Add an endpoint</h2>
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://your-service.example.com/omniflow"
            className="mt-3 w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            {EVENT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={picked.includes(option.value)}
                onClick={() => toggleEvent(option.value)}
                className={
                  "rounded-lg border px-3 py-1.5 text-xs font-medium transition " +
                  (picked.includes(option.value)
                    ? "border-cyan-400/30 bg-cyan-400/[0.08] text-cyan-200"
                    : "border-white/[0.06] bg-white/[0.02] text-slate-400 hover:text-white")
                }
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void create()}
              disabled={busy}
              className="rounded-xl bg-cyan-400/15 px-4 py-2 text-sm font-medium text-cyan-200 transition hover:bg-cyan-400/25 disabled:opacity-50"
            >
              {busy ? "Working\u2026" : "Add endpoint"}
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
          {newSecret ? (
            <div className="mt-3 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] px-3.5 py-3">
              <p className="text-[11px] uppercase tracking-wider text-emerald-300/80">
                Signing secret (shown once)
              </p>
              <code className="mt-1 block break-all font-mono text-xs text-emerald-200">
                {newSecret}
              </code>
            </div>
          ) : null}
        </div>

        {webhooks === null ? (
          <p className="text-sm text-slate-500">Loading\u2026</p>
        ) : webhooks.length === 0 ? (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] px-5 py-8 text-center">
            <p className="text-sm text-slate-400">No endpoints yet.</p>
            <p className="mt-1 text-xs text-slate-600">
              Add one above and COD or broadcast events will arrive there signed.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {webhooks.map((row) => (
              <li
                key={row.id}
                className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-slate-200">{row.url}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {eventsLabel(row.events)}
                      {row.lastStatusCode !== null
                        ? " \u00b7 last status " + String(row.lastStatusCode)
                        : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void setEnabled(row, !row.enabled)}
                      className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
                    >
                      {row.enabled ? "Pause" : "Resume"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void showLog(row.id)}
                      className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
                    >
                      {openLog === row.id ? "Hide log" : "Deliveries"}
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
                {openLog === row.id ? (
                  <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.01] p-3">
                    {deliveries.length === 0 ? (
                      <p className="text-xs text-slate-500">No deliveries yet.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {deliveries.map((delivery) => (
                          <li
                            key={delivery.id}
                            className="flex items-center justify-between gap-2 text-xs"
                          >
                            <span className="text-slate-300">{delivery.event}</span>
                            <span
                              className={
                                delivery.deliveredAt
                                  ? "text-emerald-300"
                                  : "text-amber-300"
                              }
                            >
                              {delivery.deliveredAt
                                ? "delivered"
                                : "retry " + String(delivery.attempts)}
                              {delivery.statusCode
                                ? " \u00b7 " + String(delivery.statusCode)
                                : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
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
