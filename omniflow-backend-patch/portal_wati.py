"""WATI provider integration: approved-template sync + direct template sends.

WATI (the WhatsApp BSP most PK merchants start on) needs PRE-APPROVED
templates for outbound messages - unlike the Cloud API session sender. The
owner pastes their WATI tenant URL + API token once; the portal pulls the
approved template list, and merchants send any approved template straight
into a conversation. Sent templates land in the thread as outbound messages.
API shapes (WATI docs): GET /api/v1/getTemplates (Bearer) for the list and
POST /api/v2/sendTemplateMessage?whatsappNumber= with {template_name,
broadcast_name, parameters} - result:true means queued at WATI.
"""

import json
import logging
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db

bp = Blueprint("portal_wati", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

SETTINGS_TABLE = "portal_wati_settings"
TEMPLATES_TABLE = "portal_wati_templates"

MAX_PARAMETERS = 10
PARAM_VALUE_MAX = 500
TEMPLATE_NAME_MAX = 60
MAX_TEMPLATES_SNAPSHOT = 200

_WATI_DDL_READY = False


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


def _ensure_wati_tables(conn) -> None:
    global _WATI_DDL_READY
    if _WATI_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(SETTINGS_TABLE) +
            " (client_id BIGINT PRIMARY KEY,"
            " base_url TEXT NOT NULL DEFAULT '',"
            " api_token TEXT NOT NULL DEFAULT '',"
            " enabled BOOLEAN NOT NULL DEFAULT FALSE,"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(TEMPLATES_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " name TEXT NOT NULL,"
            " data JSONB NOT NULL DEFAULT '{}'::jsonb,"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_portal_wati_tmpl"
            " ON " + portal_db._q(TEMPLATES_TABLE) + " (client_id, id)"
        )
    conn.commit()
    _WATI_DDL_READY = True


def _mask_token(token: str) -> str:
    if not token:
        return ""
    return "****" + token[-4:]


def validate_wati_settings(payload: Any) -> Tuple[Optional[Dict[str, Any]],
                                                 Optional[str]]:
    """Validate the WATI connection settings. Returns (clean, error)."""
    if not isinstance(payload, dict):
        return None, "Send a JSON object."
    enabled = payload.get("enabled")
    if not isinstance(enabled, bool):
        return None, "enabled must be true or false."
    base_url = str(payload.get("base_url") or "").strip().rstrip("/")
    token = str(payload.get("api_token") or "").strip()
    if enabled:
        if not base_url.lower().startswith(("http://", "https://")):
            return None, "Base URL must start with http:// or https://."
        if len(base_url) > 200:
            return None, "Base URL is too long."
        if len(token) < 8:
            return None, "Paste the WATI API token (at least 8 characters)."
    if len(token) > 500:
        return None, "The token is too long."
    return {
        "enabled": enabled,
        "base_url": base_url,
        "api_token": token,
    }, None


def _settings_public(row: Dict[str, Any]) -> Dict[str, Any]:
    token = str(row.get("api_token") or "")
    return {
        "enabled": row.get("enabled") is True,
        "baseUrl": str(row.get("base_url") or ""),
        "tokenMasked": _mask_token(token),
        "configured": bool(token),
    }


def _load_settings(cur, client_id) -> Optional[Dict[str, Any]]:
    cur.execute(
        "SELECT enabled, base_url, api_token FROM "
        + portal_db._q(SETTINGS_TABLE) + " WHERE client_id = %s",
        (client_id,),
    )
    found = portal_db.rows(cur)
    return found[0] if found else None


def _fetch_wati_templates(base_url: str, token: str) -> List[Dict[str, Any]]:
    """Call WATI GET /api/v1/getTemplates. Module-level so tests can stub it."""
    request = urllib.request.Request(
        base_url + "/api/v1/getTemplates",
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        payload = json.loads(response.read().decode("utf-8") or "[]")
    if isinstance(payload, dict):
        payload = payload.get("templates") or payload.get("list") or []
    return payload if isinstance(payload, list) else []


def _send_wati_template(base_url: str, token: str, number: str,
                        template_name: str,
                        parameters: List[Dict[str, str]]) -> bool:
    """Call WATI POST /api/v2/sendTemplateMessage. Returns result:true.
    Module-level so tests can stub it."""
    request = urllib.request.Request(
        base_url + "/api/v2/sendTemplateMessage?whatsappNumber="
        + urllib.request.quote(number, safe=""),
        data=json.dumps({
            "template_name": template_name,
            "broadcast_name": "omniflow_portal",
            "parameters": parameters,
        }).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        payload = json.loads(response.read().decode("utf-8") or "{}")
    return payload.get("result") is True


def _template_public(row: Dict[str, Any]) -> Dict[str, Any]:
    data = row.get("data")
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except Exception:
            data = {}
    if not isinstance(data, dict):
        data = {}
    return {
        "name": str(row.get("name") or ""),
        "data": data,
    }


@bp.get("/wati/settings")
def get_wati_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_wati_tables(conn)
            with conn.cursor() as cur:
                found = _load_settings(cur, principal["client_id"])
        finally:
            conn.close()
    except Exception as error:
        logger.warning("wati settings read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "wati settings read")[0]), 503
    return jsonify({"settings": _settings_public(found or {})}), 200


@bp.put("/wati/settings")
def save_wati_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    clean, validation_error = validate_wati_settings(
        request.get_json(silent=True) or {})
    if validation_error:
        return jsonify({"error": {"code": "bad_request",
                                  "message": validation_error}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_wati_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(SETTINGS_TABLE) +
                    " (client_id, base_url, api_token, enabled)"
                    " VALUES (%s, %s, %s, %s)"
                    " ON CONFLICT (client_id) DO UPDATE SET"
                    " base_url = EXCLUDED.base_url,"
                    " api_token = EXCLUDED.api_token,"
                    " enabled = EXCLUDED.enabled, updated_at = NOW()",
                    (principal["client_id"], clean["base_url"],
                     clean["api_token"], clean["enabled"]),
                )
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "wati.settings",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("WATI "
                     + ("enabled." if clean["enabled"] else "disabled.")),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("wati settings save failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "wati settings save")[0]), 503
    return jsonify({"ok": True, "settings": _settings_public(clean)}), 200


@bp.post("/wati/sync")
def sync_wati_templates():
    """Pull the APPROVED template list from WATI into a local snapshot."""
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
            _ensure_wati_tables(conn)
            with conn.cursor() as cur:
                settings = _load_settings(cur, principal["client_id"])
            conn.close()
        except Exception:
            conn.close()
            raise
        if not settings or not settings.get("api_token") \
                or settings.get("enabled") is not True:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Save and enable the WATI"
                                                 " connection first."}}), 400
        raw = _fetch_wati_templates(settings["base_url"],
                                    settings["api_token"])
        approved = []
        seen = set()
        for row in raw:
            if not isinstance(row, dict):
                continue
            name = str(row.get("name") or "").strip()
            status = str(row.get("status") or "").strip().upper()
            if not name or status != "APPROVED" or name in seen:
                continue
            seen.add(name)
            approved.append({"name": name[:TEMPLATE_NAME_MAX],
                             "data": {"status": "APPROVED",
                                      "variables": row.get("variables")
                                      or []}})
            if len(approved) >= MAX_TEMPLATES_SNAPSHOT:
                break
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM " + portal_db._q(TEMPLATES_TABLE) +
                    " WHERE client_id = %s",
                    (principal["client_id"],),
                )
                for entry in approved:
                    cur.execute(
                        "INSERT INTO " + portal_db._q(TEMPLATES_TABLE) +
                        " (client_id, name, data)"
                        " VALUES (%s, %s, CAST(%s AS JSONB))",
                        (principal["client_id"], entry["name"],
                         json.dumps(entry["data"])),
                    )
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "wati.synced",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Synced " + str(len(approved))
                     + " approved WATI templates."),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("wati sync failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "wati sync")[0]), 503
    return jsonify({"ok": True, "count": len(approved)}), 200


@bp.get("/wati/templates")
def list_wati_templates():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_wati_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT name, data FROM " + portal_db._q(TEMPLATES_TABLE)
                    + " WHERE client_id = %s ORDER BY name ASC LIMIT 200",
                    (principal["client_id"],),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("wati templates read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "wati templates read")[0]), 503
    return jsonify({"templates": [_template_public(row) for row in found]}), 200


@bp.post("/wati/send")
def send_wati_message():
    """Send one APPROVED WATI template into a conversation. The message is
    stored as an outbound row so it shows in the thread."""
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    try:
        conversation_id = int(payload.get("conversation_id"))
    except (TypeError, ValueError):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "conversation_id is"
                                             " required."}}), 400
    template_name = str(payload.get("template_name") or "").strip()
    if not template_name or len(template_name) > TEMPLATE_NAME_MAX:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Pick a template."}}), 400
    raw_params = payload.get("parameters")
    if not isinstance(raw_params, list):
        raw_params = []
    parameters: List[Dict[str, str]] = []
    for index, item in enumerate(raw_params[:MAX_PARAMETERS], start=1):
        value = ""
        if isinstance(item, dict):
            value = str(item.get("value") or "").strip()
        elif isinstance(item, str):
            value = item.strip()
        if not value:
            continue
        parameters.append({"name": str(index), "value": value[:PARAM_VALUE_MAX]})
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_wati_tables(conn)
            with conn.cursor() as cur:
                settings = _load_settings(cur, principal["client_id"])
                if not settings or not settings.get("api_token") \
                        or settings.get("enabled") is not True:
                    return jsonify({"error": {"code": "bad_request",
                                              "message": "Enable the WATI"
                                                         " connection in"
                                                         " Settings first."}}), 400
                cur.execute(
                    "SELECT id, contact_id, contact_name, channel FROM "
                    + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE id = %s AND client_id = %s LIMIT 1",
                    (conversation_id, principal["client_id"]),
                )
                convs = portal_db.rows(cur)
                if not convs:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Conversation not"
                                                         " found."}}), 404
                conv = convs[0]
                contact_id = str(conv.get("contact_id") or "").strip()
                if not contact_id:
                    return jsonify({"error": {"code": "bad_request",
                                              "message": "This chat has no"
                                                         " WhatsApp contact"
                                                         " id."}}), 400
                cur.execute(
                    "SELECT id FROM " + portal_db._q(TEMPLATES_TABLE) +
                    " WHERE client_id = %s AND name = %s LIMIT 1",
                    (principal["client_id"], template_name),
                )
                if not portal_db.rows(cur):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Template not in the"
                                                         " approved list -"
                                                         " sync again."}}), 404
            conn.close()
        except Exception:
            conn.close()
            raise
        sent = _send_wati_template(settings["base_url"],
                                   settings["api_token"], contact_id,
                                   template_name, parameters)
        if not sent:
            return jsonify({"error": {"code": "wati_rejected",
                                      "message": "WATI did not accept the"
                                                 " send - check the template"
                                                 " and its parameters."}}), 502
        preview = ("(template) " + template_name)[:180]
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(portal_db.MSGS_TABLE) +
                    " (conversation_id, client_id, direction, body,"
                    " sender_name, status)"
                    " VALUES (%s, %s, 'out', %s, 'WATI template', 'sent')",
                    (conversation_id, principal["client_id"], preview),
                )
                cur.execute(
                    "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
                    " SET last_message_preview = %s, last_message_at = NOW(),"
                    " updated_at = NOW() WHERE id = %s",
                    (preview, conversation_id),
                )
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "wati.sent",
                    "customer_user",
                    principal.get("user_id"),
                    conversation_id,
                    ("Template " + template_name + " to "
                     + contact_id[:30] + "."),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("wati send failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "wati send")[0]), 503
    return jsonify({"ok": True, "template": template_name}), 200
