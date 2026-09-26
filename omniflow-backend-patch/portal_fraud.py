"""Fraud heuristics: deterministic risk scoring for COD and refund behaviour
(no AI). Scores a contact from decline/refund history and keeps a flag row so
merchants can see risky buyers before confirming the next order."""

import logging
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
)
import portal_db

bp = Blueprint("portal_fraud", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

FLAGS_TABLE = "portal_fraud_flags"

LEVELS: Tuple[str, ...] = ("clear", "watch", "high")
WATCH_THRESHOLD = 30
HIGH_THRESHOLD = 60
MAX_SCORE = 100

_DECLINED_FIRST = 25
_DECLINED_REPEAT = 45
_REFUND_EACH = 15
_REFUND_CAP = 2
_NEW_CONTACT_BONUS = 10

_FRAUD_DDL_READY = False


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


def _ensure_fraud_tables(conn) -> None:
    global _FRAUD_DDL_READY
    if _FRAUD_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(FLAGS_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " contact_id TEXT NOT NULL,"
            " score INT NOT NULL DEFAULT 0,"
            " level TEXT NOT NULL DEFAULT 'clear',"
            " reasons TEXT NOT NULL DEFAULT '',"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " UNIQUE (client_id, contact_id))"
        )
    conn.commit()
    _FRAUD_DDL_READY = True


def _table_exists(cur, table: str) -> bool:
    cur.execute("SELECT to_regclass(%s) AS found", (table,))
    rows = portal_db.rows(cur)
    return bool(rows and rows[0].get("found"))


def score_contact(cur, client_id, contact) -> Dict[str, Any]:
    """Deterministic score from COD declines, refund requests and account age.

    Pure read pass (3 probes/counts) - safe to call inside any transaction.
    """
    contact = str(contact or "").strip()[:100]
    result: Dict[str, Any] = {
        "score": 0,
        "level": "clear",
        "reasons": [],
        "declined": 0,
        "refunds": 0,
        "chats": 0,
    }
    if not contact:
        return result
    declined = 0
    if _table_exists(cur, "portal_cod_requests"):
        cur.execute(
            "SELECT COUNT(*) AS total FROM " + portal_db._q("portal_cod_requests") +
            " WHERE client_id = %s AND contact_id = %s"
            " AND status = 'declined'",
            (client_id, contact),
        )
        rows = portal_db.rows(cur)
        declined = int((rows[0] if rows else {}).get("total") or 0)
    refunds = 0
    if _table_exists(cur, "portal_action_requests"):
        cur.execute(
            "SELECT COUNT(*) AS total FROM " + portal_db._q("portal_action_requests") +
            " WHERE client_id = %s AND contact_id = %s"
            " AND kind = 'refund_request'",
            (client_id, contact),
        )
        rows = portal_db.rows(cur)
        refunds = int((rows[0] if rows else {}).get("total") or 0)
    cur.execute(
        "SELECT COUNT(*) AS total FROM " + portal_db._q(portal_db.CONV_TABLE) +
        " WHERE client_id = %s AND contact_id = %s",
        (client_id, contact),
    )
    rows = portal_db.rows(cur)
    chats = int((rows[0] if rows else {}).get("total") or 0)

    score = 0
    reasons: List[str] = []
    if declined >= 2:
        score += _DECLINED_REPEAT
        reasons.append("Multiple COD orders declined")
    elif declined == 1:
        score += _DECLINED_FIRST
        reasons.append("One COD order declined")
    if refunds > 0:
        score += _REFUND_EACH * min(refunds, _REFUND_CAP)
        reasons.append(str(refunds) + " refund request(s)")
    if chats <= 1 and (declined > 0 or refunds > 0):
        score += _NEW_CONTACT_BONUS
        reasons.append("New contact with order issues")
    score = min(score, MAX_SCORE)
    level = "clear"
    if score >= HIGH_THRESHOLD:
        level = "high"
    elif score >= WATCH_THRESHOLD:
        level = "watch"
    result.update({
        "score": score,
        "level": level,
        "reasons": reasons,
        "declined": declined,
        "refunds": refunds,
        "chats": chats,
    })
    return result


def _persist_flag(cur, client_id, contact, scored: Dict[str, Any]) -> None:
    cur.execute(
        "INSERT INTO " + portal_db._q(FLAGS_TABLE) +
        " (client_id, contact_id, score, level, reasons)"
        " VALUES (%s, %s, %s, %s, %s)"
        " ON CONFLICT (client_id, contact_id) DO UPDATE SET"
        " score = EXCLUDED.score, level = EXCLUDED.level,"
        " reasons = EXCLUDED.reasons, updated_at = NOW()",
        (client_id, contact, scored["score"], scored["level"],
         "; ".join(scored["reasons"])[:300]),
    )
    portal_db.log_action(
        cur,
        client_id,
        "fraud.flagged",
        "automation",
        None,
        None,
        ("Risk " + str(scored["level"]) + " (" + str(scored["score"]) +
         ") for " + contact)[:200],
    )


@bp.get("/fraud/score")
def fraud_score():
    principal, error = _principal_or_error()
    if error:
        return error
    contact = (request.args.get("contact") or "").strip()[:100]
    if not contact:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contact is required."}}), 400
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_fraud_tables(conn)
            with conn.cursor() as cur:
                scored = score_contact(cur, client_id, contact)
                if scored["level"] != "clear":
                    _persist_flag(cur, client_id, contact, scored)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("fraud score failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "fraud score")[0]), 503
    return jsonify(scored), 200


@bp.get("/fraud/flags")
def fraud_flags():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_fraud_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT contact_id, score, level, reasons, updated_at FROM "
                    + portal_db._q(FLAGS_TABLE) +
                    " WHERE client_id = %s AND score > 0"
                    " ORDER BY updated_at DESC, contact_id ASC LIMIT 50",
                    (principal["client_id"],),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("fraud flags read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "fraud flags read")[0]), 503
    return jsonify({"flags": [
        {
            "contact_id": row.get("contact_id"),
            "score": int(row.get("score") or 0),
            "level": row.get("level") or "clear",
            "reasons": str(row.get("reasons") or ""),
            "updated_at": _iso(row.get("updated_at")),
        }
        for row in rows
    ]}), 200


def on_cod_declined(cur, client_id, contact) -> None:
    """Hook for the COD decline path: refresh the risk flag. Never raises."""
    contact = str(contact or "").strip()[:100]
    if not contact:
        return
    try:
        scored = score_contact(cur, client_id, contact)
        if scored["level"] != "clear":
            _persist_flag(cur, client_id, contact, scored)
    except Exception as error:
        logger.warning("fraud decline hook failed: %s", error)
