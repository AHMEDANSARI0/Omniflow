"""Multi-agent routing v0: deterministic keyword rules that assign inbound
chats to team members (round the clock, no AI)."""

import logging

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db

bp = Blueprint("portal_routing", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

RULES_TABLE = "portal_routing_rules"

MAX_RULES = 25
MAX_MATCH = 60

_ROUTING_DDL_READY = False


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


def _ensure_routing_tables(conn) -> None:
    global _ROUTING_DDL_READY
    if _ROUTING_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(RULES_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " match_text TEXT NOT NULL,"
            " user_id BIGINT NOT NULL,"
            " priority INT NOT NULL DEFAULT 100,"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS portal_routing_rules_client_idx ON "
            + portal_db._q(RULES_TABLE) + " (client_id, priority, id)"
        )
    conn.commit()
    _ROUTING_DDL_READY = True


@bp.get("/routing/rules")
def list_routing_rules():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_routing_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, match_text, user_id, priority, created_at FROM " +
                    portal_db._q(RULES_TABLE) +
                    " WHERE client_id = %s ORDER BY priority ASC, id ASC LIMIT 50",
                    (principal["client_id"],),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("routing rules read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "routing rules")[0]), 503
    return jsonify({"rules": [
        {
            "id": int(row.get("id") or 0),
            "match": str(row.get("match_text") or ""),
            "user_id": row.get("user_id"),
            "priority": int(row.get("priority") or 100),
            "created_at": None,
        }
        for row in rows
    ]}), 200


@bp.post("/routing/rules")
def add_routing_rule():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    match_text = str(payload.get("match") or "").strip().lower()[:MAX_MATCH]
    user_id = payload.get("user_id")
    priority = payload.get("priority", 100)
    if not match_text:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "match is required."}}), 400
    if isinstance(user_id, bool) or not isinstance(user_id, int) or user_id <= 0:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "user_id (positive int) is"
                                             " required."}}), 400
    if isinstance(priority, bool) or not isinstance(priority, int) or not (
            1 <= priority <= 999):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "priority must be 1-999."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_routing_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) AS total FROM " +
                    portal_db._q(RULES_TABLE) + " WHERE client_id = %s",
                    (principal["client_id"],),
                )
                count_rows = portal_db.rows(cur)
                if int((count_rows[0] if count_rows else {}).get("total") or 0) >= MAX_RULES:
                    return jsonify({"error": {"code": "bad_request",
                                              "message": "Max " + str(MAX_RULES)
                                                         + " rules."}}), 400
                cur.execute(
                    "INSERT INTO " + portal_db._q(RULES_TABLE) +
                    " (client_id, match_text, user_id, priority)"
                    " VALUES (%s, %s, %s, %s) RETURNING id",
                    (principal["client_id"], match_text, user_id, priority),
                )
                created = portal_db.rows(cur)
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "routing.rule",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Route '" + match_text + "' -> user " + str(user_id))[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("routing rule save failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "routing rule save")[0]), 503
    return jsonify({"ok": True, "id": int((created[0] if created else {})
                                          .get("id") or 0)}), 200


@bp.delete("/routing/rules/<int:rule_id>")
def delete_routing_rule(rule_id: int):
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
            _ensure_routing_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM " + portal_db._q(RULES_TABLE) +
                    " WHERE id = %s AND client_id = %s RETURNING id",
                    (rule_id, principal["client_id"]),
                )
                removed = portal_db.rows(cur)
                if not removed:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Rule not"
                                                         " found."}}), 404
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("routing rule delete failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "routing rule delete")[0]), 503
    return jsonify({"ok": True}), 200


def maybe_route(client_id, conversation_id, contact, text, conn) -> None:
    """Ingest hook: assign the conversation on the FIRST matching rule
    (priority order). Runs inside the ingest transaction; never raises."""
    value = str(text or "").lower()[:500]
    if not value.strip():
        return
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, match_text, user_id FROM " + portal_db._q(RULES_TABLE) +
            " WHERE client_id = %s ORDER BY priority ASC, id ASC LIMIT 25",
            (client_id,),
        )
        rules = portal_db.rows(cur)
        for rule in rules:
            match_text = str(rule.get("match_text") or "").strip().lower()
            if not match_text or match_text not in value:
                continue
            user_id = rule.get("user_id")
            if user_id is None:
                continue
            cur.execute(
                "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
                " SET assigned_to = %s"
                " WHERE id = %s AND client_id = %s AND assigned_to IS NULL",
                (user_id, conversation_id, client_id),
            )
            portal_db.log_action(
                cur,
                client_id,
                "chat.routed",
                "automation",
                None,
                conversation_id,
                ("Routed to user " + str(user_id) + " (match: " + match_text
                 + ")")[:200],
            )
            break
