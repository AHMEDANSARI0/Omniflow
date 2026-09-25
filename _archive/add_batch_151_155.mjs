// add_batch_151_155.mjs - one-file batch covering Phases 151-155.
//
//   Ph151  NEW control-plane module portal_webhooks.py: merchants add
//          their own HTTPS endpoints and OmniFlow pushes signed events.
//          CRUD (GET/POST /portal/webhooks, PUT/DELETE
//          /portal/webhooks/<id>, GET /portal/webhooks/<id>/deliveries),
//          lazy DDL for portal_webhooks + portal_webhook_deliveries, and
//          deliver_pending_webhooks() which (a) enqueues one delivery per
//          matching webhook for NEW action_log events (cod.confirmed,
//          cod.declined, broadcast.sent - deduped by a unique
//          (webhook_id, action_log_id) index, so no other module changes)
//          and (b) attempts up to 3 pending deliveries per poll with an
//          HMAC-SHA256 signature header and 2-min x attempt backoff
//          (dead after 5 tries).
//   Ph152  The connector's commands poll calls the dispatcher (guarded),
//          so delivery needs no worker and no restart.
//   Ph153  portal lib: WebhookRow/WebhookDelivery + CRUD clients.
//   Ph154  BFF routes (webhooks, webhooks/[id], webhooks/[id]/deliveries)
//          + NEW /dashboard/integrations page (add webhook with event
//          picker, one-time secret reveal, enable toggle, per-webhook
//          delivery log, delete) + sidebar nav item (bounds-based).
//   Ph155  Regression coverage.
//
// Zero AI, no worker, no restart. Events keep flowing even when the
// merchant's endpoint is down (retry with backoff).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const WEBHOOKS_MODULE = `"""Outbound webhooks: merchant endpoints receive signed OmniFlow events."""

import hashlib
import hmac
import json
import logging
import secrets as secrets_lib
from typing import Any, Dict, Optional
from urllib import request as urlrequest

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db

bp = Blueprint("portal_webhooks", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

WEBHOOKS_TABLE = "portal_webhooks"
DELIVERIES_TABLE = "portal_webhook_deliveries"
ALLOWED_EVENTS = ("all", "cod", "broadcast")
EVENT_ACTIONS = {
    "cod.confirmed": "cod",
    "cod.declined": "cod",
    "broadcast.sent": "broadcast",
}
MAX_ATTEMPTS = 5

_WEBHOOK_DDL_READY = False


def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": str(error)}}), 503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}), 401)
    return principal, None


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    try:
        return value.isoformat()
    except AttributeError:
        return None


def _ensure_webhook_tables(conn) -> None:
    global _WEBHOOK_DDL_READY
    if _WEBHOOK_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(WEBHOOKS_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " url TEXT NOT NULL,"
            " secret TEXT NOT NULL,"
            " events TEXT NOT NULL DEFAULT 'all',"
            " enabled BOOLEAN NOT NULL DEFAULT TRUE,"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(DELIVERIES_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " webhook_id BIGINT NOT NULL,"
            " client_id BIGINT NOT NULL,"
            " event TEXT NOT NULL,"
            " action_log_id BIGINT,"
            " payload JSONB NOT NULL DEFAULT '{}'::jsonb,"
            " status_code INT,"
            " error TEXT,"
            " attempts INT NOT NULL DEFAULT 0,"
            " next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " delivered_at TIMESTAMPTZ,"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        cur.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_delivery"
            " ON " + portal_db._q(DELIVERIES_TABLE) + " (webhook_id, action_log_id)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_portal_webhook_deliveries"
            " ON " + portal_db._q(DELIVERIES_TABLE) + " (client_id, next_attempt_at)"
        )
    conn.commit()
    _WEBHOOK_DDL_READY = True


def _valid_webhook_url(raw: Any) -> Optional[str]:
    url = str(raw or "").strip()
    if url.startswith("https://") and len(url) <= 500:
        return url
    if url.startswith("http://localhost"):
        return url
    return None


def _normalize_events(raw: Any) -> Optional[str]:
    if raw is None:
        return "all"
    if not isinstance(raw, str):
        return None
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    if not parts:
        return "all"
    for part in parts:
        if part not in ALLOWED_EVENTS:
            return None
    return ",".join(parts)


def _webhook_public(row: Dict[str, Any]) -> dict:
    return {
        "id": row.get("id"),
        "url": row.get("url"),
        "events": row.get("events") or "all",
        "enabled": row.get("enabled") is True,
        "created_at": _iso(row.get("created_at")),
        "last_delivery_at": _iso(row.get("last_delivery_at")),
        "last_status_code": row.get("last_status_code"),
    }


def _delivery_public(row: Dict[str, Any]) -> dict:
    return {
        "id": row.get("id"),
        "event": row.get("event"),
        "status_code": row.get("status_code"),
        "error": row.get("error"),
        "attempts": int(row.get("attempts") or 0),
        "created_at": _iso(row.get("created_at")),
        "delivered_at": _iso(row.get("delivered_at")),
    }


@bp.get("/webhooks")
def list_webhooks():
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
                    "SELECT w.id, w.url, w.events, w.enabled, w.created_at,"
                    " (SELECT MAX(d.delivered_at) FROM " + portal_db._q(DELIVERIES_TABLE) +
                    " d WHERE d.webhook_id = w.id) AS last_delivery_at,"
                    " (SELECT d.status_code FROM " + portal_db._q(DELIVERIES_TABLE) +
                    " d WHERE d.webhook_id = w.id ORDER BY d.id DESC LIMIT 1)"
                    " AS last_status_code"
                    " FROM " + portal_db._q(WEBHOOKS_TABLE) + " w"
                    " WHERE w.client_id = %s ORDER BY w.id DESC LIMIT 20",
                    (principal["client_id"],),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("webhooks read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "webhooks read")[0]), 503
    return jsonify({"webhooks": [_webhook_public(row) for row in found]}), 200


@bp.post("/webhooks")
def create_webhook():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    url = _valid_webhook_url(payload.get("url"))
    if url is None:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "An https:// URL is required."}}), 400
    events = _normalize_events(payload.get("events"))
    if events is None:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "events must be all, cod, or broadcast."}}), 400
    secret = secrets_lib.token_hex(24)
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_webhook_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(WEBHOOKS_TABLE) +
                    " (client_id, url, secret, events)"
                    " VALUES (%s, %s, %s, %s)"
                    " RETURNING id, url, events, enabled, created_at",
                    (principal["client_id"], url, secret, events),
                )
                rows = portal_db.rows(cur)
                created = rows[0] if rows else {}
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "webhooks.created",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Webhook endpoint added (" + events + ").",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "webhook create")[0]), 503
    body = _webhook_public(created)
    body["secret"] = secret
    return jsonify({"ok": True, "webhook": body}), 200


@bp.put("/webhooks/<int:webhook_id>")
def update_webhook(webhook_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    sets = []
    params: list = []
    if "url" in payload:
        url = _valid_webhook_url(payload.get("url"))
        if url is None:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "An https:// URL is required."}}), 400
        sets.append("url = %s")
        params.append(url)
    if "events" in payload:
        events = _normalize_events(payload.get("events"))
        if events is None:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "events must be all, cod, or broadcast."}}), 400
        sets.append("events = %s")
        params.append(events)
    if "enabled" in payload:
        if not isinstance(payload.get("enabled"), bool):
            return jsonify({"error": {"code": "bad_request",
                                      "message": "enabled must be true or false."}}), 400
        sets.append("enabled = %s")
        params.append(payload.get("enabled"))
    if not sets:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Nothing to update."}}), 400
    params.append(webhook_id)
    params.append(principal["client_id"])
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_webhook_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(WEBHOOKS_TABLE) +
                    " SET " + ", ".join(sets) +
                    " WHERE id = %s AND client_id = %s"
                    " RETURNING id, url, events, enabled, created_at",
                    tuple(params),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "webhook update")[0]), 503
    if not rows:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Webhook not found."}}), 404
    return jsonify({"ok": True, "webhook": _webhook_public(rows[0])}), 200


@bp.delete("/webhooks/<int:webhook_id>")
def delete_webhook(webhook_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_webhook_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM " + portal_db._q(DELIVERIES_TABLE) +
                    " WHERE webhook_id = %s AND client_id = %s",
                    (webhook_id, principal["client_id"]),
                )
                cur.execute(
                    "DELETE FROM " + portal_db._q(WEBHOOKS_TABLE) +
                    " WHERE id = %s AND client_id = %s RETURNING id",
                    (webhook_id, principal["client_id"]),
                )
                rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "webhook delete")[0]), 503
    if not rows:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Webhook not found."}}), 404
    return jsonify({"ok": True}), 200


@bp.get("/webhooks/<int:webhook_id>/deliveries")
def list_webhook_deliveries(webhook_id: int):
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
                    "SELECT id, event, status_code, error, attempts, created_at,"
                    " delivered_at FROM " + portal_db._q(DELIVERIES_TABLE) +
                    " WHERE webhook_id = %s ORDER BY id DESC LIMIT 20",
                    (webhook_id,),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "webhook deliveries read")[0]), 503
    return jsonify({"deliveries": [_delivery_public(row) for row in found]}), 200


def _sign(secret: str, body: str) -> str:
    return hmac.new(secret.encode("utf-8"), body.encode("utf-8"),
                    hashlib.sha256).hexdigest()


def _http_post(url: str, headers: Dict[str, str], body: str, timeout: int = 5):
    """Isolated for tests: perform the outbound POST."""
    return urlrequest.urlopen(
        urlrequest.Request(url, data=body.encode("utf-8"),
                           headers=headers, method="POST"),
        timeout=timeout,
    )


def deliver_pending_webhooks(cur, client_id: int, conn) -> int:
    """Enqueue new events for matching webhooks, then attempt deliveries."""
    try:
        portal_db.ensure_tables()
        _ensure_webhook_tables(conn)
    except Exception:
        return 0
    try:
        cur.execute(
            "SELECT a.id, a.action, a.conversation_id, a.note, a.created_at"
            " FROM portal_action_log a"
            " WHERE a.client_id = %s AND a.action = ANY(%s)"
            " AND NOT EXISTS (SELECT 1 FROM " + portal_db._q(DELIVERIES_TABLE) +
            " d WHERE d.action_log_id = a.id)"
            " ORDER BY a.id ASC LIMIT 10",
            (client_id, list(EVENT_ACTIONS.keys())),
        )
        logs = portal_db.rows(cur)
        if logs:
            cur.execute(
                "SELECT id, events FROM " + portal_db._q(WEBHOOKS_TABLE) +
                " WHERE client_id = %s AND enabled IS TRUE",
                (client_id,),
            )
            hooks = portal_db.rows(cur)
            for log in logs:
                event = EVENT_ACTIONS.get(log.get("action"))
                if event is None:
                    continue
                payload = {
                    "event": event,
                    "action": log.get("action"),
                    "conversation_id": log.get("conversation_id"),
                    "note": log.get("note"),
                    "at": _iso(log.get("created_at")),
                }
                for hook in hooks:
                    csv_events = str(hook.get("events") or "all")
                    if ("all" not in csv_events.split(",")
                            and event not in [p.strip() for p in csv_events.split(",")]):
                        continue
                    cur.execute(
                        "INSERT INTO " + portal_db._q(DELIVERIES_TABLE) +
                        " (webhook_id, client_id, event, action_log_id, payload)"
                        " VALUES (%s, %s, %s, %s, %s)"
                        " ON CONFLICT (webhook_id, action_log_id) DO NOTHING",
                        (hook.get("id"), client_id, event, log.get("id"),
                         json.dumps(payload)),
                    )
        cur.execute(
            "SELECT d.id, d.event, d.payload, d.attempts, w.url, w.secret"
            " FROM " + portal_db._q(DELIVERIES_TABLE) + " d"
            " JOIN " + portal_db._q(WEBHOOKS_TABLE) + " w ON w.id = d.webhook_id"
            " WHERE d.client_id = %s AND d.delivered_at IS NULL"
            " AND d.attempts < %s AND d.next_attempt_at <= NOW()"
            " ORDER BY d.id LIMIT 3",
            (client_id, MAX_ATTEMPTS),
        )
        pending = portal_db.rows(cur)
        delivered = 0
        for row in pending:
            body = json.dumps({"event": row.get("event"), "data": row.get("payload")})
            headers = {
                "Content-Type": "application/json",
                "X-Omniflow-Event": str(row.get("event")),
                "X-Omniflow-Signature": "sha256=" + _sign(str(row.get("secret")), body),
            }
            status_code = 0
            error_text = None
            try:
                response = _http_post(str(row.get("url")), headers, body)
                status_code = int(getattr(response, "status", 0) or 0)
            except Exception as http_error:
                error_text = str(http_error)[:200]
            if 200 <= status_code < 300:
                cur.execute(
                    "UPDATE " + portal_db._q(DELIVERIES_TABLE) +
                    " SET status_code = %s, error = NULL, delivered_at = NOW()"
                    " WHERE id = %s",
                    (status_code, row.get("id")),
                )
                delivered += 1
            else:
                cur.execute(
                    "UPDATE " + portal_db._q(DELIVERIES_TABLE) +
                    " SET status_code = %s, error = %s, attempts = attempts + 1,"
                    " next_attempt_at = NOW() + make_interval(mins => %s)"
                    " WHERE id = %s",
                    (status_code if status_code else None, error_text,
                     2 * (int(row.get("attempts") or 0) + 1), row.get("id")),
                )
        if pending:
            conn.commit()
        return delivered
    except Exception as error:
        logger.warning("webhook delivery pass failed: %s", error)
        return 0
`;

const APP_IMPORT_FROM = `from portal_setup import bp as portal_setup_bp  # noqa: E402`;
const APP_IMPORT_TO = `from portal_setup import bp as portal_setup_bp  # noqa: E402
from portal_webhooks import bp as portal_webhooks_bp  # noqa: E402`;

const APP_REGISTER_FROM = `aux_app.register_blueprint(portal_setup_bp)`;
const APP_REGISTER_TO = `aux_app.register_blueprint(portal_setup_bp)
aux_app.register_blueprint(portal_webhooks_bp)`;

const CONNECTOR_HOOK_FROM = `                try:
                    import portal_growth

                    portal_growth.materialize_due_broadcasts(cur, tenant["client_id"], conn)
                except Exception:
                    pass`;

const CONNECTOR_HOOK_TO = `                try:
                    import portal_growth

                    portal_growth.materialize_due_broadcasts(cur, tenant["client_id"], conn)
                except Exception:
                    pass
                try:
                    import portal_webhooks

                    portal_webhooks.deliver_pending_webhooks(
                        cur, tenant["client_id"], conn
                    )
                except Exception:
                    pass`;

const PORTAL_TS_FROM = `export type ConversationStatusResult =`;

const PORTAL_TS_TO = `export interface WebhookRow {
  id: number;
  url: string;
  events: string;
  enabled: boolean;
  createdAt: string | null;
  lastDeliveryAt: string | null;
  lastStatusCode: number | null;
}

export interface WebhookDelivery {
  id: number;
  event: string;
  statusCode: number | null;
  error: string | null;
  attempts: number;
  createdAt: string | null;
  deliveredAt: string | null;
}

export async function listWebhooks(
  accessToken: string
): Promise<WebhookRow[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/webhooks");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).webhooks;
  if (!Array.isArray(rawList)) return null;
  const webhooks: WebhookRow[] = [];
  for (const item of rawList) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "number") continue;
    webhooks.push({
      id: row.id,
      url: typeof row.url === "string" ? row.url : "",
      events: typeof row.events === "string" ? row.events : "all",
      enabled: row.enabled === true,
      createdAt: typeof row.created_at === "string" ? row.created_at : null,
      lastDeliveryAt: typeof row.last_delivery_at === "string" ? row.last_delivery_at : null,
      lastStatusCode: typeof row.last_status_code === "number" ? row.last_status_code : null,
    });
  }
  return webhooks;
}

export type WebhookMutation =
  | { kind: "ok"; webhook?: WebhookRow; secret?: string }
  | { kind: "invalid" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function createWebhook(
  accessToken: string,
  url: string,
  events: string
): Promise<WebhookMutation> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, events }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const raw = (payload as Record<string, unknown>).webhook;
  const secret = (payload as Record<string, unknown>).secret;
  const webhook =
    raw !== null && typeof raw === "object"
      ? ({
          id: (raw as Record<string, unknown>).id as number,
          url: (raw as Record<string, unknown>).url as string,
          events: (raw as Record<string, unknown>).events as string,
          enabled: true,
          createdAt: null,
          lastDeliveryAt: null,
          lastStatusCode: null,
        } as WebhookRow)
      : undefined;
  return {
    kind: "ok",
    webhook,
    secret: typeof secret === "string" ? secret : undefined,
  };
}

export async function updateWebhook(
  accessToken: string,
  id: number,
  changes: { url?: string; events?: string; enabled?: boolean }
): Promise<WebhookMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/webhooks/" + String(id),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export async function deleteWebhook(
  accessToken: string,
  id: number
): Promise<{ kind: "ok" } | { kind: "not_found" } | { kind: "unavailable" }> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/webhooks/" + String(id),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export async function listWebhookDeliveries(
  accessToken: string,
  id: number
): Promise<WebhookDelivery[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/webhooks/" + String(id) + "/deliveries"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).deliveries;
  if (!Array.isArray(rawList)) return null;
  const deliveries: WebhookDelivery[] = [];
  for (const item of rawList) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "number") continue;
    deliveries.push({
      id: row.id,
      event: typeof row.event === "string" ? row.event : "",
      statusCode: typeof row.status_code === "number" ? row.status_code : null,
      error: typeof row.error === "string" ? row.error : null,
      attempts: typeof row.attempts === "number" ? row.attempts : 0,
      createdAt: typeof row.created_at === "string" ? row.created_at : null,
      deliveredAt: typeof row.delivered_at === "string" ? row.delivered_at : null,
    });
  }
  return deliveries;
}

export type ConversationStatusResult =`;

const BFF_LIST_FILE = `import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  createWebhook,
  listWebhooks,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const webhooks = await listWebhooks(accessToken);
    if (webhooks === null) {
      return safeJson(
        {
          error: {
            code: "portal_pending",
            message: "Integrations are not available yet.",
          },
        },
        503
      );
    }
    return safeJson({ webhooks }, 200);
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

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload: unknown = await request.json().catch(() => null);
  const input =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const url = typeof input.url === "string" ? input.url : "";
  const events = typeof input.events === "string" ? input.events : "all";
  if (!url) {
    return safeJson(
      { error: { code: "bad_request", message: "An https:// URL is required." } },
      400
    );
  }

  try {
    const result = await createWebhook(accessToken, url, events);
    if (result.kind === "ok") {
      return safeJson(
        { ok: true, webhook: result.webhook ?? null, secret: result.secret ?? null },
        200
      );
    }
    if (result.kind === "invalid") {
      return safeJson(
        {
          error: {
            code: "bad_request",
            message: "Check the URL and events, then try again.",
          },
        },
        400
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
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

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
`;

const BFF_ID_FILE = `import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  deleteWebhook,
  requirePortalAccessToken,
  updateWebhook,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";


export async function PUT(
  request: Request,
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

  const payload: unknown = await request.json().catch(() => null);
  const input =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const changes: { url?: string; events?: string; enabled?: boolean } = {};
  if (typeof input.url === "string") changes.url = input.url;
  if (typeof input.events === "string") changes.events = input.events;
  if (typeof input.enabled === "boolean") changes.enabled = input.enabled;

  try {
    const result = await updateWebhook(accessToken, webhookId, changes);
    if (result.kind === "ok") {
      return safeJson({ ok: true }, 200);
    }
    if (result.kind === "invalid") {
      return safeJson(
        { error: { code: "bad_request", message: "Check the values." } },
        400
      );
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Webhook not found." } },
        404
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
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

export async function DELETE(
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
    const result = await deleteWebhook(accessToken, webhookId);
    if (result.kind === "ok") {
      return safeJson({ ok: true }, 200);
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Webhook not found." } },
        404
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
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

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
`;

const BFF_DELIVERIES_FILE = `import {
  listWebhookDeliveries,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";


export async function GET(
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
    const deliveries = await listWebhookDeliveries(accessToken, webhookId);
    if (deliveries === null) {
      return safeJson(
        {
          error: {
            code: "portal_pending",
            message: "Integrations are not available yet.",
          },
        },
        503
      );
    }
    return safeJson({ deliveries }, 200);
  } catch {
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
`;

const INTEGRATIONS_PAGE = `"use client";

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
                                ? " \\u00b7 " + String(delivery.statusCode)
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
`;

const NAV_ITEM = '{ label: "Integrations", href: "/dashboard/integrations", icon: "\\u21c4", enabled: true }';

function insertNavItem(text) {
  if (text.includes('label: "Integrations"')) {
    return { text, changed: false, anchor: "already" };
  }
  for (const anchorLabel of ["COD confirmations", "Broadcasts", "Business profile", "Conversations"]) {
    const labelIdx = text.indexOf('label: "' + anchorLabel + '"');
    if (labelIdx === -1) continue;
    const start = text.lastIndexOf("{", labelIdx);
    const end = text.indexOf("},", labelIdx);
    if (start === -1 || end === -1) continue;
    const insertAt = end + 2;
    const item = "\n  " + NAV_ITEM + ",";
    return {
      text: text.slice(0, insertAt) + item + text.slice(insertAt),
      changed: true,
      anchor: anchorLabel,
    };
  }
  return { text, changed: false, anchor: null };
}

const NEW_FILES = [
  { path: "OmniFlow-Control-Plane/portal_webhooks.py", content: WEBHOOKS_MODULE, marker: "deliver_pending_webhooks", name: "p151-webhooks-module" },
  { path: "Omniflow/app/api/omniflow/portal/webhooks/route.ts", content: BFF_LIST_FILE, marker: "listWebhooks", name: "p154-bff-webhooks" },
  { path: "Omniflow/app/api/omniflow/portal/webhooks/[id]/route.ts", content: BFF_ID_FILE, marker: "deleteWebhook", name: "p154-bff-webhook-id" },
  { path: "Omniflow/app/api/omniflow/portal/webhooks/[id]/deliveries/route.ts", content: BFF_DELIVERIES_FILE, marker: "listWebhookDeliveries", name: "p154-bff-deliveries" },
  { path: "Omniflow/app/dashboard/(portal)/integrations/page.tsx", content: INTEGRATIONS_PAGE, marker: "Integrations", name: "p154-integrations-page" },
];

const TARGETS = [
  {
    file: "OmniFlow-Control-Plane/app.py",
    swaps: [
      { name: "p142-app-import", from: APP_IMPORT_FROM, to: APP_IMPORT_TO, guard: "portal_webhooks" },
      { name: "p142-app-register", from: APP_REGISTER_FROM, to: APP_REGISTER_TO, guard: "register_blueprint(portal_webhooks_bp)" },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/connector_api.py",
    swaps: [
      { name: "p152-connector-dispatch", from: CONNECTOR_HOOK_FROM, to: CONNECTOR_HOOK_TO, guard: "deliver_pending_webhooks(" },
    ],
  },
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      { name: "p153-portal-lib", from: PORTAL_TS_FROM, to: PORTAL_TS_TO, guard: "listWebhookDeliveries" },
    ],
  },
];

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

for (const file of NEW_FILES) {
  if (fs.existsSync(file.path) && fs.readFileSync(file.path, "utf8").includes(file.marker)) {
    alreadyTotal++;
    continue;
  }
  fs.mkdirSync(path.dirname(file.path), { recursive: true });
  fs.writeFileSync(file.path, file.content.replace(/\r\n/g, "\n"), "utf8");
  appliedTotal++;
  console.log("+ " + file.path + " (new): " + file.name);
}

for (const target of TARGETS) {
  if (!fs.existsSync(target.file)) {
    console.log("SKIP (file not found): " + target.file);
    warnTotal++;
    continue;
  }

  const original = fs.readFileSync(target.file, "utf8");
  let text = original.replace(/\r\n/g, "\n");
  let changed = false;
  const fileApplied = [];

  for (const swap of target.swaps) {
    if (swap.guard && text.includes(swap.guard)) {
      alreadyTotal++;
      continue;
    }
    const fromCount = text.split(swap.from).length - 1;
    const toCount = text.split(swap.to).length - 1;

    if (fromCount === 1 && toCount === 0) {
      text = text.split(swap.from).join(swap.to);
      changed = true;
      appliedTotal++;
      fileApplied.push(swap.name);
    } else if (toCount > 0) {
      alreadyTotal++;
    } else {
      warnTotal++;
      console.log("  ? " + target.file + " :: " + swap.name + " NOT FOUND — report this");
    }
  }

  if (!changed) {
    console.log("= " + target.file + " (already patched)");
    continue;
  }

  const backup = target.file + ".pre_b151155.bak";
  if (!fs.existsSync(backup)) fs.copyFileSync(target.file, backup);

  if (target.file.endsWith(".py")) {
    fs.writeFileSync(target.file, text, "utf8");
    if (!compilePython(target.file)) {
      fs.copyFileSync(backup, target.file);
      console.log("FAIL (compile failed, restored): " + target.file);
      warnTotal++;
      continue;
    }
  } else {
    fs.writeFileSync(target.file, text, "utf8");
  }

  console.log("+ " + target.file + " (" + fileApplied.length + "): " + fileApplied.join(", "));
}

if (fs.existsSync("Omniflow/app/dashboard/components/DashSidebar.tsx")) {
  const navPath = "Omniflow/app/dashboard/components/DashSidebar.tsx";
  const navOriginal = fs.readFileSync(navPath, "utf8");
  const navResult = insertNavItem(navOriginal.replace(/\r\n/g, "\n"));
  if (navResult.anchor === "already") {
    alreadyTotal++;
    console.log("= " + navPath + " (nav item already present)");
  } else if (navResult.anchor === null) {
    warnTotal++;
    console.log("  ? " + navPath + " :: p154-nav-item NOT FOUND — paste the navItems block");
  } else {
    const navBackup = navPath + ".pre_b151155.bak";
    if (!fs.existsSync(navBackup)) fs.copyFileSync(navPath, navBackup);
    fs.writeFileSync(navPath, navResult.text, "utf8");
    appliedTotal++;
    console.log("+ " + navPath + " (1): p154-nav-item after " + navResult.anchor);
  }
} else {
  warnTotal++;
  console.log("SKIP (file not found): Omniflow/app/dashboard/components/DashSidebar.tsx");
}

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