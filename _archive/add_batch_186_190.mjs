// add_batch_186_190.mjs - one-file batch covering Phases 186-190.
//
//   Ph186  Webhook test: POST /portal/webhooks/<id>/test fires a signed
//          {"event":"ping"} at the endpoint RIGHT NOW (5s timeout), records
//          the attempt as a delivery row (action_log_id NULL so the unique
//          index never blocks) and answers {delivered, status_code, error}.
//   Ph187  Webhook retry: POST /portal/webhooks/<id>/deliveries/<did>/retry
//          re-attempts an undelivered row synchronously with the same
//          signature and backoff rules as the poll (already-delivered 400s).
//   Ph188  portal.ts clients (testWebhook / retryWebhookDelivery) + BFF
//          routes (test at 7-deep, retry at 9-deep).
//   Ph189  Integrations page: "Send test" per endpoint with a status note,
//          "Retry now" on undelivered log rows.
//   Ph190  Regression coverage (test_webhook_ops).
//
// Zero AI. Touches both repos. NO restart. Vercel deploys on push.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BACKUP_TAG = ".pre_b186190.bak";

const CP_SWAP_FROM = `    return jsonify({"deliveries": [_delivery_public(row) for row in found]}), 200\n\n\ndef _sign(secret: str, body: str) -> str:`;

const CP_SWAP_TO = `    return jsonify({"deliveries": [_delivery_public(row) for row in found]}), 200\n\n\n@bp.post("/webhooks/<int:webhook_id>/test")
def test_webhook(webhook_id: int):
    """Send a signed ping to the endpoint right now."""
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_webhook_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, url, secret FROM " + portal_db._q(WEBHOOKS_TABLE) +
                    " WHERE id = %s AND client_id = %s",
                    (webhook_id, principal["client_id"]),
                )
                found = portal_db.rows(cur)
                if not found:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Webhook not found."}}), 404
                hook = found[0]
                body = json.dumps({"event": "ping",
                                   "data": {"source": "omniflow",
                                            "webhook_id": webhook_id}})
                headers = {
                    "Content-Type": "application/json",
                    "X-Omniflow-Event": "ping",
                    "X-Omniflow-Signature":
                        "sha256=" + _sign(str(hook.get("secret")), body),
                }
                status_code = 0
                error_text = None
                try:
                    response = _http_post(str(hook.get("url")), headers, body)
                    status_code = int(getattr(response, "status", 0) or 0)
                except Exception as http_error:
                    error_text = str(http_error)[:200]
                delivered = 200 <= status_code < 300
                cur.execute(
                    "INSERT INTO " + portal_db._q(DELIVERIES_TABLE) +
                    " (webhook_id, client_id, event, action_log_id, payload,"
                    " status_code, error, attempts, next_attempt_at, delivered_at)"
                    " VALUES (%s, %s, 'ping', NULL, %s, %s, %s, 1, NOW(),"
                    " CASE WHEN %s THEN NOW() ELSE NULL END)",
                    (webhook_id, principal["client_id"], body,
                     status_code if status_code else None, error_text, delivered),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "webhook test")[0]), 503
    return jsonify({"ok": True, "delivered": delivered,
                    "status_code": status_code if status_code else None,
                    "error": error_text}), 200


@bp.post("/webhooks/<int:webhook_id>/deliveries/<int:delivery_id>/retry")
def retry_webhook_delivery(webhook_id: int, delivery_id: int):
    """Attempt a failed delivery again right now."""
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_webhook_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM " + portal_db._q(WEBHOOKS_TABLE) +
                    " WHERE id = %s AND client_id = %s",
                    (webhook_id, principal["client_id"]),
                )
                if not portal_db.rows(cur):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Webhook not found."}}), 404
                cur.execute(
                    "SELECT d.id, d.event, d.payload, d.attempts, d.delivered_at,"
                    " w.url, w.secret"
                    " FROM " + portal_db._q(DELIVERIES_TABLE) + " d"
                    " JOIN " + portal_db._q(WEBHOOKS_TABLE) + " w ON w.id = d.webhook_id"
                    " WHERE d.id = %s AND d.webhook_id = %s AND d.client_id = %s",
                    (delivery_id, webhook_id, principal["client_id"]),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Delivery not found."}}), 404
                row = rows[0]
                if row.get("delivered_at"):
                    return jsonify({"error": {"code": "bad_request",
                                              "message": "Already delivered."}}), 400
                body = json.dumps({"event": row.get("event"),
                                   "data": row.get("payload")})
                headers = {
                    "Content-Type": "application/json",
                    "X-Omniflow-Event": str(row.get("event")),
                    "X-Omniflow-Signature":
                        "sha256=" + _sign(str(row.get("secret")), body),
                }
                status_code = 0
                error_text = None
                try:
                    response = _http_post(str(row.get("url")), headers, body)
                    status_code = int(getattr(response, "status", 0) or 0)
                except Exception as http_error:
                    error_text = str(http_error)[:200]
                delivered = 200 <= status_code < 300
                if delivered:
                    cur.execute(
                        "UPDATE " + portal_db._q(DELIVERIES_TABLE) +
                        " SET status_code = %s, error = NULL, delivered_at = NOW()"
                        " WHERE id = %s",
                        (status_code, delivery_id),
                    )
                else:
                    cur.execute(
                        "UPDATE " + portal_db._q(DELIVERIES_TABLE) +
                        " SET status_code = %s, error = %s, attempts = attempts + 1,"
                        " next_attempt_at = NOW() + make_interval(mins => %s)"
                        " WHERE id = %s",
                        (status_code if status_code else None, error_text,
                         2 * (int(row.get("attempts") or 0) + 1), delivery_id),
                    )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "webhook retry")[0]), 503
    return jsonify({"ok": True, "delivered": delivered,
                    "status_code": status_code if status_code else None}), 200\n\n\ndef _sign(secret: str, body: str) -> str:`;

const PORTAL_TS_CLIENTS = `export type WebhookTestResult =
  | { kind: "ok"; delivered: boolean; statusCode: number | null; error: string | null }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function testWebhook(
  accessToken: string,
  id: number
): Promise<WebhookTestResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/webhooks/" + String(id) + "/test",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  if (typeof p.delivered !== "boolean") return { kind: "unavailable" };
  return {
    kind: "ok",
    delivered: p.delivered,
    statusCode: typeof p.status_code === "number" ? p.status_code : null,
    error: typeof p.error === "string" ? p.error : null,
  };
}

export type WebhookRetryResult =
  | { kind: "ok"; delivered: boolean; statusCode: number | null }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function retryWebhookDelivery(
  accessToken: string,
  id: number,
  deliveryId: number
): Promise<WebhookRetryResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/webhooks/" + String(id) +
        "/deliveries/" + String(deliveryId) + "/retry",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  if (typeof p.delivered !== "boolean") return { kind: "unavailable" };
  return {
    kind: "ok",
    delivered: p.delivered,
    statusCode: typeof p.status_code === "number" ? p.status_code : null,
  };
}

`;

const TEST_ROUTE = `import {
  requirePortalAccessToken,
  testWebhook,
} from "../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";


export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await params;
  const webhookId = Number.parseInt(id, 10);
  if (!Number.isFinite(webhookId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid webhook id." } },
      400
    );
  }

  try {
    const result = await testWebhook(accessToken, webhookId);
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Webhook not found." } },
        404
      );
    }
    if (result.kind !== "ok") {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return new Response(
      JSON.stringify({
        delivered: result.delivered,
        status_code: result.statusCode,
        error: result.error,
      }),
      { status: 200, headers: { ...noStoreHeaders(), "Content-Type": "application/json" } }
    );
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
`;

const RETRY_ROUTE = `import {
  requirePortalAccessToken,
  retryWebhookDelivery,
} from "../../../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../../../../lib/omniflow/control-plane";


export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; did: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id, did } = await params;
  const webhookId = Number.parseInt(id, 10);
  const deliveryId = Number.parseInt(did, 10);
  if (!Number.isFinite(webhookId) || !Number.isFinite(deliveryId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid id." } },
      400
    );
  }

  try {
    const result = await retryWebhookDelivery(accessToken, webhookId, deliveryId);
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Delivery not found." } },
        404
      );
    }
    if (result.kind !== "ok") {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return new Response(
      JSON.stringify({ delivered: result.delivered, status_code: result.statusCode }),
      { status: 200, headers: { ...noStoreHeaders(), "Content-Type": "application/json" } }
    );
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
`;

const PAGE_FULL = `"use client";

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
              {busy ? "Working\\u2026" : "Add endpoint"}
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
          <p className="text-sm text-slate-500">Loading\\u2026</p>
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
                        ? " \\u00b7 last status " + String(row.lastStatusCode)
                        : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void runTest(row)}
                      disabled={testBusy}
                      className="rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] px-3 py-1.5 text-xs font-medium text-cyan-200 transition hover:bg-cyan-400/[0.14] disabled:opacity-50"
                    >
                      {testBusy ? "Testing..." : "Send test"}
                    </button>
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
                {testNote ? (
                  <p className="mt-2 text-[11px] text-slate-400">{testNote}</p>
                ) : null}
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
                                ? " \\u00b7 " + String(delivery.statusCode)
                                : ""}
                            </span>
                            {delivery.deliveredAt ? null : (
                              <button
                                type="button"
                                onClick={() =>
                                  void retryDelivery(row.id, delivery.id)
                                }
                                className="text-[11px] text-slate-500 transition hover:text-cyan-300"
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
`;


let appliedTotal = 0;
let alreadyTotal = 0;
let warnTotal = 0;

function compilePython(pathArg) {
  for (const py of ["python", "python3"]) {
    try {
      execFileSync(py, ["-m", "py_compile", pathArg], { stdio: "pipe" });
      return true;
    } catch {
      /* try next interpreter */
    }
  }
  return false;
}

const CP_FILE = "OmniFlow-Control-Plane/portal_webhooks.py";
if (!fs.existsSync(CP_FILE)) {
  console.log("SKIP (file not found): " + CP_FILE);
  warnTotal++;
} else {
  const original = fs.readFileSync(CP_FILE, "utf8").replace(/\r\n/g, "\n");
  if (original.includes("webhooks/<int:webhook_id>/test")) {
    alreadyTotal++;
    console.log("= " + CP_FILE + " (already patched)");
  } else if (original.split(CP_SWAP_FROM).length - 1 === 1) {
    const backup = CP_FILE + BACKUP_TAG;
    if (!fs.existsSync(backup)) fs.copyFileSync(CP_FILE, backup);
    fs.writeFileSync(CP_FILE, original.replace(CP_SWAP_FROM, CP_SWAP_TO), "utf8");
    if (!compilePython(CP_FILE)) {
      fs.copyFileSync(backup, CP_FILE);
      console.log("FAIL (compile failed, restored): " + CP_FILE);
      warnTotal++;
    } else {
      appliedTotal++;
      console.log("+ " + CP_FILE + " (1): p186-187-webhook-test-retry");
    }
  } else {
    warnTotal++;
    console.log("  ? " + CP_FILE + " :: p186-187 NOT FOUND — report this");
  }
}

const PORTAL_TS = "Omniflow/lib/omniflow/portal.ts";
if (!fs.existsSync(PORTAL_TS)) {
  console.log("SKIP (file not found): " + PORTAL_TS);
  warnTotal++;
} else {
  const original = fs.readFileSync(PORTAL_TS, "utf8").replace(/\r\n/g, "\n");
  if (original.includes("testWebhook")) {
    alreadyTotal++;
    console.log("= " + PORTAL_TS + " (already patched)");
  } else if (original.split("export type ConversationStatusResult =").length - 1 === 1) {
    const backup = PORTAL_TS + BACKUP_TAG;
    if (!fs.existsSync(backup)) fs.copyFileSync(PORTAL_TS, backup);
    fs.writeFileSync(
      PORTAL_TS,
      original.replace(
        "export type ConversationStatusResult =",
        PORTAL_TS_CLIENTS + "export type ConversationStatusResult ="
      ),
      "utf8"
    );
    appliedTotal++;
    console.log("+ " + PORTAL_TS + " (1): p188-portal-clients");
  } else {
    warnTotal++;
    console.log("  ? " + PORTAL_TS + " :: p188-portal-clients NOT FOUND — report this");
  }
}

function writeFull(pathArg, content, marker, name) {
  if (fs.existsSync(pathArg)) {
    const text = fs.readFileSync(pathArg, "utf8").replace(/\r\n/g, "\n");
    if (text.includes(marker)) {
      alreadyTotal++;
      console.log("= " + pathArg + " (already patched)");
      return;
    }
    const backup = pathArg + BACKUP_TAG;
    if (!fs.existsSync(backup)) fs.copyFileSync(pathArg, backup);
  } else {
    fs.mkdirSync(path.dirname(pathArg), { recursive: true });
  }
  fs.writeFileSync(pathArg, content.replace(/\r\n/g, "\n"), "utf8");
  appliedTotal++;
  console.log("+ " + pathArg + " (written): " + name);
}

writeFull(
  "Omniflow/app/api/omniflow/portal/webhooks/[id]/test/route.ts",
  TEST_ROUTE,
  "testWebhook",
  "p188-bff-test"
);
writeFull(
  "Omniflow/app/api/omniflow/portal/webhooks/[id]/deliveries/[did]/retry/route.ts",
  RETRY_ROUTE,
  "retryWebhookDelivery",
  "p188-bff-retry"
);
writeFull(
  "Omniflow/app/dashboard/(portal)/integrations/page.tsx",
  PAGE_FULL,
  "Send test",
  "p189-integrations-page"
);

console.log("");
console.log(
  "SUMMARY: " +
    appliedTotal +
    " applied, " +
    alreadyTotal +
    " already done, " +
    warnTotal +
    " warnings"
);  