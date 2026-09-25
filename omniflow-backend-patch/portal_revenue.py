"""Revenue & pipeline pulse: deterministic, zero AI. Turns the workspace's
own checkout links into a money view - paid revenue with a prior-window
comparison, AOV, new vs repeat buyers, cancelled rate, the open-cart
pipeline, and per-item revenue with trends. Read-only: no new tables."""

import csv
import io
import logging
import re

from flask import Blueprint, jsonify, request
from flask import Response

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
)
import portal_db
from typing import Any, Dict, List, Optional

bp = Blueprint("portal_revenue", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

LINKS_TABLE = "portal_checkout_links"
LOG_TABLE = "portal_action_log"

MAX_LINKS = 500
MAX_OPEN = 100
MAX_BUYERS = 1000
MAX_ITEMS = 10

_NUMBER_RE = re.compile(r"\d[\d,]*")

_REVENUE_DDL_READY = True  # module owns no tables


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


def _item_total(items: Any) -> int:
    """Sum the numeric prices inside one link's items JSONB (defensive)."""
    total = 0
    if not isinstance(items, list):
        return total
    for entry in items:
        if not isinstance(entry, dict):
            continue
        match = _NUMBER_RE.search(str(entry.get("price") or ""))
        if match:
            total += int(match.group(0).replace(",", ""))
    return total


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


def _load_links(cur, client_id, days: int,
                has_links: bool = True) -> List[Dict[str, Any]]:
    """Paid + cancelled links inside the window (newest first)."""
    if not has_links:
        return []
    cur.execute(
        "SELECT contact_id, status, items FROM "
        + portal_db._q(LINKS_TABLE) +
        " WHERE client_id = %s AND status IN ('paid', 'cancelled')"
        " AND created_at > NOW() - make_interval(days => %s)"
        " ORDER BY id DESC LIMIT " + str(MAX_LINKS),
        (client_id, days),
    )
    return [{"contact_id": str(row.get("contact_id") or ""),
             "status": str(row.get("status") or ""),
             "items": row.get("items")}
            for row in portal_db.rows(cur)]


def _load_prior_links(cur, client_id, days: int,
                      has_links: bool = True) -> List[Dict[str, Any]]:
    if not has_links:
        return []
    cur.execute(
        "SELECT contact_id, status, items FROM "
        + portal_db._q(LINKS_TABLE) +
        " WHERE client_id = %s AND status IN ('paid', 'cancelled')"
        " AND created_at > NOW() - make_interval(days => %s)"
        " AND created_at <= NOW() - make_interval(days => %s)"
        " ORDER BY id DESC LIMIT " + str(MAX_LINKS),
        (client_id, days * 2, days),
    )
    return [{"contact_id": str(row.get("contact_id") or ""),
             "status": str(row.get("status") or ""),
             "items": row.get("items")}
            for row in portal_db.rows(cur)]


def _load_open_links(cur, client_id,
                     has_links: bool = True) -> List[Dict[str, Any]]:
    if not has_links:
        return []
    cur.execute(
        "SELECT items FROM " + portal_db._q(LINKS_TABLE) +
        " WHERE client_id = %s AND status = 'open'"
        " ORDER BY id DESC LIMIT " + str(MAX_OPEN),
        (client_id,),
    )
    return [{"items": row.get("items")} for row in portal_db.rows(cur)]


def _load_buyer_history(cur, client_id,
                        has_links: bool = True) -> List[Dict[str, Any]]:
    if not has_links:
        return []
    cur.execute(
        "SELECT contact_id, MIN(created_at) AS first_at, COUNT(*) AS total"
        " FROM " + portal_db._q(LINKS_TABLE) +
        " WHERE client_id = %s AND status = 'paid'"
        " GROUP BY contact_id LIMIT " + str(MAX_BUYERS),
        (client_id,),
    )
    return [{"contact_id": str(row.get("contact_id") or ""),
             "total": int(row.get("total") or 0)}
            for row in portal_db.rows(cur)]


def _load_winback_sent(cur, client_id, days: int) -> int:
    if not _table_exists(cur, LOG_TABLE):
        return 0
    cur.execute(
        "SELECT COUNT(*) AS hits FROM " + portal_db._q(LOG_TABLE) +
        " WHERE client_id = %s AND action = 'winback.sent'"
        " AND created_at > NOW() - make_interval(days => %s)",
        (client_id, days),
    )
    rows = portal_db.rows(cur)
    return int(rows[0].get("hits") or 0) if rows else 0


def _window_stats(links: List[Dict[str, Any]]) -> Dict[str, Any]:
    revenue = 0
    orders = 0
    cancelled = 0
    for link in links:
        if link["status"] == "paid":
            orders += 1
            revenue += _item_total(link["items"])
        else:
            cancelled += 1
    decided = orders + cancelled
    return {
        "revenue": revenue,
        "orders": orders,
        "cancelled": cancelled,
        "cancelled_rate": (round(cancelled * 100.0 / decided, 1)
                           if decided else None),
        "aov": (int(round(revenue / orders)) if orders else None),
    }


def _delta_percent(current: int, prior: int) -> Optional[int]:
    if prior <= 0:
        return None
    return int(round((current - prior) * 100.0 / prior))


def _trend(units: int, units_prior: int) -> str:
    if units_prior <= 0:
        return "up" if units > 0 else "steady"
    ratio = units / float(units_prior)
    if ratio > 1.2:
        return "up"
    if ratio < 0.8:
        return "down"
    return "steady"


def _item_stats(cur, client_id, days: int) -> List[Dict[str, Any]]:
    has_links = _table_exists(cur, LINKS_TABLE)
    window = _load_links(cur, client_id, days, has_links)
    prior = _load_prior_links(cur, client_id, days, has_links)
    stats: Dict[str, Dict[str, Any]] = {}
    for label, links, is_prior in (("current", window, False),
                                   ("prior", prior, True)):
        for link in links:
            if link["status"] != "paid":
                continue
            for item in (link["items"]
                         if isinstance(link["items"], list) else []):
                if not isinstance(item, dict):
                    continue
                name = str(item.get("name") or "").strip()
                if not name:
                    continue
                key = name.lower()
                entry = stats.setdefault(key, {
                    "name": name, "units": 0, "revenue": 0,
                    "buyers": set(), "units_prior": 0})
                if is_prior:
                    entry["units_prior"] += 1
                else:
                    entry["units"] += 1
                    entry["buyers"].add(link["contact_id"])
                    match = _NUMBER_RE.search(str(item.get("price") or ""))
                    if match:
                        entry["revenue"] += int(
                            match.group(0).replace(",", ""))
    ranked = sorted([entry for entry in stats.values()
                     if entry["units"] > 0],
                    key=lambda entry: (-entry["revenue"], -entry["units"],
                                       entry["name"].lower()))
    return [{
        "name": entry["name"],
        "units": entry["units"],
        "revenue": entry["revenue"],
        "buyers": len(entry["buyers"]),
        "units_prior": entry["units_prior"],
        "trend": _trend(entry["units"], entry["units_prior"]),
    } for entry in ranked[:MAX_ITEMS]]


@bp.get("/revenue/summary")
def revenue_summary():
    """Money view for the window: revenue, AOV, buyers, pipeline."""
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        days = int(request.args.get("days") or 30)
    except ValueError:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "days must be a number."}}), 400
    if not 1 <= days <= 180:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "days must be 1-180."}}), 400
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                has_links = _table_exists(cur, LINKS_TABLE)
                window = _load_links(cur, client_id, days, has_links)
                prior = _load_prior_links(cur, client_id, days, has_links)
                open_links = _load_open_links(cur, client_id, has_links)
                buyers = _load_buyer_history(cur, client_id, has_links)
                winback_sent = _load_winback_sent(cur, client_id, days)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("revenue summary failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error,
                                                    "revenue summary")[0]), 503
    stats = _window_stats(window)
    prior_stats = _window_stats(prior)
    pipeline_value = sum(_item_total(link["items"]) for link in open_links)
    window_contact_ids = {link["contact_id"] for link in window
                          if link["status"] == "paid" and link["contact_id"]}
    repeat = sum(1 for buyer in buyers
                 if buyer["contact_id"] in window_contact_ids)
    new = len(window_contact_ids) - repeat
    return jsonify({
        "days": days,
        "revenue": stats["revenue"],
        "revenue_prior": prior_stats["revenue"],
        "delta_percent": _delta_percent(stats["revenue"],
                                        prior_stats["revenue"]),
        "orders": stats["orders"],
        "orders_prior": prior_stats["orders"],
        "aov": stats["aov"],
        "new_buyers": max(0, new),
        "repeat_buyers": repeat,
        "cancelled": stats["cancelled"],
        "cancelled_rate": stats["cancelled_rate"],
        "open_carts": len(open_links),
        "pipeline_value": pipeline_value,
        "winback_sent": winback_sent,
    }), 200


@bp.get("/revenue/items")
def revenue_items():
    """Top items by revenue in the window, with prior-window trends."""
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        days = int(request.args.get("days") or 30)
    except ValueError:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "days must be a number."}}), 400
    if not 1 <= days <= 180:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "days must be 1-180."}}), 400
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                items = _item_stats(cur, client_id, days)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("revenue items failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error,
                                                    "revenue items")[0]), 503
    return jsonify({"days": days, "items": items}), 200


@bp.get("/revenue/export")
def revenue_export():
    """Paid-order ledger (newest first, 2000) as a CSV download."""
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, title, status, total, updated_at FROM "
                    + portal_db._q(LINKS_TABLE) +
                    " WHERE client_id = %s"
                    " AND status IN ('paid', 'shipped', 'delivered')"
                    " ORDER BY updated_at DESC NULLS LAST, id DESC"
                    " LIMIT 2000",
                    (principal["client_id"],),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("revenue export failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "revenue export")[0]), 503
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["date", "order", "status", "amount"])
    for row in found:
        writer.writerow([
            row.get("updated_at").date().isoformat()
            if row.get("updated_at") else "",
            row.get("title"),
            row.get("status"),
            row.get("total"),
        ])
    return Response(
        buffer.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition":
                 "attachment; filename=omniflow-revenue.csv"},
    )
