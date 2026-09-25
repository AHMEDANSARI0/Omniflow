// add_growth_ops.mjs — Phase 9: Growth Pack v0 (zero AI cost).
//
// 1. Broadcasts: compose a WhatsApp message once and fan it out to a
//    targeted audience (all customers / open chats / hot leads) through the
//    EXISTING connector command queue — one send_message command per
//    recipient, capped at 200 per broadcast, with {name} personalization,
//    a recipient preview and per-broadcast delivery counts.
// 2. KB gap report: when auto-reply is ON and a customer's general/
//    shipping/order/appointment question matches NO knowledge-base entry,
//    the question is recorded as a "gap" (with a per-conversation cooldown).
//    The knowledge-base page shows open gaps so the business can answer
//    them with a new KB entry, then mark them resolved.
// 3. CSAT ratings: from a conversation thread the business sends a
//    "reply 1-5" rating request. The customer's numeric reply (captured in
//    the ingest transaction, valid 48h) is stored, thanked automatically
//    (different copy for 4-5 vs 1-3) and summarized on the Analytics page.
//
// Zero bridge changes -> NO bot restart. New portal_growth.py blueprint,
// lazy DDL (portal_broadcasts + portal_kb_gaps + portal_csat_requests),
// BFF routes, /dashboard/broadcasts page, RatingCard + KbGapsCard +
// CsatSummaryCard components.
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_growth_ops.mjs
//
// Requires Phase 8 (add_team_ops.mjs) to be applied first.
//
// CRLF-tolerant, idempotent, backups: *.pre_growth.bak
// Expected first run: 26 applied / 0 warnings (15 swaps + 11 new files).
// Expected rerun:     0 applied / 15 already done / 0 warnings.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MODULE_PATH = "OmniFlow-Control-Plane/portal_growth.py";
const BFF_BROADCASTS_PATH = "Omniflow/app/api/omniflow/portal/broadcasts/route.ts";
const BFF_BROADCASTS_PREVIEW_PATH =
  "Omniflow/app/api/omniflow/portal/broadcasts/preview/route.ts";
const BFF_CSAT_PATH =
  "Omniflow/app/api/omniflow/portal/conversations/[id]/csat/route.ts";
const BFF_CSAT_SUMMARY_PATH = "Omniflow/app/api/omniflow/portal/csat/summary/route.ts";
const BFF_GAPS_PATH = "Omniflow/app/api/omniflow/portal/kb/gaps/route.ts";
const BFF_GAPS_ID_PATH = "Omniflow/app/api/omniflow/portal/kb/gaps/[id]/route.ts";
const BROADCASTS_PAGE_PATH = "Omniflow/app/dashboard/(portal)/broadcasts/page.tsx";
const RATING_CARD_PATH =
  "Omniflow/app/dashboard/(portal)/conversations/[id]/RatingCard.tsx";
const KB_GAPS_CARD_PATH =
  "Omniflow/app/dashboard/(portal)/knowledge-base/KbGapsCard.tsx";
const CSAT_SUMMARY_CARD_PATH =
  "Omniflow/app/dashboard/(portal)/analytics/CsatSummaryCard.tsx";

const PY_MODULE = `"""Portal growth ops (broadcasts, KB gap report, CSAT ratings).

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
import re
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db
import portal_kb


logger = logging.getLogger("omniflow.portal-growth")

bp = Blueprint("portal_growth", __name__, url_prefix="/api/v1")

BROADCASTS_TABLE = portal_db.BROADCASTS_TABLE
GAPS_TABLE = portal_db.GAPS_TABLE
CSAT_TABLE = portal_db.CSAT_TABLE

BROADCAST_MAX_BODY = 1000
BROADCAST_MAX_RECIPIENTS = 200
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
    clause, extra = _audience_clause(audience)
    cur.execute(
        "SELECT c.contact_id, MAX(c.contact_name) AS contact_name FROM "
        + portal_db._q(portal_db.CONV_TABLE) + " c"
        " WHERE c.client_id = %s AND COALESCE(c.contact_id, '') <> ''" + clause +
        " GROUP BY c.contact_id ORDER BY MIN(c.id) ASC LIMIT 501",
        [client_id] + extra,
    )
    return portal_db.rows(cur)


def _send_command(cur, client_id, external_user_id, display_name, body,
                  source, broadcast_id=None):
    """Queue a WhatsApp send through the existing connector command queue."""
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
    cur.execute(
        "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
        " (client_id, channel, action, payload, status, requested_by,"
        " created_at, updated_at) "
        "VALUES (%s, 'whatsapp', 'send_message', CAST(%s AS JSONB),"
        " 'pending', NULL, NOW(), NOW())",
        (client_id, json.dumps(payload)),
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
            " VALUES (%s, %s, %s, %s)",
            (client_id, conversation_id, question, str(intent or "general")),
        )


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
`;

const PORTAL_TS_GROWTH_SECTION = `// ---------------------------------------------------------------------------
// Growth: broadcasts, KB gap report, CSAT ratings
// ---------------------------------------------------------------------------

export type BroadcastAudience = "all" | "open" | "hot";

export interface BroadcastPreview {
  audience: BroadcastAudience;
  count: number;
  sample: string[];
}

export interface BroadcastRow {
  id: number;
  audience: BroadcastAudience;
  body: string;
  recipientCount: number;
  createdAt: string | null;
  queued: number | null;
  done: number | null;
  failed: number | null;
}

export interface CsatRequest {
  id: number;
  score: number | null;
  requestedAt: string | null;
  answeredAt: string | null;
}

export interface CsatSummary {
  average: number | null;
  total: number;
  pending: number;
  dist: number[];
}

export interface KbGap {
  id: number;
  conversationId: number;
  question: string;
  intent: string;
  resolved: boolean;
  createdAt: string | null;
}

function normalizeBroadcast(value: unknown): BroadcastRow | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  if (id === null) return null;
  const audience: BroadcastAudience =
    p.audience === "open" || p.audience === "hot" ? p.audience : "all";
  return {
    id,
    audience,
    body: typeof p.body === "string" ? p.body : "",
    recipientCount: typeof p.recipient_count === "number" ? p.recipient_count : 0,
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
    queued: typeof p.queued === "number" ? p.queued : null,
    done: typeof p.done === "number" ? p.done : null,
    failed: typeof p.failed === "number" ? p.failed : null,
  };
}

export async function listBroadcasts(
  accessToken: string
): Promise<{ broadcasts: BroadcastRow[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/broadcasts");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawItems = (payload as Record<string, unknown>).broadcasts;
  if (!Array.isArray(rawItems)) return { broadcasts: [] };
  const broadcasts: BroadcastRow[] = [];
  for (const raw of rawItems) {
    const row = normalizeBroadcast(raw);
    if (row) broadcasts.push(row);
  }
  return { broadcasts };
}

export async function previewBroadcast(
  accessToken: string,
  audience: BroadcastAudience
): Promise<BroadcastPreview | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/broadcasts/preview?audience=" + encodeURIComponent(audience)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  return {
    audience:
      p.audience === "open" || p.audience === "hot"
        ? p.audience
        : "all",
    count: typeof p.count === "number" ? p.count : 0,
    sample: Array.isArray(p.sample)
      ? p.sample.filter((item): item is string => typeof item === "string")
      : [],
  };
}

export type BroadcastSendResult =
  | { kind: "ok"; broadcast: BroadcastRow; recipients: number }
  | { kind: "no_recipients" }
  | { kind: "too_many" }
  | { kind: "unavailable" };

export async function sendBroadcast(
  accessToken: string,
  audience: BroadcastAudience,
  body: string
): Promise<BroadcastSendResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/broadcasts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audience, body }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) {
    const payload: unknown = await response.json().catch(() => null);
    const code =
      payload !== null && typeof payload === "object"
        ? ((payload as Record<string, unknown>).error as Record<string, unknown> | undefined)
            ?.code
        : null;
    if (code === "no_recipients") return { kind: "no_recipients" };
    if (code === "too_many_recipients") return { kind: "too_many" };
    return { kind: "unavailable" };
  }
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  const broadcast = normalizeBroadcast(p.broadcast);
  if (!broadcast) return { kind: "unavailable" };
  return {
    kind: "ok",
    broadcast,
    recipients: typeof p.recipients === "number" ? p.recipients : broadcast.recipientCount,
  };
}

export type CsatRequestResult =
  | { kind: "ok"; csat: CsatRequest }
  | { kind: "not_found" }
  | { kind: "unavailable" };

function normalizeCsat(value: unknown): CsatRequest | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  if (id === null) return null;
  return {
    id,
    score: typeof p.score === "number" ? p.score : null,
    requestedAt: typeof p.requested_at === "string" ? p.requested_at : null,
    answeredAt: typeof p.answered_at === "string" ? p.answered_at : null,
  };
}

export async function requestCsat(
  accessToken: string,
  conversationId: number
): Promise<CsatRequestResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/csat",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const csat = normalizeCsat((payload as Record<string, unknown>).csat);
  if (!csat) return { kind: "unavailable" };
  return { kind: "ok", csat };
}

export async function getConversationCsat(
  accessToken: string,
  conversationId: number
): Promise<{ csat: CsatRequest | null } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/csat"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { csat: null };
  return { csat: normalizeCsat((payload as Record<string, unknown>).csat) };
}

export async function getCsatSummary(
  accessToken: string
): Promise<CsatSummary | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/csat/summary");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const rawDist = Array.isArray(p.dist) ? p.dist : [];
  const dist = [0, 1, 2, 3, 4].map(
    (index) => (typeof rawDist[index] === "number" ? rawDist[index] : 0) as number
  );
  return {
    average: typeof p.average === "number" ? p.average : null,
    total: typeof p.total === "number" ? p.total : 0,
    pending: typeof p.pending === "number" ? p.pending : 0,
    dist,
  };
}

export async function listKbGaps(
  accessToken: string,
  status: "open" | "all" = "open"
): Promise<{ gaps: KbGap[]; openCount: number } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/kb/gaps?status=" + encodeURIComponent(status)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const rawGaps = Array.isArray(p.gaps) ? p.gaps : [];
  const gaps: KbGap[] = [];
  for (const raw of rawGaps) {
    if (raw === null || typeof raw !== "object") continue;
    const g = raw as Record<string, unknown>;
    const id = typeof g.id === "number" ? g.id : null;
    if (id === null) continue;
    gaps.push({
      id,
      conversationId: typeof g.conversation_id === "number" ? g.conversation_id : 0,
      question: typeof g.question === "string" ? g.question : "",
      intent: typeof g.intent === "string" ? g.intent : "general",
      resolved: g.resolved === true || g.resolved === 1,
      createdAt: typeof g.created_at === "string" ? g.created_at : null,
    });
  }
  return {
    gaps,
    openCount: typeof p.open_count === "number" ? p.open_count : 0,
  };
}

export async function resolveKbGap(
  accessToken: string,
  gapId: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/kb/gaps/" + encodeURIComponent(String(gapId)),
      { method: "PATCH" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export type ConversationStatusResult =`;

const BFF_BROADCASTS_FILE = `import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  listBroadcasts,
  requirePortalAccessToken,
  sendBroadcast,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const data = await listBroadcasts(accessToken);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(data, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    audience?: unknown;
    body?: unknown;
  } | null;
  const audience =
    payload?.audience === "open" || payload?.audience === "hot"
      ? payload.audience
      : "all";
  const body = typeof payload?.body === "string" ? payload.body.trim() : "";
  if (!body) {
    return safeJson(
      { error: { code: "bad_request", message: "Message text is required." } },
      400
    );
  }
  if (body.length > 1000) {
    return safeJson(
      { error: { code: "bad_request", message: "Broadcasts must be 1000 characters or fewer." } },
      400
    );
  }

  try {
    const result = await sendBroadcast(accessToken, audience, body);
    if (result.kind === "ok") {
      return safeJson(
        { ok: true, broadcast: result.broadcast, recipients: result.recipients },
        200
      );
    }
    if (result.kind === "no_recipients") {
      return safeJson(
        {
          error: {
            code: "no_recipients",
            message: "No conversations match this audience yet.",
          },
        },
        400
      );
    }
    if (result.kind === "too_many") {
      return safeJson(
        {
          error: {
            code: "too_many_recipients",
            message:
              "Audience has more than 200 customers. Narrow it down (open chats or hot leads).",
          },
        },
        400
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
`;

const BFF_BROADCASTS_PREVIEW_FILE = `import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  previewBroadcast,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const url = new URL(request.url);
  const raw = url.searchParams.get("audience") ?? "all";
  const audience = raw === "open" || raw === "hot" ? raw : "all";

  try {
    const data = await previewBroadcast(accessToken, audience);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(data, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
`;

const BFF_CSAT_FILE = `import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  getConversationCsat,
  requestCsat,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function resolveConversationId(context: RouteContext): Promise<number | null> {
  const { id } = await context.params;
  const conversationId = Number(id);
  if (!Number.isInteger(conversationId) || conversationId <= 0) return null;
  return conversationId;
}

export async function GET(_request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const conversationId = await resolveConversationId(context);
  if (conversationId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid conversation id." } },
      400
    );
  }

  try {
    const data = await getConversationCsat(accessToken, conversationId);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(data, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}

export async function POST(_request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const conversationId = await resolveConversationId(context);
  if (conversationId === null) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid conversation id." } },
      400
    );
  }

  try {
    const result = await requestCsat(accessToken, conversationId);
    if (result.kind === "ok") {
      return safeJson({ ok: true, csat: result.csat }, 200);
    }
    if (result.kind === "not_found") {
      return safeJson(
        {
          error: {
            code: "not_found",
            message: "Conversation not found or has no deliverable contact.",
          },
        },
        404
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
`;

const BFF_CSAT_SUMMARY_FILE = `import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  getCsatSummary,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const data = await getCsatSummary(accessToken);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(data, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
`;

const BFF_GAPS_FILE = `import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  listKbGaps,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const url = new URL(request.url);
  const raw = url.searchParams.get("status") ?? "open";
  const status = raw === "all" ? "all" : "open";

  try {
    const data = await listKbGaps(accessToken, status);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(data, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
`;

const BFF_GAPS_ID_FILE = `import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  resolveKbGap,
} from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(_request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const { id } = await context.params;
  const gapId = Number(id);
  if (!Number.isInteger(gapId) || gapId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid gap id." } },
      400
    );
  }

  try {
    const ok = await resolveKbGap(accessToken, gapId);
    if (!ok) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true }, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
`;

const BROADCASTS_PAGE_FILE = `"use client";

import { useCallback, useEffect, useState } from "react";

interface BroadcastPreview {
  audience: string;
  count: number;
  sample: string[];
}

interface BroadcastRow {
  id: number;
  audience: string;
  body: string;
  recipientCount: number;
  createdAt: string | null;
  queued: number | null;
  done: number | null;
  failed: number | null;
}

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const primaryBtn =
  "rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50";

function audienceLabel(audience: string): string {
  if (audience === "open") return "Open chats";
  if (audience === "hot") return "Hot leads";
  return "All customers";
}

function formatWhen(value: string | null): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function BroadcastsPage() {
  const [history, setHistory] = useState<BroadcastRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expired, setExpired] = useState(false);
  const [audience, setAudience] = useState("all");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<BroadcastPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/broadcasts", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        setExpired(true);
        return;
      }
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        broadcasts?: BroadcastRow[];
      } | null;
      if (payload && Array.isArray(payload.broadcasts)) {
        setHistory(payload.broadcasts);
        setLoaded(true);
      }
    } catch {
      // Transient network issue — the next refresh retries.
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    let alive = true;
    setPreviewLoading(true);
    setConfirming(false);
    async function loadPreview() {
      try {
        const response = await fetch(
          "/api/omniflow/portal/broadcasts/preview?audience=" + audience,
          { credentials: "same-origin", cache: "no-store" }
        );
        if (!response.ok || !alive) return;
        const payload = (await response.json().catch(() => null)) as BroadcastPreview | null;
        if (alive && payload) setPreview(payload);
      } catch {
        // The compose card simply shows no count until the preview lands.
      } finally {
        if (alive) setPreviewLoading(false);
      }
    }
    const timer = window.setTimeout(loadPreview, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [audience]);

  async function sendBroadcast() {
    if (busy || !body.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/broadcasts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ audience, body: body.trim() }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        recipients?: number;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({
          kind: "ok",
          text:
            "Broadcast queued for " +
            String(payload.recipients ?? 0) +
            " customers — messages go out as the connector sends them.",
        });
        setBody("");
        setConfirming(false);
        await loadHistory();
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not send the broadcast. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  if (expired) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-sm text-slate-300">Your session expired.</p>
          <a
            href="/dashboard/reauth"
            className="mt-3 inline-block text-xs text-cyan-300 transition-colors hover:text-cyan-200"
          >
            Re-authenticate →
          </a>
        </div>
      </div>
    );
  }

  const overLimit = (preview?.count ?? 0) > 200;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Broadcasts
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Send one WhatsApp message to a targeted audience. Use{" "}
          <span className="rounded-md border border-white/[0.08] bg-white/[0.03] px-1 py-0.5 text-xs text-cyan-300">
            {"{name}"}
          </span>{" "}
          in the text and it becomes each customer&apos;s first name.
        </p>
      </div>

      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <select
            value={audience}
            onChange={(event) => setAudience(event.target.value)}
            className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white outline-none transition-colors duration-300 focus:border-cyan-400/40 sm:w-56"
          >
            <option value="all">All customers</option>
            <option value="open">Open chats</option>
            <option value="hot">Hot leads</option>
          </select>
          <p className="text-xs text-slate-500">
            {previewLoading
              ? "Counting customers…"
              : overLimit
                ? (preview?.count ?? 0) + " customers match — narrow the audience (max 200)."
                : "Reaches " + (preview?.count ?? 0) + " customers"}
            {!previewLoading && !overLimit && preview && preview.sample.length > 0 && (
              <span className="block truncate text-[11px] text-slate-600">
                e.g. {preview.sample.join(", ")}
              </span>
            )}
          </p>
        </div>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={4}
          maxLength={1000}
          placeholder={"Hi {name}! New winter collection is live — 20% off this week only."}
          className={inputClass + " mt-3 resize-none"}
        />
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
          {confirming ? (
            <>
              <span className="text-xs text-amber-300">
                Send to {preview?.count ?? 0} customers on WhatsApp?
              </span>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="w-full rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-xs font-medium text-slate-300 transition-colors duration-300 hover:bg-white/[0.05] disabled:opacity-50 sm:w-auto"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={sendBroadcast}
                disabled={busy || overLimit || !body.trim()}
                className="w-full rounded-xl border border-emerald-400/25 bg-emerald-400/[0.08] px-4 py-2 text-xs font-medium text-emerald-300 transition-colors duration-300 hover:bg-emerald-400/[0.14] disabled:opacity-50 sm:w-auto"
              >
                {busy ? "Sending…" : "Confirm send"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                setConfirming(true);
                setMessage(null);
              }}
              disabled={!body.trim() || overLimit || (preview?.count ?? 0) === 0}
              className={primaryBtn + " w-full sm:w-auto"}
            >
              Send broadcast
            </button>
          )}
        </div>
        {message && (
          <p
            className={
              "mt-3 text-xs " +
              (message.kind === "ok" ? "text-emerald-300" : "text-red-300")
            }
          >
            {message.text}
          </p>
        )}
      </div>

      <div className="mt-6">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Recent broadcasts
        </h2>
        {loaded && history.length === 0 ? (
          <p className="mt-3 text-xs text-slate-600">
            No broadcasts yet — the first one goes out above.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {history.map((row) => (
              <li
                key={row.id}
                className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded-md border border-cyan-400/15 bg-cyan-400/[0.04] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-cyan-300/70">
                      {audienceLabel(row.audience)}
                    </span>
                    <span className="text-[10px] text-slate-600">
                      {formatWhen(row.createdAt)}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    {row.recipientCount} recipients
                    {typeof row.done === "number" && row.done > 0
                      ? " · " + String(row.done) + " sent"
                      : ""}
                    {typeof row.failed === "number" && row.failed > 0
                      ? " · " + String(row.failed) + " failed"
                      : ""}
                  </p>
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-xs text-slate-300">
                  {row.body}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
`;

const RATING_CARD_FILE = `"use client";

import { useCallback, useEffect, useState } from "react";

interface CsatState {
  score: number | null;
  requestedAt: string | null;
  answeredAt: string | null;
}

export default function RatingCard({ conversationId }: { conversationId: number }) {
  const [csat, setCsat] = useState<CsatState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );

  const load = useCallback(async () => {
    if (!conversationId) return;
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/" + String(conversationId) + "/csat",
        { credentials: "same-origin", cache: "no-store" }
      );
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        csat?: CsatState | null;
      } | null;
      if (payload) {
        setCsat(payload.csat ?? null);
        setLoaded(true);
      }
    } catch {
      // Transient network issue — reopening the thread retries.
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function sendRequest() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/" + String(conversationId) + "/csat",
        {
          method: "POST",
          credentials: "same-origin",
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({ kind: "ok", text: "Rating request sent on WhatsApp." });
        await load();
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not send. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  if (loaded && csat === null) {
    return (
      <div className="mb-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-xs font-semibold text-white">Customer rating</h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
              Ask the customer to rate this chat from 1 to 5 — the reply is
              recorded automatically.
            </p>
          </div>
          <button
            type="button"
            onClick={sendRequest}
            disabled={busy}
            className="w-full shrink-0 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50 sm:w-auto"
          >
            {busy ? "Sending…" : "Ask for rating"}
          </button>
        </div>
        {message && (
          <p
            className={
              "mt-2 text-[11px] " +
              (message.kind === "ok" ? "text-emerald-300" : "text-red-300")
            }
          >
            {message.text}
          </p>
        )}
      </div>
    );
  }

  if (!loaded && csat === null) return null;

  const answered = csat?.answeredAt && csat.score !== null;

  return (
    <div
      className={
        "mb-4 rounded-2xl border p-4 " +
        (answered
          ? "border-emerald-400/20 bg-emerald-400/[0.05]"
          : "border-amber-400/20 bg-amber-400/[0.05]")
      }
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold text-white">Customer rating</h2>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">
            {answered
              ? "Customer rated this chat " + String(csat?.score) + "/5."
              : "Waiting for the customer's 1–5 reply (valid 48 hours)."}
          </p>
        </div>
        <button
          type="button"
          onClick={sendRequest}
          disabled={busy}
          className="w-full shrink-0 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-xs font-medium text-slate-300 transition-colors duration-300 hover:bg-white/[0.05] disabled:opacity-50 sm:w-auto"
        >
          {busy ? "Sending…" : "Ask again"}
        </button>
      </div>
      {message && (
        <p
          className={
            "mt-2 text-[11px] " +
            (message.kind === "ok" ? "text-emerald-300" : "text-red-300")
          }
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
`;

const KB_GAPS_CARD_FILE = `"use client";

import { useCallback, useEffect, useState } from "react";

interface GapEntry {
  id: number;
  conversationId: number;
  question: string;
  intent: string;
  createdAt: string | null;
}

function formatWhen(value: string | null): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function KbGapsCard() {
  const [gaps, setGaps] = useState<GapEntry[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/kb/gaps", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        gaps?: GapEntry[];
        openCount?: number;
      } | null;
      if (payload && Array.isArray(payload.gaps)) {
        setGaps(payload.gaps);
        setOpenCount(typeof payload.openCount === "number" ? payload.openCount : 0);
        setLoaded(true);
      }
    } catch {
      // Transient network issue — reopening the page retries.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(gapId: number) {
    if (busyId !== null) return;
    setBusyId(gapId);
    try {
      const response = await fetch("/api/omniflow/portal/kb/gaps/" + String(gapId), {
        method: "PATCH",
        credentials: "same-origin",
      });
      if (response.ok) {
        setGaps((current) => current.filter((gap) => gap.id !== gapId));
        setOpenCount((count) => Math.max(0, count - 1));
      }
    } catch {
      // Leave the gap in place — the next load retries.
    } finally {
      setBusyId(null);
    }
  }

  if (!loaded || (openCount === 0 && gaps.length === 0)) return null;

  return (
    <div className="mb-6 rounded-2xl border border-amber-400/15 bg-amber-400/[0.03] p-4 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-xs font-semibold text-white">
          Knowledge gaps
          <span className="ml-2 rounded-md border border-amber-400/25 bg-amber-400/[0.08] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300">
            {String(openCount)} open
          </span>
        </h2>
        <p className="text-[11px] text-slate-500">
          Customer questions no KB entry could answer — add an answer, then
          resolve.
        </p>
      </div>
      <ul className="mt-3 space-y-2">
        {gaps.slice(0, 5).map((gap) => (
          <li
            key={gap.id}
            className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="break-words text-xs text-slate-200">{gap.question}</p>
                <p className="mt-0.5 text-[10px] uppercase tracking-wider text-slate-600">
                  {gap.intent.replace(/_/g, " ")}
                  {gap.createdAt ? " · " + formatWhen(gap.createdAt) : ""}
                  {" · "}
                  <a
                    href={"/dashboard/conversations/" + String(gap.conversationId)}
                    className="text-cyan-300/80 transition-colors hover:text-cyan-200"
                  >
                    open chat
                  </a>
                </p>
              </div>
              <button
                type="button"
                onClick={() => resolve(gap.id)}
                disabled={busyId !== null}
                className="w-full shrink-0 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-[11px] font-medium text-slate-300 transition-colors duration-300 hover:bg-white/[0.05] disabled:opacity-50 sm:w-auto"
              >
                {busyId === gap.id ? "…" : "Resolve"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
`;

const CSAT_SUMMARY_CARD_FILE = `"use client";

import { useCallback, useEffect, useState } from "react";

interface CsatSummary {
  average: number | null;
  total: number;
  pending: number;
  dist: number[];
}

export default function CsatSummaryCard() {
  const [summary, setSummary] = useState<CsatSummary | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/csat/summary", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as CsatSummary | null;
      if (payload) {
        setSummary(payload);
        setLoaded(true);
      }
    } catch {
      // Transient network issue — reloading the page retries.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!loaded || !summary || (summary.total === 0 && summary.pending === 0)) {
    return null;
  }

  const maxCount = Math.max(1, ...summary.dist);

  return (
    <div className="mt-6 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xs font-semibold text-white">Customer rating (CSAT)</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">
            From 1–5 replies customers send on WhatsApp.
            {summary.pending > 0
              ? " " + String(summary.pending) + " request" + (summary.pending === 1 ? "" : "s") + " waiting."
              : ""}
          </p>
        </div>
        <p className="text-2xl font-semibold text-white">
          {summary.average !== null ? String(summary.average) : "—"}
          <span className="ml-1 text-xs font-normal text-slate-500">/ 5</span>
        </p>
      </div>
      <div className="mt-4 space-y-1.5">
        {[5, 4, 3, 2, 1].map((score) => {
          const count = summary.dist[score - 1] ?? 0;
          return (
            <div key={score} className="flex items-center gap-2">
              <span className="w-3 shrink-0 text-right text-[10px] text-slate-600">
                {String(score)}
              </span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/[0.04]">
                <div
                  className={
                    "h-full rounded-full " +
                    (score >= 4 ? "bg-emerald-400/50" : score === 3 ? "bg-amber-400/50" : "bg-red-400/50")
                  }
                  style={{ width: String(Math.round((count / maxCount) * 100)) + "%" }}
                />
              </div>
              <span className="w-6 shrink-0 text-[10px] text-slate-500">
                {String(count)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
`;

const TARGETS = [
  {
    file: "OmniFlow-Control-Plane/portal_db.py",
    swaps: [
      {
        name: "growth table constants",
        from: `NOTES_TABLE = os.environ.get("OF_NOTES_TABLE", "portal_conversation_notes")`,
        to: `NOTES_TABLE = os.environ.get("OF_NOTES_TABLE", "portal_conversation_notes")
BROADCASTS_TABLE = os.environ.get("OF_BROADCASTS_TABLE", "portal_broadcasts")
GAPS_TABLE = os.environ.get("OF_GAPS_TABLE", "portal_kb_gaps")
CSAT_TABLE = os.environ.get("OF_CSAT_TABLE", "portal_csat_requests")`,
      },
      {
        name: "lazy DDL: broadcasts + kb gaps + csat requests",
        from: `CREATE INDEX IF NOT EXISTS idx_portal_conv_notes
  ON portal_conversation_notes (conversation_id, id DESC);
"""`,
        to: `CREATE INDEX IF NOT EXISTS idx_portal_conv_notes
  ON portal_conversation_notes (conversation_id, id DESC);
CREATE TABLE IF NOT EXISTS portal_broadcasts (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'all',
  body TEXT NOT NULL,
  recipient_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_broadcasts
  ON portal_broadcasts (client_id, id DESC);
CREATE TABLE IF NOT EXISTS portal_kb_gaps (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  question TEXT NOT NULL DEFAULT '',
  intent TEXT NOT NULL DEFAULT 'general',
  resolved INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_portal_kb_gaps
  ON portal_kb_gaps (client_id, resolved, id DESC);
CREATE TABLE IF NOT EXISTS portal_csat_requests (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL UNIQUE,
  contact_id TEXT NOT NULL,
  contact_name TEXT,
  score INT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_csat
  ON portal_csat_requests (client_id, score);
"""`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/app.py",
    swaps: [
      {
        name: "import portal_growth blueprint",
        from: `from portal_team import bp as portal_team_bp  # noqa: E402`,
        to: `from portal_team import bp as portal_team_bp  # noqa: E402
from portal_growth import bp as portal_growth_bp  # noqa: E402`,
      },
      {
        name: "register portal_growth blueprint",
        from: `aux_app.register_blueprint(portal_team_bp)`,
        to: `aux_app.register_blueprint(portal_team_bp)
aux_app.register_blueprint(portal_growth_bp)`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/connector_api.py",
    swaps: [
      {
        name: "import portal_growth",
        from: `import portal_revenue
`,
        to: `import portal_revenue
import portal_growth
`,
      },
      {
        name: "ingest hook: record KB gap after auto-reply attempt",
        from: `                    try:
                        portal_revenue.handle_inbound(`,
        to: `                    try:
                        portal_growth.record_kb_gap(
                            tenant["client_id"],
                            conversation_id,
                            item["from"],
                            item["name"],
                            item["body"],
                            item["intent"],
                            conn,
                        )
                    except Exception:
                        pass
                    try:
                        portal_revenue.handle_inbound(`,
      },
      {
        name: "ingest hook: CSAT capture after revenue handler",
        from: `                        portal_revenue.handle_inbound(
                            tenant["client_id"],
                            conversation_id,
                            item["from"],
                            item["name"],
                            item["body"],
                            item["intent"],
                            conn,
                        )
                    except Exception:
                        pass`,
        to: `                        portal_revenue.handle_inbound(
                            tenant["client_id"],
                            conversation_id,
                            item["from"],
                            item["name"],
                            item["body"],
                            item["intent"],
                            conn,
                        )
                    except Exception:
                        pass
                    try:
                        portal_growth.handle_inbound(
                            tenant["client_id"],
                            conversation_id,
                            item["from"],
                            item["name"],
                            item["body"],
                            item["intent"],
                            conn,
                        )
                    except Exception:
                        pass`,
      },
    ],
  },
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      {
        name: "growth client functions",
        from: `export type ConversationStatusResult =`,
        to: PORTAL_TS_GROWTH_SECTION,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/components/DashSidebar.tsx",
    swaps: [
      {
        name: "nav: Broadcasts item before Team",
        custom: {
          alreadyMarker: '"/dashboard/broadcasts"',
          build: (text) => {
            const labelIndex = text.indexOf('label: "Team"');
            if (labelIndex === -1) return null;
            const braceIndex = text.lastIndexOf("{", labelIndex);
            if (braceIndex === -1) return null;
            const item =
              '{ label: "Broadcasts", href: "/dashboard/broadcasts", icon: "➤", enabled: true },\n  ';
            return text.slice(0, braceIndex) + item + text.slice(braceIndex);
          },
        },
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/knowledge-base/page.tsx",
    swaps: [
      {
        name: "import kb gaps card",
        from: `import KnowledgeBaseClient from "./KnowledgeBaseClient";`,
        to: `import KnowledgeBaseClient from "./KnowledgeBaseClient";
import KbGapsCard from "./KbGapsCard";`,
      },
      {
        name: "mount kb gaps card above client",
        from: `      ) : (
        <KnowledgeBaseClient initial={data} />
      )}`,
        to: `      ) : (
        <>
          <KbGapsCard />
          <KnowledgeBaseClient initial={data} />
        </>
      )}`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/analytics/page.tsx",
    swaps: [
      {
        name: "import csat summary card",
        from: `import AnalyticsClient from "./AnalyticsClient";`,
        to: `import AnalyticsClient from "./AnalyticsClient";
import CsatSummaryCard from "./CsatSummaryCard";`,
      },
      {
        name: "mount csat summary card below analytics",
        from: `      ) : (
        <AnalyticsClient initial={data} />
      )}`,
        to: `      ) : (
        <>
          <AnalyticsClient initial={data} />
          <CsatSummaryCard />
        </>
      )}`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx",
    swaps: [
      {
        name: "import rating card",
        from: `import TeamCard from "./TeamCard";`,
        to: `import TeamCard from "./TeamCard";
import RatingCard from "./RatingCard";`,
      },
      {
        name: "render rating card below team card",
        from: `          initialAssignedTo={conversation?.assignedTo ?? null}
        />
      )}`,
        to: `          initialAssignedTo={conversation?.assignedTo ?? null}
        />
      )}
      {!expired && !notFound && <RatingCard conversationId={Number(id)} />}`,
      },
    ],
  },
];

let appliedTotal = 0;
let alreadyTotal = 0;
let warnTotal = 0;

function compilePython(pathArg) {
  for (const py of ["python", "python3"]) {
    try {
      execFileSync(py, ["-m", "py_compile", pathArg], { stdio: "pipe" });
      return true;
    } catch {
      /* try next interpreter */
    }
  }
  return false;
}

function writeFileEnsuringDir(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.replace(/\r\n/g, "\n"), "utf8");
}

for (const target of TARGETS) {
  if (!fs.existsSync(target.file)) {
    console.log("SKIP (file not found): " + target.file);
    warnTotal++;
    continue;
  }

  const original = fs.readFileSync(target.file, "utf8");
  let text = original.replace(/\r\n/g, "\n");
  let changed = false;
  const fileApplied = [];

  for (const swap of target.swaps) {
    if (swap.custom) {
      if (text.includes(swap.custom.alreadyMarker)) {
        alreadyTotal++;
        continue;
      }
      const next = swap.custom.build(text);
      if (next === null || next === text) {
        warnTotal++;
        console.log("  ? " + target.file + " :: " + swap.name + " NOT FOUND — report this");
        continue;
      }
      text = next;
      changed = true;
      appliedTotal++;
      fileApplied.push(swap.name);
      continue;
    }

    const fromCount = text.split(swap.from).length - 1;
    const toCount = text.split(swap.to).length - 1;

    if (fromCount === 1 && toCount === 0) {
      text = text.split(swap.from).join(swap.to);
      changed = true;
      appliedTotal++;
      fileApplied.push(swap.name);
    } else if (toCount > 0) {
      alreadyTotal++;
    } else {
      warnTotal++;
      console.log("  ? " + target.file + " :: " + swap.name + " NOT FOUND — report this");
    }
  }

  if (!changed) {
    console.log("= " + target.file + " (already patched)");
    continue;
  }

  const backup = target.file + ".pre_growth.bak";
  if (!fs.existsSync(backup)) fs.copyFileSync(target.file, backup);

  if (target.file.endsWith(".py")) {
    fs.writeFileSync(target.file, text, "utf8");
    if (!compilePython(target.file)) {
      fs.copyFileSync(backup, target.file);
      console.log("FAIL (compile failed, restored): " + target.file);
      warnTotal++;
      continue;
    }
  } else {
    fs.writeFileSync(target.file, text, "utf8");
  }

  console.log("+ " + target.file + " (" + fileApplied.length + "): " + fileApplied.join(", "));
}

// New files (written only when missing).
const NEW_FILES = [
  [MODULE_PATH, PY_MODULE],
  [BFF_BROADCASTS_PATH, BFF_BROADCASTS_FILE],
  [BFF_BROADCASTS_PREVIEW_PATH, BFF_BROADCASTS_PREVIEW_FILE],
  [BFF_CSAT_PATH, BFF_CSAT_FILE],
  [BFF_CSAT_SUMMARY_PATH, BFF_CSAT_SUMMARY_FILE],
  [BFF_GAPS_PATH, BFF_GAPS_FILE],
  [BFF_GAPS_ID_PATH, BFF_GAPS_ID_FILE],
  [BROADCASTS_PAGE_PATH, BROADCASTS_PAGE_FILE],
  [RATING_CARD_PATH, RATING_CARD_FILE],
  [KB_GAPS_CARD_PATH, KB_GAPS_CARD_FILE],
  [CSAT_SUMMARY_CARD_PATH, CSAT_SUMMARY_CARD_FILE],
];
for (const [newPath, newContent] of NEW_FILES) {
  if (fs.existsSync(newPath)) {
    console.log("= " + newPath + " (already present)");
  } else {
    writeFileEnsuringDir(newPath, newContent);
    appliedTotal++;
    console.log("+ " + newPath);
  }
}
if (fs.existsSync(MODULE_PATH)) {
  if (!compilePython(MODULE_PATH)) {
    console.log("FAIL (new module compile failed): " + MODULE_PATH);
    warnTotal++;
  }
}

console.log("");
console.log(
  "SUMMARY: " +
    appliedTotal +
    " applied, " +
    alreadyTotal +
    " already done, " +
    warnTotal +
    " warnings"
);