"""WhatsApp Cloud API templates: approved-template parity for Cloud tenants.

WATI tenants send approved templates directly from the Control Plane (the
WATI token lives in the portal). Cloud API tenants keep their token on the
CONNECTOR (OMNIFLOW_WA_CLOUD_URL / OMNIFLOW_WA_TOKEN in the bridge env), so
this module works hand-in-hand with the bridge: the bridge pulls
GET .../message_templates from Meta and pushes the list here (connector
sync endpoint below), and an owner send queues a `send_template` command
the bridge executes against the Cloud API. The outbound row is written
immediately so the outreach shows in the thread, exactly like WATI sends.
"""

import json
import logging
import os
import secrets

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db
from typing import Any, Dict, List

bp = Blueprint("portal_cloud", __name__, url_prefix="/api/v1/portal")
connector_bp = Blueprint("portal_cloud_connector", __name__,
                         url_prefix="/api/v1/connector")

logger = logging.getLogger(__name__)

TEMPLATES_TABLE = "portal_cloud_templates"

MAX_TEMPLATES = 200
NAME_MAX = 120
LANG_MAX = 20
CATEGORY_MAX = 60
MAX_PARAMETERS = 10
PARAM_VALUE_MAX = 500

_DDL_READY = False


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


def _authorized() -> bool:
    """Same service-key contract as connector_api (bridge -> CP pushes)."""
    key = request.headers.get("X-Omniflow-Key", "")
    if not key:
        return False
    accepted = [
        os.environ.get("OMNIFLOW_SERVICE_KEY"),
        os.environ.get("OMNIFLOW_ADMIN_API_KEY"),
    ]
    return any(k for k in accepted if k and secrets.compare_digest(key, k))


def _ensure_cloud_tables(conn) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(TEMPLATES_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " name TEXT NOT NULL,"
            " language TEXT NOT NULL DEFAULT '',"
            " status TEXT NOT NULL DEFAULT '',"
            " category TEXT NOT NULL DEFAULT '',"
            " synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"
            ")"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS portal_cloud_templates_client_idx ON "
            + portal_db._q(TEMPLATES_TABLE) + " (client_id, name)"
        )
    conn.commit()
    _DDL_READY = True


def _template_public(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": int(row.get("id") or 0),
        "name": str(row.get("name") or ""),
        "language": str(row.get("language") or ""),
        "status": str(row.get("status") or ""),
        "category": str(row.get("category") or ""),
    }


@connector_bp.post("/cloud-templates/sync")
def sync_cloud_templates():
    """Bridge push: replace this client's Cloud template snapshot."""
    if not _authorized():
        return jsonify({"error": {"code": "forbidden",
                                  "message": "Service key missing or"
                                             " invalid."}}), 403
    payload = request.get_json(silent=True) or {}
    try:
        client_id = int(payload.get("client_id"))
    except (TypeError, ValueError):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "client_id is required."}}), 400
    raw = payload.get("templates")
    if not isinstance(raw, list):
        raw = []
    templates: List[Dict[str, str]] = []
    seen = set()
    for row in raw[:MAX_TEMPLATES]:
        if not isinstance(row, dict):
            continue
        name = str(row.get("name") or "").strip()[:NAME_MAX]
        if not name or name in seen:
            continue
        seen.add(name)
        templates.append({
            "name": name,
            "language": str(row.get("language") or "").strip()[:LANG_MAX],
            "status": str(row.get("status") or "").strip()[:20],
            "category": str(row.get("category") or "").strip()[:CATEGORY_MAX],
        })
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_cloud_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM " + portal_db._q(TEMPLATES_TABLE) +
                    " WHERE client_id = %s",
                    (client_id,),
                )
                for template in templates:
                    cur.execute(
                        "INSERT INTO " + portal_db._q(TEMPLATES_TABLE) +
                        " (client_id, name, language, status, category)"
                        " VALUES (%s, %s, %s, %s, %s)",
                        (client_id, template["name"], template["language"],
                         template["status"], template["category"]),
                    )
                portal_db.log_action(
                    cur,
                    client_id,
                    "cloud.synced",
                    "connector",
                    None,
                    None,
                    str(len(templates)) + " templates from Meta.",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("cloud template sync failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "cloud template sync")[0]), 503
    return jsonify({"ok": True, "count": len(templates)}), 200


@bp.get("/cloud/templates")
def list_cloud_templates():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_cloud_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, name, language, status, category FROM "
                    + portal_db._q(TEMPLATES_TABLE) +
                    " WHERE client_id = %s"
                    " ORDER BY (status = 'APPROVED') DESC, name ASC"
                    " LIMIT " + str(MAX_TEMPLATES),
                    (principal["client_id"],),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("cloud templates read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "cloud templates read")[0]), 503
    return jsonify({"templates": [_template_public(row) for row in rows]}), 200


@bp.post("/cloud/send")
def send_cloud_template():
    """Queue a `send_template` command; the bridge performs the Cloud API
    POST. The thread row is written now so the outreach is visible."""
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
    template_name = str(payload.get("template_name") or "").strip()[:NAME_MAX]
    if not template_name:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Pick a template."}}), 400
    language_code = str(payload.get("language_code") or "en").strip()[:LANG_MAX] \
        or "en"
    raw_params = payload.get("parameters")
    if not isinstance(raw_params, list):
        raw_params = []
    parameters: List[str] = []
    for item in raw_params[:MAX_PARAMETERS]:
        value = ""
        if isinstance(item, dict):
            value = str(item.get("value") or item.get("text") or "").strip()
        elif isinstance(item, str):
            value = item.strip()
        if value:
            parameters.append(value[:PARAM_VALUE_MAX])
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, contact_id, contact_name FROM "
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
                command: Dict[str, Any] = {
                    "external_user_id": contact_id,
                    "template_name": template_name,
                    "language_code": language_code,
                    "parameters": parameters,
                    "source": "cloud_template",
                }
                display = str(conv.get("contact_name") or "").strip()
                if display:
                    command["target_display_name"] = display[:100]
                contact = contact_id
                channel = "telegram" if contact.startswith("tg:") \
                    else "whatsapp"
                try:
                    cur.execute(
                        "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
                        " (client_id, channel, action, payload, status,"
                        " requested_by, created_at, updated_at) "
                        "SELECT %s, %s, 'send_template', CAST(%s AS JSONB),"
                        " 'pending', NULL, NOW(), NOW()"
                        " WHERE NOT EXISTS (SELECT 1 FROM "
                        + portal_db._q("portal_optouts") +
                        " WHERE client_id = %s AND contact_id = %s)",
                        (principal["client_id"], channel,
                         json.dumps(command), principal["client_id"],
                         contact),
                    )
                except Exception:
                    cur.execute(
                        "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
                        " (client_id, channel, action, payload, status,"
                        " requested_by, created_at, updated_at) "
                        "VALUES (%s, %s, 'send_template',"
                        " CAST(%s AS JSONB), 'pending', NULL, NOW(), NOW())",
                        (principal["client_id"], channel,
                         json.dumps(command)),
                    )
                preview = ("(template) " + template_name)[:180]
                cur.execute(
                    "INSERT INTO " + portal_db._q(portal_db.MSGS_TABLE) +
                    " (conversation_id, client_id, direction, body,"
                    " sender_name, status)"
                    " VALUES (%s, %s, 'out', %s, 'Cloud API template',"
                    " 'sent')",
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
                    "cloud.sent",
                    "customer_user",
                    principal.get("user_id"),
                    conversation_id,
                    ("Template " + template_name + " (" + language_code
                     + ") to " + contact_id[:30] + "."),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("cloud template send failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "cloud template send")[0]), 503
    return jsonify({"ok": True, "template": template_name,
                    "queued": True}), 200
