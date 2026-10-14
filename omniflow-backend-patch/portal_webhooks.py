"""Outbound webhooks: merchant endpoints receive signed OmniFlow events.

§225 outbox upgrade: events come from the typed catalog
(portal_event_catalog - subscribe by category), every endpoint reads the
portal_action_log outbox with its OWN cursor (``last_log_id``: no
starvation behind unsubscribed events, no history flood for a new
endpoint), deliveries that exhaust their attempts become dead letters
(``dead_at`` + one owner notification) and can be replayed in bulk.
"""

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
import portal_event_catalog
import portal_vault

bp = Blueprint("portal_webhooks", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

WEBHOOKS_TABLE = "portal_webhooks"
DELIVERIES_TABLE = "portal_webhook_deliveries"
#: subscription keys: "all" + the catalog categories (cod, broadcast, ...)
ALLOWED_EVENTS = ("all",) + tuple(portal_event_catalog.CATEGORIES)
#: event name -> category (X-Omniflow-Event), derived from the catalog
EVENT_ACTIONS = {name: spec["category"]
                 for name, spec in portal_event_catalog.EVENTS.items()}
MAX_ATTEMPTS = 5
#: outbox rows one endpoint enqueues per poll tick
ENQUEUE_PER_TICK = 25
_EVENTS_HINT = ("events must be all or a comma list of: "
                + ", ".join(portal_event_catalog.CATEGORIES) + ".")
#: one-time §225 upgrade, idempotent. Endpoints created before the
#: catalog: "all" meant cod+broadcast, so it is pinned to exactly that
#: (no surprise new event types); their cursor starts after what they
#: already received (or at the current end of the log).
_UPGRADE_225 = """
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'portal_webhooks'
                 AND column_name = 'last_log_id') THEN
    ALTER TABLE portal_webhooks ADD COLUMN last_log_id BIGINT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'portal_webhook_deliveries'
                 AND column_name = 'dead_at') THEN
    ALTER TABLE portal_webhook_deliveries ADD COLUMN dead_at TIMESTAMPTZ;
  END IF;
END $$;
UPDATE portal_webhooks SET events = 'cod,broadcast'
  WHERE last_log_id IS NULL AND events = 'all';
UPDATE portal_webhooks w SET last_log_id = COALESCE(
  (SELECT MAX(d.action_log_id) FROM portal_webhook_deliveries d
    WHERE d.webhook_id = w.id),
  (SELECT MAX(a.id) FROM portal_action_log a
    WHERE a.client_id = w.client_id), 0)
  WHERE last_log_id IS NULL;
"""

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
            " ON " + portal_db._q(DELIVERIES_TABLE) + " (client_id, next_attempt_at);"
            + _UPGRADE_225
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
        "dead_count": int(row.get("dead_count") or 0),
    }


def _is_dead(row: Dict[str, Any]) -> bool:
    return (row.get("delivered_at") is None
            and int(row.get("attempts") or 0) >= MAX_ATTEMPTS)


def _delivery_public(row: Dict[str, Any]) -> dict:
    return {
        "id": row.get("id"),
        "event": row.get("event"),
        "status_code": row.get("status_code"),
        "error": row.get("error"),
        "attempts": int(row.get("attempts") or 0),
        "created_at": _iso(row.get("created_at")),
        "delivered_at": _iso(row.get("delivered_at")),
        "dead": _is_dead(row),
    }


def _subscribed_actions(events_csv: str) -> list:
    parts = [p.strip() for p in str(events_csv or "all").split(",")
             if p.strip()]
    return portal_event_catalog.actions_for(parts or ["all"])


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
                    " AS last_status_code,"
                    " (SELECT COUNT(*) FROM " + portal_db._q(DELIVERIES_TABLE) +
                    " d WHERE d.webhook_id = w.id AND d.delivered_at IS NULL"
                    " AND d.attempts >= " + str(MAX_ATTEMPTS) + ") AS dead_count"
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
                                  "message": _EVENTS_HINT}}), 400
    secret = secrets_lib.token_hex(24)
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_webhook_tables(conn)
            with conn.cursor() as cur:
                # a new endpoint starts at the end of the outbox: it gets
                # events from now on, not the workspace's history
                cur.execute(
                    "INSERT INTO " + portal_db._q(WEBHOOKS_TABLE) +
                    " (client_id, url, secret, events, last_log_id)"
                    " VALUES (%s, %s, %s, %s, (SELECT COALESCE(MAX(id), 0)"
                    " FROM portal_action_log WHERE client_id = %s))"
                    " RETURNING id, url, events, enabled, created_at",
                    (principal["client_id"], url, portal_vault.seal(secret),
                     events, principal["client_id"]),
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
                                      "message": _EVENTS_HINT}}), 400
        sets.append("events = %s")
        params.append(events)
    if "enabled" in payload:
        if not isinstance(payload.get("enabled"), bool):
            return jsonify({"error": {"code": "bad_request",
                                      "message": "enabled must be true or false."}}), 400
        sets.append("enabled = %s")
        params.append(payload.get("enabled"))
        if payload.get("enabled") is True:
            # re-enabling resumes from now: no backlog of events that
            # happened while the endpoint was switched off
            sets.append("last_log_id = CASE WHEN enabled THEN last_log_id"
                        " ELSE GREATEST(COALESCE(last_log_id, 0),"
                        " (SELECT COALESCE(MAX(id), 0) FROM portal_action_log"
                        " WHERE client_id = %s)) END")
            params.append(principal["client_id"])
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
            conn.commit()  # §225: updates were never committed before
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
                    " delivered_at, dead_at FROM " + portal_db._q(DELIVERIES_TABLE) +
                    " WHERE webhook_id = %s ORDER BY id DESC LIMIT 20",
                    (webhook_id,),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "webhook deliveries read")[0]), 503
    return jsonify({"deliveries": [_delivery_public(row) for row in found]}), 200


@bp.post("/webhooks/<int:webhook_id>/test")
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
                    "status_code": status_code if status_code else None}), 200


@bp.post("/webhooks/<int:webhook_id>/deliveries/replay-dead")
def replay_dead_deliveries(webhook_id: int):
    """Put every dead letter of this endpoint back on the queue (attempts
    reset); the next poll delivers them with the normal retry budget."""
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_webhook_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM " + portal_db._q(WEBHOOKS_TABLE) +
                    " WHERE id = %s AND client_id = %s",
                    (webhook_id, client_id),
                )
                if not portal_db.rows(cur):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Webhook not found."}}), 404
                cur.execute(
                    "UPDATE " + portal_db._q(DELIVERIES_TABLE) +
                    " SET attempts = 0, dead_at = NULL, error = NULL,"
                    " next_attempt_at = NOW()"
                    " WHERE webhook_id = %s AND client_id = %s"
                    " AND delivered_at IS NULL AND attempts >= %s"
                    " RETURNING id",
                    (webhook_id, client_id, MAX_ATTEMPTS),
                )
                replayed = len(portal_db.rows(cur))
                if replayed:
                    portal_db.log_action(
                        cur, client_id, "webhooks.replayed", "customer_user",
                        principal.get("user_id"), None,
                        "Webhook " + str(webhook_id) + ": " + str(replayed)
                        + " failed deliveries re-queued.",
                    )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "webhook replay")[0]), 503
    return jsonify({"ok": True, "replayed": replayed}), 200


def _sign(secret: str, body: str) -> str:
    secret = portal_vault.unseal(secret)  # §223: stored sealed
    return hmac.new(secret.encode("utf-8"), body.encode("utf-8"),
                    hashlib.sha256).hexdigest()


def _http_post(url: str, headers: Dict[str, str], body: str, timeout: int = 5):
    """Isolated for tests: perform the outbound POST."""
    return urlrequest.urlopen(
        urlrequest.Request(url, data=body.encode("utf-8"),
                           headers=headers, method="POST"),
        timeout=timeout,
    )


def _enqueue_outbox(cur, client_id: int) -> int:
    """Copy new outbox rows into deliveries, one cursor per endpoint.

    Each enabled endpoint reads ``portal_action_log`` past its own
    ``last_log_id`` filtered to the events it subscribes to, so an
    endpoint never waits behind events it does not want (the old shared
    NOT EXISTS scan could starve) and the cursor makes enqueue O(new)."""
    cur.execute(
        "SELECT id, events, last_log_id FROM " + portal_db._q(WEBHOOKS_TABLE) +
        " WHERE client_id = %s AND enabled IS TRUE",
        (client_id,),
    )
    queued = 0
    for hook in portal_db.rows(cur):
        actions = _subscribed_actions(str(hook.get("events") or "all"))
        if not actions:
            continue
        cur.execute(
            "SELECT a.id, a.action, a.conversation_id, a.note, a.created_at"
            " FROM portal_action_log a"
            " WHERE a.client_id = %s AND a.action = ANY(%s) AND a.id > %s"
            " ORDER BY a.id ASC LIMIT %s",
            (client_id, actions, int(hook.get("last_log_id") or 0),
             ENQUEUE_PER_TICK),
        )
        logs = portal_db.rows(cur)
        if not logs:
            continue
        for log in logs:
            event = EVENT_ACTIONS.get(str(log.get("action") or ""))
            if event is None:
                continue
            payload = {
                "event": event,
                "action": log.get("action"),
                "conversation_id": log.get("conversation_id"),
                "note": log.get("note"),
                "at": _iso(log.get("created_at")),
            }
            cur.execute(
                "INSERT INTO " + portal_db._q(DELIVERIES_TABLE) +
                " (webhook_id, client_id, event, action_log_id, payload)"
                " VALUES (%s, %s, %s, %s, %s)"
                " ON CONFLICT (webhook_id, action_log_id) DO NOTHING",
                (hook.get("id"), client_id, event, log.get("id"),
                 json.dumps(payload)),
            )
            queued += 1
        cur.execute(
            "UPDATE " + portal_db._q(WEBHOOKS_TABLE) +
            " SET last_log_id = %s WHERE id = %s AND client_id = %s",
            (max(int(log.get("id") or 0) for log in logs), hook.get("id"),
             client_id),
        )
    return queued


def _notify_dead(client_id: int, event: str, url: str, error: str) -> None:
    """One owner notification per dead letter (portal_notify opens its own
    connection and never raises)."""
    try:
        import portal_notify

        portal_notify.notify(
            client_id, "delivery", "Webhook delivery failed: " + str(event),
            ("Gave up after " + str(MAX_ATTEMPTS) + " attempts to "
             + str(url)[:120] + (" - " + error if error else "")
             + ". Replay it from Integrations -> Webhooks.")[:500],
            severity="normal", dedupe_key="webhook-dead:" + str(url)[:80])
    except Exception:
        pass


def deliver_pending_webhooks(cur, client_id: int, conn) -> int:
    """Enqueue new outbox events for matching webhooks, then attempt
    deliveries (retry with backoff; dead letter after MAX_ATTEMPTS)."""
    try:
        portal_db.ensure_tables()
        _ensure_webhook_tables(conn)
    except Exception:
        return 0
    try:
        queued = _enqueue_outbox(cur, client_id)
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
        dead: list = []
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
                attempts = int(row.get("attempts") or 0) + 1
                cur.execute(
                    "UPDATE " + portal_db._q(DELIVERIES_TABLE) +
                    " SET status_code = %s, error = %s, attempts = attempts + 1,"
                    " next_attempt_at = NOW() + make_interval(mins => %s),"
                    " dead_at = CASE WHEN attempts + 1 >= %s THEN NOW()"
                    " ELSE NULL END"
                    " WHERE id = %s",
                    (status_code if status_code else None, error_text,
                     2 * attempts, MAX_ATTEMPTS, row.get("id")),
                )
                if attempts >= MAX_ATTEMPTS:
                    dead.append((row.get("event"), row.get("url"),
                                 error_text or ("HTTP " + str(status_code))))
        if pending or queued:
            conn.commit()
        for event, url, error_text in dead:
            _notify_dead(client_id, str(event), str(url), str(error_text))
        return delivered
    except Exception as error:
        logger.warning("webhook delivery pass failed: %s", error)
        return 0
