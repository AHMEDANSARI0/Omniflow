"""Customer value (CLV lite): deterministic, zero AI. Sums what each contact
has actually spent from paid checkout history - total, order count, average
order, favourite item, reorder gap - and ranks the workspace's top spenders.
Read-only: no new tables."""

import logging
import re
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
)
import portal_db

bp = Blueprint("portal_value", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

LINKS_TABLE = "portal_checkout_links"

LAPSED_DAYS = 60
MAX_LINKS = 500
MAX_TOP = 25
MAX_NAME = 100

_NUMBER_RE = re.compile(r"\d[\d,]*")

_VALUE_DDL_READY = True  # module owns no tables


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


def _item_price(item: Any) -> int:
    if not isinstance(item, dict):
        return 0
    match = _NUMBER_RE.search(str(item.get("price") or ""))
    return int(match.group(0).replace(",", "")) if match else 0


def _load_paid_rows(cur, client_id) -> List[Dict[str, Any]]:
    """Every paid link's contact, timestamp and items (workspace-wide)."""
    if not _table_exists(cur, LINKS_TABLE):
        return []
    cur.execute(
        "SELECT contact_id, items, created_at FROM "
        + portal_db._q(LINKS_TABLE) +
        " WHERE client_id = %s AND status = 'paid'"
        " ORDER BY id DESC LIMIT " + str(MAX_LINKS),
        (client_id,),
    )
    return [{"contact_id": str(row.get("contact_id") or ""),
             "items": row.get("items"),
             "created_at": row.get("created_at")}
            for row in portal_db.rows(cur)]


def _load_names(cur, client_id) -> Dict[str, str]:
    cur.execute(
        "SELECT contact_id, MAX(COALESCE(contact_name, '')) AS name"
        " FROM " + portal_db._q(portal_db.CONV_TABLE) +
        " WHERE client_id = %s AND COALESCE(contact_id, '') <> ''"
        " GROUP BY contact_id LIMIT 1000",
        (client_id,),
    )
    return {str(row.get("contact_id") or ""):
            str(row.get("name") or "") for row in portal_db.rows(cur)}


def _median_gap_days(stamps: List[datetime]) -> Optional[int]:
    ordered = sorted(stamps)
    if len(ordered) < 2:
        return None
    gaps = [int((ordered[i + 1] - ordered[i]).total_seconds() // 86400)
            for i in range(len(ordered) - 1)]
    gaps.sort()
    mid = len(gaps) // 2
    if len(gaps) % 2 == 1:
        return gaps[mid]
    return (gaps[mid - 1] + gaps[mid]) // 2


def _tier(orders: int, last_order_days: Optional[int]) -> str:
    if last_order_days is not None and last_order_days > LAPSED_DAYS:
        return "lapsed"
    if orders >= 3:
        return "loyal"
    if orders == 2:
        return "repeat"
    return "new"


def value_of(rows: List[Dict[str, Any]],
             now: datetime) -> Dict[str, Any]:
    """One contact's paid history -> lifetime value block."""
    total = 0
    units = 0
    stamps: List[datetime] = []
    item_counts: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        age = _days_since(row.get("created_at"), now)
        if age is not None:
            stamps.append(_parse_ts(row.get("created_at")))
        for item in (row.get("items")
                     if isinstance(row.get("items"), list) else []):
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            units += 1
            total += _item_price(item)
            key = name.lower()
            entry = item_counts.setdefault(key, {"name": name, "count": 0})
            entry["count"] += 1
    stamps = [ts for ts in stamps if ts is not None]
    orders = len(rows)
    top_item = ""
    top_item_units = 0
    if item_counts:
        best = sorted(item_counts.values(),
                      key=lambda entry: (-entry["count"],
                                         entry["name"].lower()))[0]
        top_item = best["name"]
        top_item_units = best["count"]
    days = [_days_since(ts, now) for ts in stamps]
    days = [d for d in days if d is not None]
    first_days = max(days) if days else None
    last_days = min(days) if days else None
    return {
        "total_spent": total,
        "orders": orders,
        "units": units,
        "avg_order": (int(round(total / orders)) if orders else None),
        "top_item": top_item,
        "top_item_units": top_item_units,
        "median_gap_days": _median_gap_days(stamps),
        "first_order_days": first_days,
        "last_order_days": last_days,
        "tier": _tier(orders, last_days),
    }


@bp.get("/value/summary")
def value_summary():
    """Lifetime value for ONE contact."""
    principal, error = _principal_or_error()
    if error:
        return error
    contact = (request.args.get("contact") or "").strip()[:MAX_NAME]
    if not contact:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contact is required."}}), 400
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                rows = _load_paid_rows(cur, client_id)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("value summary failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error,
                                                    "value summary")[0]), 503
    mine = [row for row in rows if row["contact_id"] == contact]
    result = value_of(mine, _now())
    result["contact_id"] = contact
    return jsonify(result), 200


@bp.get("/value/top")
def value_top():
    """The workspace's biggest spenders."""
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        limit = int(request.args.get("limit") or 10)
    except ValueError:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "limit must be a number."}}), 400
    limit = max(1, min(limit, MAX_TOP))
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                rows = _load_paid_rows(cur, client_id)
                names = _load_names(cur, client_id)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("value top failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error,
                                                    "value top")[0]), 503
    by_contact: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        if row["contact_id"]:
            by_contact.setdefault(row["contact_id"], []).append(row)
    now = _now()
    ranked = []
    for contact, contact_rows in by_contact.items():
        block = value_of(contact_rows, now)
        ranked.append({
            "contact_id": contact,
            "name": names.get(contact, ""),
            "total_spent": block["total_spent"],
            "orders": block["orders"],
            "last_order_days": block["last_order_days"],
            "tier": block["tier"],
        })
    ranked.sort(key=lambda entry: (-entry["total_spent"],
                                   entry["name"].lower()
                                   or entry["contact_id"]))
    return jsonify({
        "customers": ranked[:limit],
        "scored": len(ranked),
    }), 200
