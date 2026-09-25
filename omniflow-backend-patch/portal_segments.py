"""Deterministic customer segments: saved filters that resolve to live audiences."""

import json
import logging

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db
import portal_growth
import portal_pipeline
from typing import Any, Dict, List, Optional

bp = Blueprint("portal_segments", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

SEGMENTS_TABLE = "portal_segments"
MAX_NAME = 80
MAX_BODY = 1000
MEMBER_CAP = 500
BROADCAST_CAP = 200
VALID_LEAD_TEMP = ("hot", "warm", "cold")
VALID_STATUS = ("open", "closed")

_SEG_DDL_READY = False


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


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    try:
        return value.isoformat()
    except AttributeError:
        return None


def _ensure_seg_tables(conn) -> None:
    global _SEG_DDL_READY
    if _SEG_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(SEGMENTS_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " name TEXT NOT NULL,"
            " filters JSONB NOT NULL,"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
    conn.commit()
    _SEG_DDL_READY = True


def _parse_filters(raw: Any) -> Optional[Dict[str, Any]]:
    """Strict allow-list validation; returns the clean dict or None."""
    if not isinstance(raw, dict):
        return None
    clean: Dict[str, Any] = {}
    if "lead_temp" in raw:
        value = raw["lead_temp"]
        if value not in VALID_LEAD_TEMP:
            return None
        clean["lead_temp"] = value
    if "status" in raw:
        value = raw["status"]
        if value not in VALID_STATUS:
            return None
        clean["status"] = value
    if "stage" in raw:
        value = raw["stage"]
        if value not in portal_pipeline.VALID_STAGE:
            return None
        clean["stage"] = value
    if "idle_days" in raw:
        value = raw["idle_days"]
        if isinstance(value, bool) or not isinstance(value, int):
            return None
        if value < 1 or value > 365:
            return None
        clean["idle_days"] = value
    if "tag" in raw:
        value = str(raw["tag"] or "").strip()[:32]
        if not value:
            return None
        clean["tag"] = value
    if not clean:
        return None
    return clean


def _member_rows(cur, client_id: int, filters: Dict[str, Any],
                 limit: int) -> list:
    join_sql = ""
    if "stage" in filters:
        cur.execute("SELECT to_regclass(%s)",
                    (portal_pipeline.STAGE_TABLE,))
        found = portal_db.rows(cur)
        if not found or not found[0].get("to_regclass"):
            return []
        join_sql = (
            " LEFT JOIN " + portal_db._q(portal_pipeline.STAGE_TABLE) + " s"
            " ON s.client_id = c.client_id"
            " AND s.contact_id = c.contact_id"
        )
    sql = (
        "SELECT c.contact_id,"
        " MAX(c.contact_name) AS name,"
        " MAX(c.last_message_at) AS last_at,"
        " COUNT(*) AS chats"
        " FROM " + portal_db._q(portal_db.CONV_TABLE) + " c"
        + join_sql +
        " WHERE c.client_id = %s"
    )
    params: list = [client_id]
    if "lead_temp" in filters:
        sql += " AND c.lead_temp = %s"
        params.append(filters["lead_temp"])
    if "status" in filters:
        sql += " AND c.status = %s"
        params.append(filters["status"])
    if "stage" in filters:
        sql += " AND COALESCE(s.stage, 'new') = %s"
        params.append(filters["stage"])
    if "tag" in filters:
        sql += (
            " AND EXISTS (SELECT 1 FROM " +
            portal_db._q(portal_db.CONV_TAGS_TABLE) +
            " ct WHERE ct.conversation_id = c.id"
            " AND ct.client_id = c.client_id"
            " AND LOWER(ct.tag) = LOWER(%s))"
        )
        params.append(filters["tag"])
    sql += " GROUP BY c.contact_id"
    if "idle_days" in filters:
        sql += (" HAVING MAX(c.last_message_at)"
                " < NOW() - make_interval(days => %s)")
        params.append(int(filters["idle_days"]))
    sql += " ORDER BY MAX(c.last_message_at) DESC NULLS LAST, c.contact_id"
    sql += " LIMIT %s"
    params.append(int(limit))
    cur.execute(sql, tuple(params))
    return portal_db.rows(cur)


def _member_count(cur, client_id: int, filters: Dict[str, Any]) -> int:
    rows = _member_rows(cur, client_id, filters, MEMBER_CAP)
    return len(rows)


def _segment_public(row: Dict[str, Any], member_count: int) -> dict:
    filters = row.get("filters")
    if isinstance(filters, str):
        try:
            filters = json.loads(filters)
        except (TypeError, ValueError):
            filters = {}
    return {
        "id": row.get("id"),
        "name": row.get("name") or "",
        "filters": filters or {},
        "member_count": member_count,
        "created_at": _iso(row.get("created_at")),
    }


@bp.get("/segments")
def list_segments():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seg_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, name, filters, created_at FROM " +
                    portal_db._q(SEGMENTS_TABLE) +
                    " WHERE client_id = %s ORDER BY id DESC LIMIT 20",
                    (principal["client_id"],),
                )
                rows = portal_db.rows(cur)
                result = []
                for row in rows:
                    filters = row.get("filters")
                    if isinstance(filters, str):
                        try:
                            filters = json.loads(filters)
                        except (TypeError, ValueError):
                            filters = {}
                    count = _member_count(cur, principal["client_id"],
                                          filters or {})
                    result.append(_segment_public(row, count))
        finally:
            conn.close()
    except Exception as error:
        logger.warning("segments read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "segments read")[0]), 503
    return jsonify({"segments": result}), 200


@bp.post("/segments")
def create_segment():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name") or "").strip()[:MAX_NAME]
    if not name:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "A name is required."}}), 400
    filters = _parse_filters(payload.get("filters"))
    if filters is None:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Pick at least one valid filter"
                                             " (lead_temp hot/warm/cold, status"
                                             " open/closed, idle_days 1-365,"
                                             " tag)."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seg_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(SEGMENTS_TABLE) +
                    " (client_id, name, filters)"
                    " VALUES (%s, %s, %s::jsonb)"
                    " RETURNING id, name, filters, created_at",
                    (principal["client_id"], name,
                     json.dumps(filters)),
                )
                rows = portal_db.rows(cur)
                created = rows[0] if rows else {}
                count = _member_count(cur, principal["client_id"], filters)
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "segment.created",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Segment '" + name + "' with filters "
                    + json.dumps(filters) + ".",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "segment create")[0]), 503
    return jsonify({"ok": True,
                    "segment": _segment_public(created, count)}), 200


def _load_segment(cur, client_id: int, segment_id: int) -> Optional[dict]:
    cur.execute(
        "SELECT id, name, filters, created_at FROM " +
        portal_db._q(SEGMENTS_TABLE) +
        " WHERE id = %s AND client_id = %s",
        (segment_id, client_id),
    )
    rows = portal_db.rows(cur)
    return rows[0] if rows else None


@bp.get("/segments/<int:segment_id>/members")
def segment_members(segment_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        raw_limit = request.args.get("limit")
        limit = int(raw_limit) if raw_limit else 100
    except (TypeError, ValueError):
        limit = 100
    limit = max(1, min(MEMBER_CAP, limit))
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seg_tables(conn)
            with conn.cursor() as cur:
                row = _load_segment(cur, principal["client_id"], segment_id)
                if not row:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Segment not found."}}), 404
                filters = row.get("filters")
                if isinstance(filters, str):
                    try:
                        filters = json.loads(filters)
                    except (TypeError, ValueError):
                        filters = {}
                rows = _member_rows(cur, principal["client_id"],
                                    filters or {}, limit)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "segment members")[0]), 503
    return jsonify({"members": [
        {
            "contact_id": row.get("contact_id") or "",
            "name": row.get("name") or "",
            "chats": int(row.get("chats") or 0),
            "last_at": _iso(row.get("last_at")),
        }
        for row in rows
    ]}), 200


@bp.delete("/segments/<int:segment_id>")
def delete_segment(segment_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seg_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM " + portal_db._q(SEGMENTS_TABLE) +
                    " WHERE id = %s AND client_id = %s RETURNING id",
                    (segment_id, principal["client_id"]),
                )
                rows = portal_db.rows(cur)
                if rows:
                    portal_db.log_action(
                        cur,
                        principal["client_id"],
                        "segment.deleted",
                        "customer_user",
                        principal.get("user_id"),
                        None,
                        "Segment #%d deleted." % segment_id,
                    )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "segment delete")[0]), 503
    if not rows:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Segment not found."}}), 404
    return jsonify({"ok": True}), 200


def segment_member_rows(cur, client_id, segment_id) -> List[Dict[str, Any]]:
    """Public member resolver for scheduled broadcasts (portal_growth).

    Same resolution as an instant segment broadcast: load the segment's
    saved filters, then run the live member query (cap included).
    """
    row = _load_segment(cur, client_id, segment_id)
    if not row:
        return []
    filters = row.get("filters")
    if isinstance(filters, str):
        try:
            filters = json.loads(filters)
        except (TypeError, ValueError):
            filters = {}
    return _member_rows(cur, client_id, filters or {}, BROADCAST_CAP)


@bp.post("/segments/<int:segment_id>/broadcast")
def segment_broadcast(segment_id: int):
    """Send a WhatsApp message to every member of the segment, right now."""
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    body = str(payload.get("body") or "").strip()[:MAX_BODY]
    if not body:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "A message is required."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seg_tables(conn)
            with conn.cursor() as cur:
                row = _load_segment(cur, principal["client_id"], segment_id)
                if not row:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Segment not found."}}), 404
                filters = row.get("filters")
                if isinstance(filters, str):
                    try:
                        filters = json.loads(filters)
                    except (TypeError, ValueError):
                        filters = {}
                members = _member_rows(cur, principal["client_id"],
                                       filters or {}, BROADCAST_CAP)
                if not members:
                    return jsonify({"error": {"code": "bad_request",
                                              "message": "No members match this"
                                                         " segment right now."}}), 400
                for member in members:
                    display = str(member.get("name") or "").strip()
                    text = body.replace(
                        "{name}", (display.split(" ")[0] if display else "there")
                    )
                    portal_growth._send_command(
                        cur, principal["client_id"],
                        str(member.get("contact_id") or ""), display,
                        text, "segment", broadcast_id=None,
                    )
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "segment.broadcast",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Broadcast to segment '" + str(row.get("name") or "")
                    + "' (" + str(len(members)) + " member(s)).",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "segment broadcast")[0]), 503
    return jsonify({"ok": True, "sent": len(members)}), 200
