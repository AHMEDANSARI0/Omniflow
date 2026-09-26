"""Deeper commerce analytics on checkout links: per-customer LTV
(new / repeat / VIP tiers) and product-wise sales aggregated from PAID
links' item JSON. Deterministic Python-side aggregation over the recent
paid window - no SQL JSON wizardry, fully testable."""
import logging
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_checkout
import portal_courier
import portal_db
import portal_recovery

bp = Blueprint("portal_analytics", __name__, url_prefix="/api/v1/portal")
logger = logging.getLogger(__name__)

PAID_STATUSES = ("paid", "shipped", "delivered")
MAX_SCAN = 500
VIP_SPEND = 25000
REPEAT_MIN = 2
VIP_ORDERS = 4


def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": "Try again shortly."}}),
                      503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}),
                      401)
    return principal, None


def _parse_days(raw: Any) -> int:
    try:
        days = int(raw)
    except (TypeError, ValueError):
        return 30
    return min(max(days, 1), 365)


def _fetch_paid_links(cur, client_id: int, days: int) -> List[Dict[str, Any]]:
    cur.execute(
        "SELECT id, contact_id, title, items, total, paid_amount, discount,"
        " status, created_at FROM " + portal_db._q(portal_checkout.LINKS_TABLE)
        + " WHERE client_id = %s AND status IN ('paid', 'shipped',"
        " 'delivered')"
        " AND created_at >= NOW() - (%s || ' days')::interval"
        " ORDER BY id DESC LIMIT %s",
        (client_id, str(days), MAX_SCAN),
    )
    return portal_db.rows(cur)


def _customer_tier(orders: int, spend: float) -> str:
    if orders >= VIP_ORDERS or spend >= VIP_SPEND:
        return "vip"
    if orders >= REPEAT_MIN:
        return "repeat"
    return "new"


@bp.get("/insights/customer-analytics")
def customer_analytics():
    principal, error = _principal_or_error()
    if error:
        return error
    days = _parse_days(request.args.get("days"))
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            portal_checkout._ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                rows = _fetch_paid_links(cur, principal["client_id"], days)
                try:
                    cur.execute(
                        "SELECT lang, COUNT(*) AS n FROM "
                        + portal_db._q("portal_contact_lang") +
                        " WHERE client_id = %s"
                        " GROUP BY lang ORDER BY n DESC LIMIT 6",
                        (principal["client_id"],),
                    )
                    lang_rows = portal_db.rows(cur)
                except Exception:
                    lang_rows = []
        finally:
            conn.close()
    except Exception as error:
        logger.warning("customer analytics failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "customer analytics")[0]), 503
    by_contact: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        contact = str(row.get("contact_id") or "").strip()
        if not contact:
            continue
        total = round(float(row.get("total") or 0), 2)
        entry = by_contact.setdefault(contact, {
            "contact_id": contact, "orders": 0, "spend": 0.0,
            "last_order": None,
        })
        entry["orders"] += 1
        entry["spend"] = round(entry["spend"] + total, 2)
        created = portal_checkout._iso(row.get("created_at"))
        if created and (entry["last_order"] is None
                        or created > entry["last_order"]):
            entry["last_order"] = created
    customers = []
    for entry in by_contact.values():
        entry["avg_order"] = round(
            entry["spend"] / entry["orders"], 2) if entry["orders"] else 0
        entry["tier"] = _customer_tier(entry["orders"], entry["spend"])
        customers.append(entry)
    customers.sort(key=lambda e: (-e["spend"], e["contact_id"]))
    tiers = {"new": 0, "repeat": 0, "vip": 0}
    for entry in customers:
        tiers[entry["tier"]] += 1
    return jsonify({"days": days, "customers": customers[:50],
                    "languages": [
                        {"lang": str(row.get("lang") or ""),
                         "count": int(row.get("n") or 0)}
                        for row in lang_rows],
                    "tiers": tiers,
                    "repeat_share": round(
                        (tiers["repeat"] + tiers["vip"])
                        / len(customers), 2) if customers else 0}), 200


@bp.get("/insights/product-analytics")
def product_analytics():
    principal, error = _principal_or_error()
    if error:
        return error
    days = _parse_days(request.args.get("days"))
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            portal_checkout._ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                rows = _fetch_paid_links(cur, principal["client_id"], days)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("product analytics failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "product analytics")[0]), 503
    by_product: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        items = row.get("items")
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            qty = int(item.get("qty") or 0)
            price = float(item.get("price") or 0)
            entry = by_product.setdefault(name, {
                "name": name, "qty_sold": 0, "revenue": 0.0, "orders": 0,
            })
            entry["qty_sold"] += qty
            entry["revenue"] = round(entry["revenue"] + qty * price, 2)
            entry["orders"] += 1
    products = sorted(by_product.values(),
                      key=lambda e: (-e["revenue"], e["name"]))[:50]
    return jsonify({"days": days, "products": products}), 200


def _count(cur, sql: str, args: tuple) -> int:
    cur.execute(sql, args)
    row = portal_db.rows(cur)
    return int((row[0].get("n") or 0)) if row else 0


def _fetch_operations(cur, client_id: int, days: int) -> Dict[str, Any]:
    """Six tiny indexed aggregates - the whole operations overview in
    one round trip. Counts stay capped so a busy workspace cannot
    make the dashboard wait."""
    window = "created_at >= NOW() - (%s || ' days')::interval"
    convs = portal_db._q(portal_db.CONV_TABLE)
    msgs = portal_db._q(portal_db.MSGS_TABLE)
    links = portal_db._q(portal_checkout.LINKS_TABLE)
    queue = portal_db._q(portal_recovery.QUEUE_TABLE)
    bookings = portal_db._q(portal_courier.BOOKINGS_TABLE)
    csat = portal_db._q(portal_db.CSAT_TABLE)
    out: Dict[str, Any] = {"chats": {}, "messages": {}, "orders": {},
                           "deliveries": {}, "recovery": {}, "csat": {}}
    out["chats"]["new"] = _count(cur, (
        "SELECT COUNT(*) AS n FROM " + convs
        + " WHERE client_id = %s AND " + window),
        (client_id, str(days)))
    out["chats"]["open"] = _count(cur, (
        "SELECT COUNT(*) AS n FROM " + convs
        + " WHERE client_id = %s AND status = 'open'"), (client_id,))
    out["chats"]["total"] = _count(cur, (
        "SELECT COUNT(*) AS n FROM " + convs
        + " WHERE client_id = %s"), (client_id,))
    out["messages"]["received"] = _count(cur, (
        "SELECT COUNT(*) AS n FROM " + msgs
        + " WHERE client_id = %s AND direction = 'in' AND " + window),
        (client_id, str(days)))
    out["messages"]["sent"] = _count(cur, (
        "SELECT COUNT(*) AS n FROM " + msgs
        + " WHERE client_id = %s AND direction = 'out' AND " + window),
        (client_id, str(days)))
    cur.execute("SELECT COUNT(*) AS n,"
                " COALESCE(SUM(paid_amount), 0) AS revenue FROM " + links
                + " WHERE client_id = %s AND status IN"
                " ('paid', 'shipped', 'delivered') AND " + window,
                (client_id, str(days)))
    paid = portal_db.rows(cur)
    out["orders"]["paid"] = int(paid[0]["n"]) if paid else 0
    out["orders"]["revenue"] = float(paid[0]["revenue"]) if paid else 0.0
    out["deliveries"]["bookings"] = _count(cur, (
        "SELECT COUNT(*) AS n FROM " + bookings
        + " WHERE client_id = %s AND " + window), (client_id, str(days)))
    cur.execute("SELECT status, COUNT(*) AS n FROM " + bookings
                + " WHERE client_id = %s GROUP BY status", (client_id,))
    by_status: Dict[str, int] = {}
    for row in portal_db.rows(cur)[:20]:
        status = str(row.get("status") or "unknown")
        by_status[status] = int(row.get("n") or 0)
    out["deliveries"]["by_status"] = by_status
    out["recovery"]["open"] = _count(cur, (
        "SELECT COUNT(*) AS n FROM " + queue
        + " WHERE client_id = %s AND status = 'open'"), (client_id,))
    out["recovery"]["resolved"] = _count(cur, (
        "SELECT COUNT(*) AS n FROM " + queue
        + " WHERE client_id = %s AND status = 'resolved' AND " + window),
        (client_id, str(days)))
    cur.execute("SELECT AVG(score) AS avg_score, COUNT(*) AS n FROM "
                + csat + " WHERE client_id = %s AND score IS NOT NULL"
                " AND answered_at IS NOT NULL AND answered_at >= NOW()"
                " - (%s || ' days')::interval", (client_id, str(days)))
    csat_rows = portal_db.rows(cur)
    score = csat_rows[0].get("avg_score") if csat_rows else None
    out["csat"]["answers"] = int(csat_rows[0]["n"]) if csat_rows else 0
    out["csat"]["avg_score"] = round(float(score), 2) if score is not None else None
    return out


@bp.get("/insights/operations")
def operations_analytics():
    """Consolidated operations snapshot: chats, messages, orders,
    deliveries, recovery and CSAT for the dashboard overview."""
    principal, error = _principal_or_error()
    if error:
        return error
    days = _parse_days(request.args.get("days"))
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                data = _fetch_operations(cur, principal["client_id"], days)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("operations analytics failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "operations analytics")[0]), 503
    return jsonify({"days": days, "operations": data}), 200
