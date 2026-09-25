"""COD order confirmations: hot leads get one confirm ask, replies are parsed."""

import logging
import re
from typing import Any, Dict, Optional

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db
import portal_growth

bp = Blueprint("portal_cod", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

COD_SETTINGS_TABLE = "portal_cod_settings"
COD_REQUESTS_TABLE = "portal_cod_requests"
COD_MAX_TEMPLATE = 1000
COD_COOLDOWN_HOURS = 24
COD_REPLY_WINDOW_HOURS = 72

_DEFAULT_TEMPLATE = (
    "Thank you {name}! Your COD order is noted. Reply YES to confirm "
    "or NO to cancel."
)

_YES_RE = re.compile(
    r"^\s*(yes|y|haan|han|ha|ji|jee|confirm|confirmed|ok|okay|theek|thik"
    r"|krdo|kar do|kardo|done|bolo|pack)\b",
    re.IGNORECASE,
)
_NO_RE = re.compile(
    r"^\s*(no|n|nahi|nahin|nhe|cancel|cancle|not needed|mat|wapas)\b",
    re.IGNORECASE,
)

_COD_DDL_READY = False


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


def _ensure_cod_tables(conn) -> None:
    global _COD_DDL_READY
    if _COD_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(COD_SETTINGS_TABLE) +
            " (client_id BIGINT PRIMARY KEY,"
            " enabled BOOLEAN NOT NULL DEFAULT FALSE,"
            " template TEXT NOT NULL DEFAULT '',"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(COD_REQUESTS_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " conversation_id BIGINT,"
            " contact_id TEXT NOT NULL,"
            " contact_name TEXT,"
            " status TEXT NOT NULL DEFAULT 'pending',"
            " template_sent TEXT NOT NULL DEFAULT '',"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " answered_at TIMESTAMPTZ)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_portal_cod_requests"
            " ON " + portal_db._q(COD_REQUESTS_TABLE) +
            " (client_id, status, id DESC)"
        )
    conn.commit()
    _COD_DDL_READY = True


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    try:
        return value.isoformat()
    except AttributeError:
        return None


def _settings_public(row: Dict[str, Any]) -> dict:
    return {
        "enabled": bool(row.get("enabled")),
        "template": row.get("template") or _DEFAULT_TEMPLATE,
    }


def _request_public(row: Dict[str, Any]) -> dict:
    return {
        "id": row.get("id"),
        "conversation_id": row.get("conversation_id"),
        "contact_id": row.get("contact_id"),
        "contact_name": row.get("contact_name"),
        "status": row.get("status") or "pending",
        "created_at": _iso(row.get("created_at")),
        "answered_at": _iso(row.get("answered_at")),
    }


@bp.get("/cod/settings")
def get_cod_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_cod_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT enabled, template FROM " + portal_db._q(COD_SETTINGS_TABLE) +
                    " WHERE client_id = %s",
                    (principal["client_id"],),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("cod settings read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "cod settings read")[0]), 503
    return jsonify({"settings": _settings_public(found[0] if found else {})}), 200


@bp.put("/cod/settings")
def save_cod_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    enabled = payload.get("enabled")
    if not isinstance(enabled, bool):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "enabled must be true or false."}}), 400
    template = str(payload.get("template") or "").strip()
    if not template:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Template text is required."}}), 400
    if len(template) > COD_MAX_TEMPLATE:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Template must be "
                                  + str(COD_MAX_TEMPLATE) + " characters or fewer."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_cod_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(COD_SETTINGS_TABLE) +
                    " (client_id, enabled, template, updated_at)"
                    " VALUES (%s, %s, %s, NOW())"
                    " ON CONFLICT (client_id) DO UPDATE"
                    " SET enabled = EXCLUDED.enabled,"
                    " template = EXCLUDED.template,"
                    " updated_at = NOW()",
                    (principal["client_id"], enabled, template),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "cod settings save")[0]), 503
    return jsonify({"ok": True, "settings": {"enabled": enabled, "template": template}}), 200


@bp.get("/cod/requests")
def list_cod_requests():
    principal, error = _principal_or_error()
    if error:
        return error
    status_filter = (request.args.get("status") or "all").strip().lower()
    if status_filter not in ("all", "pending", "confirmed", "declined"):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "status all|pending|confirmed|declined hon."}}), 400
    where = " WHERE client_id = %s"
    params: list = [principal["client_id"]]
    if status_filter != "all":
        where += " AND status = %s"
        params.append(status_filter)
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_cod_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, conversation_id, contact_id, contact_name, status,"
                    " created_at, answered_at FROM " + portal_db._q(COD_REQUESTS_TABLE) +
                    where + " ORDER BY id DESC LIMIT 50",
                    tuple(params),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "cod requests read")[0]), 503
    counts = {"pending": 0, "confirmed": 0, "declined": 0}
    for row in found:
        key = row.get("status") if row.get("status") in counts else None
        if key:
            counts[key] += 1
    return jsonify({"requests": [_request_public(row) for row in found],
                    "counts": counts}), 200


def _send_cod_message(cur, client_id, contact_id, display_name, body, request_id):
    """Queue the confirm ask through the shared connector command helper."""
    portal_growth._send_command(
        cur, client_id, contact_id, display_name, body,
        "cod_confirm", broadcast_id=None,
    )


def maybe_cod_flow(client_id, conversation_id, contact_id, contact_name,
                   body, direction, conn) -> Optional[bool]:
    """Ingest hook: ask hot leads to confirm COD orders, parse their reply.

    Returns True only when this hook queued a customer-visible message
    (the confirmation ask) — the ingest pipeline's one-reply law uses it.
    """
    if direction != "in":
        return
    text = str(body or "").strip()
    if not text:
        return
    portal_db.ensure_tables()
    with conn.cursor() as cur:
        cur.execute(
            "SELECT enabled, template FROM " + portal_db._q(COD_SETTINGS_TABLE) +
            " WHERE client_id = %s",
            (client_id,),
        )
        found = portal_db.rows(cur)
        settings = found[0] if found else {}
        if not settings.get("enabled"):
            return
        cur.execute(
            "SELECT id, status FROM " + portal_db._q(COD_REQUESTS_TABLE) +
            " WHERE client_id = %s AND conversation_id = %s"
            " AND status = 'pending'"
            " AND created_at > NOW() - make_interval(hours => %s)"
            " ORDER BY id DESC LIMIT 1",
            (client_id, conversation_id, COD_REPLY_WINDOW_HOURS),
        )
        pending = portal_db.rows(cur)
        if pending:
            request_id = int(pending[0].get("id") or 0)
            reply_kind = "cod_other"
            try:
                import portal_intents

                reply_kind = portal_intents.parse_cod_reply(text)
            except Exception:
                reply_kind = "cod_other"
            if reply_kind == "cod_confirm":
                new_status = "confirmed"
            elif reply_kind == "cod_cancel":
                new_status = "declined"
            else:
                return
            cur.execute(
                "UPDATE " + portal_db._q(COD_REQUESTS_TABLE) +
                " SET status = %s, answered_at = NOW()"
                " WHERE id = %s AND status = 'pending'",
                (new_status, request_id),
            )
            portal_db.log_action(
                cur,
                client_id,
                "cod." + new_status,
                "customer",
                None,
                conversation_id,
                "COD request " + str(request_id) + " replied " + new_status + ".",
            )
            if new_status == "declined":
                try:
                    import portal_fraud

                    portal_fraud.on_cod_declined(
                        cur, client_id, str(contact_id or ""))
                except Exception:
                    pass
            return
        cur.execute(
            " SELECT 1 FROM " + portal_db._q(portal_db.CONV_TABLE) +
            " c WHERE c.id = %s AND c.client_id = %s"
            " AND c.lead_temp = 'hot'"
            " AND NOT EXISTS ("
            " SELECT 1 FROM " + portal_db._q(COD_REQUESTS_TABLE) +
            " cr WHERE cr.conversation_id = c.id"
            " AND cr.created_at > NOW() - make_interval(hours => %s))"
            " LIMIT 1",
            (conversation_id, client_id, COD_COOLDOWN_HOURS),
        )
        eligible = portal_db.rows(cur)
        if not eligible:
            return
        display = str(contact_name or "").strip()
        rendered = str(settings.get("template") or _DEFAULT_TEMPLATE).replace(
            "{name}", (display.split(" ")[0] if display else "there")
        )
        cur.execute(
            "INSERT INTO " + portal_db._q(COD_REQUESTS_TABLE) +
            " (client_id, conversation_id, contact_id, contact_name,"
            " status, template_sent)"
            " VALUES (%s, %s, %s, %s, 'pending', %s)"
            " RETURNING id",
            (client_id, conversation_id, str(contact_id or ""), display, rendered),
        )
        created = portal_db.rows(cur)
        request_id = int((created[0] if created else {}).get("id") or 0)
        _send_cod_message(cur, client_id, str(contact_id or ""), display,
                          rendered, request_id)
        portal_db.log_action(
            cur,
            client_id,
            "cod.confirm_sent",
            "automation",
            None,
            conversation_id,
            "COD confirmation asked (" + str(request_id) + ").",
        )
        return True
