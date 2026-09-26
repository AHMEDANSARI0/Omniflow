"""Data safety: owner-only full JSON export (every table, bounded) and
retention controls (auto-close idle conversations, purge rejected action
requests). Everything is owner-only and audited."""
import logging

from flask import Blueprint, Response, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_checkout
import portal_db
from typing import Tuple

bp = Blueprint("portal_datasafety", __name__, url_prefix="/api/v1/portal")
logger = logging.getLogger(__name__)

RETENTION_TABLE = "portal_retention_settings"
_RETENTION_DDL_READY = False
DEFAULT_CLOSE_IDLE_DAYS = 14
DEFAULT_PURGE_REJECTED_DAYS = 30
EXPORT_CONV_CAP = 500
EXPORT_MSGS_PER_CONV = 20
EXPORT_LINK_CAP = 500


def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": "Try again shortly."}}),
                      503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}),
                      401)
    return principal, None


def _ensure_retention_table(conn) -> None:
    global _RETENTION_DDL_READY
    if _RETENTION_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(RETENTION_TABLE) +
            " (client_id BIGINT PRIMARY KEY,"
            " close_idle_days INTEGER NOT NULL DEFAULT %d,"
            " purge_rejected_days INTEGER NOT NULL DEFAULT %d,"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
            % (DEFAULT_CLOSE_IDLE_DAYS, DEFAULT_PURGE_REJECTED_DAYS)
        )
    conn.commit()
    _RETENTION_DDL_READY = True


def _load_retention(cur, client_id):
    cur.execute(
        "SELECT close_idle_days, purge_rejected_days FROM "
        + portal_db._q(RETENTION_TABLE) + " WHERE client_id = %s LIMIT 1",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    if not rows:
        return {"close_idle_days": DEFAULT_CLOSE_IDLE_DAYS,
                "purge_rejected_days": DEFAULT_PURGE_REJECTED_DAYS}
    return {"close_idle_days": int(rows[0].get("close_idle_days")
                                   or DEFAULT_CLOSE_IDLE_DAYS),
            "purge_rejected_days": int(rows[0].get("purge_rejected_days")
                                       or DEFAULT_PURGE_REJECTED_DAYS)}


@bp.get("/data/retention")
def get_retention():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_retention_table(conn)
            with conn.cursor() as cur:
                data = _load_retention(cur, principal["client_id"])
        finally:
            conn.close()
    except Exception as error:
        logger.warning("retention read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "retention read")[0]), 503
    return jsonify({"retention": data}), 200


@bp.put("/data/retention")
def save_retention():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    forbidden = portal_checkout.ensure_money_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}

    def _days(raw, default):
        try:
            value = int(raw)
        except (TypeError, ValueError):
            return default
        return min(max(value, 1), 90)

    close_idle = _days(payload.get("close_idle_days"),
                       DEFAULT_CLOSE_IDLE_DAYS)
    purge_rejected = _days(payload.get("purge_rejected_days"),
                           DEFAULT_PURGE_REJECTED_DAYS)
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_retention_table(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(RETENTION_TABLE) +
                    " (client_id, close_idle_days, purge_rejected_days,"
                    " updated_at) VALUES (%s, %s, %s, NOW())"
                    " ON CONFLICT (client_id) DO UPDATE SET"
                    " close_idle_days = EXCLUDED.close_idle_days,"
                    " purge_rejected_days ="
                    " EXCLUDED.purge_rejected_days, updated_at = NOW()",
                    (principal["client_id"], close_idle, purge_rejected),
                )
                portal_db.log_action(
                    cur, principal["client_id"], "data.retention",
                    "customer_user", principal.get("user_id"), None,
                    ("Retention close " + str(close_idle) + "d purge "
                     + str(purge_rejected) + "d")[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("retention save failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "retention save")[0]), 503
    return jsonify({"ok": True, "retention": {
        "close_idle_days": close_idle,
        "purge_rejected_days": purge_rejected}}), 200


def enforce_retention(cur, client_id: int, close_idle_days: int,
                      purge_rejected_days: int) -> Tuple[int, int]:
    """Close conversations idle longer than close_idle_days and delete
    rejected action requests older than purge_rejected_days.
    Returns (closed, purged)."""
    cur.execute(
        "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
        " SET status = 'closed', updated_at = NOW()"
        " WHERE client_id = %s AND status = 'open'"
        " AND updated_at <= NOW() - (%s || ' days')::interval"
        " RETURNING id",
        (client_id, str(close_idle_days)),
    )
    closed = len(portal_db.rows(cur))
    cur.execute(
        "DELETE FROM portal_action_requests"
        " WHERE client_id = %s AND status = 'rejected'"
        " AND updated_at <= NOW() - (%s || ' days')::interval",
        (client_id, str(purge_rejected_days)),
    )
    purged = cur.rowcount or 0
    if closed or purged:
        portal_db.log_action(
            cur, client_id, "data.retention_run", "system", None, None,
            ("Retention closed " + str(closed) + ", purged "
             + str(purged))[:200],
        )
    return closed, purged


@bp.post("/data/retention/run")
def run_retention():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    forbidden = portal_checkout.ensure_money_principal(principal)
    if forbidden is not None:
        return forbidden
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_retention_table(conn)
            with conn.cursor() as cur:
                data = _load_retention(cur, principal["client_id"])
                closed, purged = enforce_retention(
                    cur, principal["client_id"],
                    data["close_idle_days"],
                    data["purge_rejected_days"])
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("retention run failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "retention run")[0]), 503
    return jsonify({"ok": True, "closed": closed, "purged": purged}), 200


@bp.get("/data/export")
def export_data():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    forbidden = portal_checkout.ensure_money_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            portal_checkout._ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT * FROM portal_conversations"
                    " WHERE client_id = %s ORDER BY id DESC LIMIT %s",
                    (client_id, EXPORT_CONV_CAP),
                )
                convs = portal_db.rows(cur)
                messages = []
                for conv in convs[:50]:
                    cur.execute(
                        "SELECT * FROM portal_messages"
                        " WHERE client_id = %s AND conversation_id = %s"
                        " ORDER BY id DESC LIMIT %s",
                        (client_id, conv.get("id"), EXPORT_MSGS_PER_CONV),
                    )
                    for row in portal_db.rows(cur):
                        messages.append(row)
                cur.execute(
                    "SELECT * FROM portal_contacts"
                    " WHERE client_id = %s ORDER BY id DESC LIMIT 1000",
                    (client_id,),
                )
                contacts = portal_db.rows(cur)
                cur.execute(
                    "SELECT * FROM " + portal_db._q(portal_checkout.LINKS_TABLE)
                    + " WHERE client_id = %s ORDER BY id DESC LIMIT %s",
                    (client_id, EXPORT_LINK_CAP),
                )
                links = portal_db.rows(cur)
                cur.execute(
                    "SELECT * FROM portal_return_requests"
                    " WHERE client_id = %s ORDER BY id DESC LIMIT 500",
                    (client_id,),
                )
                returns = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("data export failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "data export")[0]), 503
    payload = {
        "exported_at": portal_checkout._iso(
            __import__("datetime").datetime.now()) or "",
        "counts": {
            "conversations": len(convs),
            "messages": len(messages),
            "contacts": len(contacts),
            "checkout_links": len(links),
            "returns": len(returns),
        },
        "conversations": convs,
        "messages": messages,
        "contacts": contacts,
        "checkout_links": links,
        "returns": returns,
    }
    body = jsonify(payload).get_data()
    stamp = portal_checkout._iso(
        __import__("datetime").datetime.now()) or "export"
    filename = "omniflow-export-" + stamp[:10] + ".json"
    return Response(
        body,
        status=200,
        headers={
            "Content-Type": "application/json",
            "Content-Disposition": 'attachment; filename="' + filename + '"',
            "Cache-Control": "no-store",
        },
    )
