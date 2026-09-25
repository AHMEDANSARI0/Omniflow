"""Social listening v0: keyword alerts on inbound chats (deterministic).
Merchants define keywords; every inbound message containing one records a
hit and an audit row - no external APIs."""

import logging
from typing import Any, Optional

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db
import portal_plans

bp = Blueprint("portal_listen", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

RULES_TABLE = "portal_listen_rules"
HITS_TABLE = "portal_listen_hits"

MAX_RULES = 20
MAX_KEYWORD = 60

_LISTEN_DDL_READY = False


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


def _ensure_listen_tables(conn) -> None:
    global _LISTEN_DDL_READY
    if _LISTEN_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(RULES_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " keyword TEXT NOT NULL,"
            " note TEXT NOT NULL DEFAULT '',"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " UNIQUE (client_id, keyword))"
        )
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(HITS_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " rule_id BIGINT NOT NULL,"
            " conversation_id BIGINT,"
            " contact_id TEXT NOT NULL DEFAULT '',"
            " snippet TEXT NOT NULL DEFAULT '',"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS portal_listen_hits_client_idx ON "
            + portal_db._q(HITS_TABLE) + " (client_id, id DESC)"
        )
    conn.commit()
    _LISTEN_DDL_READY = True


@bp.get("/listen/rules")
def list_listen_rules():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_listen_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, keyword, note, created_at FROM " +
                    portal_db._q(RULES_TABLE) +
                    " WHERE client_id = %s ORDER BY id DESC LIMIT 50",
                    (principal["client_id"],),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("listen rules read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "listen rules")[0]), 503
    return jsonify({"rules": [
        {
            "id": int(row.get("id") or 0),
            "keyword": str(row.get("keyword") or ""),
            "note": str(row.get("note") or ""),
            "created_at": _iso(row.get("created_at")),
        }
        for row in rows
    ]}), 200


@bp.post("/listen/rules")
def add_listen_rule():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    keyword = str(payload.get("keyword") or "").strip().lower()[:MAX_KEYWORD]
    note = str(payload.get("note") or "").strip()[:200]
    if not keyword:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "keyword is required."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_listen_tables(conn)
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
                                                         + " keywords."}}), 400
                blocked = portal_plans.enforce(cur, principal["client_id"],
                                               "alert_rules",
                                               "Keyword alert rule")
                if blocked is not None:
                    return blocked
                cur.execute(
                    "INSERT INTO " + portal_db._q(RULES_TABLE) +
                    " (client_id, keyword, note) VALUES (%s, %s, %s)"
                    " ON CONFLICT (client_id, keyword) DO UPDATE SET"
                    " note = EXCLUDED.note"
                    " RETURNING id, keyword, note, created_at",
                    (principal["client_id"], keyword, note),
                )
                created = portal_db.rows(cur)
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "listen.rule",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Listening for: " + keyword)[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("listen rule save failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "listen rule save")[0]), 503
    row = created[0] if created else {}
    return jsonify({"ok": True, "rule": {
        "id": int(row.get("id") or 0),
        "keyword": str(row.get("keyword") or keyword),
        "note": str(row.get("note") or ""),
        "created_at": _iso(row.get("created_at")),
    }}), 200


@bp.delete("/listen/rules/<int:rule_id>")
def delete_listen_rule(rule_id: int):
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
            _ensure_listen_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM " + portal_db._q(RULES_TABLE) +
                    " WHERE id = %s AND client_id = %s RETURNING keyword",
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
        logger.warning("listen rule delete failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "listen rule delete")[0]), 503
    return jsonify({"ok": True}), 200


@bp.get("/listen/hits")
def list_listen_hits():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_listen_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT h.id, h.conversation_id, h.contact_id, h.snippet,"
                    " h.created_at, r.keyword AS keyword FROM " +
                    portal_db._q(HITS_TABLE) + " h JOIN " +
                    portal_db._q(RULES_TABLE) + " r ON r.id = h.rule_id"
                    " WHERE h.client_id = %s ORDER BY h.id DESC LIMIT 50",
                    (principal["client_id"],),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("listen hits read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "listen hits")[0]), 503
    return jsonify({"hits": [
        {
            "id": int(row.get("id") or 0),
            "keyword": str(row.get("keyword") or ""),
            "conversation_id": row.get("conversation_id"),
            "contact_id": str(row.get("contact_id") or ""),
            "snippet": str(row.get("snippet") or "")[:160],
            "created_at": _iso(row.get("created_at")),
        }
        for row in rows
    ]}), 200


def maybe_listen(client_id, conversation_id, contact, text, conn) -> None:
    """Ingest hook: record keyword hits on inbound messages. Runs inside the
    ingest transaction; never raises into the caller."""
    value = str(text or "").lower()[:500]
    if not value.strip():
        return
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, keyword FROM " + portal_db._q(RULES_TABLE) +
            " WHERE client_id = %s ORDER BY id LIMIT 20",
            (client_id,),
        )
        rules = portal_db.rows(cur)
        for rule in rules:
            keyword = str(rule.get("keyword") or "").strip().lower()
            if not keyword or keyword not in value:
                continue
            position = value.find(keyword)
            snippet = value[max(0, position - 40):position + 80].strip()
            cur.execute(
                "INSERT INTO " + portal_db._q(HITS_TABLE) +
                " (client_id, rule_id, conversation_id, contact_id, snippet)"
                " VALUES (%s, %s, %s, %s, %s)",
                (client_id, rule.get("id"), conversation_id,
                 str(contact or "")[:100], snippet),
            )
            portal_db.log_action(
                cur,
                client_id,
                "listen.hit",
                "automation",
                None,
                conversation_id,
                ("Keyword hit: " + keyword)[:200],
            )
