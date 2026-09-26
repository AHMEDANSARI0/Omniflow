"""Interactive WhatsApp messages: button/list templates + queue + reply maps.

Templates are WhatsApp Cloud-API-shaped (works for 360dialog, Meta direct and
most BSPs). Sending queues a `send_interactive` connector command; the laptop
bridge posts it to the configured Cloud endpoint or falls back to a plain
numbered-text menu. Inbound button/list replies are normalized to plain text
(the row title) so COD confirmations, keywords and sequences keep working.
"""

import json
import logging
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db

bp = Blueprint("portal_interactive", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

TEMPLATES_TABLE = "portal_interactive_templates"

MAX_BUTTONS = 3
MAX_ROWS = 10
BUTTON_TITLE_MAX = 20
ROW_TITLE_MAX = 24
ROW_DESC_MAX = 72
BODY_MAX = 1024
HEADER_MAX = 60
FOOTER_MAX = 60
LABEL_MAX = 20
NAME_MAX = 60

_INTERACTIVE_DDL_READY = False


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


def _ensure_interactive_tables(conn) -> None:
    global _INTERACTIVE_DDL_READY
    if _INTERACTIVE_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(TEMPLATES_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " name TEXT NOT NULL,"
            " kind TEXT NOT NULL CHECK (kind IN ('buttons', 'list')),"
            " header TEXT NOT NULL DEFAULT '',"
            " body TEXT NOT NULL,"
            " footer TEXT NOT NULL DEFAULT '',"
            " rows JSONB NOT NULL DEFAULT '[]'::jsonb,"
            " list_label TEXT NOT NULL DEFAULT 'Choose one',"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_portal_interactive_tmpl"
            " ON " + portal_db._q(TEMPLATES_TABLE) + " (client_id, id DESC)"
        )
    conn.commit()
    _INTERACTIVE_DDL_READY = True


def validate_template(payload: Any) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Validate one interactive template against WhatsApp Cloud API limits.
    Returns (clean, error_message)."""
    if not isinstance(payload, dict):
        return None, "Send a JSON object."
    name = str(payload.get("name") or "").strip()
    if not name:
        return None, "Template name is required."
    if len(name) > NAME_MAX:
        return None, "Name is limited to 60 characters."
    kind = str(payload.get("kind") or "").strip().lower()
    if kind not in ("buttons", "list"):
        return None, "kind must be buttons or list."
    body = str(payload.get("body") or "").strip()
    if not body:
        return None, "Body text is required."
    if len(body) > BODY_MAX:
        return None, "Body is limited to 1024 characters."
    header = str(payload.get("header") or "").strip()
    if len(header) > HEADER_MAX:
        return None, "Header is limited to 60 characters."
    footer = str(payload.get("footer") or "").strip()
    if len(footer) > FOOTER_MAX:
        return None, "Footer is limited to 60 characters."
    raw_rows = payload.get("rows")
    if not isinstance(raw_rows, list):
        raw_rows = []
    rows: List[Dict[str, str]] = []
    seen_titles = set()
    for row in raw_rows:
        if not isinstance(row, dict):
            continue
        title = str(row.get("title") or "").strip()
        if not title:
            continue
        limit = BUTTON_TITLE_MAX if kind == "buttons" else ROW_TITLE_MAX
        if len(title) > limit:
            return None, ("Button titles are limited to 20 characters."
                          if kind == "buttons" else
                          "Option titles are limited to 24 characters.")
        key = title.lower()
        if key in seen_titles:
            return None, "Option titles must be unique."
        seen_titles.add(key)
        entry = {"title": title}
        if kind == "list":
            description = str(row.get("description") or "").strip()
            if len(description) > ROW_DESC_MAX:
                return None, "Option descriptions are limited to 72 characters."
            if description:
                entry["description"] = description
        rows.append(entry)
    if kind == "buttons" and not 1 <= len(rows) <= MAX_BUTTONS:
        return None, "Give 1 to 3 buttons."
    if kind == "list" and not 1 <= len(rows) <= MAX_ROWS:
        return None, "Give 1 to 10 list options."
    list_label = "Choose one"
    if kind == "list":
        custom = str(payload.get("list_label") or "").strip()
        if custom:
            list_label = custom
        if len(list_label) > LABEL_MAX:
            return None, "The list button label is limited to 20 characters."
    clean = {
        "name": name,
        "kind": kind,
        "header": header,
        "body": body,
        "footer": footer,
        "rows": rows,
        "list_label": list_label if kind == "list" else "",
    }
    return clean, None


def build_interactive_payload(tpl: Dict[str, Any]) -> Dict[str, Any]:
    """Build the WhatsApp Cloud API `interactive` message body."""
    interactive: Dict[str, Any] = {}
    if tpl.get("kind") == "buttons":
        buttons = []
        for index, row in enumerate(tpl.get("rows") or [], start=1):
            buttons.append({
                "type": "reply",
                "reply": {"id": "of_b%d" % index, "title": row["title"]},
            })
        interactive["type"] = "button"
        interactive["body"] = {"text": tpl.get("body") or ""}
        interactive["action"] = {"buttons": buttons}
    else:
        rows = []
        for index, row in enumerate(tpl.get("rows") or [], start=1):
            entry = {"id": "of_r%d" % index, "title": row["title"]}
            if row.get("description"):
                entry["description"] = row["description"]
            rows.append(entry)
        interactive["type"] = "list"
        interactive["body"] = {"text": tpl.get("body") or ""}
        interactive["action"] = {
            "button": tpl.get("list_label") or "Choose one",
            "sections": [{"rows": rows}],
        }
    if tpl.get("header"):
        interactive["header"] = {"type": "text", "text": tpl["header"]}
    if tpl.get("footer"):
        interactive["footer"] = {"text": tpl["footer"]}
    return {"type": "interactive", "interactive": interactive}


def interactive_body_override(interactive: Any, current_body: str) -> Optional[str]:
    """Map a provider interactive reply (button/list) to plain text so the
    existing COD/keyword/sequence flows keep working unchanged. Returns None
    when the item is not an interactive reply."""
    if not isinstance(interactive, dict):
        return None
    kind = str(interactive.get("type") or "").strip().lower()
    if kind not in ("button_reply", "list_reply"):
        return None
    title = str(interactive.get("title") or "").strip()
    if title:
        return title[:1000]
    reply_id = str(interactive.get("id") or "").strip()
    if reply_id:
        return reply_id[:1000]
    return None


def _queue_interactive_command(cur, client_id, external_user_id,
                               display_name, interactive_payload, preview):
    """Queue a send_interactive connector command (opt-out aware)."""
    payload: Dict[str, Any] = {
        "external_user_id": external_user_id,
        "body": str(preview or "")[:1000],
        "source": "interactive",
        "interactive": interactive_payload,
    }
    display = str(display_name or "").strip()
    if display:
        payload["target_display_name"] = display
    contact = str(external_user_id or "").strip()
    channel = "telegram" if contact.startswith("tg:") else "whatsapp"
    try:
        cur.execute(
            "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
            " (client_id, channel, action, payload, status, requested_by,"
            " created_at, updated_at) "
            "SELECT %s, %s, 'send_interactive', CAST(%s AS JSONB),"
            " 'pending', NULL, NOW(), NOW()"
            " WHERE NOT EXISTS (SELECT 1 FROM " + portal_db._q("portal_optouts") +
            " WHERE client_id = %s AND contact_id = %s)",
            (client_id, channel, json.dumps(payload), client_id, contact),
        )
    except Exception:
        # Deployments without the opt-out table still send.
        cur.execute(
            "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
            " (client_id, channel, action, payload, status, requested_by,"
            " created_at, updated_at) "
            "VALUES (%s, %s, 'send_interactive', CAST(%s AS JSONB),"
            " 'pending', NULL, NOW(), NOW())",
            (client_id, channel, json.dumps(payload)),
        )


def _template_public(row: Dict[str, Any]) -> Dict[str, Any]:
    rows = row.get("rows")
    if isinstance(rows, str):
        try:
            rows = json.loads(rows)
        except Exception:
            rows = []
    if not isinstance(rows, list):
        rows = []
    return {
        "id": row.get("id"),
        "name": str(row.get("name") or ""),
        "kind": str(row.get("kind") or "buttons"),
        "header": str(row.get("header") or ""),
        "body": str(row.get("body") or ""),
        "footer": str(row.get("footer") or ""),
        "rows": rows,
        "list_label": str(row.get("list_label") or ""),
        "created_at": row.get("created_at").isoformat()
        if row.get("created_at") is not None
        and hasattr(row.get("created_at"), "isoformat") else None,
    }


@bp.get("/interactive/templates")
def list_interactive_templates():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_interactive_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, name, kind, header, body, footer, rows,"
                    " list_label, created_at"
                    " FROM " + portal_db._q(TEMPLATES_TABLE) +
                    " WHERE client_id = %s ORDER BY id DESC LIMIT 50",
                    (principal["client_id"],),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("interactive templates read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "interactive templates read")[0]), 503
    return jsonify({"templates": [_template_public(row) for row in found]}), 200


@bp.post("/interactive/templates")
def create_interactive_template():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    clean, validation_error = validate_template(request.get_json(silent=True) or {})
    if validation_error:
        return jsonify({"error": {"code": "bad_request",
                                  "message": validation_error}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_interactive_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(TEMPLATES_TABLE) +
                    " (client_id, name, kind, header, body, footer, rows,"
                    " list_label) VALUES (%s, %s, %s, %s, %s, %s, CAST(%s AS"
                    " JSONB), %s) RETURNING id, name, kind, header, body,"
                    " footer, rows, list_label, created_at",
                    (principal["client_id"], clean["name"], clean["kind"],
                     clean["header"], clean["body"], clean["footer"],
                     json.dumps(clean["rows"]), clean["list_label"]),
                )
                row = portal_db.rows(cur)[0]
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "interactive.created",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Template " + clean["name"] + " (" + clean["kind"]
                     + ") created."),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("interactive template create failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "interactive template create")[0]), 503
    return jsonify({"template": _template_public(row)}), 200


@bp.put("/interactive/templates/<int:template_id>")
def update_interactive_template(template_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    clean, validation_error = validate_template(request.get_json(silent=True) or {})
    if validation_error:
        return jsonify({"error": {"code": "bad_request",
                                  "message": validation_error}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_interactive_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(TEMPLATES_TABLE) +
                    " SET name = %s, kind = %s, header = %s, body = %s,"
                    " footer = %s, rows = CAST(%s AS JSONB), list_label = %s,"
                    " updated_at = NOW()"
                    " WHERE id = %s AND client_id = %s"
                    " RETURNING id, name, kind, header, body, footer, rows,"
                    " list_label, created_at",
                    (clean["name"], clean["kind"], clean["header"],
                     clean["body"], clean["footer"], json.dumps(clean["rows"]),
                     clean["list_label"], template_id, principal["client_id"]),
                )
                found = portal_db.rows(cur)
                if not found:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Template not"
                                                         " found."}}), 404
                row = found[0]
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "interactive.updated",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Template " + clean["name"] + " updated.",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("interactive template update failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "interactive template update")[0]), 503
    return jsonify({"template": _template_public(row)}), 200


@bp.delete("/interactive/templates/<int:template_id>")
def delete_interactive_template(template_id: int):
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
            _ensure_interactive_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM " + portal_db._q(TEMPLATES_TABLE) +
                    " WHERE id = %s AND client_id = %s RETURNING id",
                    (template_id, principal["client_id"]),
                )
                found = portal_db.rows(cur)
                if not found:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Template not"
                                                         " found."}}), 404
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "interactive.deleted",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Template " + str(template_id) + " deleted.",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("interactive template delete failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "interactive template delete")[0]), 503
    return jsonify({"ok": True}), 200


@bp.post("/interactive/send")
def send_interactive_message():
    """Queue one interactive template into a conversation's WhatsApp chat."""
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    try:
        conversation_id = int(payload.get("conversation_id"))
        template_id = int(payload.get("template_id"))
    except (TypeError, ValueError):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "conversation_id and template_id"
                                             " are required."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_interactive_tables(conn)
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
                cur.execute(
                    "SELECT id, name, kind, header, body, footer, rows,"
                    " list_label FROM " + portal_db._q(TEMPLATES_TABLE) +
                    " WHERE id = %s AND client_id = %s LIMIT 1",
                    (template_id, principal["client_id"]),
                )
                templates = portal_db.rows(cur)
                if not templates:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Template not"
                                                         " found."}}), 404
                tpl = _template_public(templates[0])
                message = build_interactive_payload(tpl)
                _queue_interactive_command(
                    cur,
                    principal["client_id"],
                    contact_id,
                    conv.get("contact_name"),
                    message,
                    tpl["body"],
                )
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "interactive.sent",
                    "customer_user",
                    principal.get("user_id"),
                    conversation_id,
                    (tpl["kind"].capitalize() + " '" + tpl["name"]
                     + "' to " + contact_id[:30] + "."),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("interactive send failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "interactive send")[0]), 503
    return jsonify({"ok": True, "kind": tpl["kind"],
                    "action": "send_interactive"}), 200
