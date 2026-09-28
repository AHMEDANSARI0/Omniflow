"""Unified AI-action audit (MASTER-UPGRADE platform service).

The platform already audits everything into ONE table
(``portal_action_log`` via ``portal_db.log_action``): brain answers and
drafts, registry actions (requested / executed / approved / blocked),
workflow runs and handoffs, rule firings, escalations, knowledge imports,
approvals. What was missing is one place to READ the AI's activity as
such, with categories a human understands, instead of grepping actions.

This module is that read model - no new write path, no second log:

* ``timeline(cur, client_id, days, category, limit)`` - the AI/automation
  rows of the audit log, each tagged with a category from ``CATEGORIES``;
* ``overview(cur, client_id, days)`` - counts per category + actor kind,
  pending approvals, the escalation queue and the AI usage/cost totals -
  the numbers the Admin AI Control Center will render later.

Categories are a registry of action prefixes (data, not code paths), so a
new engine only has to log actions with a known prefix to show up here.
Tenant-scoped; open to API keys (read-only).
"""

import logging
import os
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_db
from portal_auth import PortalAuthUnavailable, authenticate_portal_request

logger = logging.getLogger("omniflow.portal-ai-audit")

bp = Blueprint("portal_ai_audit", __name__, url_prefix="/api/v1/portal")

LOG_TABLE = "portal_action_log"
DEFAULT_DAYS = 7
MAX_DAYS = int(os.environ.get("OF_AI_AUDIT_MAX_DAYS", "90") or 90)
LIST_LIMIT = int(os.environ.get("OF_AI_AUDIT_LIST_MAX", "200") or 200)

#: Actor kinds that mean "the platform did this, not a person".
AI_ACTOR_KINDS: Tuple[str, ...] = ("automation", "bot", "workflow", "system", "ai")

#: (key, label, action prefixes) - first match wins, in this order.
CATEGORIES: Tuple[Tuple[str, str, Tuple[str, ...]], ...] = (
    ("handoffs", "Handoffs", ("escalation.", "bot.escalated", "workflow.handoff")),
    ("approvals", "Approvals", ("approval.",)),
    ("actions", "Actions", ("action.",)),
    ("workflows", "Workflows", ("workflow.",)),
    ("answers", "Answers", ("ai.answer", "kb.auto_reply")),
    ("drafts", "Drafts", ("ai.draft",)),
    ("rules", "Rules", ("rule_fired", "rule.", "listen.", "routing.")),
    ("knowledge", "Knowledge", ("kb.",)),
    ("memory", "Memory & identity", ("memory.", "identity.")),
    ("notifications", "Notifications", ("notifications.", "alert.")),
    ("settings", "AI settings", ("ai.settings", "agent.", "brain.")),
    ("security", "Security", ("ai.guard",)),
)
CATEGORY_KEYS = tuple(k for k, _l, _p in CATEGORIES)


def categorize(action: str, actor_kind: str = "") -> str:
    action = str(action or "")
    for key, _label, prefixes in CATEGORIES:
        for prefix in prefixes:
            if action.startswith(prefix):
                return key
    return "other"


def _patterns() -> List[str]:
    out: List[str] = []
    for _key, _label, prefixes in CATEGORIES:
        for prefix in prefixes:
            out.append(prefix + "%")
    return out


def _days(value: Any) -> int:
    try:
        days = int(value or DEFAULT_DAYS)
    except Exception:
        days = DEFAULT_DAYS
    return max(1, min(MAX_DAYS, days))


def _iso(value: Any) -> Optional[str]:
    if value is None or value == "":
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _guarded(cur, label: str, fn):
    """Run one optional block behind a SAVEPOINT so a missing table never
    aborts the surrounding transaction; None on failure."""
    try:
        cur.execute("SAVEPOINT of_ai_audit")
        value = fn()
        cur.execute("RELEASE SAVEPOINT of_ai_audit")
        return value
    except Exception as error:
        logger.warning("overview %s failed: %s", label, error)
        try:
            cur.execute("ROLLBACK TO SAVEPOINT of_ai_audit")
        except Exception:
            pass
        return None


def _select_rows(cur, client_id: int, days: int, limit: int) -> List[Dict[str, Any]]:
    cur.execute(
        "SELECT id, action, actor_kind, actor_user_id, conversation_id, note,"
        " created_at FROM " + portal_db._q(LOG_TABLE) +
        " WHERE client_id = %s"
        " AND created_at > NOW() - make_interval(days => %s)"
        " AND (actor_kind = ANY(%s) OR action LIKE ANY(%s))"
        " ORDER BY id DESC LIMIT %s",
        (client_id, days, list(AI_ACTOR_KINDS), _patterns(), limit),
    )
    return portal_db.rows(cur)


def timeline(cur, client_id: int, days: int = DEFAULT_DAYS,
             category: str = "", limit: int = LIST_LIMIT) -> List[Dict[str, Any]]:
    """AI / automation audit rows, newest first, tagged with a category."""
    days = _days(days)
    limit = max(1, min(LIST_LIMIT, int(limit or LIST_LIMIT)))
    fetch = limit if not category else LIST_LIMIT
    items: List[Dict[str, Any]] = []
    for row in _select_rows(cur, client_id, days, fetch):
        key = categorize(row.get("action"), row.get("actor_kind"))
        if category and key != category:
            continue
        items.append({
            "id": int(row.get("id") or 0),
            "action": str(row.get("action") or ""),
            "category": key,
            "actor_kind": str(row.get("actor_kind") or ""),
            "actor_user_id": (int(row["actor_user_id"])
                              if row.get("actor_user_id") else None),
            "conversation_id": (int(row["conversation_id"])
                                if row.get("conversation_id") else None),
            "note": str(row.get("note") or ""),
            "created_at": _iso(row.get("created_at")),
        })
        if len(items) >= limit:
            break
    return items


def overview(cur, client_id: int, days: int = DEFAULT_DAYS) -> Dict[str, Any]:
    """Counts per category / actor kind for the window + the live queues
    (pending approvals, open escalations) + AI usage totals. Each block is
    fail-soft so one missing table never blanks the card."""
    days = _days(days)
    by_category = {key: 0 for key in CATEGORY_KEYS}
    by_category["other"] = 0
    by_actor: Dict[str, int] = {}
    total = 0
    cur.execute(
        "SELECT action, actor_kind, COUNT(*) AS n FROM " + portal_db._q(LOG_TABLE) +
        " WHERE client_id = %s"
        " AND created_at > NOW() - make_interval(days => %s)"
        " AND (actor_kind = ANY(%s) OR action LIKE ANY(%s))"
        " GROUP BY action, actor_kind",
        (client_id, days, list(AI_ACTOR_KINDS), _patterns()),
    )
    for row in portal_db.rows(cur):
        n = int(row.get("n") or 0)
        total += n
        key = categorize(row.get("action"), row.get("actor_kind"))
        by_category[key] = by_category.get(key, 0) + n
        actor = str(row.get("actor_kind") or "unknown")
        by_actor[actor] = by_actor.get(actor, 0) + n
    out: Dict[str, Any] = {
        "days": days,
        "total": total,
        "by_category": [
            {"key": key, "label": label, "count": by_category.get(key, 0)}
            for key, label, _p in CATEGORIES
        ] + [{"key": "other", "label": "Other", "count": by_category.get("other", 0)}],
        "by_actor": by_actor,
        "approvals_pending": None,
        "escalations": None,
        "usage": None,
    }
    def _approvals():
        import portal_approvals

        cur.execute(
            "SELECT COUNT(*) AS n FROM " + portal_db._q(portal_approvals.TABLE) +
            " WHERE client_id = %s AND status = 'pending'",
            (client_id,),
        )
        rows = portal_db.rows(cur)
        return int((rows[0] if rows else {}).get("n") or 0)

    def _escalations():
        import portal_escalation

        portal_escalation._ensure_ddl(cur)
        return portal_escalation.summary(cur, client_id)

    def _usage():
        import portal_ai_usage

        portal_ai_usage._ensure_ddl(cur)
        report = portal_ai_usage.usage_report(cur, client_id, days)
        return {"totals": report["totals"],
                "prices_configured": report["prices_configured"]}

    out["approvals_pending"] = _guarded(cur, "approvals", _approvals)
    out["escalations"] = _guarded(cur, "escalations", _escalations)
    out["usage"] = _guarded(cur, "usage", _usage)
    return out


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


@bp.get("/ai/audit")
def get_audit():
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    days = _days(request.args.get("days"))
    category = str(request.args.get("category") or "").strip().lower()
    if category and category not in CATEGORY_KEYS + ("other",):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Unknown category."}}), 400
    try:
        limit = int(request.args.get("limit") or 100)
    except Exception:
        limit = 100
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            items = timeline(cur, client_id, days, category, limit)
        conn.commit()
    finally:
        conn.close()
    return jsonify({"days": days, "category": category, "items": items,
                    "categories": [{"key": k, "label": l}
                                   for k, l, _p in CATEGORIES]}), 200


@bp.get("/ai/overview")
def get_overview():
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    days = _days(request.args.get("days"))
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            data = overview(cur, client_id, days)
        conn.commit()
    finally:
        conn.close()
    return jsonify(data), 200
