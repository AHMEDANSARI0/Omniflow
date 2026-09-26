"""Performance pack (V2 B12) - hot indexes + one owner speed report.

Two pieces, both lightweight:

* HOT INDEXES - the queries the dashboard runs on every page load
  (recent conversations, recent messages, audit trail, open checkout
  links) get covering indexes, created idempotently once per process
  (CREATE INDEX IF NOT EXISTS). Pure database-level speed: no UI
  change, no behaviour change.

* SPEED REPORT - GET /portal/perf tells the owner how big the store
  is (row counts), how fast the three hottest queries are right now
  (milliseconds, measured live), and that the hot indexes exist.
  Human-only (API keys get 403). Read-only - nothing is mutated.

Everything reads table names from portal_db so env overrides keep
working. No new dependencies.
"""

import logging
import time
from typing import Any, Dict, List

from flask import Blueprint, jsonify

import portal_db
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
)

logger = logging.getLogger("omniflow.portal-perf")

bp = Blueprint("portal_perf", __name__, url_prefix="/api/v1/portal")

#: (index name, table, columns) - the dashboard's hottest reads.
HOT_INDEXES: List = [
    ("idx_portal_conv_client_updated",
     portal_db.CONV_TABLE, "(client_id, updated_at DESC)"),
    ("idx_portal_msgs_conv_id",
     portal_db.MSGS_TABLE, "(conversation_id, id DESC)"),
    ("idx_portal_msgs_client_created",
     portal_db.MSGS_TABLE, "(client_id, created_at DESC)"),
    ("idx_portal_action_log_client",
     "portal_action_log", "(client_id, id DESC)"),
    ("idx_portal_checkout_contact",
     "portal_checkout_links", "(client_id, contact_id)"),
]

_DDL_READY = False


def _ensure_indexes(cur) -> None:
    """Create the hot indexes once per process (idempotent)."""
    global _DDL_READY
    if _DDL_READY:
        return
    for name, table, columns in HOT_INDEXES:
        cur.execute(
            "CREATE INDEX IF NOT EXISTS " + portal_db._q(name) +
            " ON " + portal_db._q(table) + " " + columns
        )
    _DDL_READY = True


def _principal_or_error():
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


def _count(cur, table: str) -> int:
    cur.execute("SELECT COUNT(*) AS n FROM " + portal_db._q(table))
    rows = portal_db.rows(cur)
    return int(rows[0].get("n") or 0) if rows else 0


def _timed(cur, client_id: int, sql: str) -> float:
    start = time.perf_counter()
    cur.execute(sql, (client_id,))
    portal_db.rows(cur)
    return round((time.perf_counter() - start) * 1000.0, 1)


@bp.get("/perf")
def get_perf_report():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_indexes(cur)
            counts = {
                "conversations": _count(cur, portal_db.CONV_TABLE),
                "messages": _count(cur, portal_db.MSGS_TABLE),
                "actions": _count(cur, "portal_action_log"),
                "checkout_links": _count(cur, "portal_checkout_links"),
            }
            timings_ms = {
                "recent_conversations": _timed(
                    cur, client_id,
                    "SELECT id FROM " + portal_db._q(portal_db.CONV_TABLE)
                    + " WHERE client_id = %s"
                    " ORDER BY updated_at DESC LIMIT 10"),
                "recent_messages": _timed(
                    cur, client_id,
                    "SELECT id FROM " + portal_db._q(portal_db.MSGS_TABLE)
                    + " WHERE client_id = %s"
                    " ORDER BY created_at DESC LIMIT 20"),
                "open_links": _timed(
                    cur, client_id,
                    "SELECT id FROM "
                    + portal_db._q("portal_checkout_links")
                    + " WHERE client_id = %s AND status = 'open'"
                    " ORDER BY id DESC LIMIT 10"),
            }
            tables = [portal_db.CONV_TABLE, portal_db.MSGS_TABLE,
                      "portal_action_log", "portal_checkout_links"]
            placeholders = ", ".join(["%s"] * len(tables))
            cur.execute(
                "SELECT indexname FROM pg_indexes WHERE tablename IN ("
                + placeholders + ") ORDER BY indexname",
                tuple(tables),
            )
            rows = portal_db.rows(cur)
            indexes = [str(r.get("indexname") or "") for r in rows]
        conn.commit()
    finally:
        conn.close()
    hot = sorted(name for name, _t, _c in HOT_INDEXES)
    missing = [name for name in hot if name not in indexes]
    return jsonify({
        "counts": counts,
        "timings_ms": timings_ms,
        "indexes": indexes,
        "hot_indexes_present": hot,
        "missing_hot_indexes": missing,
        "ok": not missing,
    }), 200
