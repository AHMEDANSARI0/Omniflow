"""Growth rollups + the one-call Growth bundle (V2 B4 performance batch).

The Growth dashboard used to fire ~14 parallel BFF calls per visit; every
one of them is a Vercel->laptop WAN round trip, which is why the page took
seconds. This module collapses them into ONE endpoint:

``GET /api/v1/portal/growth-bundle?days=N``

``build_bundle`` re-dispatches the existing owner endpoints in-process
(exactly their own code paths - zero duplicated SQL, zero drift), collects
the payloads under ``segments``, adds per-day rollup trends, and caches the
whole bundle per (tenant, days) for ``OF_CACHE_TTL_SECONDS`` (default 45s),
so repeat clicks cost one dict lookup.

Rollups (``portal_rollups`` table) keep the per-day message/revenue trend
counters that used to be recomputed by long scans. They are recomputed with
three grouped queries whenever the bundle rebuilds - cheap, bounded, and
idempotent (upsert); "nightly" is simply the first rebuild after midnight.

Rollback: ``OF_BUNDLE=0`` makes the endpoint return 503 and the Growth page
falls back to its original parallel calls; ``OF_ROLLUPS=0`` skips the
trend writes. No new infrastructure (one table, no workers).
"""

import json
import logging
import os
import time
from datetime import date, timedelta
from typing import Any, Dict, Optional, Tuple

from flask import Blueprint, current_app, jsonify, request

import portal_db
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
)

logger = logging.getLogger("omniflow.portal-rollups")

bp = Blueprint("portal_rollups", __name__, url_prefix="/api/v1/portal")

ROLLUPS_TABLE = os.environ.get("OF_ROLLUPS_TABLE", "portal_rollups")
#: Master switch - 503 makes the web page fall back to live compute.
BUNDLE_ENABLED = os.environ.get(
    "OF_BUNDLE", "1").strip().lower() not in ("0", "false", "no", "off")
ROLLOUPS_ENABLED = os.environ.get(
    "OF_ROLLUPS", "1").strip().lower() not in ("0", "false", "no", "off")
BUNDLE_TTL_SECONDS = int(
    os.environ.get("OF_CACHE_TTL_SECONDS", "45") or 45)
BUNDLE_MAX_DAYS = 90

_DDL_READY = False

_DDL = """
CREATE TABLE IF NOT EXISTS portal_rollups (
  client_id BIGINT NOT NULL,
  day DATE NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL DEFAULT '',
  value BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, day, kind, key)
);
CREATE INDEX IF NOT EXISTS idx_portal_rollups_read
  ON portal_rollups (client_id, kind, day);
"""


def _ensure_ddl(cur) -> None:
    """Create the rollup table once per process (lazy DDL)."""
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    _DDL_READY = True


def _principal_or_error():
    """Owner/staff session required (API keys cannot read the bundle)."""
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": str(error)}}), 503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}),
                      401)
    if principal.get("via_api_key"):
        return None, (jsonify({"error": {"code": "forbidden",
                                         "message": "Owner sign-in required."}}),
                      403)
    return principal, None


# ---------------------------------------------------------------------------
# Rollups: three grouped upserts + a tiny trend reader
# ---------------------------------------------------------------------------

def refresh_recent(cur, client_id: int, days: int = 30) -> None:
    """Recompute the last ``days`` daily rollups (idempotent upserts)."""
    if not ROLLOUPS_ENABLED:
        return
    since = date.today() - timedelta(days=max(1, days) - 1)
    _ensure_ddl(cur)
    cur.execute(
        "INSERT INTO " + portal_db._q(ROLLUPS_TABLE) +
        " (client_id, day, kind, key, value)"
        " SELECT client_id, created_at::date, 'msgs_' || direction, '',"
        " COUNT(*) FROM " + portal_db._q(portal_db.MSGS_TABLE) +
        " WHERE client_id = %s AND created_at::date >= %s"
        " GROUP BY client_id, created_at::date, direction"
        " ON CONFLICT (client_id, day, kind, key)"
        " DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
        (client_id, since),
    )
    try:
        import portal_checkout

        links_table = portal_db._q(portal_checkout.LINKS_TABLE)
    except Exception:
        return
    cur.execute(
        "INSERT INTO " + portal_db._q(ROLLUPS_TABLE) +
        " (client_id, day, kind, key, value)"
        " SELECT client_id, updated_at::date, 'revenue',"
        " '', SUM(COALESCE(paid_amount, 0))::BIGINT"
        " FROM " + links_table +
        " WHERE client_id = %s AND status = 'paid'"
        " AND updated_at::date >= %s"
        " GROUP BY client_id, updated_at::date"
        " ON CONFLICT (client_id, day, kind, key)"
        " DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
        (client_id, since),
    )
    cur.execute(
        "INSERT INTO " + portal_db._q(ROLLUPS_TABLE) +
        " (client_id, day, kind, key, value)"
        " SELECT client_id, updated_at::date, 'orders',"
        " '', COUNT(*)"
        " FROM " + links_table +
        " WHERE client_id = %s AND status = 'paid'"
        " AND updated_at::date >= %s"
        " GROUP BY client_id, updated_at::date"
        " ON CONFLICT (client_id, day, kind, key)"
        " DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
        (client_id, since),
    )


def read_trend(cur, client_id: int, kind: str,
               days: int = 30) -> list:
    """One rollup series as [{day, value}] ordered by day."""
    since = date.today() - timedelta(days=max(1, days) - 1)
    cur.execute(
        "SELECT day, value FROM " + portal_db._q(ROLLUPS_TABLE) +
        " WHERE client_id = %s AND kind = %s AND day >= %s"
        " ORDER BY day",
        (client_id, kind, since),
    )
    rows = []
    for row in portal_db.rows(cur):
        day = row.get("day")
        rows.append({
            "day": (day.isoformat() if hasattr(day, "isoformat")
                    else (str(day) if day else None)),
            "value": int(row.get("value") or 0),
        })
    return rows


# ---------------------------------------------------------------------------
# Growth bundle: re-dispatch the existing endpoints in one round trip
# ---------------------------------------------------------------------------

#: (bundle key, CP path, query builder) - the Growth page's parallel calls.
SEGMENTS: Tuple[Tuple[str, str, str], ...] = (
    ("churn", "/api/v1/portal/insights/churn", "days={days}"),
    ("radar", "/api/v1/portal/churn/radar", "limit=5"),
    ("revenue", "/api/v1/portal/revenue/summary", "days={days}"),
    ("revenue_items", "/api/v1/portal/revenue/items", "days={days}"),
    ("staffing", "/api/v1/portal/insights/staffing", ""),
    ("ideas", "/api/v1/portal/insights/broadcast-suggestions", ""),
    ("negotiation", "/api/v1/portal/negotiation/settings", ""),
    ("links", "/api/v1/portal/checkout/links", ""),
    ("listen_rules", "/api/v1/portal/listen/rules", ""),
    ("listen_hits", "/api/v1/portal/listen/hits", ""),
    ("routing", "/api/v1/portal/routing/rules", ""),
    ("restock", "/api/v1/portal/restock/radar", "days={days}"),
    ("customers", "/api/v1/portal/insights/customer-analytics",
     "days={days}"),
    ("products", "/api/v1/portal/insights/product-analytics", "days={days}"),
)


def _run_segment(path: str, query: str) -> Tuple[Any, int]:
    """Dispatch one owner endpoint in-process with a forged request context.

    The inner context reuses the caller's Authorization header so the
    sub-view authenticates exactly as it would over HTTP. Returns
    ``(payload, status)`` for both ``(jsonify, code)`` tuples and real
    responses. Never raises into the caller beyond what Flask raises for a
    missing route (callers wrap this in try/except anyway).
    """
    app = current_app._get_current_object()
    headers = {"Authorization": request.headers.get("Authorization", "")}
    full = path + ("?" + query if query else "")
    with app.test_request_context(full, headers=headers):
        adapter = app.url_map.bind("")
        endpoint, kwargs = adapter.match(path)
        view = app.view_functions[endpoint]
        result = view(**kwargs)
    if isinstance(result, tuple):
        payload, status = result[0], result[1]
        return (payload.get_json() if hasattr(payload, "get_json")
                else payload), int(status)
    return result.get_json(), int(result.status_code)


_BUNDLE_CACHE: Dict[Tuple[int, int], Tuple[float, Dict[str, Any]]] = {}


def _cache_get(key: Tuple[int, int]) -> Optional[Dict[str, Any]]:
    hit = _BUNDLE_CACHE.get(key)
    if not hit:
        return None
    expires, payload = hit
    if expires < time.time():
        _BUNDLE_CACHE.pop(key, None)
        return None
    return payload


def build_bundle(client_id: int, days: int) -> Dict[str, Any]:
    """Assemble (and cache) the whole Growth dashboard payload once."""
    cached = _cache_get((client_id, days))
    if cached is not None:
        return cached
    segments: Dict[str, Any] = {}
    for name, path, query in SEGMENTS:
        try:
            payload, status = _run_segment(
                path, query.format(days=days) if "{days}" in query else query)
            segments[name] = payload if status == 200 else None
        except Exception as error:
            logger.warning("bundle segment %s failed: %s", name, error)
            segments[name] = None
    trends: Dict[str, list] = {}
    if ROLLOUPS_ENABLED:
        try:
            conn = portal_db._conn()
            try:
                with conn.cursor() as cur:
                    refresh_recent(cur, client_id, days)
                    trends = {
                        "messages_in": read_trend(cur, client_id,
                                                  "msgs_in", days),
                        "messages_out": read_trend(cur, client_id,
                                                   "msgs_out", days),
                        "revenue": read_trend(cur, client_id,
                                              "revenue", days),
                        "orders": read_trend(cur, client_id,
                                             "orders", days),
                    }
                conn.commit()
            finally:
                conn.close()
        except Exception as error:
            logger.warning("bundle trends failed: %s", error)
    bundle = {
        "segments": segments,
        "trends": trends,
        "days": days,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                      time.gmtime()),
    }
    if len(_BUNDLE_CACHE) > 64:
        _BUNDLE_CACHE.clear()
    _BUNDLE_CACHE[(client_id, days)] = (
        time.time() + max(5, BUNDLE_TTL_SECONDS), bundle)
    return bundle


@bp.get("/growth-bundle")
def growth_bundle():
    """The Growth dashboard in one round trip (owner/staff sessions)."""
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    if not BUNDLE_ENABLED:
        return jsonify({"error": {
            "code": "bundle_disabled",
            "message": "Growth bundle is disabled; the page falls back to"
                       " individual endpoints.",
        }}), 503
    try:
        days = int(request.args.get("days") or 14)
    except Exception:
        days = 14
    days = max(1, min(BUNDLE_MAX_DAYS, days))
    bundle = build_bundle(int(principal.get("client_id") or 0), days)
    return jsonify(bundle), 200
