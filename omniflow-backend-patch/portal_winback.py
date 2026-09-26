"""Win-back & recovery kit: deterministic, zero AI. Turns the workspace's own
history into three ready-to-send outreach queues - open carts to recover,
repeat buyers whose reorder gap has elapsed, and quiet payers to win back.
Read-only: every entry carries a suggested WhatsApp message and a wa.me deep
link; nothing is ever sent automatically. No new tables."""

import json
import logging
import re
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db

bp = Blueprint("portal_winback", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

LINKS_TABLE = "portal_checkout_links"

CART_MIN_DAYS = 1            # younger carts are still warm - leave them
REORDER_QUIET_DAYS = 3       # skip if the agent chatted with them recently
WINBACK_QUIET_DAYS = 45      # gone-quiet threshold for the win-back nudge
MIN_REPEAT_ORDERS = 2        # reorder math needs a gap to learn from

MAX_POOL = 200
MAX_PAID = 20
MAX_OPEN = 5
MAX_ITEM_NAMES = 3
MAX_MESSAGE = 300
SEGMENT_CAP = 10

_NUMBER_RE = re.compile(r"\d[\d,]*")

_WINBACK_DDL_READY = True  # module owns no tables


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


def _table_exists(cur, table: str) -> bool:
    cur.execute("SELECT to_regclass(%s) AS oid", (table,))
    rows = portal_db.rows(cur)
    return bool(rows and rows[0].get("oid"))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_ts(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day,
                        tzinfo=timezone.utc)
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _days_since(value: Any, now: datetime) -> Optional[int]:
    ts = _parse_ts(value)
    if ts is None:
        return None
    return max(0, int((now - ts).total_seconds() // 86400))


def _names_of(items: Any) -> List[str]:
    names: List[str] = []
    if not isinstance(items, list):
        return names
    for entry in items:
        if isinstance(entry, dict):
            name = str(entry.get("name") or "").strip()
            if name:
                names.append(name)
    return names


def _parse_total(items: Any) -> Optional[int]:
    """Sum the numeric prices inside a cart's items JSONB (defensive)."""
    total = 0
    seen = False
    if isinstance(items, list):
        for entry in items:
            if not isinstance(entry, dict):
                continue
            match = _NUMBER_RE.search(str(entry.get("price") or ""))
            if match:
                seen = True
                total += int(match.group(0).replace(",", ""))
    return total if seen else None


def _median_gap(days: List[int]) -> Optional[int]:
    ordered = sorted(days)
    if not ordered:
        return None
    mid = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) // 2


def _wa_link(contact_id: str) -> Optional[str]:
    digits = re.sub(r"\D", "", str(contact_id or ""))
    if len(digits) < 9 or len(digits) > 15:
        return None
    return "https://wa.me/" + digits


def _first_name(name: str, contact_id: str) -> str:
    for part in str(name or "").split():
        if part:
            return part[:40]
    return str(contact_id or "there")[:40]


def _most_frequent_item(paid_items: List[Any]) -> tuple:
    """(best_name, occurrences) across every paid item; ties alphabetical."""
    counts: Dict[str, Dict[str, Any]] = {}
    for items in paid_items:
        for name in _names_of(items):
            key = name.lower().strip()
            entry = counts.setdefault(key, {"name": name, "count": 0})
            entry["count"] += 1
    if not counts:
        return "", 0
    best = sorted(counts.values(),
                  key=lambda entry: (-entry["count"],
                                     entry["name"].lower()))[0]
    return best["name"], best["count"]


def _load_last_message(cur, client_id, contact) -> Dict[str, Any]:
    cur.execute(
        "SELECT m.direction AS direction, m.created_at AS created_at"
        " FROM " + portal_db._q(portal_db.MSGS_TABLE) +
        " m JOIN " + portal_db._q(portal_db.CONV_TABLE) + " c"
        " ON c.id = m.conversation_id"
        " WHERE c.client_id = %s AND c.contact_id = %s"
        " ORDER BY m.id DESC LIMIT 1",
        (client_id, contact),
    )
    rows = portal_db.rows(cur)
    if not rows:
        return {}
    return {"direction": str(rows[0].get("direction") or ""),
            "created_at": rows[0].get("created_at")}


def _load_open_carts(cur, client_id, contact) -> List[Dict[str, Any]]:
    if not _table_exists(cur, LINKS_TABLE):
        return []
    cur.execute(
        "SELECT created_at, items FROM " + portal_db._q(LINKS_TABLE) +
        " WHERE client_id = %s AND contact_id = %s AND status = 'open'"
        " ORDER BY created_at ASC, id ASC LIMIT " + str(MAX_OPEN),
        (client_id, contact),
    )
    return [{"created_at": row.get("created_at"), "items": row.get("items")}
            for row in portal_db.rows(cur)]


def _load_paid_links(cur, client_id, contact) -> List[Dict[str, Any]]:
    if not _table_exists(cur, LINKS_TABLE):
        return []
    cur.execute(
        "SELECT created_at, items FROM " + portal_db._q(LINKS_TABLE) +
        " WHERE client_id = %s AND contact_id = %s AND status = 'paid'"
        " ORDER BY created_at ASC, id ASC LIMIT " + str(MAX_PAID),
        (client_id, contact),
    )
    return [{"created_at": row.get("created_at"), "items": row.get("items")}
            for row in portal_db.rows(cur)]


def build_entry(open_carts: List[Dict[str, Any]],
                paid_links: List[Dict[str, Any]], last_message: Dict[str, Any],
                contact_id: str, name: str,
                now: datetime) -> Optional[Dict[str, Any]]:
    """One contact -> at most one outreach entry (cart > reorder > winback)."""
    first = _first_name(name, contact_id)

    # 1) Cart recovery - the hottest signal
    carts = [cart for cart in open_carts
             if (_days_since(cart.get("created_at"), now) or 0) >= CART_MIN_DAYS]
    if carts:
        cart = carts[0]
        names = _names_of(cart.get("items"))[:MAX_ITEM_NAMES]
        total = _parse_total(cart.get("items"))
        listing = ", ".join(names) if names else "your cart"
        message = ("Hi " + first + "! Your cart (" + listing
                   + ") is still open. Shall I confirm the order for you?")
        return {
            "kind": "cart",
            "days": _days_since(cart.get("created_at"), now),
            "item": names[0] if names else "",
            "price_text": "",
            "total": total,
            "message": message[:MAX_MESSAGE],
        }

    last_msg_days = _days_since(last_message.get("created_at"), now)
    order_days = [days for days in
                  (_days_since(link.get("created_at"), now)
                   for link in paid_links)
                  if days is not None]

    # 2) Reorder due - repeat buyer past their own gap
    if len(order_days) >= MIN_REPEAT_ORDERS and len(paid_links) >= 2:
        stamps = sorted(_parse_ts(link.get("created_at"))
                        for link in paid_links)
        stamps = [ts for ts in stamps if ts is not None]
        gaps = [int((stamps[i + 1] - stamps[i]).total_seconds() // 86400)
                for i in range(len(stamps) - 1)]
        gap = _median_gap(gaps)
        if gap is not None and gap >= 1 and order_days:
            days_since_last = min(order_days)
            if days_since_last >= gap \
                    and (last_msg_days is None
                         or last_msg_days >= REORDER_QUIET_DAYS):
                item, _count = _most_frequent_item(
                    [link.get("items") for link in paid_links])
                price_text = ""
                for link in paid_links:
                    for entry in (link.get("items") or []):
                        if isinstance(entry, dict) \
                                and str(entry.get("name") or "").lower() \
                                == item.lower():
                            price_text = str(entry.get("price") or "")
                            break
                    if price_text:
                        break
                return {
                    "kind": "reorder",
                    "days": days_since_last - gap,
                    "item": item,
                    "price_text": price_text,
                    "total": None,
                    "message": ("Hi " + first + "! Time to restock your "
                                + item + " - shall I set one aside for you?"
                                )[:MAX_MESSAGE],
                }

    # 3) Win-back - a paying customer who went quiet
    if paid_links and last_msg_days is not None \
            and last_msg_days >= WINBACK_QUIET_DAYS:
        latest = paid_links[-1]
        names = _names_of(latest.get("items"))
        return {
            "kind": "winback",
            "days": last_msg_days,
            "item": names[0] if names else "",
            "price_text": "",
            "total": None,
            "message": ("Hi " + first + "! It has been a while - anything"
                        " you need from the new stock?")[:MAX_MESSAGE],
        }

    return None


def _load_pool(cur, client_id) -> List[Dict[str, str]]:
    cur.execute(
        "SELECT contact_id, MAX(COALESCE(contact_name, '')) AS name"
        " FROM " + portal_db._q(portal_db.CONV_TABLE) +
        " WHERE client_id = %s AND COALESCE(contact_id, '') <> ''"
        " GROUP BY contact_id ORDER BY contact_id LIMIT " + str(MAX_POOL),
        (client_id,),
    )
    return [{"contact_id": str(row.get("contact_id") or ""),
             "name": str(row.get("name") or "")}
            for row in portal_db.rows(cur)]


def _entry_payload(contact_id: str, name: str,
                   entry: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "contact_id": contact_id,
        "name": name,
        "kind": entry["kind"],
        "days": entry["days"],
        "item": entry["item"],
        "price_text": entry["price_text"],
        "total": entry["total"],
        "message": entry["message"],
        "wa_link": _wa_link(contact_id),
    }


@bp.get("/winback/queue")
def winback_queue():
    """Three ready-to-send outreach queues built from workspace history."""
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                pool = _load_pool(cur, client_id)
                segments: Dict[str, List[Dict[str, Any]]] = {
                    "cart": [], "reorder": [], "winback": []}
                for row in pool:
                    last = _load_last_message(cur, client_id,
                                              row["contact_id"])
                    carts = _load_open_carts(cur, client_id,
                                             row["contact_id"])
                    paid = _load_paid_links(cur, client_id,
                                            row["contact_id"])
                    entry = build_entry(carts, paid, last, row["contact_id"],
                                        row["name"], _now())
                    if entry is not None:
                        segments[entry["kind"]].append(
                            _entry_payload(row["contact_id"], row["name"],
                                           entry))
        finally:
            conn.close()
    except Exception as error:
        logger.warning("winback queue failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error,
                                                    "winback queue")[0]), 503
    for kind, entries in segments.items():
        entries.sort(key=lambda entry: (-(entry["days"] or 0),
                                        entry["name"].lower()))
        segments[kind] = entries[:SEGMENT_CAP]
    counts = {kind: len(entries) for kind, entries in segments.items()}
    return jsonify({
        "segments": segments,
        "counts": counts,
        "scored": len(pool),
    }), 200


SEND_COOLDOWN_HOURS = 24
WINBACK_KINDS = ("cart", "reorder", "winback")


@bp.post("/winback/send")
def winback_send():
    """Queue ONE suggested win-back message through the connector bridge.

    The message is re-derived server-side from fresh data (never trusted from
    the client), a 24h per-contact cooldown guards against double sends, and
    the insert is audited. API keys are read-only - human session required.
    """
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden:
        return forbidden
    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        body = {}
    contact = str(body.get("contact_id") or "").strip()[:100]
    kind = str(body.get("kind") or "").strip()
    if not contact or kind not in WINBACK_KINDS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contact_id and a valid kind are"
                                             " required."}}), 400
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COALESCE(contact_name, '') AS name FROM "
                    + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE client_id = %s AND contact_id = %s LIMIT 1",
                    (client_id, contact),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Contact not"
                                                         " found."}}), 404
                display_name = str(rows[0].get("name") or "")
                cur.execute(
                    "SELECT 1 FROM " + portal_db._q(portal_db.CMD_TABLE) +
                    " WHERE client_id = %s AND action = 'send_message'"
                    " AND payload->>'source' = 'winback'"
                    " AND payload->>'external_user_id' = %s"
                    " AND created_at > NOW() - make_interval(hours => %s)"
                    " LIMIT 1",
                    (client_id, contact, SEND_COOLDOWN_HOURS),
                )
                if portal_db.rows(cur):
                    return jsonify({"error": {"code": "cooldown",
                                              "message": "A win-back message"
                                                         " was sent to this"
                                                         " contact recently."}}), 409
                last = _load_last_message(cur, client_id, contact)
                carts = _load_open_carts(cur, client_id, contact)
                paid = _load_paid_links(cur, client_id, contact)
                entry = build_entry(carts, paid, last, contact, display_name,
                                    _now())
                if entry is None or entry["kind"] != kind:
                    return jsonify({"error": {"code": "stale",
                                              "message": "This suggestion is"
                                                         " no longer in the"
                                                         " queue."}}), 409
                cur.execute(
                    "SELECT id FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE client_id = %s AND contact_id = %s"
                    " ORDER BY id DESC LIMIT 1",
                    (client_id, contact),
                )
                conv_rows = portal_db.rows(cur)
                conversation_id = (conv_rows[0].get("id")
                                   if conv_rows else None)
                payload = {
                    "external_user_id": contact,
                    "body": entry["message"],
                    "source": "winback",
                }
                if conversation_id is not None:
                    payload["conversation_id"] = conversation_id
                cur.execute(
                    "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
                    " (client_id, channel, action, payload, status,"
                    " requested_by, created_at, updated_at) "
                    "VALUES (%s, 'whatsapp', 'send_message',"
                    " CAST(%s AS JSONB), 'pending', NULL, NOW(), NOW()) "
                    "RETURNING id",
                    (client_id, json.dumps(payload)),
                )
                inserted = portal_db.rows(cur)
                command_id = (int(inserted[0].get("id") or 0)
                              if inserted else 0)
                portal_db.log_action(
                    cur, client_id, "winback.sent",
                    actor_kind="customer_user",
                    actor_user_id=principal.get("user_id"),
                    note=kind,
                )
        finally:
            conn.close()
    except Exception as error:
        logger.warning("winback send failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error,
                                                    "winback send")[0]), 503
    return jsonify({"sent": True, "kind": kind,
                    "command_id": command_id}), 200
