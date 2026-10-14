"""Centralised escalation / handoff (MASTER-UPGRADE platform service).

Before this module a handoff was three different things: the AI Brain
silently dropped to "handoff" (a trace row nobody reads), the knowledge-gap
path assigned the first teammate, and workflows had their own handoff
branch.  Now every "a human must look at this chat" goes through ONE call:

    portal_escalation.escalate(cur, client_id, conversation_id,
                               reason="low_confidence", source="ai")

which - in the caller's transaction and never raising -

1. keeps ONE open escalation per conversation (a repeat bumps ``hits``
   instead of re-assigning and re-alerting);
2. picks the human: the explicit ``user_id`` -> the escalation target of
   the AI persona the chat is assigned to (portal_agents
   ``escalation_user_id`` - configured for a long time, honoured now) ->
   the first teammate (the legacy behaviour) -> nobody (still recorded);
3. assigns the conversation to that human;
4. writes the ``portal_escalations`` ledger row (reason, source, severity,
   target) and the ``escalation.opened`` audit line;
5. notifies the owner through portal_notify (bell + optional email).

Sources: ai (Brain needs_human / low_confidence / policy block), workflow
(handoff step), kb (repeated knowledge gaps), rule, human (owner button),
system.  Resolution is explicit (owner API / UI) so the queue is honest;
``resolve_for_conversation`` exists for future auto-resolve hooks.
"""

import logging
import os
from typing import Any, Dict, List, Optional

from flask import Blueprint, jsonify, request

import portal_db
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)

logger = logging.getLogger("omniflow.portal-escalation")

bp = Blueprint("portal_escalation", __name__, url_prefix="/api/v1/portal")

TABLE = "portal_escalations"

SOURCES = ("ai", "workflow", "kb", "rule", "human", "system")
STATUSES = ("open", "resolved")
SEVERITIES = ("normal", "high")
#: source -> actor_kind used in portal_action_log (existing vocabulary).
ACTOR_KIND = {"ai": "automation", "workflow": "workflow", "kb": "bot",
              "rule": "automation", "human": "customer_user",
              "system": "system"}
#: Brain decision reasons that mean "a person should look" (llm_unavailable
#: and empty_reply are platform problems, not customer situations).
AI_ESCALATE_REASONS = ("needs_human", "low_confidence")
LIST_LIMIT = int(os.environ.get("OF_ESCALATIONS_LIST_MAX", "100") or 100)
MAX_NOTE = 300

_DDL_READY = False

_DDL = """
CREATE TABLE IF NOT EXISTS portal_escalations (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'system',
  severity TEXT NOT NULL DEFAULT 'normal',
  note TEXT NOT NULL DEFAULT '',
  target_user_id BIGINT,
  status TEXT NOT NULL DEFAULT 'open',
  hits INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by BIGINT,
  resolved_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_portal_escalations_queue
  ON portal_escalations (client_id, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_portal_escalations_conv
  ON portal_escalations (client_id, conversation_id);
"""


def _ensure_ddl(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    _DDL_READY = True


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def default_severity(reason: str, source: str) -> str:
    """Policy blocks (the AI was about to promise something it must not)
    and owner-raised escalations are high; everything else normal."""
    reason = str(reason or "")
    if reason.startswith("policy") or source == "human":
        return "high"
    return "normal"


def reason_label(reason: str) -> str:
    reason = str(reason or "").strip()
    if reason == "needs_human":
        return "AI asked for a human"
    if reason == "low_confidence":
        return "AI was not confident"
    if reason == "injection_suspected":
        return "Suspicious message (prompt injection)"
    if reason.startswith("output_guard"):
        return "AI reply withheld (" + reason.split(":", 1)[-1] + ")"
    if reason.startswith("policy"):
        return "Blocked by policy (" + reason.split(":", 1)[-1] + ")"
    if reason == "repeated knowledge gaps":
        return "Repeated knowledge gaps"
    if reason.startswith("workflow"):
        return "Workflow handoff"
    if reason == "manual":
        return "Raised by the team"
    return reason or "Handoff"


def _persona_target(cur, client_id: int, conversation_id: int) -> Optional[int]:
    """The escalation teammate configured on the AI persona this chat is
    assigned to (fail-soft: none). Probed with to_regclass first so a
    workspace that never used personas cannot abort the transaction."""
    try:
        import portal_agents

        cur.execute("SELECT to_regclass(%s)", (portal_agents.CONV_AGENTS_TABLE,))
        found = portal_db.rows(cur)
        if not (found and found[0].get("to_regclass")):
            return None
        agent = portal_agents.agent_for_conversation(cur, client_id,
                                                     conversation_id)
    except Exception:
        agent = None
    if agent and agent.get("escalation_user_id"):
        try:
            return int(agent["escalation_user_id"])
        except Exception:
            return None
    return None


def _first_teammate(cur, client_id: int) -> Optional[int]:
    """Legacy fallback: the first team member (table may not exist)."""
    try:
        cur.execute("SELECT to_regclass(%s)", ("portal_team_members",))
        found = portal_db.rows(cur)
        if not (found and found[0].get("to_regclass")):
            return None
        cur.execute(
            "SELECT user_id FROM " + portal_db._q(portal_db.TEAM_TABLE) +
            " WHERE client_id = %s AND user_id IS NOT NULL"
            " ORDER BY user_id LIMIT 1",
            (client_id,),
        )
        members = portal_db.rows(cur)
        if members and members[0].get("user_id") is not None:
            return int(members[0]["user_id"])
    except Exception:
        return None
    return None


def _open_for_conversation(cur, client_id: int, conversation_id: int) -> Optional[Dict[str, Any]]:
    cur.execute(
        "SELECT id, hits, target_user_id FROM " + portal_db._q(TABLE) +
        " WHERE client_id = %s AND conversation_id = %s AND status = 'open'"
        " ORDER BY id DESC LIMIT 1",
        (client_id, conversation_id),
    )
    rows = portal_db.rows(cur)
    return rows[0] if rows else None


# ---------------------------------------------------------------------------
# the service
# ---------------------------------------------------------------------------

def escalate(cur, client_id: int, conversation_id: Any, reason: str = "",
             source: str = "system", severity: str = "", note: str = "",
             user_id: Optional[int] = None,
             notify_owner: bool = True) -> Optional[Dict[str, Any]]:
    """Hand a conversation to a human (see module docstring). Returns the
    escalation summary dict, or None when nothing could be recorded."""
    try:
        conversation_id = int(conversation_id or 0)
    except Exception:
        conversation_id = 0
    if conversation_id <= 0:
        return None
    source = str(source or "system")
    if source not in SOURCES:
        source = "system"
    reason = str(reason or "").strip()[:120]
    severity = str(severity or "") or default_severity(reason, source)
    if severity not in SEVERITIES:
        severity = "normal"
    note = str(note or "").strip()[:MAX_NOTE]
    try:
        _ensure_ddl(cur)
        existing = _open_for_conversation(cur, client_id, conversation_id)
        if existing:
            cur.execute(
                "UPDATE " + portal_db._q(TABLE) +
                " SET hits = hits + 1, updated_at = NOW(),"
                " severity = CASE WHEN %s = 'high' THEN 'high' ELSE severity END"
                " WHERE id = %s AND client_id = %s",
                (severity, int(existing["id"]), client_id),
            )
            return {"id": int(existing["id"]), "status": "open",
                    "deduped": True, "hits": int(existing.get("hits") or 1) + 1,
                    "target_user_id": existing.get("target_user_id"),
                    "reason": reason, "source": source, "severity": severity}
        target: Optional[int] = None
        if user_id:
            try:
                target = int(user_id)
            except Exception:
                target = None
        if not target:
            target = _persona_target(cur, client_id, conversation_id)
        if not target:
            target = _first_teammate(cur, client_id)
        if target:
            cur.execute(
                "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
                " SET assigned_to = %s WHERE id = %s AND client_id = %s",
                (target, conversation_id, client_id),
            )
        cur.execute(
            "INSERT INTO " + portal_db._q(TABLE) +
            " (client_id, conversation_id, reason, source, severity, note,"
            " target_user_id) VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (client_id, conversation_id, reason, source, severity, note, target),
        )
        rows = portal_db.rows(cur)
        escalation_id = int((rows[0] if rows else {}).get("id") or 0)
        label = reason_label(reason)
        portal_db.log_action(
            cur, client_id, "escalation.opened", ACTOR_KIND.get(source, "system"),
            None, conversation_id,
            (label + " (" + source + ")"
             + (" -> user " + str(target) if target else " -> unassigned")
             + (": " + note if note else ""))[:200],
        )
        result = {"id": escalation_id, "status": "open", "deduped": False,
                  "hits": 1, "target_user_id": target, "reason": reason,
                  "source": source, "severity": severity}
        if notify_owner:
            try:
                import portal_notify

                result["notified"] = portal_notify.notify(
                    client_id, "escalation",
                    "Chat needs a human: " + label,
                    ("Conversation #" + str(conversation_id)
                     + (" assigned to user " + str(target) if target
                        else " - nobody is assigned yet")
                     + (". " + note if note else "")),
                    severity=severity,
                    dedupe_key="conv:" + str(conversation_id),
                    conversation_id=conversation_id)
            except Exception as error:
                logger.warning("escalation notify failed: %s", error)
        return result
    except Exception as error:
        logger.warning("escalate failed: %s", error)
        return None


def resolve(cur, client_id: int, escalation_id: int,
            user_id: Optional[int] = None, note: str = "") -> Optional[Dict[str, Any]]:
    """Close one open escalation; None when it does not exist / is closed."""
    _ensure_ddl(cur)
    cur.execute(
        "UPDATE " + portal_db._q(TABLE) +
        " SET status = 'resolved', resolved_at = NOW(), resolved_by = %s,"
        " resolved_note = %s, updated_at = NOW()"
        " WHERE id = %s AND client_id = %s AND status = 'open'"
        " RETURNING id, conversation_id, reason, source, severity",
        (user_id, str(note or "")[:MAX_NOTE], int(escalation_id), client_id),
    )
    rows = portal_db.rows(cur)
    if not rows:
        return None
    row = rows[0]
    portal_db.log_action(
        cur, client_id, "escalation.resolved", "customer_user", user_id,
        row.get("conversation_id"),
        ("Resolved: " + reason_label(row.get("reason"))
         + (" - " + note if note else ""))[:200],
    )
    return {"id": int(row["id"]), "status": "resolved",
            "conversation_id": int(row.get("conversation_id") or 0)}


def resolve_for_conversation(cur, client_id: int, conversation_id: int,
                             user_id: Optional[int] = None,
                             note: str = "") -> int:
    """Close every open escalation of a conversation (returns how many)."""
    try:
        _ensure_ddl(cur)
        cur.execute(
            "UPDATE " + portal_db._q(TABLE) +
            " SET status = 'resolved', resolved_at = NOW(), resolved_by = %s,"
            " resolved_note = %s, updated_at = NOW()"
            " WHERE client_id = %s AND conversation_id = %s AND status = 'open'",
            (user_id, str(note or "")[:MAX_NOTE], client_id, int(conversation_id)),
        )
        return int(cur.rowcount or 0)
    except Exception as error:
        logger.warning("resolve_for_conversation failed: %s", error)
        return 0


def _iso(value: Any) -> Optional[str]:
    if value is None or value == "":
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _public(row: Dict[str, Any]) -> Dict[str, Any]:
    reason = str(row.get("reason") or "")
    return {
        "id": int(row.get("id") or 0),
        "conversation_id": int(row.get("conversation_id") or 0),
        "contact_name": str(row.get("contact_name") or ""),
        "contact_id": str(row.get("contact_id") or ""),
        "reason": reason,
        "reason_label": reason_label(reason),
        "source": str(row.get("source") or "system"),
        "severity": str(row.get("severity") or "normal"),
        "note": str(row.get("note") or ""),
        "target_user_id": (int(row["target_user_id"])
                           if row.get("target_user_id") else None),
        "status": str(row.get("status") or "open"),
        "hits": int(row.get("hits") or 1),
        "created_at": _iso(row.get("created_at")),
        "updated_at": _iso(row.get("updated_at")),
        "resolved_at": _iso(row.get("resolved_at")),
        "resolved_note": str(row.get("resolved_note") or ""),
    }


def list_escalations(cur, client_id: int, status: str = "open",
                     limit: int = LIST_LIMIT) -> List[Dict[str, Any]]:
    where = " AND e.status = %s" if status in STATUSES else ""
    params: List[Any] = [client_id]
    if where:
        params.append(status)
    params.append(max(1, min(LIST_LIMIT, int(limit or LIST_LIMIT))))
    cur.execute(
        "SELECT e.id, e.conversation_id, e.reason, e.source, e.severity,"
        " e.note, e.target_user_id, e.status, e.hits, e.created_at,"
        " e.updated_at, e.resolved_at, e.resolved_note,"
        " c.contact_name, c.contact_id FROM " + portal_db._q(TABLE) + " e"
        " LEFT JOIN " + portal_db._q(portal_db.CONV_TABLE) + " c"
        " ON c.id = e.conversation_id AND c.client_id = e.client_id"
        " WHERE e.client_id = %s" + where +
        " ORDER BY e.id DESC LIMIT %s",
        tuple(params),
    )
    return [_public(r) for r in portal_db.rows(cur)]


def summary(cur, client_id: int) -> Dict[str, Any]:
    """Queue health: open now, opened / resolved in 7 days, average time to
    resolve, and the 7-day breakdown by source and reason."""
    cur.execute(
        "SELECT COUNT(*) FILTER (WHERE status = 'open') AS open_now,"
        " COUNT(*) FILTER (WHERE status = 'open' AND severity = 'high')"
        " AS open_high,"
        " COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')"
        " AS opened_7d,"
        " COUNT(*) FILTER (WHERE resolved_at > NOW() - INTERVAL '7 days')"
        " AS resolved_7d,"
        " AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)))"
        " FILTER (WHERE resolved_at > NOW() - INTERVAL '7 days')"
        " AS avg_resolve_seconds"
        " FROM " + portal_db._q(TABLE) + " WHERE client_id = %s",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    totals = rows[0] if rows else {}
    cur.execute(
        "SELECT source, reason, COUNT(*) AS n FROM " + portal_db._q(TABLE) +
        " WHERE client_id = %s AND created_at > NOW() - INTERVAL '7 days'"
        " GROUP BY source, reason ORDER BY n DESC LIMIT 50",
        (client_id,),
    )
    by_source: Dict[str, int] = {}
    reasons: Dict[str, int] = {}
    for row in portal_db.rows(cur):
        n = int(row.get("n") or 0)
        by_source[str(row.get("source") or "system")] = by_source.get(
            str(row.get("source") or "system"), 0) + n
        label = reason_label(row.get("reason"))
        reasons[label] = reasons.get(label, 0) + n
    top = sorted(reasons.items(), key=lambda item: (-item[1], item[0]))[:5]
    avg = totals.get("avg_resolve_seconds")
    return {
        "open": int(totals.get("open_now") or 0),
        "open_high": int(totals.get("open_high") or 0),
        "opened_7d": int(totals.get("opened_7d") or 0),
        "resolved_7d": int(totals.get("resolved_7d") or 0),
        "avg_resolve_minutes": (round(float(avg) / 60.0, 1)
                                if avg is not None else None),
        "by_source": by_source,
        "top_reasons": [{"label": label, "count": count} for label, count in top],
    }


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

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
    return principal, None


def _human_or_error():
    principal, error = _principal_or_error()
    if error:
        return None, error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return None, forbidden
    return principal, None


def _bad(message: str, code: str = "bad_request", status: int = 400):
    return jsonify({"error": {"code": code, "message": message}}), status


@bp.get("/escalations")
def get_escalations():
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    status = str(request.args.get("status") or "open").strip().lower()
    if status not in STATUSES + ("all",):
        return _bad("status must be open, resolved or all.")
    try:
        limit = int(request.args.get("limit") or LIST_LIMIT)
    except Exception:
        limit = LIST_LIMIT
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            items = list_escalations(cur, client_id, status, limit)
            stats = summary(cur, client_id)
        conn.commit()
    finally:
        conn.close()
    return jsonify({"items": items, "summary": stats,
                    "sources": list(SOURCES)}), 200


@bp.post("/escalations")
def post_escalation():
    """Owner / teammate raises a handoff by hand (optionally to a user)."""
    principal, error = _human_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True) or {}
    try:
        conversation_id = int(payload.get("conversation_id") or 0)
    except Exception:
        conversation_id = 0
    if conversation_id <= 0:
        return _bad("conversation_id is required.")
    user_id = payload.get("user_id")
    if user_id is not None and (isinstance(user_id, bool)
                                or not isinstance(user_id, int) or user_id <= 0):
        return _bad("user_id must be a positive integer.")
    note = str(payload.get("note") or "").strip()[:MAX_NOTE]
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "SELECT id FROM " + portal_db._q(portal_db.CONV_TABLE) +
                " WHERE id = %s AND client_id = %s",
                (conversation_id, client_id),
            )
            if not portal_db.rows(cur):
                conn.rollback()
                return _bad("No such conversation.", "not_found", 404)
            result = escalate(cur, client_id, conversation_id, "manual",
                              "human", note=note, user_id=user_id)
            if result is None:
                conn.rollback()
                return _bad("The escalation could not be recorded.",
                            "escalation_failed", 500)
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "escalation": result}), 200


@bp.post("/escalations/<int:escalation_id>/resolve")
def resolve_escalation(escalation_id: int):
    principal, error = _human_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True) or {}
    note = str(payload.get("note") or "").strip()[:MAX_NOTE]
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            result = resolve(cur, client_id, escalation_id,
                             principal.get("user_id"), note)
            if result is None:
                conn.rollback()
                return _bad("No open escalation with that id.", "not_found", 404)
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "escalation": result}), 200
