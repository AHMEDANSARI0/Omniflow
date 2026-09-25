"""Revenue-critical failure alerts (V2 B5): in-app bell + badge.

When a delivery dies (the connector exhausted its retries on a COD
confirmation, a checkout send, ...), the owner should not have to find a
thread note - the dashboard bell shows an alert. One small table, one
settings row per tenant, no email infra: alerts appear in the web bell
(AlertsBell component) and the Daily Brief "Needs attention" block.

Design laws:
  * raise_alert is FAIL-SILENT and DEDUPED - an unread alert with the same
    (kind, dedupe_key) suppresses duplicates, so a retrying command cannot
    flood the bell;
  * severity "revenue" for revenue-critical actions (COD confirmations,
    checkout sends), "normal" otherwise;
  * every tenant can switch alerts off (portal_alerts_settings; a missing
    row means enabled) and OF_ALERTS=0 is the global kill switch;
  * the owner API is human-only (API keys cannot read or ack alerts).
"""

import logging
import os
from typing import Any, Dict, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_db
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
)

logger = logging.getLogger("omniflow.portal-alerts")

bp = Blueprint("portal_alerts", __name__, url_prefix="/api/v1/portal")

ALERTS_TABLE = os.environ.get("OF_ALERTS_TABLE", "portal_alerts")
SETTINGS_TABLE = "portal_alerts_settings"
#: Global kill switch (env). Per-tenant toggles live in the settings table.
ALERTS_ENABLED = os.environ.get(
    "OF_ALERTS", "1").strip().lower() not in ("0", "false", "no", "off")
#: Only the N most recent alerts are returned by the list endpoint.
LIST_LIMIT = 50

REVENUE_ACTIONS = ("cod", "checkout", "order", "payment")

_DDL_READY = False

_DDL = """
CREATE TABLE IF NOT EXISTS portal_alerts (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'normal',
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_alerts_unread
  ON portal_alerts (client_id, is_read, id DESC);
CREATE TABLE IF NOT EXISTS portal_alerts_settings (
  client_id BIGINT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""


def _ensure_ddl(cur) -> None:
    """Create the alert tables once per process (lazy DDL)."""
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    _DDL_READY = True


def _principal_or_error():
    """Owner/staff session required (API keys cannot touch alerts)."""
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": str(error)}}), 503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}),
                      401)
    if principal.get("via_api_key"):
        return None, (jsonify({"error": {"code": "forbidden",
                                         "message": "Owner sign-in required."}}),
                      403)
    return principal, None


def alerts_on(cur, client_id: int) -> bool:
    """Global env switch AND the per-tenant toggle (missing row = on)."""
    if not ALERTS_ENABLED:
        return False
    cur.execute(
        "SELECT enabled FROM " + portal_db._q(SETTINGS_TABLE) +
        " WHERE client_id = %s",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    return bool(rows[0].get("enabled")) if rows else True


def raise_alert(cur, client_id: int, kind: str, title: str,
                detail: str = "", severity: str = "normal",
                dedupe_key: str = "") -> Optional[int]:
    """Insert one alert unless the same unread alert already exists.

    Returns the new alert id, or None when suppressed/disabled/failed.
    Never raises - alerting must not break the caller's transaction.
    """
    try:
        _ensure_ddl(cur)
        if not alerts_on(cur, client_id):
            return None
        if dedupe_key:
            cur.execute(
                "SELECT 1 FROM " + portal_db._q(ALERTS_TABLE) +
                " WHERE client_id = %s AND kind = %s AND dedupe_key = %s"
                " AND is_read = FALSE LIMIT 1",
                (client_id, kind, dedupe_key),
            )
            if portal_db.rows(cur):
                return None
        cur.execute(
            "INSERT INTO " + portal_db._q(ALERTS_TABLE) +
            " (client_id, kind, dedupe_key, severity, title, detail)"
            " VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
            (client_id, kind, dedupe_key, severity, title[:200],
             detail[:500]),
        )
        rows = portal_db.rows(cur)
        return int((rows[0] if rows else {}).get("id") or 0) or None
    except Exception as error:
        logger.warning("raise_alert failed: %s", error)
        return None


def alert_dead_command(cur, client_id: int, command_id: int,
                       note: str = "") -> Optional[int]:
    """Raise the bell alert when a delivery ends up dead.

    Revenue-critical actions (COD confirmations, checkout/order/payment
    sends) get severity "revenue"; everything else "normal". Suppressed
    unless the command really is dead (a retrying failure is normal).
    """
    try:
        cur.execute(
            "SELECT action, status, error_message FROM " +
            portal_db._q(portal_db.CMD_TABLE) +
            " WHERE id = %s AND client_id = %s LIMIT 1",
            (command_id, client_id),
        )
        rows = portal_db.rows(cur)
        row = rows[0] if rows else {}
        if (row.get("status") or "") != "dead":
            return None
        action = str(row.get("action") or "")
        critical = action.startswith(REVENUE_ACTIONS)
        return raise_alert(
            cur,
            client_id,
            "delivery_dead",
            ("Delivery failed: " + (action or "message")
             + " #" + str(command_id)),
            str(note or row.get("error_message") or "")[:500],
            "revenue" if critical else "normal",
            dedupe_key="cmd:" + str(command_id),
        )
    except Exception as error:
        logger.warning("alert_dead_command failed: %s", error)
        return None


def unread_count(cur, client_id: int) -> int:
    """Number of unread alerts (best effort; 0 on any problem)."""
    try:
        _ensure_ddl(cur)
        cur.execute(
            "SELECT COUNT(*) AS n FROM " + portal_db._q(ALERTS_TABLE) +
            " WHERE client_id = %s AND is_read = FALSE",
            (client_id,),
        )
        rows = portal_db.rows(cur)
        return int((rows[0] if rows else {}).get("n") or 0)
    except Exception:
        return 0


def _iso(value: Any) -> Optional[str]:
    """Timestamp -> ISO string (None stays None; tolerant of strings)."""
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value) or None


def _alert_public(row: Dict[str, Any]) -> dict:
    return {
        "id": int(row.get("id") or 0),
        "kind": str(row.get("kind") or ""),
        "severity": str(row.get("severity") or "normal"),
        "title": str(row.get("title") or ""),
        "detail": str(row.get("detail") or ""),
        "is_read": bool(row.get("is_read")),
        "created_at": _iso(row.get("created_at")),
    }


@bp.get("/alerts")
def list_alerts():
    """Recent alerts + unread badge count (owner/staff sessions)."""
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal.get("client_id") or 0)
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "SELECT id, kind, dedupe_key, severity, title, detail,"
                " is_read, created_at FROM " + portal_db._q(ALERTS_TABLE) +
                " WHERE client_id = %s ORDER BY id DESC LIMIT %s",
                (client_id, LIST_LIMIT),
            )
            rows = portal_db.rows(cur)
            unread = unread_count(cur, client_id)
        conn.commit()
    finally:
        conn.close()
    return jsonify({"alerts": [_alert_public(r) for r in rows],
                    "unread": unread}), 200


@bp.post("/alerts/read")
def mark_alerts_read():
    """Mark one alert ({"id": N}) or everything ({"all": true}) read."""
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True) or {}
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            if payload.get("all"):
                cur.execute(
                    "UPDATE " + portal_db._q(ALERTS_TABLE) +
                    " SET is_read = TRUE"
                    " WHERE client_id = %s AND is_read = FALSE",
                    (client_id,),
                )
            else:
                try:
                    alert_id = int(payload.get("id") or 0)
                except Exception:
                    alert_id = 0
                if alert_id <= 0:
                    conn.rollback()
                    return jsonify({"error": {
                        "code": "bad_request",
                        "message": "id or all is required.",
                    }}), 400
                cur.execute(
                    "UPDATE " + portal_db._q(ALERTS_TABLE) +
                    " SET is_read = TRUE"
                    " WHERE id = %s AND client_id = %s",
                    (alert_id, client_id),
                )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True}), 200


@bp.get("/alerts/settings")
def get_alert_settings():
    """Per-tenant alerts toggle (missing row reads as enabled)."""
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal.get("client_id") or 0)
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            enabled = alerts_on(cur, client_id)
        conn.commit()
    finally:
        conn.close()
    return jsonify({"settings": {"enabled": enabled}}), 200


@bp.put("/alerts/settings")
def put_alert_settings():
    """Turn alerts on/off for this tenant (the per-tenant rollback)."""
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True) or {}
    enabled = payload.get("enabled")
    if not isinstance(enabled, bool):
        return jsonify({"error": {
            "code": "bad_request",
            "message": "enabled (boolean) is required.",
        }}), 400
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "INSERT INTO " + portal_db._q(SETTINGS_TABLE) +
                " (client_id, enabled, updated_at) VALUES (%s, %s, NOW())"
                " ON CONFLICT (client_id)"
                " DO UPDATE SET enabled = EXCLUDED.enabled,"
                " updated_at = NOW()",
                (client_id, enabled),
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"settings": {"enabled": enabled}}), 200
