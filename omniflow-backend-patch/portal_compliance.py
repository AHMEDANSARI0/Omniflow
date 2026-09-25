"""Compliance flags: STOP/opt-out handling and a merchant-managed opt-out
list. Outbound sends through the connector command queue never target an
opted-out contact (guard lives in portal_growth._send_command)."""

import logging
import re
from typing import Any, Optional

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db

bp = Blueprint("portal_compliance", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

OPTOUT_TABLE = "portal_optouts"

REASONS = ("customer", "merchant")

# Inbound STOP keywords (English + Roman Urdu), matched on word boundaries
# anywhere in the message - a missed STOP is worse than a recoverable
# false positive (the merchant can remove the opt-out).
STOP_RE = re.compile(
    r"\b(stop|unsubscribe|band\s+karo|band\s+kar\s+do|band\s+kro|"
    r"koi\s+message\s+nahi|no\s+more\s+messages?)\b",
    re.I,
)

_COMPLIANCE_DDL_READY = False


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


def _ensure_compliance_tables(conn) -> None:
    global _COMPLIANCE_DDL_READY
    if _COMPLIANCE_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(OPTOUT_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " contact_id TEXT NOT NULL,"
            " reason TEXT NOT NULL DEFAULT 'customer',"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " UNIQUE (client_id, contact_id))"
        )
    conn.commit()
    _COMPLIANCE_DDL_READY = True


@bp.get("/compliance/optouts")
def list_optouts():
    principal, error = _principal_or_error()
    if error:
        return error
    query = (request.args.get("q") or "").strip()[:100]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_compliance_tables(conn)
            with conn.cursor() as cur:
                sql = (
                    "SELECT contact_id, reason, created_at FROM "
                    + portal_db._q(OPTOUT_TABLE) +
                    " WHERE client_id = %s"
                )
                params: list = [principal["client_id"]]
                if query:
                    sql += " AND contact_id ILIKE %s"
                    params.append("%" + query + "%")
                sql += " ORDER BY created_at DESC, contact_id ASC LIMIT 100"
                cur.execute(sql, tuple(params))
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("optouts read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "optouts read")[0]), 503
    return jsonify({"optouts": [
        {
            "contact_id": row.get("contact_id"),
            "reason": row.get("reason") or "customer",
            "created_at": _iso(row.get("created_at")),
        }
        for row in rows
    ]}), 200


@bp.post("/compliance/optouts")
def add_optout():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    contact = str(payload.get("contact") or "").strip()[:100]
    reason = payload.get("reason") or "customer"
    if not contact:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contact is required."}}), 400
    if reason not in REASONS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Pick customer or merchant."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_compliance_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(OPTOUT_TABLE) +
                    " (client_id, contact_id, reason) VALUES (%s, %s, %s)"
                    " ON CONFLICT (client_id, contact_id)"
                    " DO UPDATE SET reason = EXCLUDED.reason",
                    (principal["client_id"], contact, reason),
                )
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "compliance.optout_manual",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Opt-out added for " + contact + " (" + reason + ")")[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("optout save failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "optout save")[0]), 503
    return jsonify({"ok": True, "contact_id": contact, "reason": reason}), 200


@bp.delete("/compliance/optouts")
def remove_optout():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    contact = (request.args.get("contact") or "").strip()[:100]
    if not contact:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contact is required."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_compliance_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM " + portal_db._q(OPTOUT_TABLE) +
                    " WHERE client_id = %s AND contact_id = %s"
                    " RETURNING contact_id",
                    (principal["client_id"], contact),
                )
                removed = portal_db.rows(cur)
                if not removed:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Not in the opt-out"
                                                         " list."}}), 404
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "compliance.resubscribed",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Opt-out removed for " + contact)[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("optout delete failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "optout delete")[0]), 503
    return jsonify({"ok": True}), 200


def maybe_opt_out(client_id, contact, text, conn) -> None:
    """Ingest hook: record a STOP/opt-out request. Runs inside the ingest
    transaction; never raises into the caller."""
    value = str(text or "").strip()
    contact = str(contact or "").strip()[:100]
    if not value or not contact:
        return
    if not STOP_RE.match(value[:200]):
        return
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO " + portal_db._q(OPTOUT_TABLE) +
            " (client_id, contact_id, reason) VALUES (%s, %s, 'customer')"
            " ON CONFLICT (client_id, contact_id) DO NOTHING",
            (client_id, contact),
        )
        portal_db.log_action(
            cur,
            client_id,
            "compliance.optout",
            "customer",
            None,
            None,
            ("Customer asked to stop: " + contact)[:200],
        )
