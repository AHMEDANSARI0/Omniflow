"""Portal conversations API (multi-tenant, human + API-key principals).

Test-rig reconstruction of the laptop Control Plane file, conversations
endpoints only (list+counts, detail, message paging, bulk, export). Regions
are verbatim from the shipped patchers; see HANDOFF section 54.
"""
import os
from typing import Any, Optional

import csv
import io
import re

from flask import Blueprint, jsonify, request, Response

import portal_db
from portal_auth import authenticate_portal_request, ensure_human_principal

bp = Blueprint("portal_conversations", __name__, url_prefix="/api/v1/portal")

MESSAGE_PAGE_SIZE = 200
BULK_MAX_IDS = 50
EXPORT_LIMIT = 500
ALLOWED_STATUS = ("all", "open", "closed")
MAX_TAGS_PER_CONVERSATION = 6
MAX_TAG_LENGTH = 24
MAX_TAG_SUMMARY = 30

try:
    OVERDUE_HOURS = max(1, min(72, int(os.environ.get("OF_SLA_HOURS", "4"))))
except (TypeError, ValueError):
    OVERDUE_HOURS = 4

_STAR_COLUMN_READY = False


def _ensure_star_column(conn) -> None:
    """Lazy migration: older databases miss the starred flag (runs once)."""
    global _STAR_COLUMN_READY
    if _STAR_COLUMN_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "ALTER TABLE " + portal_db._q(portal_db.CONV_TABLE) +
            " ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT FALSE"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_portal_messages_conv_dir"
            " ON " + portal_db._q(portal_db.MSGS_TABLE) +
            " (conversation_id, direction, id)"
        )
    conn.commit()
    _STAR_COLUMN_READY = True


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    try:
        return value.isoformat()
    except AttributeError:
        return None


def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except Exception:
        principal = None
    if not principal:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}), 401)
    return principal, None


def _conversation_public(row: Any) -> dict:
    return {
        "id": row.get("id"),
        "channel": row.get("channel") or "whatsapp",
        "contact_id": row.get("contact_id"),
        "contact_name": row.get("contact_name"),
        "status": row.get("status") or "open",
        "last_message_at": _iso(row.get("last_message_at")),
        "last_message_preview": row.get("last_message_preview"),
        "created_at": _iso(row.get("created_at")),
        "unread": bool(row.get("unread")),
        "needs_reply": bool(row.get("needs_reply")),
        "last_intent": row.get("last_intent"),
        "lead_score": int(row.get("lead_score") or 0),
        "lead_temp": row.get("lead_temp") or "cold",
        "assigned_to": row.get("assigned_to"),
        "assignee_name": row.get("assignee_name"),
        "starred": bool(row.get("starred")),
    }


def _message_public(row: Any) -> dict:
    return {
        "id": row.get("id"),
        "direction": row.get("direction") or "in",
        "body": row.get("body") or "",
        "status": row.get("status") or "received",
        "intent": row.get("intent"),
        "created_at": _iso(row.get("created_at")),
    }


VIP_THRESHOLD = 3  # paid orders that turn a contact into a VIP


def _paid_order_counts(cur, client_id, contact_ids):
    """contact_id -> paid order count ({} when the links table is absent)."""
    ids = sorted({str(cid).strip() for cid in contact_ids
                  if cid and str(cid).strip()})
    if not ids:
        return {}
    try:
        cur.execute("SELECT to_regclass(%s) AS oid",
                    ("portal_checkout_links",))
        rows = portal_db.rows(cur)
        if not rows or not rows[0].get("oid"):
            return {}
        cur.execute(
            "SELECT contact_id, COUNT(*) AS orders FROM portal_checkout_links"
            " WHERE client_id = %s AND status = 'paid'"
            " AND contact_id = ANY(%s)"
            " GROUP BY contact_id",
            (client_id, ids),
        )
        return {str(row.get("contact_id") or ""): int(row.get("orders") or 0)
                for row in portal_db.rows(cur)}
    except Exception:
        return {}


def _tags_map(cur, client_id, conversation_ids) -> dict:
    """Return {conversation_id: [tag, ...]} for the given conversations."""
    ids = [int(cid) for cid in conversation_ids if cid is not None]
    if not ids:
        return {}
    cur.execute(
        "SELECT id, conversation_id, tag FROM " + portal_db._q(portal_db.CONV_TAGS_TABLE) +
        " WHERE client_id = %s AND conversation_id = ANY(%s) ORDER BY id",
        (client_id, ids),
    )
    mapping = {}
    for row in portal_db.rows(cur):
        mapping.setdefault(row.get("conversation_id"), []).append(
            str(row.get("tag") or "")
        )
    return mapping


@bp.get("/conversations")
def list_conversations():
    principal, error = _principal_or_error()
    if error:
        return error

    status = (request.args.get("status") or "all").strip().lower()
    if status not in ALLOWED_STATUS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "status must be all, open, or closed."}}), 400
    raw_limit = request.args.get("limit", "")
    try:
        limit = int(raw_limit) if raw_limit else 50
    except (TypeError, ValueError):
        limit = 50
    limit = max(1, min(50, limit))
    raw_page = request.args.get("page") or ""
    try:
        page = int(raw_page) if raw_page else 1
    except (TypeError, ValueError):
        page = 1
    page = max(1, page)

    search = (request.args.get("q") or "").strip()
    if len(search) > 100:
        search = search[:100]
    sort_order = (request.args.get("sort") or "").strip().lower()
    if sort_order not in ("", "oldest"):
        sort_order = ""
    assigned_filter = (request.args.get("assigned") or "").strip().lower()
    if assigned_filter not in ("", "unassigned", "me"):
        assigned_filter = ""
    days_filter = (request.args.get("days") or "").strip()
    if days_filter not in ("", "1", "7", "30"):
        days_filter = ""
    unread_filter = (request.args.get("unread") or "").strip()
    if unread_filter != "1":
        unread_filter = ""
    include_counts = (request.args.get("include") or "").strip().lower() == "counts"
    include_raw = (request.args.get("include") or "").strip().lower()
    include_vip = "vip" in include_raw.split(",")
    starred_filter = (request.args.get("starred") or "").strip()
    if starred_filter != "1":
        starred_filter = ""

    sql = (
        "SELECT c.id, c.channel, c.contact_id, c.contact_name, c.status,"
        " c.last_message_at, c.last_message_preview, c.created_at, c.last_intent,"
        " c.lead_score, c.lead_temp, c.assigned_to, c.starred, tm.name AS assignee_name,"
        " EXISTS ("
        " SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
        " m WHERE m.conversation_id = c.id AND m.direction = 'in'"
        " AND m.created_at > COALESCE(c.last_read_at, TO_TIMESTAMP(0))"
        " ) AS unread, EXISTS ("
        " SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
        " lr WHERE lr.conversation_id = c.id"
        " GROUP BY lr.conversation_id"
        " HAVING COALESCE(MAX(CASE WHEN lr.direction = 'in' THEN lr.id END), 0)"
        " > COALESCE(MAX(CASE WHEN lr.direction = 'out' THEN lr.id END), 0)"
        " ) AS needs_reply FROM "
        + portal_db._q(portal_db.CONV_TABLE) + " c"
        " LEFT JOIN " + portal_db._q(portal_db.TEAM_TABLE) + " tm"
        " ON tm.client_id = c.client_id AND tm.email = c.assigned_to"
        " WHERE c.client_id = %s"
    )
    params = [principal["client_id"]]
    if status != "all":
        sql += " AND c.status = %s"
        params.append(status)
    intent_filter = (request.args.get("intent") or "").strip().lower()
    if intent_filter and intent_filter != "all":
        sql += " AND c.last_intent = %s"
        params.append(intent_filter[:40])
    channel_filter = (request.args.get("channel") or "").strip().lower()
    if channel_filter in ("whatsapp", "website"):
        sql += " AND c.channel = %s"
        params.append(channel_filter)
    tag_filter = (request.args.get("tag") or "").strip()[:MAX_TAG_LENGTH]
    if tag_filter:
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.CONV_TAGS_TABLE) +
            " ct WHERE ct.conversation_id = c.id AND ct.client_id = c.client_id"
            " AND LOWER(ct.tag) = LOWER(%s))"
        )
        params.append(tag_filter)
    if assigned_filter == "unassigned":
        sql += " AND c.assigned_to IS NULL"
    elif assigned_filter == "me":
        sql += " AND c.assigned_to = %s"
        params.append(principal["email"])

    if days_filter:
        sql += " AND c.last_message_at >= NOW() - make_interval(days => %s)"
        params.append(int(days_filter))
    if unread_filter == "1":
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " nb WHERE nb.conversation_id = c.id"
            " AND nb.created_at > COALESCE(c.last_read_at, TO_TIMESTAMP(0)))"
        )
    if starred_filter == "1":
        sql += " AND c.starred = TRUE"

    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    if needs_reply_filter in ("1", "overdue"):
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " nr WHERE nr.conversation_id = c.id"
            " GROUP BY nr.conversation_id"
            " HAVING COALESCE(MAX(CASE WHEN nr.direction = 'in' THEN nr.id END), 0)"
            " > COALESCE(MAX(CASE WHEN nr.direction = 'out' THEN nr.id END), 0)"
        )
        if needs_reply_filter == "overdue":
            sql += (
                " AND MAX(CASE WHEN nr.direction = 'in' THEN nr.created_at END)"
                " < NOW() - make_interval(hours => %s)"
            )
            params.append(OVERDUE_HOURS)
        sql += ")"
    if search:
        like = "%" + search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        sql += (
            " AND (c.contact_name ILIKE %s OR c.contact_id ILIKE %s"
            " OR EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " sm WHERE sm.conversation_id = c.id AND sm.body ILIKE %s))"
        )
        params.extend([like, like, like])
    if sort_order == "oldest":
        sql += " ORDER BY c.starred DESC, c.last_message_at ASC NULLS LAST, c.id ASC LIMIT %s"
    else:
        sql += " ORDER BY c.starred DESC, c.last_message_at DESC NULLS LAST, c.id DESC LIMIT %s"
    params.append(limit)
    if page > 1:
        sql += " OFFSET %s"
        params.append((page - 1) * limit)

    tags_map = {}
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        _ensure_star_column(conn)
        try:
            with conn.cursor() as cur:
                cur.execute(sql, tuple(params))
                found = portal_db.rows(cur)
                tags_map = _tags_map(cur, principal["client_id"],
                                     [row.get("id") for row in found])
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "conversations read")[0]), 503

    conversations = []
    for row in found:
        item = _conversation_public(row)
        item["tags"] = tags_map.get(row.get("id"), [])
        conversations.append(item)

    if include_vip:
        vip_map = {}
        try:
            portal_db.ensure_tables()
            conn = portal_db._conn()
            try:
                with conn.cursor() as cur:
                    vip_map = _paid_order_counts(
                        cur, principal["client_id"],
                        [row.get("contact_id") for row in found])
            finally:
                conn.close()
        except Exception:
            vip_map = {}
        for item in conversations:
            orders = int(vip_map.get(str(item.get("contact_id") or ""), 0))
            item["paid_orders"] = orders
            item["vip"] = orders >= VIP_THRESHOLD

    counts = {"needs_reply": 0, "overdue": 0, "unassigned": 0, "unread": 0}
    if include_counts:
        counts_sql = (
            " WITH recent AS ("
            " SELECT m.conversation_id,"
            " COALESCE(MAX(CASE WHEN m.direction = 'in' THEN m.id END), 0) AS last_in,"
            " MAX(CASE WHEN m.direction = 'in' THEN m.created_at END) AS last_in_at,"
            " COALESCE(MAX(CASE WHEN m.direction = 'out' THEN m.id END), 0) AS last_out"
            " FROM " + portal_db._q(portal_db.MSGS_TABLE) + " m"
            " JOIN " + portal_db._q(portal_db.CONV_TABLE) + " oc"
            " ON oc.id = m.conversation_id"
            " WHERE oc.client_id = %s AND oc.status = 'open'"
            " GROUP BY m.conversation_id"
            " )"
            " SELECT COUNT(*) FILTER (WHERE recent.last_in > recent.last_out) AS needs_reply,"
            " COUNT(*) FILTER (WHERE recent.last_in > recent.last_out"
            " AND recent.last_in_at < NOW() - make_interval(hours => %s)) AS overdue,"
            " COUNT(*) FILTER (WHERE recent.last_in_at > COALESCE(c.last_read_at, TO_TIMESTAMP(0))) AS unread,"
            " COUNT(*) FILTER (WHERE c.assigned_to IS NULL) AS unassigned"
            " FROM " + portal_db._q(portal_db.CONV_TABLE) + " c"
            " LEFT JOIN recent ON recent.conversation_id = c.id"
            " WHERE c.client_id = %s AND c.status = 'open'"
        )
        try:
            portal_db.ensure_tables()
            conn = portal_db._conn()
            try:
                with conn.cursor() as cur:
                    cur.execute(counts_sql, (principal["client_id"], OVERDUE_HOURS, principal["client_id"]))
                    summary = portal_db.rows(cur)
                    if summary:
                        counts = {
                            "needs_reply": int(summary[0].get("needs_reply") or 0),
                            "overdue": int(summary[0].get("overdue") or 0),
                            "unassigned": int(summary[0].get("unassigned") or 0),
                            "unread": int(summary[0].get("unread") or 0),
                        }
            finally:
                conn.close()
        except Exception:
            counts = {"needs_reply": 0, "overdue": 0, "unassigned": 0, "unread": 0}

    response_payload = {"conversations": conversations}
    if include_counts:
        response_payload["counts"] = counts
    return jsonify(response_payload), 200


@bp.get("/conversations/<int:conversation_id>")
def conversation_detail(conversation_id: int):
    principal, error = _principal_or_error()
    if error:
        return error

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        _ensure_star_column(conn)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, channel, contact_id, contact_name, status,"
                    " last_message_at, last_message_preview, created_at,"
                    " c.lead_score, c.lead_temp, c.assigned_to, c.starred,"
                    " tm.name AS assignee_name FROM "
                    + portal_db._q(portal_db.CONV_TABLE) + " c"
                    " LEFT JOIN " + portal_db._q(portal_db.TEAM_TABLE) + " tm"
                    " ON tm.client_id = c.client_id AND tm.email = c.assigned_to"
                    " WHERE c.id = %s AND c.client_id = %s LIMIT 1",
                    (conversation_id, principal["client_id"]),
                )
                found = portal_db.rows(cur)
                if not found:
                    # Other tenant's (or unknown) conversation -> plain 404.
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Conversation not found."}}), 404
                cur.execute(
                    "SELECT id, direction, body, status, intent, created_at FROM "
                    + portal_db._q(portal_db.MSGS_TABLE) +
                    " WHERE conversation_id = %s ORDER BY id DESC LIMIT %s",
                    (conversation_id, MESSAGE_PAGE_SIZE + 1),
                )
                msgs = portal_db.rows(cur)
                has_more = len(msgs) > MESSAGE_PAGE_SIZE
                if has_more:
                    msgs = msgs[:MESSAGE_PAGE_SIZE]
                detail_tags = _tags_map(
                    cur, principal["client_id"], [conversation_id]
                ).get(conversation_id, [])
                cur.execute(
                    "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
                    " SET last_read_at = NOW()"
                    " WHERE id = %s AND client_id = %s",
                    (conversation_id, principal["client_id"]),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "conversation detail")[0]), 503

    conversation_public = _conversation_public(found[0])
    conversation_public["tags"] = detail_tags
    vip_map = {}
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                vip_map = _paid_order_counts(
                    cur, principal["client_id"],
                    [found[0].get("contact_id")])
        finally:
            conn.close()
    except Exception:
        vip_map = {}
    vip_orders = int(vip_map.get(str(found[0].get("contact_id") or ""), 0))
    conversation_public["paid_orders"] = vip_orders
    conversation_public["vip"] = vip_orders >= VIP_THRESHOLD
    return jsonify({
        "conversation": conversation_public,
        "messages": [_message_public(m) for m in reversed(msgs)],
        "has_more": has_more,
    }), 200


@bp.get("/conversations/<int:conversation_id>/messages")
def conversation_messages(conversation_id: int):
    principal, error = _principal_or_error()
    if error:
        return error

    raw_before = request.args.get("before_id") or ""
    try:
        before_id = int(raw_before) if raw_before else 0
    except (TypeError, ValueError):
        before_id = 0

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE id = %s AND client_id = %s LIMIT 1",
                    (conversation_id, principal["client_id"]),
                )
                if not portal_db.rows(cur):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Conversation not found."}}), 404
                if before_id > 0:
                    cur.execute(
                        "SELECT id, direction, body, status, intent, created_at FROM "
                        + portal_db._q(portal_db.MSGS_TABLE) +
                        " WHERE conversation_id = %s AND id < %s"
                        " ORDER BY id DESC LIMIT %s",
                        (conversation_id, before_id, MESSAGE_PAGE_SIZE + 1),
                    )
                else:
                    cur.execute(
                        "SELECT id, direction, body, status, intent, created_at FROM "
                        + portal_db._q(portal_db.MSGS_TABLE) +
                        " WHERE conversation_id = %s"
                        " ORDER BY id DESC LIMIT %s",
                        (conversation_id, MESSAGE_PAGE_SIZE + 1),
                    )
                msgs = portal_db.rows(cur)
                has_more = len(msgs) > MESSAGE_PAGE_SIZE
                if has_more:
                    msgs = msgs[:MESSAGE_PAGE_SIZE]
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "conversation messages")[0]), 503
    return jsonify({
        "messages": [_message_public(m) for m in reversed(msgs)],
        "has_more": has_more,
    }), 200


@bp.post("/conversations/<int:conversation_id>/star")
def toggle_conversation_star(conversation_id: int):
    principal, error = _principal_or_error()
    if error:
        return error

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        _ensure_star_column(conn)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
                    " SET starred = NOT COALESCE(starred, FALSE)"
                    " WHERE id = %s AND client_id = %s"
                    " RETURNING starred",
                    (conversation_id, principal["client_id"]),
                )
                updated = portal_db.rows(cur)
                if updated:
                    portal_db.log_action(
                        cur,
                        principal["client_id"],
                        "conversation.star_toggled",
                        "customer_user",
                        principal.get("user_id"),
                        conversation_id,
                        "Star " + ("on" if updated[0].get("starred") else "off") + ".",
                    )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "conversation star")[0]), 503
    if not updated:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Conversation not found."}}), 404
    return jsonify({"ok": True, "starred": bool(updated[0].get("starred"))}), 200


@bp.post("/conversations/bulk")
def bulk_update_conversations():
    principal, error = _principal_or_error()
    if error:
        return error

    payload = request.get_json(silent=True) or {}
    action = str(payload.get("action") or "").strip().lower()
    if action not in ("close", "reopen", "assign", "unassign"):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "action must be close, reopen, assign, or unassign."}}), 400
    raw_ids = payload.get("ids")
    if not isinstance(raw_ids, list):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "ids must be a list."}}), 400
    ids = []
    for value in raw_ids[:BULK_MAX_IDS]:
        if isinstance(value, int) and not isinstance(value, bool) and value > 0 and value not in ids:
            ids.append(value)
    if not ids:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "At least one conversation id is required."}}), 400

    assignee = ""
    if action == "assign":
        assignee = str(payload.get("assignee_email") or "").strip().lower()[:120]
        if not assignee:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "assignee_email is required for assign."}}), 400

    status_value = {"close": "closed", "reopen": "open"}.get(action)
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                if action == "assign":
                    cur.execute(
                        "SELECT 1 FROM " + portal_db._q(portal_db.TEAM_TABLE) +
                        " WHERE client_id = %s AND email = %s"
                        " AND (status = 'active' OR status IS NULL) LIMIT 1",
                        (principal["client_id"], assignee),
                    )
                    if not portal_db.rows(cur):
                        return jsonify({"error": {"code": "assignee_not_found",
                                                  "message": "That teammate is not an active member."}}), 404
                if status_value:
                    cur.execute(
                        "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
                        " SET status = %s, updated_at = NOW()"
                        " WHERE client_id = %s AND id = ANY(%s) RETURNING id",
                        (status_value, principal["client_id"], ids),
                    )
                elif action == "assign":
                    cur.execute(
                        "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
                        " SET assigned_to = %s, updated_at = NOW()"
                        " WHERE client_id = %s AND id = ANY(%s) RETURNING id",
                        (assignee, principal["client_id"], ids),
                    )
                else:
                    cur.execute(
                        "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
                        " SET assigned_to = NULL, updated_at = NOW()"
                        " WHERE client_id = %s AND id = ANY(%s) RETURNING id",
                        (principal["client_id"], ids),
                    )
                updated = portal_db.rows(cur)
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "conversation.bulk_" + action,
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Bulk " + action + " on " + str(len(updated)) + " conversations.",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "conversation bulk update")[0]), 503
    return jsonify({"ok": True, "updated": len(updated)}), 200


import json

_DEFAULT_BUSINESS_HOURS = {
    "enabled": False,
    "timezone": "Asia/Karachi",
    "days": [
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
    ],
    "away_message": "Thanks for your message! Our team is currently offline. We will reply during business hours.",
}

_SETTINGS_TABLE_READY = False


def _ensure_settings_table() -> None:
    global _SETTINGS_TABLE_READY
    if _SETTINGS_TABLE_READY:
        return
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "CREATE TABLE IF NOT EXISTS " + portal_db._q("client_settings") +
                " (client_id BIGINT PRIMARY KEY, settings JSONB NOT NULL DEFAULT '{}'::jsonb,"
                " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
            )
        conn.commit()
    finally:
        conn.close()
    _SETTINGS_TABLE_READY = True


def _validate_business_hours(config) -> list:
    problems = []
    if not isinstance(config, dict):
        return ["business_hours must be an object."]
    if not isinstance(config.get("enabled"), bool):
        problems.append("enabled must be a boolean.")
    timezone = config.get("timezone")
    if not isinstance(timezone, str) or not timezone or len(timezone) > 64:
        problems.append("timezone must be a short string.")
    days = config.get("days")
    if not isinstance(days, list) or len(days) != 7:
        problems.append("days must list all seven days.")
    else:
        for day in days:
            if not isinstance(day, dict) or not isinstance(day.get("enabled"), bool):
                problems.append("each day needs an enabled flag.")
                break
            for field in ("start", "end"):
                value = day.get(field)
                if (
                    not isinstance(value, str)
                    or len(value) != 5
                    or value[2] != ":"
                    or not value[:2].isdigit()
                    or not value[3:].isdigit()
                ):
                    problems.append("day times must be HH:MM.")
                    break
    message = config.get("away_message")
    if not isinstance(message, str) or len(message) > 500:
        problems.append("away_message must be at most 500 characters.")
    for variant_key in ("away_message_ur", "away_message_roman"):
        variant = config.get(variant_key)
        if variant is not None and (not isinstance(variant, str)
                                    or len(variant) > 500):
            problems.append(variant_key + " must be at most 500 characters.")
    return problems


@bp.get("/business-hours")
def get_business_hours():
    principal, error = _principal_or_error()
    if error:
        return error

    try:
        _ensure_settings_table()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT settings -> 'business_hours' AS business_hours FROM " +
                    portal_db._q("client_settings") +
                    " WHERE client_id = %s",
                    (principal["client_id"],),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "business hours")[0]), 503

    stored = rows[0].get("business_hours") if rows and rows[0] else None
    config = stored if isinstance(stored, dict) else _DEFAULT_BUSINESS_HOURS
    return jsonify({"business_hours": config}), 200


@bp.put("/business-hours")
def update_business_hours():
    principal, error = _principal_or_error()
    if error:
        return error

    payload = request.get_json(silent=True) or {}
    config = payload.get("business_hours")
    problems = _validate_business_hours(config)
    if problems:
        return jsonify({"error": {"code": "bad_request", "message": " ".join(problems)}}), 400

    try:
        _ensure_settings_table()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q("client_settings") +
                    " (client_id, settings) VALUES (%s, %s::jsonb)"
                    " ON CONFLICT (client_id) DO UPDATE SET"
                    " settings = client_settings.settings || EXCLUDED.settings,"
                    " updated_at = NOW()",
                    (principal["client_id"], json.dumps({"business_hours": config})),
                )
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "business_hours.update",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Business hours updated.",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "business hours update")[0]), 503
    return jsonify({"ok": True, "business_hours": config}), 200


@bp.post("/conversations/read-all")
def mark_all_conversations_read():
    principal, error = _principal_or_error()
    if error:
        return error

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
                    " SET last_read_at = NOW()"
                    " WHERE client_id = %s AND status = 'open' RETURNING id",
                    (principal["client_id"],),
                )
                updated = portal_db.rows(cur)
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "conversation.read_all",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Marked " + str(len(updated)) + " conversations read.",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "conversation read-all")[0]), 503
    return jsonify({"ok": True, "updated": len(updated)}), 200


@bp.get("/conversations/export")
def export_conversations():
    principal, error = _principal_or_error()
    if error:
        return error

    status = (request.args.get("status") or "all").strip().lower()
    if status not in ALLOWED_STATUS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "status must be all, open, or closed."}}), 400
    search = (request.args.get("q") or "").strip()[:100]
    sort_order = (request.args.get("sort") or "").strip().lower()
    if sort_order not in ("", "oldest"):
        sort_order = ""
    assigned_filter = (request.args.get("assigned") or "").strip().lower()
    if assigned_filter not in ("", "unassigned", "me"):
        assigned_filter = ""
    days_filter = (request.args.get("days") or "").strip()
    if days_filter not in ("", "1", "7", "30"):
        days_filter = ""
    unread_filter = (request.args.get("unread") or "").strip()
    if unread_filter != "1":
        unread_filter = ""
    starred_filter = (request.args.get("starred") or "").strip()
    if starred_filter != "1":
        starred_filter = ""
    raw_id_parts = (request.args.get("ids") or "").split(",")
    export_ids = []
    for part in raw_id_parts[:100]:
        part = part.strip()
        if part.isdigit():
            value = int(part)
            if value > 0 and value not in export_ids:
                export_ids.append(value)
    intent_filter = (request.args.get("intent") or "").strip().lower()
    channel_filter = (request.args.get("channel") or "").strip().lower()
    tag_filter = (request.args.get("tag") or "").strip()[:MAX_TAG_LENGTH]

    sql = (
        "SELECT c.id, c.channel, c.contact_id, c.contact_name, c.status,"
        " c.last_message_at, c.last_message_preview, c.created_at, c.last_intent,"
        " c.lead_score, c.lead_temp, c.assigned_to, c.starred, tm.name AS assignee_name"
        " FROM " + portal_db._q(portal_db.CONV_TABLE) + " c"
        " LEFT JOIN " + portal_db._q(portal_db.TEAM_TABLE) + " tm"
        " ON tm.client_id = c.client_id AND tm.email = c.assigned_to"
        " WHERE c.client_id = %s"
    )
    params = [principal["client_id"]]
    if status != "all":
        sql += " AND c.status = %s"
        params.append(status)
    if intent_filter and intent_filter != "all":
        sql += " AND c.last_intent = %s"
        params.append(intent_filter[:40])
    if channel_filter in ("whatsapp", "website"):
        sql += " AND c.channel = %s"
        params.append(channel_filter)
    if tag_filter:
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.CONV_TAGS_TABLE) +
            " ct WHERE ct.conversation_id = c.id AND ct.client_id = c.client_id"
            " AND LOWER(ct.tag) = LOWER(%s))"
        )
        params.append(tag_filter)
    if assigned_filter == "unassigned":
        sql += " AND c.assigned_to IS NULL"
    elif assigned_filter == "me":
        sql += " AND c.assigned_to = %s"
        params.append(principal["email"])

    if days_filter:
        sql += " AND c.last_message_at >= NOW() - make_interval(days => %s)"
        params.append(int(days_filter))
    if unread_filter == "1":
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " nb WHERE nb.conversation_id = c.id"
            " AND nb.created_at > COALESCE(c.last_read_at, TO_TIMESTAMP(0)))"
        )
    if starred_filter == "1":
        sql += " AND c.starred = TRUE"
    if export_ids:
        sql += " AND c.id = ANY(%s)"
        params.append(export_ids)

    needs_reply_filter = (request.args.get("needs_reply") or "").strip()
    export_reply = needs_reply_filter
    if export_reply in ("1", "overdue"):
        sql += (
            " AND EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " nr WHERE nr.conversation_id = c.id"
            " GROUP BY nr.conversation_id"
            " HAVING COALESCE(MAX(CASE WHEN nr.direction = 'in' THEN nr.id END), 0)"
            " > COALESCE(MAX(CASE WHEN nr.direction = 'out' THEN nr.id END), 0)"
        )
        if export_reply == "overdue":
            sql += (
                " AND MAX(CASE WHEN nr.direction = 'in' THEN nr.created_at END)"
                " < NOW() - make_interval(hours => %s)"
            )
            params.append(OVERDUE_HOURS)
        sql += ")"
    if search:
        like = "%" + search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        sql += (
            " AND (c.contact_name ILIKE %s OR c.contact_id ILIKE %s"
            " OR EXISTS (SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " sm WHERE sm.conversation_id = c.id AND sm.body ILIKE %s))"
        )
        params.extend([like, like, like])
    if sort_order == "oldest":
        sql += " ORDER BY c.starred DESC, c.last_message_at ASC NULLS LAST, c.id ASC LIMIT %s"
    else:
        sql += " ORDER BY c.starred DESC, c.last_message_at DESC NULLS LAST, c.id DESC LIMIT %s"
    params.append(EXPORT_LIMIT)

    tags_map = {}
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        _ensure_star_column(conn)
        try:
            with conn.cursor() as cur:
                cur.execute(sql, tuple(params))
                found = portal_db.rows(cur)
                tags_map = _tags_map(cur, principal["client_id"],
                                     [row.get("id") for row in found])
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "conversations export")[0]), 503

    conversations = []
    for row in found:
        item = _conversation_public(row)
        item["tags"] = tags_map.get(row.get("id"), [])
        conversations.append(item)
    return jsonify({"conversations": conversations}), 200





# ---------------------------------------------------------------------------
# Customers (contacts aggregated across all their conversations)
# ---------------------------------------------------------------------------

CUSTOMERS_LIMIT = 100
WARM_LEAD_SCORE = 35


def _normalize_pk_phone(raw: str):
    """Normalize PK numbers to 92xxxxxxxxxx; None when unusable."""
    digits = "".join(ch for ch in str(raw or "") if ch.isdigit())
    if digits.startswith("0092"):
        digits = digits[4:]
    elif digits.startswith("92"):
        digits = digits[2:]
    elif digits.startswith("0"):
        digits = digits[1:]
    if len(digits) == 10 and digits.startswith("3"):
        digits = "92" + digits
    if len(digits) < 10 or len(digits) > 12 or not digits.startswith("92"):
        return None
    if len(digits) != 12:
        return None
    return digits


@bp.post("/customers/import")
def import_customers():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    rows = payload.get("customers")
    if not isinstance(rows, list) or not rows:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "customers list is required."}}), 400
    if len(rows) > 300:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Import at most 300 customers per request."}}), 400
    prepared = {}
    invalid = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            invalid.append({"row": index + 1, "reason": "not an object"})
            continue
        name = str(row.get("name") or "").strip()[:120]
        phone = _normalize_pk_phone(row.get("phone"))
        if phone is None:
            invalid.append({"row": index + 1, "reason": "unusable phone number"})
            continue
        prepared.setdefault(phone, name)
    created = 0
    merged = 0
    if prepared:
        try:
            portal_db.ensure_tables()
            conn = portal_db._conn()
            try:
                with conn.cursor() as cur:
                    for phone, name in prepared.items():
                        cur.execute(
                            "INSERT INTO " + portal_db._q(portal_db.CONV_TABLE) +
                            " (client_id, channel, contact_id, contact_name, status)"
                            " VALUES (%s, 'whatsapp', %s, %s, 'open')"
                            " ON CONFLICT (client_id, channel, contact_id) DO UPDATE"
                            " SET contact_name = COALESCE(NULLIF(EXCLUDED.contact_name, ''),"
                            " " + portal_db._q(portal_db.CONV_TABLE) + ".contact_name),"
                            " updated_at = NOW()"
                            " RETURNING (xmax = 0) AS created",
                            (principal["client_id"], phone + "@c.us", name),
                        )
                        outcome = portal_db.rows(cur)
                        if outcome and outcome[0].get("created"):
                            created += 1
                        else:
                            merged += 1
                    portal_db.log_action(
                        cur,
                        principal["client_id"],
                        "customers.imported",
                        "customer_user",
                        principal.get("user_id"),
                        None,
                        "CSV import: " + str(created) + " new, "
                        + str(merged) + " merged, "
                        + str(len(invalid)) + " invalid.",
                    )
                conn.commit()
            finally:
                conn.close()
        except Exception as error:
            return jsonify(portal_db.portal_unavailable(error, "customers import")[0]), 503
    return jsonify({"created": created, "merged": merged,
                    "invalid": invalid[:20], "invalid_count": len(invalid)}), 200


@bp.get("/customers/export")
def export_customers_csv():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT c.contact_id,"
                    " COALESCE(MAX(c.contact_name), '') AS name,"
                    " COUNT(*) AS conversations,"
                    " COUNT(*) FILTER (WHERE c.status = 'open') AS open_count,"
                    " COALESCE(BOOL_OR(c.lead_temp = 'hot'), FALSE) AS has_hot,"
                    " MAX(c.last_message_at) AS last_message_at"
                    " FROM " + portal_db._q(portal_db.CONV_TABLE) + " c"
                    " WHERE c.client_id = %s"
                    " GROUP BY c.contact_id"
                    " ORDER BY MAX(c.last_message_at) DESC NULLS LAST, c.contact_id"
                    " LIMIT 2000",
                    (principal["client_id"],),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "customers export")[0]), 503
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["contact_id", "name", "conversations", "open_chats",
                     "hot_lead", "last_message_at"])
    for row in found:
        writer.writerow([
            row.get("contact_id"),
            row.get("name"),
            row.get("conversations"),
            row.get("open_count"),
            "yes" if row.get("has_hot") else "no",
            row.get("last_message_at").isoformat() if row.get("last_message_at") else "",
        ])
    return Response(
        buffer.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=omniflow-customers.csv"},
    )


@bp.get("/customers")
def list_customers():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    search = (request.args.get("q") or "").strip()[:100]
    channel_filter = (request.args.get("channel") or "").strip().lower()

    sql = (
        "SELECT c.contact_id,"
        " COALESCE(MAX(c.contact_name), '') AS contact_name,"
        " COUNT(*) AS conversation_count,"
        " COUNT(*) FILTER (WHERE c.status = 'open') AS open_count,"
        " MAX(c.last_message_at) AS last_message_at,"
        " MAX(c.last_message_preview) AS last_message_preview,"
        " STRING_AGG(DISTINCT c.channel, ',') AS channels,"
        " BOOL_OR(c.lead_temp = 'hot') AS has_hot,"
        " MAX(c.lead_score) AS max_lead_score"
        " FROM " + portal_db._q(portal_db.CONV_TABLE) + " c"
        " WHERE c.client_id = %s"
    )
    params = [principal["client_id"]]
    if channel_filter in ("whatsapp", "website"):
        sql += " AND c.channel = %s"
        params.append(channel_filter)
    if search:
        like = "%" + search.replace("\\\\", "\\\\\\\\").replace("%", "\\\\%").replace("_", "\\\\_") + "%"
        sql += (
            " GROUP BY c.contact_id"
            " HAVING (COALESCE(MAX(c.contact_name), '') ILIKE %s"
            " OR c.contact_id ILIKE %s)"
        )
        params.extend([like, like])
    else:
        sql += " GROUP BY c.contact_id"
    sql += (
        " ORDER BY MAX(c.last_message_at) DESC NULLS LAST, c.contact_id"
        " LIMIT %s"
    )
    params.append(CUSTOMERS_LIMIT)

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(sql, tuple(params))
                found = portal_db.rows(cur)
                contact_ids = [row.get("contact_id") for row in found]
                tags_map = {}
                if contact_ids:
                    cur.execute(
                        "SELECT conv.contact_id, ct.tag FROM "
                        + portal_db._q(portal_db.CONV_TAGS_TABLE) + " ct"
                        " JOIN " + portal_db._q(portal_db.CONV_TABLE) + " conv"
                        " ON conv.id = ct.conversation_id"
                        " WHERE ct.client_id = %s AND conv.client_id = %s"
                        " AND conv.contact_id = ANY(%s) ORDER BY ct.id",
                        (principal["client_id"], principal["client_id"],
                         contact_ids),
                    )
                    for row in portal_db.rows(cur):
                        key = row.get("contact_id")
                        tag = str(row.get("tag") or "")
                        if key is None or not tag:
                            continue
                        bucket = tags_map.setdefault(key, [])
                        if tag not in bucket:
                            bucket.append(tag)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "customers read")[0]), 503

    customers = []
    for row in found:
        max_score = int(row.get("max_lead_score") or 0)
        if row.get("has_hot"):
            lead_temp = "hot"
        elif max_score >= WARM_LEAD_SCORE:
            lead_temp = "warm"
        else:
            lead_temp = "cold"
        customers.append({
            "contact_id": row.get("contact_id"),
            "name": str(row.get("contact_name") or ""),
            "channels": [
                part for part in str(row.get("channels") or "").split(",") if part
            ],
            "conversation_count": int(row.get("conversation_count") or 0),
            "open_count": int(row.get("open_count") or 0),
            "last_message_at": _iso(row.get("last_message_at")),
            "last_message_preview": row.get("last_message_preview"),
            "lead_temp": lead_temp,
            "tags": tags_map.get(row.get("contact_id"), []),
        })
    return jsonify({"customers": customers}), 200


def _profile_table_exists(cur, table: str) -> bool:
    """True when an optional module table exists (cod requests, sequences)."""
    cur.execute("SELECT to_regclass(%s) AS oid", (table,))
    rows = portal_db.rows(cur)
    return bool(rows and rows[0].get("oid"))


ASSIST_STOPWORDS = frozenset((
    "the", "and", "you", "your", "with", "for", "from", "this", "that",
    "have", "can", "are", "was", "were", "will", "would", "what", "when",
    "where", "how", "does", "did", "please", "hey", "hi", "hello", "salam",
))


def _assist_tokens(text) -> set:
    return set(re.findall(r"[a-z0-9]{3,}", str(text or "").lower())) - ASSIST_STOPWORDS


@bp.get("/conversations/<int:conversation_id>/assist")
def conversation_assist(conversation_id: int):
    """Agent assist v0: deterministic reply suggestions from the knowledge
    base (keyword overlap), plus intent / language / linked-contact hints."""
    principal, error = _principal_or_error()
    if error is not None:
        return error
    import portal_insights
    import portal_kb

    contact = None
    inbound: list = []
    kb_rows: list = []
    lang_rows: list = []
    identity_rows: list = []
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT contact_id FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE id = %s AND client_id = %s",
                    (conversation_id, principal["client_id"]),
                )
                found = portal_db.rows(cur)
                if not found:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Conversation not"
                                                         " found."}}), 404
                contact = str(found[0].get("contact_id") or "")
                cur.execute(
                    "SELECT body FROM " + portal_db._q(portal_db.MSGS_TABLE) +
                    " WHERE conversation_id = %s AND client_id = %s"
                    " AND direction = 'in' AND COALESCE(body, '') <> ''"
                    " ORDER BY id DESC LIMIT 3",
                    (conversation_id, principal["client_id"]),
                )
                inbound = portal_db.rows(cur)
                if _profile_table_exists(cur, portal_kb.KB_TABLE):
                    cur.execute(
                        "SELECT id, question, answer FROM " +
                        portal_db._q(portal_kb.KB_TABLE) +
                        " WHERE client_id = %s ORDER BY id DESC LIMIT 200",
                        (principal["client_id"],),
                    )
                    kb_rows = portal_db.rows(cur)
                if _profile_table_exists(cur, "portal_contact_lang"):
                    cur.execute(
                        "SELECT lang FROM " + portal_db._q("portal_contact_lang") +
                        " WHERE client_id = %s AND contact_id = %s",
                        (principal["client_id"], contact),
                    )
                    lang_rows = portal_db.rows(cur)
                if _profile_table_exists(cur, "portal_contact_identities"):
                    cur.execute(
                        "SELECT DISTINCT contact_id FROM " +
                        portal_db._q("portal_contact_identities") +
                        " WHERE client_id = %s AND identity_key IN"
                        " (SELECT identity_key FROM " +
                        portal_db._q("portal_contact_identities") +
                        " WHERE client_id = %s AND contact_id = %s)"
                        " ORDER BY contact_id",
                        (principal["client_id"], principal["client_id"], contact),
                    )
                    identity_rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "agent assist")[0]), 503
    text = " ".join(str(row.get("body") or "") for row in reversed(inbound))
    tokens = _assist_tokens(text)
    suggestions = []
    for row in kb_rows:
        q_tokens = _assist_tokens(str(row.get("question") or ""))
        overlap = tokens & q_tokens
        if not overlap:
            continue
        suggestions.append({
            "id": int(row.get("id") or 0),
            "question": str(row.get("question") or ""),
            "snippet": str(row.get("answer") or "")[:160],
            "matched": sorted(overlap)[:5],
            "score": len(overlap),
        })
    suggestions.sort(key=lambda item: (-item["score"], item["id"]))
    suggestions = suggestions[:2]
    language = lang_rows[0].get("lang") if lang_rows else None
    linked = [str(row.get("contact_id") or "") for row in identity_rows
              if str(row.get("contact_id") or "")
              and str(row.get("contact_id") or "") != contact]
    return jsonify({
        "intent": portal_insights.classify_intent(text[:1000]),
        "sentiment": portal_insights.analyze_sentiment_smart(text[:1000]),
        "language": language,
        "linked": linked,
        "suggestions": suggestions,
        "based_on": text[:120],
    }), 200


@bp.get("/customers/profile")
def customer_profile():
    """Everything the business knows about ONE customer, in one response."""
    principal, error = _principal_or_error()
    if error is not None:
        return error
    import portal_cod
    import portal_sequences

    contact = (request.args.get("contact") or "").strip()[:100]
    if not contact:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contact is required."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) AS chats,"
                    " COUNT(*) FILTER (WHERE status = 'open') AS open_chats,"
                    " COALESCE(MAX(contact_name), '') AS name,"
                    " BOOL_OR(lead_temp = 'hot') AS has_hot,"
                    " MAX(lead_score) AS max_lead_score,"
                    " MIN(created_at) AS first_at,"
                    " MAX(last_message_at) AS last_at"
                    " FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE client_id = %s AND contact_id = %s",
                    (principal["client_id"], contact),
                )
                summary_rows = portal_db.rows(cur)
                summary = summary_rows[0] if summary_rows else {}
                cur.execute(
                    "SELECT id, status, channel, created_at, last_message_at"
                    " FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE client_id = %s AND contact_id = %s"
                    " ORDER BY last_message_at DESC NULLS LAST, id DESC LIMIT 20",
                    (principal["client_id"], contact),
                )
                conversations = portal_db.rows(cur)
                cur.execute(
                    "SELECT DISTINCT ct.tag FROM "
                    + portal_db._q(portal_db.CONV_TAGS_TABLE) + " ct"
                    " JOIN " + portal_db._q(portal_db.CONV_TABLE) + " conv"
                    " ON conv.id = ct.conversation_id"
                    " WHERE ct.client_id = %s AND conv.client_id = %s"
                    " AND conv.contact_id = %s ORDER BY ct.tag",
                    (principal["client_id"], principal["client_id"], contact),
                )
                tags = [str(row.get("tag") or "") for row in portal_db.rows(cur)
                        if row.get("tag")]
                cod_requests = []
                if _profile_table_exists(cur, portal_cod.COD_REQUESTS_TABLE):
                    cur.execute(
                        "SELECT id, status, created_at, answered_at FROM "
                        + portal_db._q(portal_cod.COD_REQUESTS_TABLE) +
                        " WHERE client_id = %s AND contact_id = %s"
                        " ORDER BY id DESC LIMIT 10",
                        (principal["client_id"], contact),
                    )
                    cod_requests = portal_db.rows(cur)
                sequence_items = []
                if _profile_table_exists(cur, portal_sequences.SEQUENCES_TABLE):
                    cur.execute(
                        "SELECT s.name AS name, e.status AS status,"
                        " e.current_step AS current_step, e.enrolled_at AS enrolled_at"
                        " FROM " + portal_db._q(portal_sequences.ENROLLMENTS_TABLE) +
                        " e JOIN " + portal_db._q(portal_sequences.SEQUENCES_TABLE) +
                        " s ON s.id = e.sequence_id"
                        " WHERE e.client_id = %s AND e.contact_id = %s"
                        " ORDER BY e.id DESC LIMIT 10",
                        (principal["client_id"], contact),
                    )
                    sequence_items = portal_db.rows(cur)
                cur.execute(
                    "SELECT n.body, n.author_email, n.created_at FROM "
                    + portal_db._q(portal_db.NOTES_TABLE) + " n"
                    " JOIN " + portal_db._q(portal_db.CONV_TABLE) + " conv"
                    " ON conv.id = n.conversation_id"
                    " WHERE n.client_id = %s AND conv.client_id = %s"
                    " AND conv.contact_id = %s"
                    " ORDER BY n.id DESC LIMIT 10",
                    (principal["client_id"], principal["client_id"], contact),
                )
                notes = portal_db.rows(cur)
                if _profile_table_exists(cur, "portal_contact_lang"):
                    cur.execute(
                        "SELECT lang FROM " + portal_db._q("portal_contact_lang") +
                        " WHERE client_id = %s AND contact_id = %s",
                        (principal["client_id"], contact),
                    )
                    lang_rows = portal_db.rows(cur)
                else:
                    lang_rows = []
                if _profile_table_exists(cur, "portal_contact_identities"):
                    cur.execute(
                        "SELECT DISTINCT contact_id FROM "
                        + portal_db._q("portal_contact_identities") +
                        " WHERE client_id = %s AND identity_key IN"
                        " (SELECT identity_key FROM "
                        + portal_db._q("portal_contact_identities") +
                        " WHERE client_id = %s AND contact_id = %s)"
                        " ORDER BY contact_id",
                        (principal["client_id"], principal["client_id"], contact),
                    )
                    identity_rows = portal_db.rows(cur)
                else:
                    identity_rows = []
                if _profile_table_exists(cur, "portal_action_requests"):
                    cur.execute(
                        "SELECT id, kind, status, note, created_at FROM "
                        + portal_db._q("portal_action_requests") +
                        " WHERE client_id = %s AND contact_id = %s"
                        " ORDER BY id DESC LIMIT 5",
                        (principal["client_id"], contact),
                    )
                    action_rows = portal_db.rows(cur)
                else:
                    action_rows = []
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "customer profile")[0]), 503
    max_score = int(summary.get("max_lead_score") or 0)
    lead_temp = "cold"
    if summary.get("has_hot"):
        lead_temp = "hot"
    elif max_score >= WARM_LEAD_SCORE:
        lead_temp = "warm"
    return jsonify({
        "contact_id": contact,
        "name": str(summary.get("name") or ""),
        "lead_temp": lead_temp,
        "chats": int(summary.get("chats") or 0),
        "open_chats": int(summary.get("open_chats") or 0),
        "first_seen": _iso(summary.get("first_at")),
        "last_seen": _iso(summary.get("last_at")),
        "tags": tags,
        "conversations": [
            {
                "id": int(row.get("id") or 0),
                "status": row.get("status") or "open",
                "channel": row.get("channel") or "whatsapp",
                "last_message_at": _iso(row.get("last_message_at")),
            }
            for row in conversations
        ],
        "cod_requests": [
            {
                "id": int(row.get("id") or 0),
                "status": row.get("status") or "pending",
                "created_at": _iso(row.get("created_at")),
                "answered_at": _iso(row.get("answered_at")),
            }
            for row in cod_requests
        ],
        "sequences": [
            {
                "name": row.get("name") or "",
                "status": row.get("status") or "active",
                "current_step": int(row.get("current_step") or 0),
                "enrolled_at": _iso(row.get("enrolled_at")),
            }
            for row in sequence_items
        ],
        "notes": [
            {
                "body": row.get("body") or "",
                "author_email": row.get("author_email") or "",
                "created_at": _iso(row.get("created_at")),
            }
            for row in notes
        ],
        "language": (lang_rows[0].get("lang") if lang_rows else None),
        "linked_channels": [
            str(row.get("contact_id") or "")
            for row in identity_rows
            if str(row.get("contact_id") or "")
            and str(row.get("contact_id") or "") != contact
        ],
        "actions": [
            {
                "id": row.get("id"),
                "kind": row.get("kind"),
                "status": row.get("status"),
                "note": str(row.get("note") or ""),
                "created_at": _iso(row.get("created_at")),
            }
            for row in action_rows
        ],
    }), 200



# ---------------------------------------------------------------------------
# Saved replies (canned response templates for the shared inbox)
# ---------------------------------------------------------------------------

MAX_SAVED_REPLIES = 30
MAX_REPLY_BODY = 1000
SHORTCUT_RE = re.compile(r"^[a-z0-9_-]{1,24}$")


def _clean_shortcut(value: Any) -> str:
    """Normalize a shortcut: trim, drop a leading slash, lowercase, cap 24."""
    if not isinstance(value, str):
        return ""
    shortcut = value.strip()
    while shortcut.startswith("/"):
        shortcut = shortcut[1:]
    shortcut = re.sub(r"\\s+", "-", shortcut.strip().lower())
    shortcut = shortcut[:24]
    if not SHORTCUT_RE.match(shortcut):
        return ""
    return shortcut


@bp.get("/saved-replies")
def list_saved_replies():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_saved_usage_columns(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, shortcut, body, created_at,"
                    " COALESCE(use_count, 0) AS use_count, last_used_at FROM "
                    + portal_db._q(portal_db.SAVED_REPLIES_TABLE) +
                    " WHERE client_id = %s ORDER BY id DESC LIMIT %s",
                    (principal["client_id"], MAX_SAVED_REPLIES),
                )
                rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "saved replies read")[0]), 503
    return jsonify({"replies": [
        {
            "id": int(row.get("id") or 0),
            "shortcut": str(row.get("shortcut") or ""),
            "body": str(row.get("body") or ""),
            "created_at": _iso(row.get("created_at")),
            "use_count": int(row.get("use_count") or 0),
            "last_used_at": _iso(row.get("last_used_at")),
        }
        for row in rows
    ]}), 200


@bp.post("/saved-replies")
def create_saved_reply():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    shortcut = _clean_shortcut(payload.get("shortcut"))
    if not shortcut:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Shortcut can use letters, numbers, dashes and underscores (max 24)."}}), 400
    body_text = payload.get("body")
    body_text = body_text.strip() if isinstance(body_text, str) else ""
    if not body_text:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Message text is required."}}), 400
    if len(body_text) > MAX_REPLY_BODY:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Message must be 1000 characters or fewer."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) AS total FROM "
                    + portal_db._q(portal_db.SAVED_REPLIES_TABLE) +
                    " WHERE client_id = %s",
                    (principal["client_id"],),
                )
                counts = portal_db.rows(cur)
                if counts and int(counts[0].get("total") or 0) >= MAX_SAVED_REPLIES:
                    return jsonify({"error": {"code": "limit_reached",
                                              "message": "Up to 30 saved replies per workspace."}}), 409
                cur.execute(
                    "SELECT id FROM " + portal_db._q(portal_db.SAVED_REPLIES_TABLE) +
                    " WHERE client_id = %s AND LOWER(shortcut) = LOWER(%s) LIMIT 1",
                    (principal["client_id"], shortcut),
                )
                if portal_db.rows(cur):
                    return jsonify({"error": {"code": "duplicate",
                                              "message": "A reply with this shortcut already exists."}}), 409
                cur.execute(
                    "INSERT INTO " + portal_db._q(portal_db.SAVED_REPLIES_TABLE) +
                    " (client_id, shortcut, body, created_at)"
                    " VALUES (%s, %s, %s, NOW()) RETURNING id, shortcut, body, created_at",
                    (principal["client_id"], shortcut, body_text),
                )
                inserted = portal_db.rows(cur)
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "saved_reply.created",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Saved reply added: /" + shortcut)[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "saved reply create")[0]), 503
    created = inserted[0] if inserted else {}
    return jsonify({"ok": True, "reply": {
        "id": int(created.get("id") or 0),
        "shortcut": str(created.get("shortcut") or shortcut),
        "body": str(created.get("body") or body_text),
        "created_at": _iso(created.get("created_at")),
    }}), 200


@bp.delete("/saved-replies/<int:reply_id>")
def delete_saved_reply(reply_id: int):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM " + portal_db._q(portal_db.SAVED_REPLIES_TABLE) +
                    " WHERE id = %s AND client_id = %s RETURNING shortcut",
                    (reply_id, principal["client_id"]),
                )
                deleted = portal_db.rows(cur)
                if not deleted:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Saved reply not found."}}), 404
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "saved_reply.deleted",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Saved reply deleted: /"
                     + str(deleted[0].get("shortcut") or ""))[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "saved reply delete")[0]), 503
    return jsonify({"ok": True}), 200

# ---------------------------------------------------------------------------
# Saved replies v2 (editing + usage stats) and activity CSV export
# ---------------------------------------------------------------------------

_SAVED_USAGE_DDL_READY = False


def _ensure_saved_usage_columns(conn) -> None:
    """Usage columns landed in batch 281-295; older tables get them lazily."""
    global _SAVED_USAGE_DDL_READY
    if _SAVED_USAGE_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "ALTER TABLE " + portal_db._q(portal_db.SAVED_REPLIES_TABLE) +
            " ADD COLUMN IF NOT EXISTS use_count INT NOT NULL DEFAULT 0"
        )
        cur.execute(
            "ALTER TABLE " + portal_db._q(portal_db.SAVED_REPLIES_TABLE) +
            " ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ"
        )
    conn.commit()
    _SAVED_USAGE_DDL_READY = True


@bp.put("/saved-replies/<int:reply_id>")
def update_saved_reply(reply_id: int):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    shortcut = _clean_shortcut(payload.get("shortcut"))
    if not shortcut:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Shortcut can use letters, numbers, dashes and underscores (max 24)."}}), 400
    body_text = payload.get("body")
    body_text = body_text.strip() if isinstance(body_text, str) else ""
    if not body_text:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Message text is required."}}), 400
    if len(body_text) > MAX_REPLY_BODY:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Message must be 1000 characters or fewer."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id FROM "
                    + portal_db._q(portal_db.SAVED_REPLIES_TABLE) +
                    " WHERE client_id = %s AND LOWER(shortcut) = LOWER(%s)"
                    " AND id <> %s LIMIT 1",
                    (principal["client_id"], shortcut, reply_id),
                )
                if portal_db.rows(cur):
                    return jsonify({"error": {"code": "duplicate",
                                              "message": "A reply with this shortcut already exists."}}), 409
                cur.execute(
                    "UPDATE " + portal_db._q(portal_db.SAVED_REPLIES_TABLE) +
                    " SET shortcut = %s, body = %s"
                    " WHERE id = %s AND client_id = %s"
                    " RETURNING id, shortcut, body, created_at",
                    (shortcut, body_text, reply_id, principal["client_id"]),
                )
                updated = portal_db.rows(cur)
                if not updated:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Saved reply not found."}}), 404
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "saved_reply.updated",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Saved reply updated: /" + shortcut)[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "saved reply update")[0]), 503
    row = updated[0]
    return jsonify({"ok": True, "reply": {
        "id": int(row.get("id") or 0),
        "shortcut": str(row.get("shortcut") or shortcut),
        "body": str(row.get("body") or body_text),
        "created_at": _iso(row.get("created_at")),
    }}), 200


@bp.post("/saved-replies/<int:reply_id>/use")
def use_saved_reply(reply_id: int):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_saved_usage_columns(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(portal_db.SAVED_REPLIES_TABLE) +
                    " SET use_count = COALESCE(use_count, 0) + 1,"
                    " last_used_at = NOW()"
                    " WHERE id = %s AND client_id = %s RETURNING id",
                    (reply_id, principal["client_id"]),
                )
                if not portal_db.rows(cur):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Saved reply not found."}}), 404
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "saved reply use")[0]), 503
    return jsonify({"ok": True}), 200


@bp.get("/activity/export")
def export_activity_csv():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, created_at, action, actor_kind, note,"
                    " conversation_id FROM " + portal_db._q("portal_action_log") +
                    " WHERE client_id = %s"
                    " ORDER BY created_at DESC, id DESC LIMIT 2000",
                    (principal["client_id"],),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "activity export")[0]), 503
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["id", "created_at", "action", "actor", "note",
                     "conversation_id"])
    for row in found:
        created = row.get("created_at")
        conversation = row.get("conversation_id")
        writer.writerow([
            row.get("id"),
            created.isoformat() if created else "",
            row.get("action"),
            row.get("actor_kind"),
            str(row.get("note") or ""),
            conversation if conversation is not None else "",
        ])
    return Response(
        buffer.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=omniflow-activity.csv"},
    )

@bp.post("/customers/merge")
def merge_customers():
    """Move one duplicate contact's history onto the kept contact."""
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    keep = str(payload.get("keep") or "").strip()[:100]
    merge = str(payload.get("merge") or "").strip()[:100]
    if not keep or not merge:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Both contacts are required."}}), 400
    if keep == merge:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Pick two different contacts."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) AS total FROM "
                    + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE client_id = %s AND contact_id = %s",
                    (principal["client_id"], merge),
                )
                counts = portal_db.rows(cur)
                merge_chats = int(counts[0].get("total") or 0) if counts else 0
                if merge_chats == 0:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "The duplicate contact has no chats."}}), 404
                cur.execute(
                    "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
                    " SET contact_id = %s"
                    " WHERE client_id = %s AND contact_id = %s",
                    (keep, principal["client_id"], merge),
                )
                stage_moved = 0
                if _profile_table_exists(cur, "portal_contact_stage"):
                    cur.execute(
                        "DELETE FROM " + portal_db._q("portal_contact_stage") +
                        " WHERE client_id = %s AND contact_id = %s"
                        " AND EXISTS (SELECT 1 FROM "
                        + portal_db._q("portal_contact_stage") + " k"
                        " WHERE k.client_id = "
                        + portal_db._q("portal_contact_stage") + ".client_id"
                        " AND k.contact_id = %s)",
                        (principal["client_id"], merge, keep),
                    )
                    cur.execute(
                        "UPDATE " + portal_db._q("portal_contact_stage") +
                        " SET contact_id = %s"
                        " WHERE client_id = %s AND contact_id = %s",
                        (keep, principal["client_id"], merge),
                    )
                    stage_moved = 1
                if _profile_table_exists(cur, "portal_cod_requests"):
                    cur.execute(
                        "UPDATE " + portal_db._q("portal_cod_requests") +
                        " SET contact_id = %s"
                        " WHERE client_id = %s AND contact_id = %s",
                        (keep, principal["client_id"], merge),
                    )
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "customers.merged",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Merged " + merge + " into " + keep
                     + " (" + str(merge_chats) + " chats moved).")[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "customer merge")[0]), 503
    return jsonify({"ok": True, "moved": merge_chats}), 200
