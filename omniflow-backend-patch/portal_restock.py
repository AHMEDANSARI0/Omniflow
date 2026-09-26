"""Restock radar: deterministic, zero AI. Classifies every sold item into
stock-up / watch / slow lists from paid checkout history - weekly sell
rate, recent-vs-prior trend, revenue share, buyer count and days since
last sale. Tells the seller what to reorder before it runs out, and what
NOT to restock. Read-only: no new tables."""

import logging
import re
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
)
import portal_db

bp = Blueprint("portal_restock", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

LINKS_TABLE = "portal_checkout_links"

WINDOW_DAYS_DEFAULT = 60
MAX_WINDOW_DAYS = 180
MAX_LINKS = 500
MAX_PER_LIST = 8

_NUMBER_RE = re.compile(r"\d[\d,]*")

_RESTOCK_DDL_READY = True  # module owns no tables


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


def _weekly_rate(units: int, window_days: int) -> float:
    weeks = max(window_days / 7.0, 1.0)
    return round(units / weeks, 1)


STOCK_UP_WEEKLY = 0.5  # at least ~2 units/month keeps a item stock-worthy


def _classify(recent: int, prior: int, weekly_rate: float) -> Tuple[str, str]:
    """(list, trend) from the two window halves."""
    if recent > 0 and prior == 0:
        return ("stock_up", "new") if weekly_rate >= STOCK_UP_WEEKLY \
            else ("watch", "new")
    if prior > 0 and recent == 0:
        return "slow", "stalled"
    ratio = recent / float(prior)
    if ratio < 0.5:
        return "slow", "slowing"
    if weekly_rate >= STOCK_UP_WEEKLY:
        return "stock_up", ("accelerating" if ratio > 1.2 else "steady")
    if ratio > 1.2:
        return "watch", "accelerating"
    return "watch", "steady"


def _load_window_links(cur, client_id, days: int) -> List[Dict[str, Any]]:
    """Paid links inside the window (created_at included for the halves)."""
    if not _table_exists(cur, LINKS_TABLE):
        return []
    cur.execute(
        "SELECT contact_id, items, created_at FROM "
        + portal_db._q(LINKS_TABLE) +
        " WHERE client_id = %s AND status = 'paid'"
        " AND created_at > NOW() - make_interval(days => %s)"
        " ORDER BY id DESC LIMIT " + str(MAX_LINKS),
        (client_id, days),
    )
    return [{"contact_id": str(row.get("contact_id") or ""),
             "items": row.get("items"),
             "created_at": row.get("created_at")}
            for row in portal_db.rows(cur)]


def _item_revenue(item: Any) -> int:
    if not isinstance(item, dict):
        return 0
    match = _NUMBER_RE.search(str(item.get("price") or ""))
    return int(match.group(0).replace(",", "")) if match else 0


def build_radar(links: List[Dict[str, Any]], days: int,
                now: datetime) -> Dict[str, Any]:
    """Split the window into halves, classify every sold item."""
    half_seconds = max(days, 1) * 86400 / 2.0
    stats: Dict[str, Dict[str, Any]] = {}
    total_revenue = 0
    for link in links:
        age = _days_since(link.get("created_at"), now)
        if age is None:
            continue
        in_recent = age < half_seconds // 86400 or age <= days / 2.0
        for item in (link["items"] if isinstance(link["items"], list)
                     else []):
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            key = name.lower()
            entry = stats.setdefault(key, {
                "name": name, "recent": 0, "prior": 0, "revenue": 0,
                "buyers": set(), "last_sold_days": None})
            if in_recent:
                entry["recent"] += 1
            else:
                entry["prior"] += 1
            revenue = _item_revenue(item)
            entry["revenue"] += revenue
            total_revenue += revenue
            entry["buyers"].add(link["contact_id"])
            last = entry["last_sold_days"]
            if last is None or age < last:
                entry["last_sold_days"] = age

    lists: Dict[str, List[Dict[str, Any]]] = {
        "stock_up": [], "watch": [], "slow": []}
    steady_count = 0
    for entry in stats.values():
        weekly = _weekly_rate(entry["recent"] + entry["prior"], days)
        bucket, trend = _classify(entry["recent"], entry["prior"], weekly)
        if bucket == "watch" and trend == "steady" \
                and weekly < STOCK_UP_WEEKLY:
            # mid mover, no signal either way - counted, not listed
            steady_count += 1
            continue
        payload = {
            "name": entry["name"],
            "weekly_rate": weekly,
            "revenue": entry["revenue"],
            "buyers": len(entry["buyers"]),
            "last_sold_days": entry["last_sold_days"],
            "recent_units": entry["recent"],
            "prior_units": entry["prior"],
            "share_percent": (round(entry["revenue"] * 100.0
                                    / total_revenue, 1)
                              if total_revenue else None),
            "trend": trend,
        }
        lists[bucket].append(payload)

    for bucket in lists.values():
        bucket.sort(key=lambda entry: (-entry["revenue"],
                                       entry["name"].lower()))
    lists["stock_up"] = lists["stock_up"][:MAX_PER_LIST]
    lists["watch"] = lists["watch"][:MAX_PER_LIST]
    lists["slow"] = lists["slow"][:MAX_PER_LIST]
    return {
        "stock_up": lists["stock_up"],
        "watch": lists["watch"],
        "slow": lists["slow"],
        "counts": {
            "stock_up": len(lists["stock_up"]),
            "watch": len(lists["watch"]),
            "slow": len(lists["slow"]),
            "steady": steady_count,
        },
        "items_sold": len(stats),
    }


@bp.get("/restock/radar")
def restock_radar():
    """Stock-up / watch / slow lists from paid order history."""
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        days = int(request.args.get("days") or WINDOW_DAYS_DEFAULT)
    except ValueError:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "days must be a number."}}), 400
    if not 1 <= days <= MAX_WINDOW_DAYS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "days must be 1-180."}}), 400
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                links = _load_window_links(cur, client_id, days)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("restock radar failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error,
                                                    "restock radar")[0]), 503
    radar = build_radar(links, days, _now())
    radar["days"] = days
    return jsonify(radar), 200
