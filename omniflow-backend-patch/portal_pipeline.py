"""CRM pipeline: deterministic deal stages for contacts (kanban board data)."""

import logging
from typing import Any, Dict, Optional, Tuple

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db

bp = Blueprint("portal_pipeline", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

STAGE_TABLE = "portal_contact_stage"
MAX_CONTACT = 100
BOARD_LIMIT = 400
COLUMN_CAP = 50
VALID_STAGE: Tuple[str, ...] = ("new", "interested", "negotiating", "won", "lost")

_PIPE_DDL_READY = False


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


def _ensure_stage_table(conn) -> None:
    global _PIPE_DDL_READY
    if _PIPE_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(STAGE_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " contact_id TEXT NOT NULL,"
            " stage TEXT NOT NULL DEFAULT 'new',"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " UNIQUE (client_id, contact_id))"
        )
    conn.commit()
    _PIPE_DDL_READY = True


def _board_rows(cur, client_id: int) -> list:
    sql = (
        "SELECT COALESCE(s.stage, 'new') AS stage,"
        " c.contact_id,"
        " MAX(c.contact_name) AS name,"
        " MAX(c.lead_temp) AS lead_temp,"
        " COUNT(*) AS chats,"
        " MAX(c.last_message_at) AS last_at"
        " FROM " + portal_db._q(portal_db.CONV_TABLE) + " c"
        " LEFT JOIN " + portal_db._q(STAGE_TABLE) + " s"
        " ON s.client_id = c.client_id"
        " AND s.contact_id = c.contact_id"
        " WHERE c.client_id = %s"
        " GROUP BY c.contact_id, COALESCE(s.stage, 'new')"
        " ORDER BY MAX(c.last_message_at) DESC NULLS LAST, c.contact_id"
        " LIMIT %s"
    )
    cur.execute(sql, (client_id, BOARD_LIMIT))
    return portal_db.rows(cur)


@bp.get("/pipeline")
def board():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_stage_table(conn)
            with conn.cursor() as cur:
                rows = _board_rows(cur, principal["client_id"])
            columns: Dict[str, list] = {stage: [] for stage in VALID_STAGE}
            counts: Dict[str, int] = {stage: 0 for stage in VALID_STAGE}
            for row in rows:
                stage = row.get("stage")
                if stage not in columns:
                    stage = "new"
                counts[stage] += 1
                if len(columns[stage]) < COLUMN_CAP:
                    columns[stage].append(
                        {
                            "contact_id": row.get("contact_id"),
                            "name": row.get("name") or "",
                            "lead_temp": row.get("lead_temp") or "cold",
                            "chats": int(row.get("chats") or 0),
                            "last_at": _iso(row.get("last_at")),
                        }
                    )
            result = [
                {"stage": stage, "count": counts[stage],
                 "contacts": columns[stage]}
                for stage in VALID_STAGE
            ]
        finally:
            conn.close()
    except Exception as error:
        logger.warning("pipeline read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "pipeline read")[0]), 503
    return jsonify({"stages": result}), 200


@bp.post("/pipeline/stage")
def set_stage():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    contact = str(payload.get("contact") or "").strip()[:MAX_CONTACT]
    stage = payload.get("stage")
    if not contact:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "A contact is required."}}), 400
    if stage not in VALID_STAGE:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Pick a valid stage"
                                             " (new/interested/negotiating/"
                                             "won/lost)."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_stage_table(conn)
            with conn.cursor() as cur:
                if stage == "new":
                    cur.execute(
                        "DELETE FROM " + portal_db._q(STAGE_TABLE) +
                        " WHERE client_id = %s AND contact_id = %s",
                        (principal["client_id"], contact),
                    )
                else:
                    cur.execute(
                        "INSERT INTO " + portal_db._q(STAGE_TABLE) +
                        " (client_id, contact_id, stage)"
                        " VALUES (%s, %s, %s)"
                        " ON CONFLICT (client_id, contact_id)"
                        " DO UPDATE SET stage = EXCLUDED.stage,"
                        " updated_at = NOW()",
                        (principal["client_id"], contact, stage),
                    )
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "pipeline.stage_changed",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Contact moved to '" + str(stage) + "': " + contact + ".",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("pipeline stage failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "pipeline stage")[0]), 503
    return jsonify({"ok": True, "contact": contact, "stage": stage}), 200
