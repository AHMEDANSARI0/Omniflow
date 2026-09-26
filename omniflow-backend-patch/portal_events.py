"""Event core v1: idempotent inbound events and a reliable command queue.

Why this module exists
----------------------
Before this module the platform depended on two silent assumptions:

1. A webhook replay (bridge retry, network blip) would create a duplicate
   inbound message — and possibly duplicate automated replies.
2. A command that failed on the connector stayed ``failed`` forever; the only
   trace was a note on the thread row. Nobody retried it.

This module fixes both with plain Postgres — no Redis, no Celery, no extra
infrastructure (the platform must stay lightweight):

* ``portal_events`` records every inbound message lifecycle. A provider
  message id (when the connector supplies one) is deduplicated forever; a
  content fingerprint is deduplicated within a replay window, so a customer
  legitimately sending "ok" twice still gets two conversations rows.
* Command rows gain attempts / next_attempt_at / provider_message_id /
  error columns. A failed ack schedules an exponential-backoff retry; after
  ``OF_EVENT_MAX_ATTEMPTS`` the command is marked ``dead`` and shows up in
  Settings -> Deliveries where the owner can replay it manually.

Retry requeueing rides the existing bridge poll (``list_commands`` calls
``requeue_due_commands``), so no background worker thread is needed and the
connector protocol is unchanged.
"""

import hashlib
import json
import os
from typing import Any, Dict, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_db
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
)

bp = Blueprint("portal_events", __name__, url_prefix="/api/v1/portal")

EVENTS_TABLE = os.environ.get("OF_EVENTS_TABLE", "portal_events")
CMD_TABLE = portal_db.CMD_TABLE
MSGS_TABLE = portal_db.MSGS_TABLE

#: Replay window for content fingerprints (seconds). Provider ids are kept
#: forever — a real provider never reuses a message id.
REPLAY_WINDOW_SECONDS = int(
    os.environ.get("OF_EVENT_REPLAY_WINDOW_SECONDS", "600") or 600
)
#: How many delivery attempts before a command is declared dead.
MAX_ATTEMPTS = int(os.environ.get("OF_EVENT_MAX_ATTEMPTS", "5") or 5)
#: First retry delay; doubles every attempt, capped at MAX_DELAY_SECONDS.
BASE_DELAY_SECONDS = int(
    os.environ.get("OF_EVENT_RETRY_BASE_SECONDS", "30") or 30
)
MAX_DELAY_SECONDS = int(
    os.environ.get("OF_EVENT_RETRY_MAX_SECONDS", "900") or 900
)

_DEAD = "dead"

_DDL_READY = False

_DDL = """
CREATE TABLE IF NOT EXISTS portal_events (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'inbound_message',
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  claimed_by TEXT,
  trace_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_events_provider
  ON portal_events (client_id, idempotency_key)
  WHERE idempotency_key LIKE 'pid:%';
CREATE INDEX IF NOT EXISTS idx_portal_events_client
  ON portal_events (client_id, id, status);
ALTER TABLE portal_connector_commands
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE portal_connector_commands
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE portal_connector_commands
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE portal_connector_commands
  ADD COLUMN IF NOT EXISTS error_code TEXT;
ALTER TABLE portal_connector_commands
  ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE portal_connector_commands
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE portal_events
  ADD COLUMN IF NOT EXISTS claimed_by TEXT;
CREATE INDEX IF NOT EXISTS idx_portal_cmds_retry
  ON portal_connector_commands (client_id, status, next_attempt_at);
"""


def _ensure_ddl(cur) -> None:
    """Create/upgrade the event tables once per process (lazy DDL)."""
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    _DDL_READY = True


# ---------------------------------------------------------------------------
# Inbound messages: idempotency gate + lifecycle rows
# ---------------------------------------------------------------------------

def _content_fingerprint(client_id: int, item: Dict[str, Any]) -> str:
    """Stable fingerprint of an inbound message's business content."""
    raw = "|".join(
        str(item.get(field) or "")
        for field in ("channel", "from", "direction", "body")
    )
    digest = hashlib.sha256(
        (str(client_id) + "|" + raw).encode("utf-8")
    ).hexdigest()
    return "sha:" + digest


def _event_key(client_id: int, item: Dict[str, Any]) -> Tuple[str, str]:
    """(idempotency_key, uses_window) for one inbound message."""
    provider_id = item.get("id")
    if isinstance(provider_id, (str, int)) and str(provider_id).strip():
        return "pid:" + str(provider_id).strip(), ""
    return _content_fingerprint(client_id, item), (
        " AND created_at > NOW() - INTERVAL '"
        + str(max(1, REPLAY_WINDOW_SECONDS)) + " seconds'"
    )


def record_inbound(cur, client_id: int, item: Dict[str, Any]) -> bool:
    """Return True when this message is new and should be processed.

    Dedupe rules:
      * provider id present  -> permanent uniqueness per tenant;
      * no provider id       -> unique within REPLAY_WINDOW_SECONDS so a
        webhook replay cannot double-process, while the customer sending the
        same text again later still works.
    The gate fails OPEN: any database error lets the message through, because
    losing a customer message is worse than a rare duplicate.
    """
    key, window_sql = _event_key(client_id, item)
    try:
        _ensure_ddl(cur)
        cur.execute(
            "SELECT id FROM " + portal_db._q(EVENTS_TABLE) +
            " WHERE client_id = %s AND idempotency_key = %s" + window_sql +
            " ORDER BY id DESC LIMIT 1",
            (client_id, key),
        )
        if portal_db.rows(cur):
            return False
        cur.execute(
            "INSERT INTO " + portal_db._q(EVENTS_TABLE) +
            " (client_id, event_type, idempotency_key, status, payload)"
            " VALUES (%s, 'inbound_message', %s, 'received', %s)",
            (client_id, key, json.dumps(item, default=str)),
        )
        return True
    except Exception:
        # Fail open — dedupe must never swallow a customer message.
        return True


def mark_inbound_done(cur, client_id: int, item: Dict[str, Any]) -> None:
    """Flag the event row as fully processed (best effort)."""
    key, _ = _event_key(client_id, item)
    try:
        cur.execute(
            "UPDATE " + portal_db._q(EVENTS_TABLE) +
            " SET status = 'done', updated_at = NOW()"
            " WHERE client_id = %s AND idempotency_key = %s",
            (client_id, key),
        )
    except Exception:
        pass


def note_claim(cur, client_id: int, item: Dict[str, Any],
               hook: str) -> None:
    """Record which automation claimed the customer reply (one-reply law)."""
    key, _ = _event_key(client_id, item)
    try:
        cur.execute(
            "UPDATE " + portal_db._q(EVENTS_TABLE) +
            " SET claimed_by = %s, updated_at = NOW()"
            " WHERE client_id = %s AND idempotency_key = %s",
            (hook, client_id, key),
        )
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Outbound commands: retry scheduling + delivery status
# ---------------------------------------------------------------------------

def backoff_delay_seconds(attempts: int) -> int:
    """Exponential backoff: base * 2^(n-1), capped."""
    expo = max(0, int(attempts) - 1)
    return min(BASE_DELAY_SECONDS * (2 ** expo), MAX_DELAY_SECONDS)


def on_command_ack(
    cur,
    client_id: int,
    command_id: int,
    ok: bool,
    note: Optional[str],
    provider_message_id: Optional[str] = None,
) -> None:
    """Update delivery bookkeeping after the connector acks a command.

    Runs in the SAME transaction as the ack UPDATE (called before commit).
      * success: stamp the provider message id when the adapter supplied one;
      * failure: schedule a retry with exponential backoff, or mark the
        command dead once MAX_ATTEMPTS is exhausted.
    Best effort: bookkeeping problems never fail the ack itself.
    """
    try:
        _ensure_ddl(cur)
        if ok:
            cur.execute(
                "UPDATE " + portal_db._q(CMD_TABLE) +
                " SET provider_message_id = COALESCE(%s, provider_message_id),"
                " error_code = NULL, error_message = NULL,"
                " next_attempt_at = NULL, updated_at = NOW()"
                " WHERE id = %s AND client_id = %s",
                (provider_message_id, command_id, client_id),
            )
            return
        cur.execute(
            "UPDATE " + portal_db._q(CMD_TABLE) +
            " SET attempts = attempts + 1,"
            " error_code = CASE WHEN attempts + 1 >= %s"
            "   THEN 'max_attempts' ELSE error_code END,"
            " error_message = %s,"
            " status = CASE WHEN attempts + 1 >= %s"
            "   THEN '" + _DEAD + "' ELSE status END,"
            " next_attempt_at = CASE WHEN attempts + 1 >= %s"
            "   THEN NULL ELSE NOW()"
            "   + MAKE_INTERVAL(secs => %s) END,"
            " updated_at = NOW()"
            " WHERE id = %s AND client_id = %s",
            (
                MAX_ATTEMPTS, note, MAX_ATTEMPTS, MAX_ATTEMPTS,
                backoff_delay_seconds(_current_attempts(cur, client_id,
                                                       command_id) + 1),
                command_id, client_id,
            ),
        )
        try:
            import portal_alerts

            portal_alerts.alert_dead_command(
                cur, client_id, command_id, note
            )
        except Exception:
            pass
    except Exception:
        pass


def _current_attempts(cur, client_id: int, command_id: int) -> int:
    cur.execute(
        "SELECT attempts FROM " + portal_db._q(CMD_TABLE) +
        " WHERE id = %s AND client_id = %s",
        (command_id, client_id),
    )
    rows = portal_db.rows(cur)
    if rows and isinstance(rows[0].get("attempts"), int):
        return rows[0]["attempts"]
    return 0


def requeue_due_commands(cur, client_id: int) -> int:
    """Put failed commands whose backoff elapsed back into the poll queue.

    Called from the connector command poll (the bridge polls every ~15s, so
    no timer thread is needed). Returns the number of requeued commands.
    """
    try:
        _ensure_ddl(cur)
        cur.execute(
            "UPDATE " + portal_db._q(CMD_TABLE) +
            " SET status = 'pending', updated_at = NOW()"
            " WHERE client_id = %s AND status = 'failed'"
            " AND attempts < %s"
            " AND next_attempt_at IS NOT NULL AND next_attempt_at <= NOW()",
            (client_id, MAX_ATTEMPTS),
        )
        return getattr(cur, "rowcount", 0) or 0
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# Owner-facing deliveries API (Settings -> Deliveries)
# ---------------------------------------------------------------------------

def _principal_or_error():
    """Owner/staff session required (API keys cannot touch deliveries)."""
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": str(error)}}), 503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}), 401)
    if principal.get("via_api_key"):
        return None, (jsonify({"error": {"code": "forbidden",
                                         "message": "Owner sign-in required."}}),
                      403)
    return principal, None


_DELIVERY_ROW_SQL = (
    "SELECT id, '{kind}' AS kind, action AS label, status, attempts,"
    " next_attempt_at, error_code, error_message, provider_message_id,"
    " result_note, channel, created_at, updated_at"
    " FROM {cmd}"
    " WHERE client_id = %s{extra}"
)


def _serialize(row: Dict[str, Any]) -> Dict[str, Any]:
    def _iso(value):
        return value.isoformat() if hasattr(value, "isoformat") else None

    return {
        "id": row.get("id"),
        "kind": row.get("kind"),
        "label": row.get("label"),
        "status": row.get("status"),
        "attempts": row.get("attempts"),
        "nextAttemptAt": _iso(row.get("next_attempt_at")),
        "errorCode": row.get("error_code"),
        "errorMessage": row.get("error_message") or row.get("result_note"),
        "providerMessageId": row.get("provider_message_id"),
        "channel": row.get("channel"),
        "createdAt": _iso(row.get("created_at")),
        "updatedAt": _iso(row.get("updated_at")),
    }


@bp.get("/deliveries")
def list_deliveries():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    status = (request.args.get("status") or "").strip().lower()
    if status and status not in ("pending", "failed", "dead", "done"):
        return jsonify({"error": {
            "code": "bad_request",
            "message": "status pending|failed|dead|done hon.",
        }}), 400

    client_id = principal.get("client_id")
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                cur.execute(
                    "SELECT status, COUNT(*) AS count FROM "
                    + portal_db._q(CMD_TABLE) +
                    " WHERE client_id = %s GROUP BY status",
                    (client_id,),
                )
                counts = {row["status"]: row["count"]
                          for row in portal_db.rows(cur)}
                extra = " AND status = '" + status + "'" if status else ""
                cur.execute(
                    _DELIVERY_ROW_SQL.format(
                        kind="command",
                        cmd=portal_db._q(CMD_TABLE),
                        extra=extra,
                    ) +
                    " ORDER BY id DESC LIMIT 100",
                    (client_id,),
                )
                rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "deliveries")[0]), 503

    return jsonify({
        "deliveries": [_serialize(row) for row in rows],
        "counts": {
            "pending": counts.get("pending", 0),
            "failed": counts.get("failed", 0),
            "dead": counts.get("dead", 0),
            "done": counts.get("done", 0),
        },
    }), 200


@bp.post("/deliveries/replay")
def replay_delivery():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    payload = request.get_json(silent=True) or {}
    delivery_id = payload.get("id")
    if isinstance(delivery_id, bool) or not isinstance(delivery_id, int) \
            or delivery_id <= 0:
        return jsonify({"error": {
            "code": "bad_request",
            "message": "id (positive int) required.",
        }}), 400

    client_id = principal.get("client_id")
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                cur.execute(
                    "UPDATE " + portal_db._q(CMD_TABLE) +
                    " SET status = 'pending', attempts = 0,"
                    " next_attempt_at = NULL, error_code = NULL,"
                    " error_message = NULL, updated_at = NOW()"
                    " WHERE id = %s AND client_id = %s"
                    " AND status IN ('failed', 'dead')"
                    " RETURNING id",
                    (delivery_id, client_id),
                )
                revived = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "replay")[0]), 503

    if not revived:
        return jsonify({"error": {
            "code": "not_found",
            "message": "No replayable delivery found.",
        }}), 404
    return jsonify({"ok": True}), 200
