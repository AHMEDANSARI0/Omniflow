"""Portal knowledge base (customer Bearer + ingest-time auto-reply).

Businesses store answers (title, category, keywords, content) as knowledge
base entries. When an inbound WhatsApp message classifies as a general
informational intent (general, shipping, order_tracking, appointment) and a
keyword matches an active entry, the Control Plane queues a regular
send_message command; the laptop connector delivers it through the existing
command polling. Complaints, refund requests and human-handoff messages are
never auto-answered. Matching is deterministic keyword scoring: zero AI cost.
"""

import json
import logging
import re
from typing import Any, Dict

from flask import Blueprint, jsonify, request

from portal_auth import PortalAuthUnavailable, authenticate_portal_request
import portal_db
import portal_plans
import portal_brands


logger = logging.getLogger("omniflow.portal-knowledge-base")

bp = Blueprint("portal_kb", __name__, url_prefix="/api/v1")

KB_SETTINGS_TABLE = "portal_kb_settings"
KB_TABLE = "portal_kb_entries"

# Intents eligible for instant knowledge-base answers. Sensitive intents
# (human_request, complaint, refund_return) and the sales intents owned by
# the follow-up agent are deliberately excluded.
KB_AUTO_INTENTS = ("general", "shipping", "order_tracking", "appointment")

_INTENT_HINTS = (
    ("order_tracking", ("track", "tracking", "kahan", "status of my order",
                        "order status", "mera order")),
    ("shipping", ("delivery", "shipping", "charge", "kitne din", "courier",
                  "pahunch")),
    ("appointment", ("appointment", "booking", "book", "appointment time")),
)


def classify_intent(message_text) -> str:
    """Coarse intent for the KB auto-reply gate (keyword hints first).

    B3: portal_intents.classify wraps this table as its offline fallback —
    callers get the LLM label when configured, keywords otherwise.
    """
    text = _normalize_text(message_text)
    if not text:
        return "general"
    for intent, hints in _INTENT_HINTS:
        for hint in hints:
            if hint in text:
                return intent
    return "general"

MIN_KEYWORD_SCORE = 3  # one keyword hit = 3 points
AUTO_REPLY_COOLDOWN_SECONDS = 120
MAX_LIST_ENTRIES = 200


_LANG_DDL_READY = False


def _ensure_lang_column(conn) -> None:
    """portal_kb_entries.lang lands lazily (older installs keep working)."""
    global _LANG_DDL_READY
    if _LANG_DDL_READY:
        return
    try:
        with conn.cursor() as cur:
            cur.execute(
                "ALTER TABLE " + portal_db._q(KB_TABLE) +
                " ADD COLUMN IF NOT EXISTS lang TEXT NOT NULL DEFAULT 'auto'"
            )
        conn.commit()
        _LANG_DDL_READY = True
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass


def _ensure_brand_column(conn) -> None:
    """portal_kb_entries.brand_id lands lazily (multi-brand prep)."""
    global _BRAND_DDL_READY
    if _BRAND_DDL_READY:
        return
    try:
        with conn.cursor() as cur:
            cur.execute(
                "ALTER TABLE " + portal_db._q(KB_TABLE) +
                " ADD COLUMN IF NOT EXISTS brand_id BIGINT"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS portal_kb_brand_idx ON "
                + portal_db._q(KB_TABLE) + " (client_id, brand_id)"
            )
        conn.commit()
        _BRAND_DDL_READY = True
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass


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


def _normalize_text(value) -> str:
    cleaned = re.sub(r"[^\w\s]", " ", str(value or "").lower())
    return re.sub(r"\s+", " ", cleaned).strip()


def _entry_json(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": int(row.get("id") or 0),
        "title": str(row.get("title") or ""),
        "category": str(row.get("category") or "general"),
        "keywords": str(row.get("keywords") or ""),
        "content": str(row.get("content") or ""),
        "is_active": row.get("is_active") is True,
        "usage_count": int(row.get("usage_count") or 0),
        "lang": str(row.get("lang") or "auto"),
        "brand_id": int(row["brand_id"]) if row.get("brand_id") else None,
    }


def _clean_entry_payload(raw):
    """Validate a knowledge-base entry payload. Returns (fields, error)."""
    if not isinstance(raw, dict):
        return None, (jsonify({"error": {"code": "bad_request",
                                         "message": "entry object is required."}}), 400)
    title = str(raw.get("title") or "").strip()
    content = str(raw.get("content") or "").strip()
    keywords = str(raw.get("keywords") or "").strip()
    category = str(raw.get("category") or "").strip() or "general"
    is_active_raw = raw.get("is_active")
    if is_active_raw is None:
        is_active = True
    else:
        is_active = is_active_raw is True or str(is_active_raw).lower() == "true"
    if not title or len(title) > 200:
        return None, (jsonify({"error": {"code": "bad_request",
                                         "message": "Title is required (max 200 characters)."}}), 400)
    if not content or len(content) > 4000:
        return None, (jsonify({"error": {"code": "bad_request",
                                         "message": "Answer is required (max 4000 characters)."}}), 400)
    if len(keywords) > 600:
        return None, (jsonify({"error": {"code": "bad_request",
                                         "message": "Keywords must be 600 characters or fewer."}}), 400)
    if len(category) > 60:
        return None, (jsonify({"error": {"code": "bad_request",
                                         "message": "Category must be 60 characters or fewer."}}), 400)
    lang = str(raw.get("lang") or "auto").strip().lower() or "auto"
    if lang not in ("auto", "en", "ur", "roman"):
        return None, (jsonify({"error": {"code": "bad_request",
                                         "message": "lang must be auto, en,"
                                                    " ur, or roman."}}), 400)
    return {
        "title": title,
        "content": content,
        "keywords": keywords,
        "category": category,
        "is_active": is_active,
        "lang": lang,
        "brand_id": raw.get("brand_id"),
    }, None


def match_knowledge_base_lang(cur, client_id, message_text, lang=None):
    """Language-aware twin of match_knowledge_base.

    Same keyword scoring; when scores tie, an entry written in the
    customer's stored language wins over 'auto', which wins over any other
    language. Falls back to the classic SELECT when the lang column is not
    installed yet, so the ingest hot path can never break.
    """
    normalized = _normalize_text(message_text)
    if not normalized:
        return None
    tokens = set(normalized.split(" "))
    want = str(lang or "").strip().lower()
    try:
        cur.execute(
            "SELECT id, title, content, keywords, lang FROM "
            + portal_db._q(KB_TABLE) +
            " WHERE client_id = %s AND is_active IS TRUE LIMIT %s",
            (client_id, MAX_LIST_ENTRIES),
        )
        rows = portal_db.rows(cur)
    except Exception:
        cur.execute(
            "SELECT id, title, content, keywords FROM "
            + portal_db._q(KB_TABLE) +
            " WHERE client_id = %s AND is_active IS TRUE LIMIT %s",
            (client_id, MAX_LIST_ENTRIES),
        )
        rows = portal_db.rows(cur)
    best = None
    best_key = None
    for row in rows:
        score = 0
        for chunk in str(row.get("keywords") or "").split(","):
            keyword = _normalize_text(chunk)
            if not keyword:
                continue
            if " " in keyword:
                if keyword in normalized:
                    score += 3
            elif keyword in tokens:
                score += 3
        if score <= 0:
            continue
        row_lang = str(row.get("lang") or "auto").strip().lower() or "auto"
        if want and row_lang == want:
            tier = 0
        elif row_lang == "auto":
            tier = 1
        else:
            tier = 2
        key = (score, -tier)
        if best_key is None or key > best_key:
            best_key = key
            best = row
    if best is None or best_key[0] < MIN_KEYWORD_SCORE:
        return None
    return best


def match_knowledge_base(cur, client_id, message_text):
    """Return the best-scoring active entry whose keywords hit the message.

    Single tokens score 3 when the normalized message contains the token;
    multi-word keywords score 3 when the phrase appears in the normalized
    text. Requires MIN_KEYWORD_SCORE (at least one keyword hit).
    """
    normalized = _normalize_text(message_text)
    if not normalized:
        return None
    tokens = set(normalized.split(" "))
    cur.execute(
        "SELECT id, title, content, keywords FROM " + portal_db._q(KB_TABLE) +
        " WHERE client_id = %s AND is_active IS TRUE LIMIT %s",
        (client_id, MAX_LIST_ENTRIES),
    )
    best = None
    best_score = 0
    for row in portal_db.rows(cur):
        score = 0
        for chunk in str(row.get("keywords") or "").split(","):
            keyword = _normalize_text(chunk)
            if not keyword:
                continue
            if " " in keyword:
                if keyword in normalized:
                    score += 3
            elif keyword in tokens:
                score += 3
        if score > best_score:
            best_score = score
            best = row
    if best is None or best_score < MIN_KEYWORD_SCORE:
        return None
    return best


def maybe_auto_reply(client_id, conversation_id, contact_id, contact_name,
                     message_text, intent, conn):
    """Queue an instant knowledge-base answer inside the ingest transaction.

    Fires only for KB_AUTO_INTENTS when auto-reply is enabled, no outbound
    message was sent to this conversation in the last
    AUTO_REPLY_COOLDOWN_SECONDS, and an active entry keyword-matches the
    message. Never raises into the caller: wrap in try/except there.
    """
    if intent not in KB_AUTO_INTENTS:
        return
    external_user_id = str(contact_id or "").strip()
    if not external_user_id:
        return
    with conn.cursor() as cur:
        cur.execute(
            "SELECT auto_reply FROM " + portal_db._q(KB_SETTINGS_TABLE) +
            " WHERE client_id = %s LIMIT 1",
            (client_id,),
        )
        settings_rows = portal_db.rows(cur)
        if not settings_rows or settings_rows[0].get("auto_reply") is not True:
            return
        cur.execute(
            "SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " WHERE conversation_id = %s AND direction = 'out'"
            " AND created_at > NOW() - make_interval(secs => %s)"
            " LIMIT 1",
            (conversation_id, AUTO_REPLY_COOLDOWN_SECONDS),
        )
        if portal_db.rows(cur):
            return  # we just answered this conversation — stay quiet
        contact_lang = None
        try:
            import portal_contacts

            contact_lang = portal_contacts.stored_language(
                cur, client_id, external_user_id)
        except Exception:
            contact_lang = None
        entry = match_knowledge_base_lang(
            cur, client_id, message_text, contact_lang)
        if entry is None:
            return
        display_name = str(contact_name or "").strip()
        first_name = display_name.split(" ")[0] if display_name else "there"
        rendered = str(entry.get("content") or "").replace(
            "{name}", first_name
        ).strip()
        if not rendered:
            return
        payload = {
            "external_user_id": external_user_id,
            "body": rendered[:1000],
            "conversation_id": conversation_id,
            "source": "knowledge_base",
        }
        if display_name:
            payload["target_display_name"] = display_name
        cur.execute(
            "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
            " (client_id, channel, action, payload, status, requested_by,"
            " created_at, updated_at) "
            "VALUES (%s, 'whatsapp', 'send_message', CAST(%s AS JSONB),"
            " 'pending', NULL, NOW(), NOW()) "
            "RETURNING id",
            (client_id, json.dumps(payload)),
        )
        cur.execute(
            "UPDATE " + portal_db._q(KB_TABLE) +
            " SET usage_count = usage_count + 1 WHERE id = %s",
            (entry.get("id"),),
        )
        return True
    logger.info(
        "knowledge base auto-reply queued entry=%s conversation=%s client=%s",
        entry.get("id"),
        conversation_id,
        client_id,
    )


@bp.get("/portal/kb")
def get_knowledge_base():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_lang_column(conn)
            _ensure_brand_column(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(KB_SETTINGS_TABLE) +
                    " (client_id) VALUES (%s)"
                    " ON CONFLICT (client_id) DO NOTHING",
                    (principal["client_id"],),
                )
                cur.execute(
                    "SELECT auto_reply FROM " + portal_db._q(KB_SETTINGS_TABLE) +
                    " WHERE client_id = %s LIMIT 1",
                    (principal["client_id"],),
                )
                settings_rows = portal_db.rows(cur)
                brand_filter = request.args.get("brand_id")
                brand_where = ""
                list_args = [principal["client_id"]]
                if brand_filter not in (None, "", "all"):
                    brand_where = " AND brand_id = %s"
                    list_args.append(int(brand_filter))
                list_args.append(MAX_LIST_ENTRIES)
                cur.execute(
                    "SELECT id, title, category, keywords, content,"
                    " is_active, usage_count, lang, brand_id FROM "
                    + portal_db._q(KB_TABLE) +
                    " WHERE client_id = %s" + brand_where +
                    " ORDER BY updated_at DESC, id DESC LIMIT %s",
                    tuple(list_args),
                )
                entry_rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal knowledge base")[0]), 503
    settings_row = settings_rows[0] if settings_rows else {}
    return jsonify({
        "settings": {"auto_reply": settings_row.get("auto_reply") is True},
        "entries": [_entry_json(row) for row in entry_rows],
    }), 200


@bp.post("/portal/kb")
def create_kb_entry():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    payload = request.get_json(silent=True) or {}
    fields, entry_error = _clean_entry_payload(payload.get("entry"))
    if entry_error is not None:
        return entry_error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_brand_column(conn)
            with conn.cursor() as cur:
                blocked = portal_plans.enforce(cur, principal["client_id"],
                                               "kb_entries",
                                               "Knowledge-base entry")
                if blocked is not None:
                    return blocked
                brand_id = portal_brands.resolve_brand(
                    cur, principal["client_id"],
                    (payload.get("entry") or {}).get("brand_id"))
                cur.execute(
                    "INSERT INTO " + portal_db._q(KB_TABLE) +
                    " (client_id, title, category, keywords, content,"
                    " is_active, lang, brand_id)"
                    " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)"
                    " RETURNING id, title, category, keywords, content,"
                    " is_active, usage_count, lang, brand_id",
                    (principal["client_id"], fields["title"], fields["category"],
                     fields["keywords"], fields["content"], fields["is_active"],
                     fields["lang"], brand_id),
                )
                created = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal knowledge base create")[0]), 503
    return jsonify({
        "ok": True,
        "entry": _entry_json(created[0] if created else {}),
    }), 200


@bp.put("/portal/kb")
def save_kb_settings():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    payload = request.get_json(silent=True) or {}
    raw = payload.get("settings")
    auto_reply = raw.get("auto_reply") if isinstance(raw, dict) else None
    if not isinstance(auto_reply, bool):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "auto_reply must be true or false."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(KB_SETTINGS_TABLE) +
                    " (client_id, auto_reply, updated_at)"
                    " VALUES (%s, %s, NOW())"
                    " ON CONFLICT (client_id) DO UPDATE SET"
                    " auto_reply = EXCLUDED.auto_reply, updated_at = NOW()",
                    (principal["client_id"], auto_reply),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal knowledge base settings")[0]), 503
    return jsonify({"ok": True, "settings": {"auto_reply": auto_reply}}), 200


@bp.put("/portal/kb/<int:entry_id>")
def update_kb_entry(entry_id):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    payload = request.get_json(silent=True) or {}
    fields, entry_error = _clean_entry_payload(payload.get("entry"))
    if entry_error is not None:
        return entry_error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                brand_id = portal_brands.resolve_brand(
                    cur, principal["client_id"], fields.get("brand_id"))
                cur.execute(
                    "UPDATE " + portal_db._q(KB_TABLE) +
                    " SET title = %s, category = %s, keywords = %s,"
                    " content = %s, lang = %s, is_active = %s,"
                    " brand_id = %s, updated_at = NOW()"
                    " WHERE id = %s AND client_id = %s"
                    " RETURNING id, title, category, keywords, content,"
                    " is_active, usage_count, lang, brand_id",
                    (fields["title"], fields["category"],
                     fields["keywords"], fields["content"],
                     fields["lang"], fields["is_active"], brand_id,
                     entry_id, principal["client_id"]),
                )
            updated = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal knowledge base update")[0]), 503
    if not updated:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Knowledge base entry not found."}}), 404
    return jsonify({"ok": True, "entry": _entry_json(updated[0])}), 200


@bp.delete("/portal/kb/<int:entry_id>")
def delete_kb_entry(entry_id):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM " + portal_db._q(KB_TABLE) +
                    " WHERE id = %s AND client_id = %s RETURNING id",
                    (entry_id, principal["client_id"]),
                )
                deleted = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal knowledge base delete")[0]), 503
    if not deleted:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Knowledge base entry not found."}}), 404
    return jsonify({"ok": True}), 200
