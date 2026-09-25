"""Portal growth ops (broadcasts, KB gap report, CSAT ratings).

Broadcasts: a WhatsApp message is fanned out to a targeted audience through
the existing connector command queue - one send_message command per
recipient, capped, with {name} personalization and delivery counts read
back from the command table. KB gaps: when auto-reply is enabled and a
customer question within the KB intents matches no entry, the question is
recorded so the business can close the gap with a new entry. CSAT: the
business sends a 1-5 rating request from a thread; the customer's numeric
reply inside the validity window is captured in the ingest transaction,
thanked automatically and summarized. All deterministic: zero AI cost, no
bridge changes, no bot restart.
"""

import json
import logging
from datetime import datetime, timedelta, timezone
import re
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db
import portal_plans
import portal_kb


logger = logging.getLogger("omniflow.portal-growth")

bp = Blueprint("portal_growth", __name__, url_prefix="/api/v1")

BROADCASTS_TABLE = portal_db.BROADCASTS_TABLE
GAPS_TABLE = portal_db.GAPS_TABLE
CSAT_TABLE = portal_db.CSAT_TABLE

BROADCAST_MAX_BODY = 1000
BROADCAST_MAX_RECIPIENTS = 200
BROADCAST_SCHEDULE_MAX_DAYS = 30
_SCHEDULE_COLUMNS_READY = False
GAP_COOLDOWN_SECONDS = 300
GAP_QUESTION_MAX = 300
CSAT_WINDOW_HOURS = 48

AUDIENCES = ("all", "open", "hot")
AUDIENCE_LABELS = {
    "all": "all customers",
    "open": "open chats",
    "hot": "hot leads",
}
RATING_RE = re.compile(r"^\\s*([1-5])(?:\\s*/\\s*5|\\s*stars?)?\\s*$")

CSAT_REQUEST_TEMPLATE = (
    "Hi {name}! How did we do? Reply with a rating from 1 to 5 "
    "(5 = excellent) - it helps us improve."
)
CSAT_THANKS_HIGH = (
    "Thank you {name}! We are glad we could help. See you again soon."
)
CSAT_THANKS_LOW = (
    "Thank you for the honest feedback, {name}. Message us here and we "
    "will make it right."
)


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


def _iso(value) -> Optional[str]:
    """ISO-8601 string for timestamps coming out of the driver, else None."""
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _first_name(contact_name) -> str:
    display = str(contact_name or "").strip()
    return display.split(" ")[0] if display else "there"


def _broadcast_public(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": int(row.get("id") or 0),
        "audience": row.get("audience") or "all",
        "body": row.get("body") or "",
        "recipient_count": int(row.get("recipient_count") or 0),
        "created_at": _iso(row.get("created_at")),
        "queued": row.get("queued"),
        "done": row.get("done"),
        "failed": row.get("failed"),
    }


def _gap_public(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": int(row.get("id") or 0),
        "conversation_id": int(row.get("conversation_id") or 0),
        "question": row.get("question") or "",
        "intent": row.get("intent") or "general",
        "resolved": row.get("resolved") == 1 or row.get("resolved") is True,
        "created_at": _iso(row.get("created_at")),
    }


def _audience_clause(audience: str) -> Tuple[str, List[Any]]:
    if audience == "open":
        return " AND c.status = 'open'", []
    if audience == "hot":
        return " AND c.lead_temp = 'hot'", []
    return "", []


def _resolve_recipients(cur, client_id, audience) -> List[Dict[str, Any]]:
    if audience.startswith("segment:"):
        return _segment_recipients(cur, client_id, int(audience[8:]))
    clause, extra = _audience_clause(audience)
    cur.execute(
        "SELECT c.contact_id, MAX(c.contact_name) AS contact_name FROM "
        + portal_db._q(portal_db.CONV_TABLE) + " c"
        " WHERE c.client_id = %s AND COALESCE(c.contact_id, '') <> ''" + clause +
        " GROUP BY c.contact_id ORDER BY MIN(c.id) ASC LIMIT 501",
        [client_id] + extra,
    )
    return portal_db.rows(cur)


def _valid_audience(audience: str) -> bool:
    """all/open/hot or segment:<id> (saved-segment scheduled sends)."""
    if audience in AUDIENCES:
        return True
    return audience.startswith("segment:") and audience[8:].isdigit()


def _segment_recipients(cur, client_id, segment_id) -> List[Dict[str, Any]]:
    """Members of a saved segment, resolved at schedule AND send time.

    Deferred import avoids the portal_segments cycle (segments import
    growth for _send_command); a missing/broken segment resolves to no
    recipients so the schedule/save path reports it honestly.
    """
    try:
        import portal_segments

        return portal_segments.segment_member_rows(cur, client_id, segment_id)
    except Exception:
        return []


def _send_command(cur, client_id, external_user_id, display_name, body,
                  source, broadcast_id=None):
    """Queue a customer send through the connector command queue. Telegram
    contacts (tg: prefix) ride the telegram channel; opted-out contacts are
    never queued."""
    payload: Dict[str, Any] = {
        "external_user_id": external_user_id,
        "body": str(body or "")[:1000],
        "source": source,
    }
    display = str(display_name or "").strip()
    if display:
        payload["target_display_name"] = display
    if broadcast_id is not None:
        payload["broadcast_id"] = int(broadcast_id)
    contact = str(external_user_id or "").strip()
    channel = "telegram" if contact.startswith("tg:") else "whatsapp"
    try:
        cur.execute(
            "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
            " (client_id, channel, action, payload, status, requested_by,"
            " created_at, updated_at) "
            "SELECT %s, %s, 'send_message', CAST(%s AS JSONB),"
            " 'pending', NULL, NOW(), NOW()"
            " WHERE NOT EXISTS (SELECT 1 FROM " + portal_db._q("portal_optouts") +
            " WHERE client_id = %s AND contact_id = %s)",
            (client_id, channel, json.dumps(payload), client_id, contact),
        )
    except Exception:
        # Deployments without the opt-out table (compliance never used) still send.
        cur.execute(
            "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
            " (client_id, channel, action, payload, status, requested_by,"
            " created_at, updated_at) "
            "VALUES (%s, %s, 'send_message', CAST(%s AS JSONB),"
            " 'pending', NULL, NOW(), NOW())",
            (client_id, channel, json.dumps(payload)),
        )


def _conversation_contact(cur, client_id, conversation_id):
    cur.execute(
        "SELECT contact_id, contact_name FROM "
        + portal_db._q(portal_db.CONV_TABLE) +
        " WHERE id = %s AND client_id = %s LIMIT 1",
        (conversation_id, client_id),
    )
    rows = portal_db.rows(cur)
    if not rows:
        return None
    external_user_id = str(rows[0].get("contact_id") or "").strip()
    if not external_user_id:
        return None
    return external_user_id, str(rows[0].get("contact_name") or "").strip()


@bp.get("/portal/broadcasts")
def list_broadcasts():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, audience, body, recipient_count, created_at"
                    " FROM " + portal_db._q(BROADCASTS_TABLE) +
                    " WHERE client_id = %s ORDER BY id DESC LIMIT 20",
                    (client_id,),
                )
                broadcasts = portal_db.rows(cur)
                cur.execute(
                    "SELECT payload->>'broadcast_id' AS broadcast_id, status,"
                    " COUNT(*) AS total FROM " + portal_db._q(portal_db.CMD_TABLE) +
                    " WHERE client_id = %s AND action = 'send_message'"
                    " AND payload->>'broadcast_id' IS NOT NULL"
                    " GROUP BY 1, 2",
                    (client_id,),
                )
                counts = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "broadcast list")[0]), 503
    by_broadcast: Dict[str, Dict[str, int]] = {}
    for row in counts:
        bid = str(row.get("broadcast_id") or "")
        status = str(row.get("status") or "")
        total = int(row.get("total") or 0)
        bucket = by_broadcast.setdefault(bid, {"queued": 0, "done": 0, "failed": 0})
        if status in bucket:
            bucket[status] += total
    items = []
    for row in broadcasts:
        public = _broadcast_public(row)
        bucket = by_broadcast.get(str(public["id"]))
        if bucket:
            public["queued"] = bucket["queued"]
            public["done"] = bucket["done"]
            public["failed"] = bucket["failed"]
        items.append(public)
    return jsonify({"broadcasts": items}), 200


def _ensure_schedule_columns(conn) -> None:
    """Lazy migration: schedules live on the broadcasts table (runs once)."""
    global _SCHEDULE_COLUMNS_READY
    if _SCHEDULE_COLUMNS_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "ALTER TABLE " + portal_db._q(BROADCASTS_TABLE) +
            " ADD COLUMN IF NOT EXISTS send_at TIMESTAMPTZ,"
            " ADD COLUMN IF NOT EXISTS recipients_json JSONB,"
            " ADD COLUMN IF NOT EXISTS materialized_at TIMESTAMPTZ"
        )
    conn.commit()
    _SCHEDULE_COLUMNS_READY = True


def _parse_send_at(raw: Any):
    """Accept an ISO timestamp; return an aware datetime or None."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        parsed = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed


def _schedule_public(row: dict) -> dict:
    send_at = row.get("send_at")
    return {
        "id": row.get("id"),
        "audience": row.get("audience") or "all",
        "body": row.get("body") or "",
        "recipient_count": int(row.get("recipient_count") or 0),
        "send_at": _iso(send_at),
        "created_at": _iso(row.get("created_at")),
    }


@bp.post("/portal/broadcasts/schedule")
def schedule_broadcast():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = principal["client_id"]
    payload = request.get_json(silent=True) or {}
    audience = str(payload.get("audience") or "all").strip().lower()
    body = str(payload.get("body") or "").strip()
    if not _valid_audience(audience):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "audience must be all, open, or hot."}}), 400
    if not body:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Message text is required."}}), 400
    if len(body) > BROADCAST_MAX_BODY:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Broadcasts must be 1000 characters or fewer."}}), 400
    send_at = _parse_send_at(payload.get("send_at"))
    if send_at is None:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "send_at must be an ISO date-time with a timezone."}}), 400
    now_utc = datetime.now(timezone.utc)
    if send_at <= now_utc:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Pick a time in the future."}}), 400
    if send_at > now_utc + timedelta(days=BROADCAST_SCHEDULE_MAX_DAYS):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Schedule at most "
                                  + str(BROADCAST_SCHEDULE_MAX_DAYS) + " days ahead."}}), 400
    scheduled_row = None
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_schedule_columns(conn)
            with conn.cursor() as cur:
                recipients = _resolve_recipients(cur, client_id, audience)
                if not recipients:
                    return jsonify({"error": {"code": "no_recipients",
                                              "message": "No conversations match this audience yet."}}), 400
                if len(recipients) > BROADCAST_MAX_RECIPIENTS:
                    return jsonify({"error": {"code": "too_many_recipients",
                                              "message": "Audience has more than "
                                              + str(BROADCAST_MAX_RECIPIENTS)
                                              + " customers. Narrow it down (open chats or hot leads)."}}), 400
                from psycopg2.extras import Json

                cur.execute(
                    "INSERT INTO " + portal_db._q(BROADCASTS_TABLE) +
                    " (client_id, audience, body, recipient_count, send_at, recipients_json)"
                    " VALUES (%s, %s, %s, %s, %s, %s)"
                    " RETURNING id, audience, body, recipient_count, send_at, created_at",
                    (client_id, audience, body, len(recipients), send_at,
                     Json([{"contact_id": str(r.get("contact_id") or ""),
                            "contact_name": str(r.get("contact_name") or "")}
                           for r in recipients])),
                )
                rows = portal_db.rows(cur)
                scheduled_row = rows[0] if rows else {}
                portal_db.log_action(
                    cur,
                    client_id,
                    "broadcast.scheduled",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Broadcast scheduled for "
                    + send_at.isoformat() + " ("
                    + AUDIENCE_LABELS.get(audience, audience) + ").",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "broadcast schedule")[0]), 503
    return jsonify({"ok": True, "scheduled": _schedule_public(scheduled_row or {})}), 200


@bp.get("/portal/broadcasts/scheduled")
def list_scheduled_broadcasts():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_schedule_columns(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, audience, body, recipient_count, send_at, created_at"
                    " FROM " + portal_db._q(BROADCASTS_TABLE) +
                    " WHERE client_id = %s"
                    " AND send_at IS NOT NULL AND materialized_at IS NULL"
                    " ORDER BY send_at ASC LIMIT 20",
                    (principal["client_id"],),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "scheduled broadcasts read")[0]), 503
    return jsonify({"scheduled": [_schedule_public(row) for row in found]}), 200


@bp.delete("/portal/broadcasts/scheduled/<int:broadcast_id>")
def cancel_scheduled_broadcast(broadcast_id: int):
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
            _ensure_schedule_columns(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM " + portal_db._q(BROADCASTS_TABLE) +
                    " WHERE id = %s AND client_id = %s"
                    " AND send_at IS NOT NULL AND materialized_at IS NULL"
                    " RETURNING id",
                    (broadcast_id, principal["client_id"]),
                )
                found = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "scheduled broadcast cancel")[0]), 503
    if not found:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Scheduled broadcast not found (or already sent)."}}), 404
    return jsonify({"ok": True}), 200


def materialize_due_broadcasts(cur, client_id, conn) -> int:
    """Fan out due scheduled broadcasts as send_message commands (max 5)."""
    cur.execute(
        "SELECT id, client_id, audience, body, recipients_json"
        " FROM " + portal_db._q(BROADCASTS_TABLE) +
        " WHERE client_id = %s"
        " AND send_at IS NOT NULL AND materialized_at IS NULL"
        " AND send_at <= NOW()"
        " ORDER BY send_at ASC LIMIT 5",
        (client_id,),
    )
    due_rows = portal_db.rows(cur)
    delivered = 0
    for row in due_rows:
        broadcast_id = int(row.get("id") or 0)
        row_client = int(row.get("client_id") or client_id)
        audience = str(row.get("audience") or "all")
        body = str(row.get("body") or "")
        recipients = row.get("recipients_json")
        if not isinstance(recipients, list) or not recipients:
            recipients = _resolve_recipients(cur, row_client, audience)
        sent_count = 0
        for recipient in recipients:
            if not isinstance(recipient, dict):
                continue
            external_user_id = str(recipient.get("contact_id") or "").strip()
            if not external_user_id:
                continue
            display = str(recipient.get("contact_name") or "").strip()
            rendered = body.replace("{name}", _first_name(display))
            _send_command(cur, row_client, external_user_id, display,
                          rendered, "broadcast", broadcast_id=broadcast_id)
            sent_count += 1
        cur.execute(
            "UPDATE " + portal_db._q(BROADCASTS_TABLE) +
            " SET materialized_at = NOW() WHERE id = %s",
            (broadcast_id,),
        )
        portal_db.log_action(
            cur,
            row_client,
            "broadcast.sent",
            "system",
            None,
            None,
            "Scheduled broadcast delivered to "
            + str(sent_count) + " customers (" + AUDIENCE_LABELS.get(audience, audience) + ").",
        )
        delivered += 1
    if delivered:
        conn.commit()
    return delivered


@bp.get("/portal/broadcasts/preview")
def preview_broadcast():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    audience = (request.args.get("audience") or "all").strip().lower()
    if audience not in AUDIENCES:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "audience must be all, open, or hot."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                rows = _resolve_recipients(cur, principal["client_id"], audience)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "broadcast preview")[0]), 503
    sample = [
        str(r.get("contact_name") or r.get("contact_id") or "").strip() or "customer"
        for r in rows[:5]
    ]
    return jsonify({"audience": audience, "count": len(rows), "sample": sample}), 200


@bp.post("/portal/broadcasts")
def create_broadcast():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = principal["client_id"]
    payload = request.get_json(silent=True) or {}
    audience = str(payload.get("audience") or "all").strip().lower()
    body = str(payload.get("body") or "").strip()
    if audience not in AUDIENCES:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "audience must be all, open, or hot."}}), 400
    if not body:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Message text is required."}}), 400
    if len(body) > BROADCAST_MAX_BODY:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Broadcasts must be 1000 characters or fewer."}}), 400
    broadcast_row = None
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                recipients = _resolve_recipients(cur, client_id, audience)
                if not recipients:
                    return jsonify({"error": {"code": "no_recipients",
                                              "message": "No conversations match this audience yet."}}), 400
                if len(recipients) > BROADCAST_MAX_RECIPIENTS:
                    return jsonify({"error": {"code": "too_many_recipients",
                                              "message": "Audience has more than "
                                              + str(BROADCAST_MAX_RECIPIENTS)
                                              + " customers. Narrow it down (open chats or hot leads)."}}), 400
                blocked = portal_plans.enforce(cur, client_id,
                                               "broadcasts_per_month",
                                               "Monthly broadcast")
                if blocked is not None:
                    return blocked
                cur.execute(
                    "INSERT INTO " + portal_db._q(BROADCASTS_TABLE) +
                    " (client_id, audience, body, recipient_count)"
                    " VALUES (%s, %s, %s, %s)"
                    " RETURNING id, audience, body, recipient_count, created_at",
                    (client_id, audience, body, len(recipients)),
                )
                rows = portal_db.rows(cur)
                broadcast_row = rows[0] if rows else {}
                broadcast_id = int((broadcast_row or {}).get("id") or 0)
                for recipient in recipients:
                    external_user_id = str(recipient.get("contact_id") or "").strip()
                    if not external_user_id:
                        continue
                    display = str(recipient.get("contact_name") or "").strip()
                    rendered = body.replace("{name}", _first_name(display))
                    _send_command(cur, client_id, external_user_id, display,
                                  rendered, "broadcast", broadcast_id=broadcast_id)
                portal_db.log_action(
                    cur,
                    client_id,
                    "broadcast.sent",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Broadcast to " + str(len(recipients)) + " customers ("
                    + AUDIENCE_LABELS[audience] + ").",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "broadcast send")[0]), 503
    return jsonify({"ok": True, "broadcast": _broadcast_public(broadcast_row or {}),
                    "recipients": len(recipients)}), 200


@bp.post("/portal/conversations/<int:conversation_id>/csat")
def request_csat(conversation_id: int):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = principal["client_id"]
    csat_row = None
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                contact = _conversation_contact(cur, client_id, conversation_id)
                if contact is None:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Conversation not found or has no deliverable contact."}}), 404
                external_user_id, display_name = contact
                _send_command(cur, client_id, external_user_id, display_name,
                              CSAT_REQUEST_TEMPLATE.format(name=_first_name(display_name)),
                              "csat_request")
                cur.execute(
                    "INSERT INTO " + portal_db._q(CSAT_TABLE) +
                    " (client_id, conversation_id, contact_id, contact_name,"
                    " requested_at)"
                    " VALUES (%s, %s, %s, %s, NOW())"
                    " ON CONFLICT (conversation_id) DO UPDATE SET"
                    " score = NULL, answered_at = NULL, requested_at = NOW(),"
                    " updated_at = NOW()"
                    " RETURNING id, score, requested_at, answered_at",
                    (client_id, conversation_id, external_user_id,
                     display_name or None),
                )
                rows = portal_db.rows(cur)
                csat_row = rows[0] if rows else {}
                portal_db.log_action(
                    cur,
                    client_id,
                    "csat.requested",
                    "customer_user",
                    principal.get("user_id"),
                    conversation_id,
                    "CSAT rating request sent.",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "csat request")[0]), 503
    row = csat_row or {}
    return jsonify({"ok": True, "csat": {
        "id": int(row.get("id") or 0),
        "score": row.get("score"),
        "requested_at": _iso(row.get("requested_at")),
        "answered_at": _iso(row.get("answered_at")),
    }}), 200


@bp.get("/portal/conversations/<int:conversation_id>/csat")
def get_csat(conversation_id: int):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                contact = _conversation_contact(cur, client_id, conversation_id)
                if contact is None:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Conversation not found."}}), 404
                cur.execute(
                    "SELECT id, score, requested_at, answered_at FROM "
                    + portal_db._q(CSAT_TABLE) +
                    " WHERE conversation_id = %s AND client_id = %s LIMIT 1",
                    (conversation_id, client_id),
                )
                rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "csat get")[0]), 503
    row = rows[0] if rows else None
    if not row:
        return jsonify({"csat": None}), 200
    return jsonify({"csat": {
        "id": int(row.get("id") or 0),
        "score": row.get("score"),
        "requested_at": _iso(row.get("requested_at")),
        "answered_at": _iso(row.get("answered_at")),
    }}), 200


@bp.get("/portal/csat/summary")
def csat_summary():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT score, COUNT(*) AS total FROM "
                    + portal_db._q(CSAT_TABLE) +
                    " WHERE client_id = %s AND score IS NOT NULL"
                    " GROUP BY score",
                    (client_id,),
                )
                scored = portal_db.rows(cur)
                cur.execute(
                    "SELECT COUNT(*) AS total FROM "
                    + portal_db._q(CSAT_TABLE) +
                    " WHERE client_id = %s AND score IS NULL",
                    (client_id,),
                )
                pending_rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "csat summary")[0]), 503
    dist = [0, 0, 0, 0, 0]
    total = 0
    weighted = 0
    for row in scored:
        score = row.get("score")
        try:
            score_int = int(score)
        except (TypeError, ValueError):
            continue
        if 1 <= score_int <= 5:
            count = int(row.get("total") or 0)
            dist[score_int - 1] += count
            total += count
            weighted += score_int * count
    average = round(weighted / total, 1) if total else None
    pending = 0
    if pending_rows:
        try:
            pending = int(pending_rows[0].get("total") or 0)
        except (TypeError, ValueError):
            pending = 0
    return jsonify({
        "average": average,
        "total": total,
        "pending": pending,
        "dist": dist,
    }), 200


@bp.get("/portal/kb/gaps")
def list_gaps():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    client_id = principal["client_id"]
    status = (request.args.get("status") or "open").strip().lower()
    if status not in ("open", "all"):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "status must be open or all."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                where = " WHERE client_id = %s"
                params: List[Any] = [client_id]
                if status == "open":
                    where += " AND resolved = 0"
                    params.append(0)
                cur.execute(
                    "SELECT id, conversation_id, question, intent, resolved,"
                    " created_at FROM " + portal_db._q(GAPS_TABLE) + where +
                    " ORDER BY id DESC LIMIT 50",
                    tuple(params),
                )
                gaps = portal_db.rows(cur)
                cur.execute(
                    "SELECT COUNT(*) AS total FROM "
                    + portal_db._q(GAPS_TABLE) +
                    " WHERE client_id = %s AND resolved = 0",
                    (client_id,),
                )
                count_rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "kb gaps")[0]), 503
    open_count = 0
    if count_rows:
        try:
            open_count = int(count_rows[0].get("total") or 0)
        except (TypeError, ValueError):
            open_count = 0
    return jsonify({"gaps": [_gap_public(g) for g in gaps],
                    "open_count": open_count}), 200


@bp.patch("/portal/kb/gaps/<int:gap_id>")
def resolve_gap(gap_id: int):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(GAPS_TABLE) +
                    " SET resolved = 1, resolved_at = NOW()"
                    " WHERE id = %s AND client_id = %s AND resolved = 0"
                    " RETURNING id",
                    (gap_id, client_id),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Gap not found or already resolved."}}), 404
                portal_db.log_action(
                    cur,
                    client_id,
                    "kb.gap_resolved",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Knowledge gap #" + str(gap_id) + " resolved.",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "kb gap resolve")[0]), 503
    return jsonify({"ok": True}), 200


def record_kb_gap(client_id, conversation_id, contact_id, contact_name,
                  message_text, intent, conn):
    """Record an unanswered in-scope question as a knowledge gap, inside the
    ingest transaction. Fires only when KB auto-reply is enabled and the
    intent is in the KB auto-reply set (i.e. an entry COULD have answered).
    Per-conversation cooldown keeps one busy chat from flooding the report.
    Never raises into the caller: wrap in try/except there."""
    if intent not in portal_kb.KB_AUTO_INTENTS:
        return
    with conn.cursor() as cur:
        cur.execute(
            "SELECT auto_reply FROM " + portal_db._q(portal_kb.KB_SETTINGS_TABLE) +
            " WHERE client_id = %s LIMIT 1",
            (client_id,),
        )
        settings_rows = portal_db.rows(cur)
        if not settings_rows or settings_rows[0].get("auto_reply") is not True:
            return
        cur.execute(
            "SELECT 1 FROM " + portal_db._q(GAPS_TABLE) +
            " WHERE conversation_id = %s"
            " AND created_at > NOW() - make_interval(secs => %s)"
            " LIMIT 1",
            (conversation_id, GAP_COOLDOWN_SECONDS),
        )
        if portal_db.rows(cur):
            return
        question = str(message_text or "").strip()[:GAP_QUESTION_MAX]
        if not question:
            return
        cur.execute(
            "INSERT INTO " + portal_db._q(GAPS_TABLE) +
            " (client_id, conversation_id, question, intent)"
            " VALUES (%s, %s, %s, %s)"
            " RETURNING (SELECT COUNT(*) FROM " + portal_db._q(GAPS_TABLE) +
            " g WHERE g.conversation_id = %s AND g.client_id = %s) AS total",
            (client_id, conversation_id, question, str(intent or "general"),
             conversation_id, client_id),
        )
        inserted = portal_db.rows(cur)
        if inserted and int(inserted[0].get("total") or 0) >= 2:
            _escalate_conversation(cur, client_id, conversation_id,
                                   "repeated knowledge gaps")


def _escalate_conversation(cur, client_id, conversation_id, reason: str) -> None:
    """Assign the conversation to the first team member and audit it, so a
    lost bot hands the chat to a human automatically. Never raises."""
    import portal_db as _db
    try:
        cur.execute(
            "SELECT to_regclass(%s)", ("portal_team_members",),
        )
        found = _db.rows(cur)
        if found and found[0].get("to_regclass"):
            cur.execute(
                "SELECT user_id FROM " + _db._q(_db.TEAM_TABLE) +
                " WHERE client_id = %s AND user_id IS NOT NULL"
                " ORDER BY user_id LIMIT 1",
                (client_id,),
            )
            members = _db.rows(cur)
            if members and members[0].get("user_id") is not None:
                cur.execute(
                    "UPDATE " + _db._q(_db.CONV_TABLE) +
                    " SET assigned_to = %s"
                    " WHERE id = %s AND client_id = %s",
                    (members[0].get("user_id"), conversation_id, client_id),
                )
        _db.log_action(
            cur,
            client_id,
            "bot.escalated",
            "bot",
            None,
            conversation_id,
            ("Bot handed off: " + str(reason))[:200],
        )
    except Exception:
        pass


def handle_inbound(client_id, conversation_id, contact_id, contact_name,
                   message_text, intent, conn):
    """Capture a CSAT rating reply inside the ingest transaction. Only a
    pending, in-window request for THIS conversation counts; the update is
    guarded so a rating is recorded exactly once. Never raises into the
    caller: wrap in try/except there."""
    match = RATING_RE.match(str(message_text or ""))
    if not match:
        return
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM " + portal_db._q(CSAT_TABLE) +
            " WHERE conversation_id = %s AND client_id = %s"
            " AND answered_at IS NULL"
            " AND requested_at > NOW() - make_interval(hours => %s)"
            " LIMIT 1",
            (conversation_id, client_id, CSAT_WINDOW_HOURS),
        )
        rows = portal_db.rows(cur)
        if not rows:
            return
        request_id = int(rows[0].get("id") or 0)
        score = int(match.group(1))
        cur.execute(
            "UPDATE " + portal_db._q(CSAT_TABLE) +
            " SET score = %s, answered_at = NOW(), updated_at = NOW()"
            " WHERE id = %s AND client_id = %s AND answered_at IS NULL"
            " RETURNING contact_id, contact_name",
            (score, request_id, client_id),
        )
        answered = portal_db.rows(cur)
        if not answered:
            return
        external_user_id = str(answered[0].get("contact_id") or "").strip()
        display_name = str(answered[0].get("contact_name") or "").strip()
        if external_user_id:
            template = CSAT_THANKS_HIGH if score >= 4 else CSAT_THANKS_LOW
            _send_command(cur, client_id, external_user_id, display_name,
                          template.format(name=_first_name(display_name)),
                          "csat_reply")
        portal_db.log_action(
            cur,
            client_id,
            "csat.received",
            "customer",
            None,
            conversation_id,
            "CSAT score " + str(score) + "/5.",
        )
