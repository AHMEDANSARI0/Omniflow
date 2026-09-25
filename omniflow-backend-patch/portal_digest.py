"""Owner daily digest: once a day, the workspace owner gets a short
WhatsApp summary of their own business - orders paid today (count +
revenue), open carts, returns today. Deterministic, tick-based (rides
the connector poll like scheduled broadcasts and cart recovery), zero
AI. Recovery-style feature: everything defaults OFF and every failure
degrades to silence, never an error."""

import logging
from typing import Optional

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db
import portal_growth

bp = Blueprint("portal_digest", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

DIGEST_TABLE = "portal_digest_settings"
DDL_READY = False
DEFAULT_HOUR = 9
MIN_HOUR = 6
MAX_HOUR = 21



def _ensure_tables(conn) -> None:
    global DDL_READY
    if DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(DIGEST_TABLE) +
            " (client_id BIGINT PRIMARY KEY,"
            " owner_contact TEXT NOT NULL DEFAULT '',"
            " enabled BOOLEAN NOT NULL DEFAULT FALSE,"
            " hour INTEGER NOT NULL DEFAULT %d,"
            " last_sent_date DATE,"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())" % DEFAULT_HOUR
        )
    conn.commit()
    DDL_READY = True


def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (
            jsonify({"error": {"code": "portal_unavailable",
                               "message": str(error)}}),
            503,
        )
    if principal is None:
        return None, (
            jsonify({"error": {"code": "unauthorized",
                               "message": "Sign in required."}}),
            401,
        )
    return principal, None


def _load_settings(cur, client_id):
    """Digest settings. Absent row or unreadable table -> OFF defaults."""
    try:
        cur.execute(
            "SELECT owner_contact, enabled, hour, last_sent_date FROM "
            + portal_db._q(DIGEST_TABLE) + " WHERE client_id = %s",
            (client_id,),
        )
        rows = portal_db.rows(cur)
    except Exception:
        rows = []
    row = rows[0] if rows else {}
    try:
        hour = int(row.get("hour"))
    except (TypeError, ValueError):
        hour = DEFAULT_HOUR
    if not MIN_HOUR <= hour <= MAX_HOUR:
        hour = DEFAULT_HOUR
    return {
        "owner_contact": str(row.get("owner_contact") or "").strip()[:100],
        "enabled": bool(row.get("enabled", False)),
        "hour": hour,
        "last_sent_date": str(row.get("last_sent_date") or ""),
    }


def _count(cur, client_id, sql, params):
    """Tiny COUNT helper: any failure -> 0 (metrics never break the send)."""
    try:
        cur.execute(sql, params)
        rows = portal_db.rows(cur)
        return int((rows[0].get("n") if rows else 0) or 0)
    except Exception:
        return 0


def _sum_total(cur, client_id):
    try:
        cur.execute(
            "SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS amount FROM "
            + portal_db._q("portal_checkout_links") +
            " WHERE client_id = %s"
            " AND status IN ('paid', 'shipped', 'delivered')"
            " AND updated_at >= date_trunc('day', NOW())",
            (client_id,),
        )
        rows = portal_db.rows(cur)
        if not rows:
            return 0, 0.0
        return (int(rows[0].get("n") or 0),
                float(rows[0].get("amount") or 0))
    except Exception:
        return 0, 0.0


def _returns_today(cur, client_id):
    try:
        cur.execute("SELECT to_regclass(%s) AS oid",
                    ("portal_return_requests",))
        rows = portal_db.rows(cur)
        if not rows or not rows[0].get("oid"):
            return 0
        cur.execute(
            "SELECT COUNT(*) AS n FROM portal_return_requests"
            " WHERE client_id = %s"
            " AND created_at >= date_trunc('day', NOW())",
            (client_id,),
        )
        rows = portal_db.rows(cur)
        return int((rows[0].get("n") if rows else 0) or 0)
    except Exception:
        return 0


def materialize_due_digest(cur, client_id, conn) -> int:
    """Send today's digest if it is enabled, late enough in the day, and
    not already sent. Returns 1 when a digest was queued, else 0.
    Never raises for missing tables - the digest silently stays off."""
    settings = _load_settings(cur, client_id)
    if not settings["enabled"] or not settings["owner_contact"]:
        return 0
    hour_now = _current_hour(cur)
    if hour_now is not None and hour_now < settings["hour"]:
        return 0
    if settings["last_sent_date"] == _today(cur):
        return 0
    paid_count, paid_amount = _sum_total(cur, client_id)
    open_count = _count(
        cur, client_id,
        "SELECT COUNT(*) AS n FROM portal_checkout_links"
        " WHERE client_id = %s AND status = 'open'",
        (client_id,),
    )
    returns_count = _returns_today(cur, client_id)
    body = ("Daily digest: %d order(s) paid today (Rs %s), %d cart(s) still"
            " open, %d return(s) today."
            % (paid_count, ("%.0f" % paid_amount), open_count,
               returns_count))
    try:
        portal_growth._send_command(
            cur, client_id, settings["owner_contact"], "", body,
            "owner_digest",
        )
        portal_db.log_action(
            cur,
            client_id,
            "digest.sent",
            "system",
            None,
            None,
            ("Daily digest queued (" + body[:120] + ")")[:200],
        )
        cur.execute(
            "UPDATE " + portal_db._q(DIGEST_TABLE) +
            " SET last_sent_date = CURRENT_DATE WHERE client_id = %s",
            (client_id,),
        )
        conn.commit()
        return 1
    except Exception as send_error:
        logger.warning("digest send failed: %s", send_error)
        return 0


def _current_hour(cur) -> Optional[int]:
    try:
        cur.execute("SELECT EXTRACT(HOUR FROM NOW()) AS h")
        rows = portal_db.rows(cur)
        return int((rows[0].get("h") if rows else 0) or 0)
    except Exception:
        return None


def _today(cur) -> str:
    try:
        cur.execute("SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS d")
        rows = portal_db.rows(cur)
        return str((rows[0].get("d") if rows else "") or "")
    except Exception:
        return ""


@bp.get("/digest/settings")
def get_digest_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_tables(conn)
            with conn.cursor() as cur:
                settings = _load_settings(cur, principal["client_id"])
        finally:
            conn.close()
    except Exception as error:
        logger.warning("digest settings read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "digest settings")[0]), 503
    return jsonify({"ok": True, "settings": {
        "enabled": settings["enabled"],
        "owner_contact": settings["owner_contact"],
        "hour": settings["hour"],
    }}), 200


@bp.put("/digest/settings")
def save_digest_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    settings_in = payload.get("settings")
    settings_in = settings_in if isinstance(settings_in, dict) else {}
    enabled = settings_in.get("enabled") is True
    owner_contact = str(settings_in.get("owner_contact") or "").strip()[:100]
    if enabled and not owner_contact:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Your WhatsApp number is"
                                             " required to enable the"
                                             " digest."}}), 400
    try:
        hour = int(settings_in.get("hour"))
    except (TypeError, ValueError):
        hour = DEFAULT_HOUR
    if not MIN_HOUR <= hour <= MAX_HOUR:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Digest hour must be between"
                                             " 6 and 21."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(DIGEST_TABLE) +
                    " (client_id, owner_contact, enabled, hour, updated_at)"
                    " VALUES (%s, %s, %s, %s, NOW())"
                    " ON CONFLICT (client_id) DO UPDATE SET"
                    " owner_contact = EXCLUDED.owner_contact,"
                    " enabled = EXCLUDED.enabled,"
                    " hour = EXCLUDED.hour,"
                    " updated_at = NOW()",
                    (principal["client_id"], owner_contact, enabled, hour),
                )
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "digest.settings",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Digest settings: enabled="
                     + ("on" if enabled else "off")
                     + " hour=" + str(hour))[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("digest settings save failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "digest settings")[0]), 503
    return jsonify({"ok": True}), 200
