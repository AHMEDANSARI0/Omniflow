// add_revenue_ops.mjs — Phase 7: Revenue Ops v0 (zero AI cost).
//
// 1. COD order confirmation: from any conversation thread the business sends
//    a "Reply YES to confirm or NO to cancel" request. When the customer's
//    reply arrives through the normal ingest, OmniFlow classifies YES/NO
//    (English + Roman Urdu keywords), updates the order state, sends the
//    thank-you/cancellation message automatically and records the outcome
//    in the audit log.
// 2. Order tracking: the business pastes an orders list (code, status,
//    note). When a customer's message classifies as order_tracking and
//    contains an order code, OmniFlow answers with the stored status
//    instantly (with a cooldown and a not-found fallback).
// 3. Lead scoring: every inbound message recomputes a deterministic
//    0-100 score + hot/warm/cold temperature per conversation from intent
//    and engagement; hot leads get a chip in the conversations list.
//
// Zero bridge changes -> NO bot restart. New portal_revenue.py blueprint,
// lazy DDL (lead columns + portal_cod_orders + portal_orders), ingest hook,
// BFF routes, CodCard in the thread, OrdersSection on Business profile.
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_revenue_ops.mjs
//
// Requires Phase 6 (add_analytics.mjs) to be applied first.
//
// CRLF-tolerant, idempotent, backups: *.pre_rev.bak

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MODULE_PATH = "OmniFlow-Control-Plane/portal_revenue.py";
const BFF_COD_PATH =
  "Omniflow/app/api/omniflow/portal/conversations/[id]/cod/route.ts";
const BFF_ORDERS_PATH = "Omniflow/app/api/omniflow/portal/orders/route.ts";
const BFF_ORDERS_ID_PATH = "Omniflow/app/api/omniflow/portal/orders/[id]/route.ts";
const COD_CARD_PATH =
  "Omniflow/app/dashboard/(portal)/conversations/[id]/CodCard.tsx";
const ORDERS_SECTION_PATH =
  "Omniflow/app/dashboard/(portal)/profile/OrdersSection.tsx";

const MODULE_FILE = `"""Portal revenue ops (COD confirmation, order tracking, lead scoring).

COD: the business sends a confirmation request from a conversation thread;
the customer replies YES/NO (English + Roman Urdu keywords) and OmniFlow
updates the order state, sends the follow-up message automatically and
records the outcome. Orders: the business imports an orders list (code,
status, note) and order_tracking messages are answered instantly with the
stored status. Lead scoring: a deterministic 0-100 score + temperature is
recomputed on every inbound message. All deterministic: zero AI cost.
"""

import logging
import re
from typing import Any, Dict, List, Optional

from flask import Blueprint, jsonify, request

from portal_auth import PortalAuthUnavailable, authenticate_portal_request
import portal_db


logger = logging.getLogger("omniflow.portal-revenue")

bp = Blueprint("portal_revenue", __name__, url_prefix="/api/v1")

COD_TABLE = "portal_cod_orders"
ORDERS_TABLE = "portal_orders"
ORDERS_MAX_ROWS = 500
AUTO_REPLY_COOLDOWN_SECONDS = 120

YES_TOKENS = frozenset({
    "yes", "y", "haan", "han", "haa", "confirm", "confirmed", "ok", "okay",
    "theek", "thik", "done", "deal", "kardo", "krdo", "ji",
})
NO_TOKENS = frozenset({
    "no", "n", "nahi", "nahin", "nai", "na", "cancel", "cancelled",
    "canceled", "radd", "mat", "stop",
})
YES_PHRASES = (
    "confirm kar do", "kar do", "kr do", "order confirm", "confirm karo",
    "pakka", "final kar do", "no problem",
)
NO_PHRASES = (
    "cancel kar do", "cancel karo", "cancel my order", "order cancel",
    "radd karo", "nahi chahiye", "nh chahiye",
)

LEAD_BASE_SCORES = {
    "purchase_intent": 50,
    "pricing": 35,
    "availability": 30,
    "order_tracking": 20,
    "appointment": 20,
    "shipping": 12,
    "general": 10,
    "complaint": 4,
    "refund_return": 4,
    "human_request": 4,
}

COD_CONFIRM_TEMPLATE = (
    "Hi {name}! Please confirm your cash-on-delivery order{details}. "
    "Reply YES to confirm or NO to cancel."
)
COD_CONFIRMED_REPLY = (
    "Thank you {name}! Your order is confirmed. We will share delivery "
    "updates right here."
)
COD_CANCELLED_REPLY = (
    "Your order request has been cancelled as requested. Message us anytime "
    "if you change your mind."
)
ORDER_FOUND_REPLY = "Hi {name}! Order {code} status: {status}{note}"
ORDER_MISSING_REPLY = (
    "Hi {name}! We could not find order {code}. Please double-check the "
    "number or message us here and we will help right away."
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


def _normalize_text(value) -> str:
    cleaned = re.sub(r"[^\\w\\s]", " ", str(value or "").lower())
    return re.sub(r"\\s+", " ", cleaned).strip()


def _first_name(contact_name) -> str:
    display = str(contact_name or "").strip()
    return display.split(" ")[0] if display else "there"


def _iso(value) -> Optional[str]:
    """ISO-8601 string for timestamps coming out of the driver, else None."""
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _cod_reply_kind(message_text):
    """Classify a COD reply as "yes", "no" or None (undecidable)."""
    normalized = _normalize_text(message_text)
    if not normalized:
        return None
    tokens = set(normalized.split(" "))
    yes_hits = sum(1 for token in tokens if token in YES_TOKENS)
    no_hits = sum(1 for token in tokens if token in NO_TOKENS)
    # Phrases are deliberate statements -> stronger signal than bare tokens.
    yes_hits += 2 * sum(1 for phrase in YES_PHRASES if phrase in normalized)
    no_hits += 2 * sum(1 for phrase in NO_PHRASES if phrase in normalized)
    if no_hits > 0 and no_hits >= yes_hits:
        return "no"
    if yes_hits > 0:
        return "yes"
    return None


def _extract_order_codes(message_text) -> List[str]:
    """Pull order-code candidates (3+ digits, optional prefix/dash) out."""
    matches = re.findall(r"#?\\b([A-Z]{0,3}-?\\d{3,10})\\b",
                         str(message_text or "").upper())
    codes: List[str] = []
    for match in matches[:3]:
        code = match.strip("-").strip()
        if code and code not in codes:
            codes.append(code)
    return codes


def _send_command(cur, client_id, external_user_id, display_name, body,
                  source):
    """Queue a WhatsApp send through the existing connector command queue."""
    payload: Dict[str, Any] = {
        "external_user_id": external_user_id,
        "body": str(body or "")[:1000],
        "source": source,
    }
    display = str(display_name or "").strip()
    if display:
        payload["target_display_name"] = display
    import json

    cur.execute(
        "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
        " (client_id, channel, action, payload, status, requested_by,"
        " created_at, updated_at) "
        "VALUES (%s, 'whatsapp', 'send_message', CAST(%s AS JSONB),"
        " 'pending', NULL, NOW(), NOW()) "
        "RETURNING id",
        (client_id, json.dumps(payload)),
    )


def _recent_outbound(cur, conversation_id, seconds):
    cur.execute(
        "SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +
        " WHERE conversation_id = %s AND direction = 'out'"
        " AND created_at > NOW() - make_interval(secs => %s)"
        " LIMIT 1",
        (conversation_id, seconds),
    )
    return bool(portal_db.rows(cur))


def _cod_public(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": int(row.get("id") or 0),
        "status": str(row.get("status") or "pending"),
        "details": str(row.get("details") or ""),
        "attempts": int(row.get("attempts") or 1),
        "created_at": _iso(row.get("created_at")),
        "answered_at": _iso(row.get("answered_at")),
    }


def recompute_lead_score(cur, client_id, conversation_id, intent):
    """Deterministic 0-100 lead score + temperature for one conversation."""
    base = LEAD_BASE_SCORES.get(str(intent or ""), 8)
    cur.execute(
        "SELECT COUNT(*) AS c FROM " + portal_db._q(portal_db.MSGS_TABLE) +
        " WHERE conversation_id = %s AND direction = 'in'"
        " AND created_at > NOW() - make_interval(days => 7)",
        (conversation_id,),
    )
    count_rows = portal_db.rows(cur)
    inbound_week = int((count_rows[0].get("c") if count_rows else 0) or 0)
    score = min(100, base + min(20, 3 * inbound_week))
    if score >= 65:
        temp = "hot"
    elif score >= 35:
        temp = "warm"
    else:
        temp = "cold"
    cur.execute(
        "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
        " SET lead_score = %s, lead_temp = %s"
        " WHERE id = %s AND client_id = %s",
        (score, temp, conversation_id, client_id),
    )


def _handle_cod_reply(cur, client_id, conversation_id, external_user_id,
                      contact_name, message_text, intent) -> bool:
    """Transition a pending COD order on YES/NO. True = handled."""
    if intent in ("human_request", "complaint", "refund_return"):
        return False
    cur.execute(
        "SELECT id, details FROM " + portal_db._q(COD_TABLE) +
        " WHERE client_id = %s AND conversation_id = %s"
        " AND status = 'pending' ORDER BY id DESC LIMIT 1",
        (client_id, conversation_id),
    )
    pending = portal_db.rows(cur)
    if not pending:
        return False
    kind = _cod_reply_kind(message_text)
    if kind is None:
        return False
    new_status = "confirmed" if kind == "yes" else "cancelled"
    cur.execute(
        "UPDATE " + portal_db._q(COD_TABLE) +
        " SET status = %s, answered_at = NOW(), updated_at = NOW()"
        " WHERE id = %s AND status = 'pending'"
        " RETURNING id",
        (new_status, pending[0].get("id")),
    )
    if not portal_db.rows(cur):
        return False
    portal_db.log_action(
        cur,
        client_id,
        "cod." + new_status,
        "system",
        None,
        conversation_id,
        ("COD order confirmed by customer." if kind == "yes"
         else "COD order cancelled by customer.")[:200],
    )
    reply = COD_CONFIRMED_REPLY if kind == "yes" else COD_CANCELLED_REPLY
    _send_command(cur, client_id, external_user_id, contact_name,
                  reply.replace("{name}", _first_name(contact_name)),
                  "cod_confirmation")
    return True


def _handle_order_lookup(cur, client_id, conversation_id, external_user_id,
                         contact_name, message_text) -> None:
    codes = _extract_order_codes(message_text)
    if not codes:
        return
    if _recent_outbound(cur, conversation_id, AUTO_REPLY_COOLDOWN_SECONDS):
        return
    cur.execute(
        "SELECT id, code, status_text, note FROM " + portal_db._q(ORDERS_TABLE) +
        " WHERE client_id = %s AND code = ANY(%s) LIMIT 1",
        (client_id, codes),
    )
    found = portal_db.rows(cur)
    display = _first_name(contact_name)
    if found:
        order = found[0]
        note = str(order.get("note") or "").strip()
        body = ORDER_FOUND_REPLY.format(
            name=display,
            code=str(order.get("code") or ""),
            status=str(order.get("status_text") or "pending"),
            note=(" — " + note) if note else "",
        )
    else:
        body = ORDER_MISSING_REPLY.format(name=display, code=codes[0])
    _send_command(cur, client_id, external_user_id, contact_name, body,
                  "order_tracking")
    portal_db.log_action(
        cur,
        client_id,
        "order.lookup",
        "system",
        None,
        conversation_id,
        ("Order " + str(found[0].get("code")) + ": "
         + str(found[0].get("status_text")) if found
         else "Order " + codes[0] + " not found")[:200],
    )


def handle_inbound(client_id, conversation_id, contact_id, contact_name,
                   message_text, intent, conn):
    """COD reply transition, order lookup and lead scoring, in the ingest
    transaction. Never raises into the caller: wrap in try/except there."""
    external_user_id = str(contact_id or "").strip()
    if not external_user_id:
        return
    with conn.cursor() as cur:
        handled_cod = _handle_cod_reply(
            cur, client_id, conversation_id, external_user_id,
            contact_name, message_text, intent,
        )
        if not handled_cod and intent == "order_tracking":
            _handle_order_lookup(
                cur, client_id, conversation_id, external_user_id,
                contact_name, message_text,
            )
        recompute_lead_score(cur, client_id, conversation_id, intent)


@bp.post("/portal/conversations/<int:conversation_id>/cod")
def request_cod_confirmation(conversation_id: int):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    payload = request.get_json(silent=True) or {}
    details = str(payload.get("details") or "").strip()
    if len(details) > 200:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Details must be 200 characters or fewer."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT contact_id, contact_name FROM "
                    + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE id = %s AND client_id = %s LIMIT 1",
                    (conversation_id, principal["client_id"]),
                )
                conv_rows = portal_db.rows(cur)
                if not conv_rows:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Conversation not found."}}), 404
                external_user_id = str(conv_rows[0].get("contact_id") or "").strip()
                if not external_user_id:
                    return jsonify({"error": {"code": "bad_request",
                                              "message": "This conversation has no deliverable contact."}}), 400
                display_name = str(conv_rows[0].get("contact_name") or "").strip()
                details_suffix = " (" + details + ")" if details else ""
                body = COD_CONFIRM_TEMPLATE.format(
                    name=_first_name(display_name),
                    details=details_suffix,
                )
                _send_command(cur, principal["client_id"], external_user_id,
                              display_name, body, "cod_confirmation")
                cur.execute(
                    "INSERT INTO " + portal_db._q(COD_TABLE) +
                    " (client_id, conversation_id, contact_id, contact_name,"
                    " status, details, attempts)"
                    " VALUES (%s, %s, %s, %s, 'pending', %s, 1)"
                    " ON CONFLICT (conversation_id) DO UPDATE SET"
                    " status = 'pending', details = EXCLUDED.details,"
                    " attempts = " + portal_db._q(COD_TABLE) + ".attempts + 1,"
                    " answered_at = NULL, updated_at = NOW()"
                    " RETURNING id, status, details, attempts, created_at,"
                    " answered_at",
                    (principal["client_id"], conversation_id,
                     external_user_id, display_name or None, details),
                )
                cod_rows = portal_db.rows(cur)
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "cod.requested",
                    "customer_user",
                    principal.get("user_id"),
                    conversation_id,
                    ("COD confirmation sent: " + details) if details
                    else "COD confirmation sent.",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal cod request")[0]), 503
    return jsonify({"ok": True, "cod": _cod_public(cod_rows[0] if cod_rows else {})}), 200


@bp.get("/portal/conversations/<int:conversation_id>/cod")
def get_cod_confirmation(conversation_id: int):
    principal, error = _principal_or_error()
    if error is not None:
        return error
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
                cur.execute(
                    "SELECT id, status, details, attempts, created_at,"
                    " answered_at FROM " + portal_db._q(COD_TABLE) +
                    " WHERE client_id = %s AND conversation_id = %s"
                    " ORDER BY id DESC LIMIT 1",
                    (principal["client_id"], conversation_id),
                )
                cod_rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal cod read")[0]), 503
    return jsonify({
        "cod": _cod_public(cod_rows[0]) if cod_rows else None,
    }), 200


@bp.get("/portal/orders")
def list_orders():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, code, status_text, note, updated_at FROM "
                    + portal_db._q(ORDERS_TABLE) +
                    " WHERE client_id = %s ORDER BY updated_at DESC, id DESC"
                    " LIMIT %s",
                    (principal["client_id"], ORDERS_MAX_ROWS),
                )
                order_rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal orders")[0]), 503
    items = [
        {
            "id": int(row.get("id") or 0),
            "code": str(row.get("code") or ""),
            "status_text": str(row.get("status_text") or ""),
            "note": str(row.get("note") or ""),
            "updated_at": _iso(row.get("updated_at")),
        }
        for row in order_rows
    ]
    return jsonify({"items": items}), 200


@bp.post("/portal/orders/import")
def import_orders():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    payload = request.get_json(silent=True) or {}
    raw_items = payload.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "items list is required."}}), 400
    if len(raw_items) > ORDERS_MAX_ROWS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Import at most " + str(ORDERS_MAX_ROWS) + " orders at a time."}}), 400
    cleaned: List[Dict[str, str]] = []
    seen = set()
    for raw in raw_items:
        if not isinstance(raw, dict):
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Each item must be an object."}}), 400
        code = str(raw.get("code") or "").strip().upper()
        status_text = str(raw.get("status") or "").strip() or "pending"
        note = str(raw.get("note") or "").strip()
        if not code or len(code) > 40:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Every order needs a code (max 40 characters)."}}), 400
        if len(status_text) > 60:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Status must be 60 characters or fewer."}}), 400
        if len(note) > 200:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Notes must be 200 characters or fewer."}}), 400
        if code in seen:
            continue
        seen.add(code)
        cleaned.append({"code": code, "status_text": status_text, "note": note})
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                for item in cleaned:
                    cur.execute(
                        "INSERT INTO " + portal_db._q(ORDERS_TABLE) +
                        " (client_id, code, status_text, note)"
                        " VALUES (%s, %s, %s, %s)"
                        " ON CONFLICT (client_id, code) DO UPDATE SET"
                        " status_text = EXCLUDED.status_text,"
                        " note = EXCLUDED.note, updated_at = NOW()",
                        (principal["client_id"], item["code"],
                         item["status_text"], item["note"]),
                    )
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "orders.imported",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Imported " + str(len(cleaned)) + " orders.",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal orders import")[0]), 503
    return jsonify({"ok": True, "imported": len(cleaned)}), 200


@bp.delete("/portal/orders/<int:order_id>")
def delete_order(order_id: int):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM " + portal_db._q(ORDERS_TABLE) +
                    " WHERE id = %s AND client_id = %s RETURNING id",
                    (order_id, principal["client_id"]),
                )
                deleted = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal orders delete")[0]), 503
    if not deleted:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Order not found."}}), 404
    return jsonify({"ok": True}), 200
`;

const BFF_COD_FILE = `import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  getConversationCod,
  requestCodConfirmation,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";


interface RouteContext {
  params: Promise<{ id: string }>;
}

async function resolveConversationId(context: RouteContext): Promise<number | null> {
  const { id } = await context.params;
  const conversationId = Number(id);
  if (!Number.isInteger(conversationId) || conversationId <= 0) return null;
  return conversationId;
}

export async function GET(request: Request, context: RouteContext) {
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
    const data = await getConversationCod(accessToken, conversationId);
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

export async function POST(request: Request, context: RouteContext) {
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

  const payload = (await request.json().catch(() => null)) as {
    details?: unknown;
  } | null;
  const details =
    typeof payload?.details === "string" ? payload.details.trim() : "";
  if (details.length > 200) {
    return safeJson(
      { error: { code: "bad_request", message: "Details must be 200 characters or fewer." } },
      400
    );
  }

  try {
    const ok = await requestCodConfirmation(accessToken, conversationId, details);
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

const BFF_ORDERS_FILE = `import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  importOrders,
  listOrders,
  requirePortalAccessToken,
  type OrderImportItem,
} from "../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const data = await listOrders(accessToken);
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
    items?: unknown;
  } | null;
  if (!Array.isArray(payload?.items) || payload.items.length === 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Paste at least one order." } },
      400
    );
  }
  if (payload.items.length > 500) {
    return safeJson(
      { error: { code: "bad_request", message: "Import at most 500 orders at a time." } },
      400
    );
  }
  const items: OrderImportItem[] = [];
  for (const raw of payload.items) {
    const item = raw as { code?: unknown; status?: unknown; note?: unknown };
    const code = typeof item.code === "string" ? item.code.trim().toUpperCase() : "";
    if (!code || code.length > 40) {
      return safeJson(
        { error: { code: "bad_request", message: "Every order needs a code (max 40 characters)." } },
        400
      );
    }
    items.push({
      code,
      status: typeof item.status === "string" ? item.status.trim().slice(0, 60) : "pending",
      note: typeof item.note === "string" ? item.note.trim().slice(0, 200) : "",
    });
  }

  try {
    const ok = await importOrders(accessToken, items);
    if (!ok) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true, imported: items.length }, 200);
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

const BFF_ORDERS_ID_FILE = `import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  deleteOrder,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";


interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await context.params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid order id." } },
      400
    );
  }

  try {
    const ok = await deleteOrder(accessToken, orderId);
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

const COD_CARD_FILE = `"use client";

import { useCallback, useEffect, useState } from "react";

interface CodState {
  status: string;
  details: string;
  createdAt: string | null;
  answeredAt: string | null;
}

const POLL_MS = 15_000;

export default function CodCard({ conversationId }: { conversationId: number }) {
  const [cod, setCod] = useState<CodState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );

  const load = useCallback(async () => {
    if (!conversationId) return;
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/" + String(conversationId) + "/cod",
        { credentials: "same-origin", cache: "no-store" }
      );
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        cod?: CodState | null;
      } | null;
      if (payload) {
        setCod(payload.cod ?? null);
        setLoaded(true);
      }
    } catch {
      // Transient network issue — the next poll retries.
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  async function sendRequest() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/conversations/" + String(conversationId) + "/cod",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ details: details.trim() }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({ kind: "ok", text: "Confirmation request sent on WhatsApp." });
        setExpanded(false);
        setDetails("");
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

  if (loaded && cod === null && !expanded) {
    return (
      <div className="mb-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-xs font-semibold text-white">COD order</h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
              Send a confirmation request — the customer replies YES or NO and
              OmniFlow tracks it automatically.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setExpanded(true);
              setMessage(null);
            }}
            className="w-full shrink-0 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] sm:w-auto"
          >
            Send COD confirmation
          </button>
        </div>
      </div>
    );
  }

  if (!loaded && cod === null && !expanded) return null;

  const banner =
    cod?.status === "pending"
      ? "border-amber-400/20 bg-amber-400/[0.05]"
      : cod?.status === "confirmed"
        ? "border-emerald-400/20 bg-emerald-400/[0.05]"
        : cod?.status === "cancelled"
          ? "border-red-400/20 bg-red-400/[0.05]"
          : "border-white/[0.06] bg-white/[0.015]";
  const bannerText =
    cod?.status === "pending"
      ? "Awaiting customer confirmation — the customer can reply YES or NO on WhatsApp."
      : cod?.status === "confirmed"
        ? "COD confirmed — the customer replied YES."
        : cod?.status === "cancelled"
          ? "COD cancelled — the customer replied NO."
          : "COD request closed.";
  const bannerLabel =
    cod?.status === "pending"
      ? "COD pending"
      : cod?.status === "confirmed"
        ? "COD confirmed"
        : cod?.status === "cancelled"
          ? "COD cancelled"
          : "COD";

  return (
    <div className={"mb-4 rounded-2xl border p-4 " + banner}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-white">{bannerLabel}</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">
            {bannerText}
          </p>
          {cod?.details && (
            <p className="mt-1 truncate text-[11px] text-slate-500">
              Order: {cod.details}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => sendRequest()}
          disabled={busy}
          className="w-full shrink-0 rounded-xl border border-white/[0.1] bg-white/[0.03] px-4 py-2 text-xs font-medium text-slate-300 transition-colors duration-300 hover:bg-white/[0.06] disabled:opacity-50 sm:w-auto"
        >
          {busy ? "Sending..." : "Send again"}
        </button>
      </div>

      {expanded && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            maxLength={200}
            placeholder="Optional details, e.g. 2 suits, PKR 4,500"
            className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setExpanded(false);
                setDetails("");
              }}
              className="flex-1 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-xs font-medium text-slate-300 transition-colors duration-300 hover:bg-white/[0.05] sm:flex-none"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => sendRequest()}
              disabled={busy}
              className="flex-1 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50 sm:flex-none"
            >
              {busy ? "Sending..." : "Send"}
            </button>
          </div>
        </div>
      )}

      {message && (
        <p
          className={
            "mt-2 text-[11px] " +
            (message.kind === "ok" ? "text-emerald-300/90" : "text-red-300/90")
          }
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
`;

const ORDERS_SECTION_FILE = `"use client";

import { useCallback, useEffect, useState } from "react";
import type { OrderRow } from "../../../../lib/omniflow/portal";

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const primaryBtn =
  "rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50";

const chipClass =
  "rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-slate-500";

interface ParsedOrder {
  code: string;
  status: string;
  note: string;
}

function parseOrdersText(text: string): ParsedOrder[] {
  const items: ParsedOrder[] = [];
  for (const line of text.split("\\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(",");
    const code = (parts[0] || "").trim();
    if (!code) continue;
    items.push({
      code,
      status: (parts[1] || "").trim() || "pending",
      note: parts.slice(2).join(",").trim(),
    });
  }
  return items.slice(0, 500);
}

export default function OrdersSection() {
  const [items, setItems] = useState<OrderRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/orders", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        items?: OrderRow[];
      } | null;
      if (payload && Array.isArray(payload.items)) setItems(payload.items);
    } catch {
      // Transient network issue — the next action retries.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function importOrders() {
    if (busy) return;
    const parsed = parseOrdersText(draft);
    if (parsed.length === 0) {
      setMessage({
        kind: "error",
        text: "Add at least one line: code, status, note (status and note are optional).",
      });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ items: parsed }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        imported?: number;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({
          kind: "ok",
          text: String(payload.imported ?? parsed.length) +
            " orders imported — customers can now ask for their order status.",
        });
        setDraft("");
        await refresh();
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not import. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  async function removeOrder(orderId: number) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/orders/" + String(orderId),
        { method: "DELETE", credentials: "same-origin" }
      );
      if (response.ok) {
        setMessage({ kind: "ok", text: "Order removed." });
        await refresh();
      } else {
        setMessage({
          kind: "error",
          text: "Could not remove. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
      <h2 className="text-sm font-semibold text-white">Order tracking</h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">
        Paste your orders — when a customer asks about their order on
        WhatsApp and mentions the order code, the assistant answers with the
        status instantly, day and night.
      </p>

      <textarea
        rows={5}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={"10234, shipped, TCS 4456678\\n10235, pending\\n10236, delivered"}
        className={inputClass + " mt-4 resize-none font-mono text-xs"}
      />
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={() => importOrders()}
          disabled={busy}
          className={primaryBtn + " w-full sm:w-auto"}
        >
          {busy ? "Importing..." : "Import / update orders"}
        </button>
        <p className="text-[11px] leading-relaxed text-slate-600">
          One order per line: code, status, note. Re-importing the same code
          updates it.
        </p>
      </div>

      {message && (
        <div
          className={
            "mt-4 rounded-xl border px-4 py-3 text-xs leading-relaxed " +
            (message.kind === "ok"
              ? "border-emerald-400/20 bg-emerald-400/[0.05] text-emerald-200/90"
              : "border-red-400/20 bg-red-400/[0.05] text-red-200/90")
          }
        >
          {message.text}
        </div>
      )}

      {!loaded ? (
        <p className="mt-4 text-xs text-slate-600">Loading orders...</p>
      ) : items.length === 0 ? (
        <p className="mt-4 text-xs leading-relaxed text-slate-600">
          No orders yet — paste your list above to enable instant order
          status replies.
        </p>
      ) : (
        <div className="mt-5 space-y-2.5">
          {items.map((order) => (
            <div
              key={order.id}
              className="flex flex-col gap-2 rounded-xl border border-white/[0.05] bg-white/[0.01] p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-mono text-xs font-semibold text-white">
                    {order.code}
                  </p>
                  <span className={chipClass}>{order.statusText}</span>
                </div>
                {order.note && (
                  <p className="mt-1 truncate text-[11px] text-slate-500">
                    {order.note}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => removeOrder(order.id)}
                disabled={busy}
                className="w-full shrink-0 rounded-xl border border-red-400/15 bg-red-400/[0.04] px-4 py-2 text-xs font-medium text-red-300/80 transition-colors duration-300 hover:bg-red-400/[0.09] disabled:opacity-50 sm:w-auto"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
`;

const TARGETS = [
  // ---------------------------------------------------------------- backend
  {
    file: "OmniFlow-Control-Plane/portal_db.py",
    swaps: [
      {
        name: "lazy revenue-ops tables",
        from: `CREATE INDEX IF NOT EXISTS idx_portal_action_log
  ON portal_action_log (client_id, id DESC);
"""`,
        to: `CREATE INDEX IF NOT EXISTS idx_portal_action_log
  ON portal_action_log (client_id, id DESC);
ALTER TABLE portal_conversations
  ADD COLUMN IF NOT EXISTS lead_score INT NOT NULL DEFAULT 0;
ALTER TABLE portal_conversations
  ADD COLUMN IF NOT EXISTS lead_temp TEXT NOT NULL DEFAULT 'cold';
CREATE TABLE IF NOT EXISTS portal_cod_orders (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL UNIQUE,
  contact_id TEXT NOT NULL,
  contact_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  details TEXT NOT NULL DEFAULT '',
  attempts INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_portal_cod_orders
  ON portal_cod_orders (client_id, status);
CREATE TABLE IF NOT EXISTS portal_orders (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  code TEXT NOT NULL,
  status_text TEXT NOT NULL DEFAULT 'pending',
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_portal_order_code UNIQUE (client_id, code)
);
CREATE INDEX IF NOT EXISTS idx_portal_orders_client
  ON portal_orders (client_id, updated_at DESC);
"""`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/app.py",
    swaps: [
      {
        name: "import revenue blueprint",
        from: `from portal_analytics import bp as portal_analytics_bp  # noqa: E402`,
        to: `from portal_analytics import bp as portal_analytics_bp  # noqa: E402
from portal_revenue import bp as portal_revenue_bp  # noqa: E402`,
      },
      {
        name: "register revenue blueprint",
        from: `aux_app.register_blueprint(portal_analytics_bp)`,
        to: `aux_app.register_blueprint(portal_analytics_bp)
aux_app.register_blueprint(portal_revenue_bp)`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/connector_api.py",
    swaps: [
      {
        name: "import revenue helper",
        from: `import portal_kb`,
        to: `import portal_kb
import portal_revenue`,
      },
      {
        name: "revenue ops inside ingest",
        from: `                    except Exception:
                        pass
                    inserted += 1`,
        to: `                    except Exception:
                        pass
                    try:
                        portal_revenue.handle_inbound(
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
                    inserted += 1`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/portal_conversations.py",
    swaps: [
      {
        name: "list includes lead fields",
        from: `        " c.last_message_at, c.last_message_preview, c.created_at, c.last_intent,"
        " EXISTS ("
        " SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +`,
        to: `        " c.last_message_at, c.last_message_preview, c.created_at, c.last_intent,"
        " c.lead_score, c.lead_temp,"
        " EXISTS ("
        " SELECT 1 FROM " + portal_db._q(portal_db.MSGS_TABLE) +`,
      },
      {
        name: "detail includes lead fields",
        from: `                    "SELECT id, channel, contact_id, contact_name, status,"
                    " last_message_at, last_message_preview, created_at FROM "`,
        to: `                    "SELECT id, channel, contact_id, contact_name, status,"
                    " last_message_at, last_message_preview, created_at,"
                    " lead_score, lead_temp FROM "`,
      },
      {
        name: "status RETURNING includes lead fields",
        from: `                    " RETURNING id, channel, contact_id, contact_name, status,"
                    " last_message_at, last_message_preview, created_at",`,
        to: `                    " RETURNING id, channel, contact_id, contact_name, status,"
                    " last_message_at, last_message_preview, created_at,"
                    " lead_score, lead_temp",`,
      },
      {
        name: "conversation payload exposes lead fields",
        from: `        "unread": bool(row.get("unread")),
        "last_intent": row.get("last_intent"),
    }`,
        to: `        "unread": bool(row.get("unread")),
        "last_intent": row.get("last_intent"),
        "lead_score": int(row.get("lead_score") or 0),
        "lead_temp": row.get("lead_temp") or "cold",
    }`,
      },
    ],
  },
  // ---------------------------------------------------------------- website
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      {
        name: "summary type gains lead fields",
        from: `  createdAt: string | null;
  unread: boolean;
  lastIntent: string | null;
}

export interface ConversationMessage {`,
        to: `  createdAt: string | null;
  unread: boolean;
  lastIntent: string | null;
  leadScore: number;
  leadTemp: string;
}

export interface ConversationMessage {`,
      },
      {
        name: "summary mapper gains lead fields",
        from: `    unread: p.unread === true,
    lastIntent: typeof p.last_intent === "string" ? p.last_intent : null,
  };`,
        to: `    unread: p.unread === true,
    lastIntent: typeof p.last_intent === "string" ? p.last_intent : null,
    leadScore: typeof p.lead_score === "number" ? p.lead_score : 0,
    leadTemp: typeof p.lead_temp === "string" ? p.lead_temp : "cold",
  };`,
      },
      {
        name: "revenue ops client helpers",
        from: `export type ConversationStatusResult =`,
        to: `export interface CodConfirmation {
  id: number;
  status: string;
  details: string;
  attempts: number;
  createdAt: string | null;
  answeredAt: string | null;
}

export interface OrderRow {
  id: number;
  code: string;
  statusText: string;
  note: string;
  updatedAt: string | null;
}

export interface OrderImportItem {
  code: string;
  status: string;
  note: string;
}

export async function getConversationCod(
  accessToken: string,
  conversationId: number
): Promise<{ cod: CodConfirmation | null } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" + conversationId + "/cod"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).cod;
  if (raw === null || raw === undefined) return { cod: null };
  if (typeof raw !== "object") return { cod: null };
  const p = raw as Record<string, unknown>;
  return {
    cod: {
      id: typeof p.id === "number" ? p.id : 0,
      status: typeof p.status === "string" ? p.status : "pending",
      details: typeof p.details === "string" ? p.details : "",
      attempts: typeof p.attempts === "number" ? p.attempts : 1,
      createdAt: typeof p.created_at === "string" ? p.created_at : null,
      answeredAt: typeof p.answered_at === "string" ? p.answered_at : null,
    },
  };
}

export async function requestCodConfirmation(
  accessToken: string,
  conversationId: number,
  details: string
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" + conversationId + "/cod",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ details }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function listOrders(
  accessToken: string
): Promise<{ items: OrderRow[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/orders");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawItems = (payload as Record<string, unknown>).items;
  if (!Array.isArray(rawItems)) return { items: [] };
  return {
    items: rawItems
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object"
      )
      .map((raw) => ({
        id: typeof raw.id === "number" ? raw.id : 0,
        code: typeof raw.code === "string" ? raw.code : "",
        statusText: typeof raw.status_text === "string" ? raw.status_text : "",
        note: typeof raw.note === "string" ? raw.note : "",
        updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : null,
      })),
  };
}

export async function importOrders(
  accessToken: string,
  items: OrderImportItem[]
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/orders/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function deleteOrder(
  accessToken: string,
  orderId: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/orders/" + orderId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export type ConversationStatusResult =`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/conversations/page.tsx",
    swaps: [
      {
        name: "list item type gains leadTemp",
        from: `  lastMessagePreview: string | null;
  unread: boolean;
  lastIntent: string | null;
}`,
        to: `  lastMessagePreview: string | null;
  unread: boolean;
  lastIntent: string | null;
  leadTemp: string;
}`,
      },
      {
        name: "hot lead chip in rows",
        from: `                {item.lastIntent && item.lastIntent !== "general" && (
                  <span className="mt-2 inline-block rounded-md border border-cyan-400/15 bg-cyan-400/[0.04] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-cyan-300/70">
                    {item.lastIntent.replace(/_/g, " ")}
                  </span>
                )}`,
        to: `                {((item.lastIntent && item.lastIntent !== "general") ||
                  item.leadTemp === "hot") && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {item.lastIntent && item.lastIntent !== "general" && (
                      <span className="inline-block rounded-md border border-cyan-400/15 bg-cyan-400/[0.04] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-cyan-300/70">
                        {item.lastIntent.replace(/_/g, " ")}
                      </span>
                    )}
                    {item.leadTemp === "hot" && (
                      <span className="inline-block rounded-md border border-orange-400/25 bg-orange-400/[0.08] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-orange-300">
                        Hot lead
                      </span>
                    )}
                  </div>
                )}`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx",
    swaps: [
      {
        name: "import cod card",
        from: `import Link from "next/link";
import { useParams } from "next/navigation";`,
        to: `import Link from "next/link";
import { useParams } from "next/navigation";
import CodCard from "./CodCard";`,
      },
      {
        name: "render cod card above thread",
        from: `      </div>

      {expired ? (`,
        to: `      </div>

      {!expired && !notFound && <CodCard conversationId={Number(id)} />}

      {expired ? (`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/profile/page.tsx",
    swaps: [
      {
        name: "import orders section",
        from: `import CatalogSection from "./CatalogSection";`,
        to: `import CatalogSection from "./CatalogSection";
import OrdersSection from "./OrdersSection";`,
      },
      {
        name: "render orders section",
        from: `      <div className="mt-6">
        <CatalogSection />
      </div>`,
        to: `      <div className="mt-6">
        <CatalogSection />
      </div>

      <div className="mt-6">
        <OrdersSection />
      </div>`,
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

  const backup = target.file + ".pre_rev.bak";
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
  [MODULE_PATH, MODULE_FILE],
  [BFF_COD_PATH, BFF_COD_FILE],
  [BFF_ORDERS_PATH, BFF_ORDERS_FILE],
  [BFF_ORDERS_ID_PATH, BFF_ORDERS_ID_FILE],
  [COD_CARD_PATH, COD_CARD_FILE],
  [ORDERS_SECTION_PATH, ORDERS_SECTION_FILE],
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
