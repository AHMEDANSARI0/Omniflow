"""Churn radar v2: deterministic, zero AI. Scores every chat contact 0-100
from five signals the workspace already has - quiet chats, unanswered
replies, cold carts, slowing orders and dormant repeat buyers. Read-only:
no new tables."""

import logging
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
)
import portal_db

bp = Blueprint("portal_churn", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

LINKS_TABLE = "portal_checkout_links"

WEIGHT_QUIET = 25           # +10 more once quiet passes the severe mark
WEIGHT_UNANSWERED = 15
WEIGHT_COLD_CART = 20       # +10 more once the cart passes the severe mark
WEIGHT_SPEND_DROP = 15
WEIGHT_SLOWDOWN = 10
WEIGHT_DORMANT = 20

QUIET_DAYS = 21
QUIET_DAYS_SEVERE = 45
UNANSWERED_DAYS = 7
COLD_CART_DAYS = 7
COLD_CART_DAYS_SEVERE = 21
DORMANT_ORDERS = 2
DORMANT_DAYS = 45
WINDOW_DAYS = 30

TIER_COOLING = 40
TIER_AT_RISK = 70

MAX_SCORE = 100
MAX_POOL = 200
MAX_PAID = 60
MAX_RECENT = 10
MAX_RADAR = 50

_CHURN_DDL_READY = True  # module owns no tables


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


def _load_recent_messages(cur, client_id, contact) -> List[Dict[str, Any]]:
    cur.execute(
        "SELECT m.direction AS direction, m.created_at AS created_at"
        " FROM " + portal_db._q(portal_db.MSGS_TABLE) +
        " m JOIN " + portal_db._q(portal_db.CONV_TABLE) + " c"
        " ON c.id = m.conversation_id"
        " WHERE c.client_id = %s AND c.contact_id = %s"
        " ORDER BY m.id DESC LIMIT " + str(MAX_RECENT),
        (client_id, contact),
    )
    return [{"direction": str(row.get("direction") or ""),
             "created_at": row.get("created_at")}
            for row in portal_db.rows(cur)]


def _load_oldest_open_cart(cur, client_id, contact) -> Any:
    if not _table_exists(cur, LINKS_TABLE):
        return None
    cur.execute(
        "SELECT created_at FROM " + portal_db._q(LINKS_TABLE) +
        " WHERE client_id = %s AND contact_id = %s AND status = 'open'"
        " ORDER BY created_at ASC, id ASC LIMIT 1",
        (client_id, contact),
    )
    rows = portal_db.rows(cur)
    return rows[0].get("created_at") if rows else None


def _load_paid_links(cur, client_id, contact) -> List[Any]:
    if not _table_exists(cur, LINKS_TABLE):
        return []
    cur.execute(
        "SELECT created_at FROM " + portal_db._q(LINKS_TABLE) +
        " WHERE client_id = %s AND contact_id = %s AND status = 'paid'"
        " ORDER BY created_at DESC, id DESC LIMIT " + str(MAX_PAID),
        (client_id, contact),
    )
    return [row.get("created_at") for row in portal_db.rows(cur)]


def score_contact(messages: List[Dict[str, Any]], open_cart_at: Any,
                  paid_links: List[Any], now: datetime) -> Dict[str, Any]:
    """Five deterministic signals -> score 0-100 with human reasons."""
    score = 0
    reasons: List[str] = []

    last_in_days: Optional[int] = None
    for entry in messages:
        if entry.get("direction") != "in":
            continue
        days = _days_since(entry.get("created_at"), now)
        if days is not None:
            last_in_days = days
            break
    if last_in_days is not None and last_in_days >= QUIET_DAYS:
        score += WEIGHT_QUIET + (10 if last_in_days >= QUIET_DAYS_SEVERE
                                 else 0)
        reasons.append("No message from them in " + str(last_in_days)
                       + " days")

    unanswered_days: Optional[int] = None
    if messages:
        head = messages[0]
        if head.get("direction") == "out":
            unanswered_days = _days_since(head.get("created_at"), now)
            if unanswered_days is not None \
                    and unanswered_days >= UNANSWERED_DAYS:
                score += WEIGHT_UNANSWERED
                reasons.append("Your last reply is unanswered for "
                               + str(unanswered_days) + " days")

    open_cart_days = _days_since(open_cart_at, now)
    if open_cart_days is not None and open_cart_days >= COLD_CART_DAYS:
        score += WEIGHT_COLD_CART + (10 if open_cart_days
                                     >= COLD_CART_DAYS_SEVERE else 0)
        reasons.append("Cart open for " + str(open_cart_days) + " days")

    order_days = [days for days in
                  (_days_since(ts, now) for ts in paid_links)
                  if days is not None]
    recent = sum(1 for days in order_days if days < WINDOW_DAYS)
    prior = sum(1 for days in order_days
                if WINDOW_DAYS <= days < WINDOW_DAYS * 2)
    if prior >= 1 and recent == 0:
        score += WEIGHT_SPEND_DROP
        reasons.append("No orders in the last month")
    elif prior >= 2 and recent < prior:
        score += WEIGHT_SLOWDOWN
        reasons.append("Orders slowed down")

    last_order_days = min(order_days) if order_days else None
    if len(order_days) >= DORMANT_ORDERS and last_order_days is not None \
            and last_order_days >= DORMANT_DAYS:
        score += WEIGHT_DORMANT
        reasons.append("Hasn't reordered in " + str(last_order_days)
                       + " days")

    final = min(MAX_SCORE, score)
    if final >= TIER_AT_RISK:
        tier = "at_risk"
    elif final >= TIER_COOLING:
        tier = "cooling"
    else:
        tier = "healthy"
    return {
        "score": final,
        "tier": tier,
        "reasons": reasons,
        "signals": {
            "last_inbound_days": last_in_days,
            "unanswered_days": unanswered_days,
            "open_cart_days": open_cart_days,
            "orders_last_30d": recent,
            "orders_prior_30d": prior,
            "paid_orders": len(order_days),
            "last_order_days": last_order_days,
        },
    }


def _score_contact(cur, client_id, contact, now: datetime) -> Dict[str, Any]:
    messages = _load_recent_messages(cur, client_id, contact)
    open_cart_at = _load_oldest_open_cart(cur, client_id, contact)
    paid_links = _load_paid_links(cur, client_id, contact)
    return score_contact(messages, open_cart_at, paid_links, now)


def _contact_pool(cur, client_id) -> List[Dict[str, str]]:
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


def _score_pool(cur, client_id, now: datetime) -> List[Dict[str, Any]]:
    scored = []
    for entry in _contact_pool(cur, client_id):
        result = _score_contact(cur, client_id, entry["contact_id"], now)
        result["contact_id"] = entry["contact_id"]
        result["name"] = entry["name"]
        scored.append(result)
    return scored


def _tier_counts(scored: List[Dict[str, Any]]) -> Dict[str, int]:
    counts = {"healthy": 0, "cooling": 0, "at_risk": 0}
    for entry in scored:
        counts[entry["tier"]] = counts.get(entry["tier"], 0) + 1
    return counts


@bp.get("/churn/score")
def churn_score():
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
            with conn.cursor() as cur:
                result = _score_contact(cur, principal["client_id"], contact,
                                        _now())
        finally:
            conn.close()
    except Exception as error:
        logger.warning("churn score failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "churn score")[0]), 503
    result["contact_id"] = contact
    return jsonify(result), 200


@bp.get("/churn/radar")
def churn_radar():
    """Workspace-wide: the most at-risk contacts first."""
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        limit = int(request.args.get("limit") or 10)
    except ValueError:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "limit must be a number."}}), 400
    limit = max(1, min(limit, MAX_RADAR))
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                scored = _score_pool(cur, principal["client_id"], _now())
        finally:
            conn.close()
    except Exception as error:
        logger.warning("churn radar failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "churn radar")[0]), 503
    flagged = [entry for entry in scored if entry["score"] > 0]
    flagged.sort(key=lambda entry: (-entry["score"],
                                    str(entry.get("name") or "").lower()))
    return jsonify({
        "contacts": [
            {
                "contact_id": entry["contact_id"],
                "name": entry.get("name") or "",
                "score": entry["score"],
                "tier": entry["tier"],
                "reasons": entry["reasons"][:2],
            }
            for entry in flagged[:limit]
        ],
        "scored": len(scored),
        "counts": _tier_counts(scored),
    }), 200


@bp.get("/churn/report")
def churn_report():
    """Workspace aggregate: tier counts, average score, top reasons."""
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                scored = _score_pool(cur, principal["client_id"], _now())
        finally:
            conn.close()
    except Exception as error:
        logger.warning("churn report failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "churn report")[0]), 503
    histogram: Dict[str, int] = {}
    for entry in scored:
        for reason in entry["reasons"]:
            histogram[reason] = histogram.get(reason, 0) + 1
    top_reasons = sorted(histogram.items(), key=lambda kv: (-kv[1], kv[0]))
    return jsonify({
        "scored": len(scored),
        "avg_score": (round(sum(entry["score"] for entry in scored)
                            / len(scored), 1) if scored else None),
        "tiers": _tier_counts(scored),
        "top_reasons": [{"reason": reason, "count": count}
                        for reason, count in top_reasons[:5]],
    }), 200
