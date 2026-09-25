"""Cross-channel contacts: language preference, identity linking and the
autonomous action-request surface (deterministic, no AI)."""

import logging
import re
from typing import Any, Optional, Tuple

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db

bp = Blueprint("portal_contacts", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

WORKSPACE_SETTINGS_TABLE = "portal_workspace_settings"
LANG_TABLE = "portal_contact_lang"
IDENTITY_TABLE = "portal_contact_identities"
ACTIONS_TABLE = "portal_action_requests"

LANGS: Tuple[str, ...] = ("auto", "en", "ur", "roman")
ACTION_KINDS: Tuple[str, ...] = ("cancel_order", "change_address", "refund_request")
ACTION_STATUSES: Tuple[str, ...] = ("pending", "done", "declined")

ARABIC_RE = re.compile(r"[\u0600-\u06FF]")
ROMAN_MARKERS = (
    "hai", "hain", "nahi", "chahiye", "kya", "aap", "kitna", "karn",
    "bhej", "mila", "acha", "theek", "shukriya", "meherbani",
)

_CONTACTS_DDL_READY = False


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


def _ensure_contacts_tables(conn) -> None:
    global _CONTACTS_DDL_READY
    if _CONTACTS_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(WORKSPACE_SETTINGS_TABLE) +
            " (client_id BIGINT PRIMARY KEY,"
            " reply_language TEXT NOT NULL DEFAULT 'auto',"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(LANG_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " contact_id TEXT NOT NULL,"
            " lang TEXT NOT NULL,"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " UNIQUE (client_id, contact_id))"
        )
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(IDENTITY_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " channel TEXT NOT NULL,"
            " contact_id TEXT NOT NULL,"
            " identity_key TEXT NOT NULL,"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " UNIQUE (client_id, channel, contact_id))"
        )
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(ACTIONS_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " conversation_id BIGINT,"
            " contact_id TEXT NOT NULL,"
            " kind TEXT NOT NULL,"
            " note TEXT NOT NULL DEFAULT '',"
            " status TEXT NOT NULL DEFAULT 'pending',"
            " requested_by TEXT,"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " resolved_at TIMESTAMPTZ)"
        )
    conn.commit()
    _CONTACTS_DDL_READY = True


def detect_language(text: str) -> str:
    """Deterministic script/marker sniffing: Urdu script, Roman Urdu, English."""
    value = str(text or "")
    if not value.strip():
        return "en"
    if ARABIC_RE.search(value):
        return "ur"
    lowered = value.lower()
    hits = sum(1 for marker in ROMAN_MARKERS if marker in lowered)
    if hits >= 2:
        return "roman"
    return "en"


@bp.get("/workspace/language")
def get_workspace_language():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_contacts_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT reply_language FROM " +
                    portal_db._q(WORKSPACE_SETTINGS_TABLE) +
                    " WHERE client_id = %s",
                    (principal["client_id"],),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("workspace language read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "language read")[0]), 503
    lang = str(rows[0].get("reply_language") or "auto") if rows else "auto"
    return jsonify({"reply_language": lang}), 200


@bp.put("/workspace/language")
def put_workspace_language():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    language = payload.get("language")
    if language not in LANGS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Pick auto, en, ur or roman."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_contacts_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(WORKSPACE_SETTINGS_TABLE) +
                    " (client_id, reply_language) VALUES (%s, %s)"
                    " ON CONFLICT (client_id)"
                    " DO UPDATE SET reply_language = EXCLUDED.reply_language,"
                    " updated_at = NOW()",
                    (principal["client_id"], language),
                )
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "workspace.language",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Reply language set to " + str(language) + ".",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("workspace language save failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "language save")[0]), 503
    return jsonify({"ok": True, "reply_language": language}), 200


@bp.get("/contacts/language")
def get_contact_language():
    principal, error = _principal_or_error()
    if error:
        return error
    contact = (request.args.get("contact") or "").strip()[:100]
    if not contact:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contact is required."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_contacts_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT lang, updated_at FROM " + portal_db._q(LANG_TABLE) +
                    " WHERE client_id = %s AND contact_id = %s",
                    (principal["client_id"], contact),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("contact language read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "language read")[0]), 503
    if not rows:
        return jsonify({"lang": None, "updated_at": None}), 200
    return jsonify({"lang": rows[0].get("lang"),
                    "updated_at": _iso(rows[0].get("updated_at"))}), 200


@bp.post("/contacts/language")
def post_contact_language():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    contact = str(payload.get("contact") or "").strip()[:100]
    lang = payload.get("lang")
    if not contact:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contact is required."}}), 400
    if lang not in LANGS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Pick auto, en, ur or roman."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_contacts_tables(conn)
            with conn.cursor() as cur:
                if lang == "auto":
                    cur.execute(
                        "DELETE FROM " + portal_db._q(LANG_TABLE) +
                        " WHERE client_id = %s AND contact_id = %s",
                        (principal["client_id"], contact),
                    )
                else:
                    cur.execute(
                        "INSERT INTO " + portal_db._q(LANG_TABLE) +
                        " (client_id, contact_id, lang) VALUES (%s, %s, %s)"
                        " ON CONFLICT (client_id, contact_id)"
                        " DO UPDATE SET lang = EXCLUDED.lang,"
                        " updated_at = NOW()",
                        (principal["client_id"], contact, lang),
                    )
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "contact.language",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Language for " + contact + " set to " + str(lang) + ".",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("contact language save failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "language save")[0]), 503
    return jsonify({"ok": True, "lang": lang}), 200


@bp.post("/contacts/language/detect")
def detect_contact_language():
    principal, error = _principal_or_error()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        return jsonify({"error": {"code": "bad_request",
                                  "message": "text is required."}}), 400
    return jsonify({"lang": detect_language(text[:1000])}), 200


@bp.post("/contacts/link")
def link_contacts():
    """Identity stitching: map two contact ids onto one deterministic key."""
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    contact_a = str(payload.get("contact_a") or "").strip()[:100]
    contact_b = str(payload.get("contact_b") or "").strip()[:100]
    if not contact_a or not contact_b:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Both contacts are required."}}), 400
    if contact_a == contact_b:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Pick two different contacts."}}), 400
    identity_key = "id:" + "-".join(sorted((contact_a, contact_b)))[:180]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_contacts_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(IDENTITY_TABLE) +
                    " (client_id, channel, contact_id, identity_key)"
                    " VALUES (%s, 'whatsapp', %s, %s), (%s, 'whatsapp', %s, %s)"
                    " ON CONFLICT (client_id, channel, contact_id)"
                    " DO UPDATE SET identity_key = EXCLUDED.identity_key",
                    (principal["client_id"], contact_a, identity_key,
                     principal["client_id"], contact_b, identity_key),
                )
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "contact.linked",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Linked " + contact_a + " with " + contact_b)[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("contact link failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "contact link")[0]), 503
    return jsonify({"ok": True, "identity_key": identity_key}), 200


@bp.get("/contacts/identities")
def list_identities():
    principal, error = _principal_or_error()
    if error:
        return error
    contact = (request.args.get("contact") or "").strip()[:100]
    if not contact:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contact is required."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_contacts_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT DISTINCT contact_id FROM " +
                    portal_db._q(IDENTITY_TABLE) +
                    " WHERE client_id = %s AND identity_key IN"
                    " (SELECT identity_key FROM " + portal_db._q(IDENTITY_TABLE) +
                    " WHERE client_id = %s AND contact_id = %s)"
                    " ORDER BY contact_id",
                    (principal["client_id"], principal["client_id"], contact),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("identities read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "identities read")[0]), 503
    linked = [str(row.get("contact_id") or "") for row in rows
              if str(row.get("contact_id") or "") != contact]
    return jsonify({"linked": linked}), 200


@bp.post("/conversations/<int:conversation_id>/actions")
def create_action_request(conversation_id: int):
    """Queue a real-world action (cancel / address change / refund) for humans
    or the bot executor to carry out — the deterministic action surface."""
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    kind = payload.get("kind")
    note = str(payload.get("note") or "").strip()[:300]
    if kind not in ACTION_KINDS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Pick cancel_order, change_address"
                                             " or refund_request."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_contacts_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT contact_id FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE id = %s AND client_id = %s",
                    (conversation_id, principal["client_id"]),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Conversation not found."}}), 404
                contact = str(rows[0].get("contact_id") or "")
                cur.execute(
                    "INSERT INTO " + portal_db._q(ACTIONS_TABLE) +
                    " (client_id, conversation_id, contact_id, kind, note,"
                    " requested_by) VALUES (%s, %s, %s, %s, %s, %s)"
                    " RETURNING id",
                    (principal["client_id"], conversation_id, contact, kind,
                     note, principal.get("email")),
                )
                created = portal_db.rows(cur)
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "action.requested",
                    "customer_user",
                    principal.get("user_id"),
                    conversation_id,
                    ("Action " + str(kind) + " requested for " + contact)[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("action create failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "action create")[0]), 503
    action_id = int(created[0].get("id") or 0) if created else 0
    return jsonify({"ok": True, "id": action_id, "kind": kind,
                    "status": "pending"}), 200


@bp.get("/contacts/actions")
def list_action_requests():
    principal, error = _principal_or_error()
    if error:
        return error
    contact = (request.args.get("contact") or "").strip()[:100]
    status = (request.args.get("status") or "").strip().lower()
    if status and status not in ACTION_STATUSES:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "status must be pending, done or"
                                             " declined."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_contacts_tables(conn)
            with conn.cursor() as cur:
                sql = (
                    "SELECT id, conversation_id, contact_id, kind, note, status,"
                    " requested_by, created_at, resolved_at FROM " +
                    portal_db._q(ACTIONS_TABLE) +
                    " WHERE client_id = %s"
                )
                params: list = [principal["client_id"]]
                if contact:
                    sql += " AND contact_id = %s"
                    params.append(contact)
                if status:
                    sql += " AND status = %s"
                    params.append(status)
                sql += " ORDER BY id DESC LIMIT 20"
                cur.execute(sql, tuple(params))
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("actions read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "actions read")[0]), 503
    return jsonify({"actions": [
        {
            "id": int(row.get("id") or 0),
            "conversation_id": row.get("conversation_id"),
            "contact_id": row.get("contact_id"),
            "kind": row.get("kind"),
            "note": str(row.get("note") or ""),
            "status": row.get("status"),
            "requested_by": row.get("requested_by"),
            "created_at": _iso(row.get("created_at")),
            "resolved_at": _iso(row.get("resolved_at")),
        }
        for row in rows
    ]}), 200


@bp.patch("/contacts/actions/<int:action_id>")
def resolve_action_request(action_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    status = payload.get("status")
    if status not in ("done", "declined"):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Pick done or declined."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_contacts_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(ACTIONS_TABLE) +
                    " SET status = %s, resolved_at = NOW()"
                    " WHERE id = %s AND client_id = %s"
                    " RETURNING contact_id, kind",
                    (status, action_id, principal["client_id"]),
                )
                updated = portal_db.rows(cur)
                if not updated:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Action not found."}}), 404
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "action.resolved",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Action " + str(updated[0].get("kind")) + " "
                     + str(status))[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("action resolve failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "action resolve")[0]), 503
    return jsonify({"ok": True, "status": status}), 200


def stored_language(cur, client_id, contact_id) -> Optional[str]:
    """Best-effort stored auto-detected language for a contact (or None).

    Read-only helper for auto-reply paths (away messages etc.) - never
    raises into the caller's transaction.
    """
    if not contact_id:
        return None
    try:
        cur.execute(
            "SELECT lang FROM " + portal_db._q(LANG_TABLE) +
            " WHERE client_id = %s AND contact_id = %s LIMIT 1",
            (client_id, str(contact_id)[:100]),
        )
        rows = portal_db.rows(cur)
    except Exception:
        return None
    if not rows:
        return None
    lang = str(rows[0].get("lang") or "").strip().lower()
    return lang or None


def maybe_detect_language(client_id, contact, text, conn):
    """Store the auto-detected language on first sight of a contact. Runs in
    the ingest transaction; never raises into the caller."""
    value = str(text or "")
    if not value.strip() or not contact:
        return
    with conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM " + portal_db._q(LANG_TABLE) +
            " WHERE client_id = %s AND contact_id = %s LIMIT 1",
            (client_id, str(contact)[:100]),
        )
        if portal_db.rows(cur):
            return
        lang = detect_language(value[:400])
        cur.execute(
            "INSERT INTO " + portal_db._q(LANG_TABLE) +
            " (client_id, contact_id, lang) VALUES (%s, %s, %s)"
            " ON CONFLICT (client_id, contact_id) DO NOTHING",
            (client_id, str(contact)[:100], lang),
        )
