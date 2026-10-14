"use client";

import { useCallback, useEffect, useState } from "react";

interface Webhook {
  id: number;
  url: string;
  events: string;
  enabled: boolean;
  lastStatusCode: number | null;
  deadCount: number;
}

interface Delivery {
  id: number;
  event: string;
  statusCode: number | null;
  error: string | null;
  attempts: number;
  createdAt: string | null;
  deliveredAt: string | null;
  dead: boolean;
}

interface EventCategory {
  key: string;
  label: string;
  events: number;
}

function eventsLabel(events: string, categories: EventCategory[]): string {
  if (events === "all") return "All events";
  return events
    .split(",")
    .map((key) => categories.find((item) => item.key === key)?.label ?? key)
    .join(" + ");
}

export default function IntegrationsPage() {
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
  const [url, setUrl] = useState("");
  // event categories come from the Control Plane catalog; none picked = all
  const [categories, setCategories] = useState<EventCategory[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [noteTone, setNoteTone] = useState("neutral");
  const [newSecret, setNewSecret] = useState("");
  const [openLog, setOpenLog] = useState<number | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [testBusy, setTestBusy] = useState(false);
  const [testNote, setTestNote] = useState<string | null>(null);

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

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/omniflow/portal/events/catalog", {
          cache: "no-store",
        });
        const payload = (await response.json().catch(() => null)) as {
          categories?: EventCategory[];
        } | null;
        if (response.ok && payload && Array.isArray(payload.categories)) {
          setCategories(payload.categories);
        }
      } catch {
        // Catalog unavailable: endpoints can still be added for all events.
      }
    })();
  }, []);

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

  const runTest = useCallback(
    async (row: Webhook) => {
      if (testBusy) return;
      setTestBusy(true);
      setTestNote(null);
      try {
        const response = await fetch(
          "/api/omniflow/portal/webhooks/" + String(row.id) + "/test",
          { method: "POST" }
        );
        const payload = (await response.json().catch(() => null)) as {
          delivered?: boolean;
          status_code?: number | null;
          error?: string | null;
        } | null;
        if (response.ok && payload && typeof payload.delivered === "boolean") {
          const status = payload.status_code
            ? " (status " + String(payload.status_code) + ")"
            : "";
          setTestNote(
            payload.delivered
              ? "Test delivered" + status
              : "Test failed" + status + (payload.error ? ": " + payload.error : "")
          );
          if (openLog === row.id) void showLog(row.id);
        } else {
          setTestNote("Test could not run.");
        }
      } catch {
        setTestNote("Test could not run.");
      } finally {
        setTestBusy(false);
      }
    },
    [testBusy, openLog, showLog]
  );

  const replayDead = useCallback(
    async (row: Webhook) => {
      setBusy(true);
      try {
        const response = await fetch(
          "/api/omniflow/portal/webhooks/" + String(row.id) +
            "/deliveries/replay-dead",
          { method: "POST" }
        );
        const payload = (await response.json().catch(() => null)) as {
          replayed?: number;
        } | null;
        setTestNote(
          response.ok && payload && typeof payload.replayed === "number"
            ? String(payload.replayed) + " failed deliveries queued again."
            : "Could not queue the failed deliveries."
        );
      } catch {
        setTestNote("Could not queue the failed deliveries.");
      } finally {
        setBusy(false);
      }
      void load();
      if (openLog === row.id) void showLog(row.id);
    },
    [load, openLog, showLog]
  );

  const retryDelivery = useCallback(
    async (webhookId: number, deliveryId: number) => {
      try {
        await fetch(
          "/api/omniflow/portal/webhooks/" + String(webhookId) +
            "/deliveries/" + String(deliveryId) + "/retry",
          { method: "POST" }
        );
      } catch {
        // Transient network issue — the log refresh shows the outcome.
      }
      void showLog(webhookId);
    },
    [showLog]
  );

  return (
    <main className="min-h-screen bg-canvas px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-brand">
            Workspace
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Integrations</h1>
          <p className="mt-1.5 text-sm text-ink-2">
            Get OmniFlow events pushed to your own endpoint - Google Sheets
            bridges, Zapier, or your own tools. Every request is signed.
          </p>
        </div>

        <div className="mb-6 rounded-2xl border border-line bg-white shadow-card p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-ink">Add an endpoint</h2>
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://your-service.example.com/omniflow"
            className="mt-3 w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-3 outline-none transition-colors duration-300 focus:border-brand/40"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            {categories.map((option) => (
              <button
                key={option.key}
                type="button"
                aria-pressed={picked.includes(option.key)}
                onClick={() => toggleEvent(option.key)}
                className={
                  "rounded-lg border inline-flex min-h-9 items-center px-3 py-1.5 text-xs font-medium transition " +
                  (picked.includes(option.key)
                    ? "border-brand/30 bg-brand-soft text-brand"
                    : "border-line bg-soft text-ink-3 hover:text-ink")
                }
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-ink-3">
            {picked.length === 0
              ? "No category picked: the endpoint receives every event."
              : "Only the picked categories are sent."}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void create()}
              disabled={busy}
              className="rounded-xl bg-brand/15 px-4 py-2 text-sm font-medium text-brand transition hover:bg-brand/25 disabled:opacity-50"
            >
              {busy ? "Working\u2026" : "Add endpoint"}
            </button>
            {note ? (
              <p
                className={
                  "text-xs " +
                  (noteTone === "emerald" ? "text-ok" : "text-amber-700")
                }
              >
                {note}
              </p>
            ) : null}
          </div>
          {newSecret ? (
            <div className="mt-3 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] px-3.5 py-3">
              <p className="text-[11px] uppercase tracking-wider text-ok">
                Signing secret (shown once)
              </p>
              <code className="mt-1 block break-all font-mono text-xs text-ok">
                {newSecret}
              </code>
            </div>
          ) : null}
        </div>

        {webhooks === null ? (
          <p className="text-sm text-ink-3">Loading{"\u2026"}</p>
        ) : webhooks.length === 0 ? (
          <div className="rounded-2xl border border-line bg-white shadow-card px-5 py-8 text-center">
            <p className="text-sm text-ink-3">No endpoints yet.</p>
            <p className="mt-1 text-xs text-ink-3">
              Add one above and the events you pick will arrive there signed.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {webhooks.map((row) => (
              <li
                key={row.id}
                className="rounded-2xl border border-line bg-white shadow-card p-4"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">{row.url}</p>
                    <p className="mt-0.5 text-[11px] text-ink-3">
                      {eventsLabel(row.events, categories)}
                      {row.lastStatusCode !== null
                        ? " \u00b7 last status " + String(row.lastStatusCode)
                        : ""}
                      {row.deadCount > 0 ? (
                        <span className="text-danger">
                          {" \u00b7 " + String(row.deadCount) + " failed"}
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {row.deadCount > 0 ? (
                      <button
                        type="button"
                        onClick={() => void replayDead(row)}
                        disabled={busy}
                        className="rounded-lg border border-line inline-flex min-h-9 items-center px-3 py-1.5 text-xs font-medium text-danger transition hover:bg-line/60 disabled:opacity-50"
                      >
                        Replay failed
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void runTest(row)}
                      disabled={testBusy}
                      className="rounded-lg border border-brand/25 bg-brand-soft inline-flex min-h-9 items-center px-3 py-1.5 text-xs font-medium text-brand transition hover:bg-brand/[0.12] disabled:opacity-50"
                    >
                      {testBusy ? "Testing..." : "Send test"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void setEnabled(row, !row.enabled)}
                      className="rounded-lg border border-line inline-flex min-h-9 items-center px-3 py-1.5 text-xs text-ink-2 transition hover:text-ink"
                    >
                      {row.enabled ? "Pause" : "Resume"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void showLog(row.id)}
                      className="rounded-lg border border-line inline-flex min-h-9 items-center px-3 py-1.5 text-xs text-ink-2 transition hover:text-ink"
                    >
                      {openLog === row.id ? "Hide log" : "Deliveries"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(row)}
                      className="rounded-lg border border-line inline-flex min-h-9 items-center px-3 py-1.5 text-xs text-ink-2 transition hover:border-rose-400/40 hover:text-danger"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {testNote ? (
                  <p className="mt-2 text-[11px] text-ink-3">{testNote}</p>
                ) : null}
                {openLog === row.id ? (
                  <div className="mt-3 rounded-xl border border-line bg-white p-3">
                    {deliveries.length === 0 ? (
                      <p className="text-xs text-ink-3">No deliveries yet.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {deliveries.map((delivery) => (
                          <li
                            key={delivery.id}
                            className="flex items-center justify-between gap-2 text-xs"
                          >
                            <span className="text-ink-2">{delivery.event}</span>
                            <span
                              className={
                                delivery.deliveredAt
                                  ? "text-ok"
                                  : delivery.dead
                                    ? "text-danger"
                                    : "text-amber-700"
                              }
                            >
                              {delivery.deliveredAt
                                ? "delivered"
                                : delivery.dead
                                  ? "failed after " + String(delivery.attempts) + " tries"
                                  : "retry " + String(delivery.attempts)}
                              {delivery.statusCode
                                ? " \u00b7 " + String(delivery.statusCode)
                                : ""}
                            </span>
                            {delivery.deliveredAt ? null : (
                              <button
                                type="button"
                                onClick={() =>
                                  void retryDelivery(row.id, delivery.id)
                                }
                                className="text-[11px] text-ink-3 transition hover:text-brand"
                              >
                                Retry now
                              </button>
                            )}
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
