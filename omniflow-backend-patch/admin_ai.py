"""Admin AI Control Center (MASTER-UPGRADE build-order 15).

Platform-admin view over EVERY workspace's AI: autonomy level, agents,
LLM usage + estimated cost, open escalations, pending approvals, brain
answers vs handoffs, last AI activity - plus the platform controls the
brain and every LLM call obey:

  * ``ai.kill_switch`` (on|off)      - pause all AI answering platform-wide
                                       (portal_llm.chat_json returns None,
                                       the brain runs at "off");
  * ``ai.autonomy_cap`` (off|suggest|auto) - the highest autonomy any
                                       workspace may run at (brain uses
                                       min(own, cap));
  * ``ai.daily_call_cap`` (int, 0 = unlimited) - LLM calls per workspace
                                       per 24 h; the owner is notified once
                                       a day when the cap is hit.

Controls live in platform_settings group "ai" (DB-backed, env fallback
OF_AI_*), are saved through the existing admin providers API (validated
whitelist) and read through ``platform_settings.ai_controls()``. This
module adds the READ overview and the per-workspace autonomy override
(audited as actor ``platform_admin`` + owner notified). Guarded by the
same service/admin key as the other admin blueprints; every optional
table sits behind a SAVEPOINT so a fresh install still renders.
"""

import json
import logging
import os
import secrets as _secrets
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from flask import Blueprint, jsonify, request

import platform_settings
import portal_db

logger = logging.getLogger("omniflow.admin-ai")

bp = Blueprint("admin_ai", __name__, url_prefix="/api/v1/admin/ai")

DEFAULT_DAYS = 7
MAX_DAYS = int(os.environ.get("OF_ADMIN_AI_MAX_DAYS", "90") or 90)
MAX_WORKSPACES = int(os.environ.get("OF_ADMIN_AI_MAX_WORKSPACES", "200") or 200)
RECENT_LIMIT = int(os.environ.get("OF_ADMIN_AI_RECENT", "40") or 40)
AUTONOMY_LEVELS = ("off", "suggest", "auto")


# ---------------------------------------------------------------------------
# auth (same contract as admin_providers / admin_users)
# ---------------------------------------------------------------------------

def _authorized() -> bool:
    key = request.headers.get("X-Omniflow-Key", "")
    if not key:
        return False
    accepted = [
        os.environ.get("OMNIFLOW_SERVICE_KEY"),
        os.environ.get("OMNIFLOW_ADMIN_API_KEY"),
    ]
    return any(k for k in accepted if k and _secrets.compare_digest(key, k))


@bp.before_request
def _guard():
    if request.method == "OPTIONS":
        return None
    if not _authorized():
        return jsonify({"error": {"code": "forbidden",
                                  "message": "Service key missing or invalid."}}), 403


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _days(value: Any) -> int:
    try:
        days = int(value or DEFAULT_DAYS)
    except (TypeError, ValueError):
        days = DEFAULT_DAYS
    return max(1, min(MAX_DAYS, days))


def _iso(value: Any) -> Optional[str]:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return str(value) if value else None


def _guarded(cur, label: str, fn):
    """Run one optional block behind a SAVEPOINT (missing table on a
    fresh install must not abort the overview); None on failure."""
    try:
        cur.execute("SAVEPOINT of_admin_ai")
        value = fn()
        cur.execute("RELEASE SAVEPOINT of_admin_ai")
        return value
    except Exception as error:
        logger.warning("admin ai overview %s failed: %s", label, error)
        try:
            cur.execute("ROLLBACK TO SAVEPOINT of_admin_ai")
        except Exception:
            pass
        return None


def _by_client(rows: Optional[List[Dict[str, Any]]]) -> Dict[int, Dict[str, Any]]:
    out: Dict[int, Dict[str, Any]] = {}
    for row in rows or []:
        try:
            out[int(row.get("client_id") or 0)] = row
        except (TypeError, ValueError):
            continue
    return out


# ---------------------------------------------------------------------------
# overview
# ---------------------------------------------------------------------------

def _workspaces(cur) -> List[Dict[str, Any]]:
    email_col = getattr(portal_db, "USER_EMAIL_COL", "email")
    cur.execute(
        "SELECT client_id, MIN(" + portal_db._q(email_col) +
        ") AS email, MIN(display_name) AS owner, COUNT(*) AS users"
        " FROM " + portal_db._q(portal_db.USERS_TABLE) +
        " WHERE client_id IS NOT NULL"
        " GROUP BY client_id ORDER BY client_id LIMIT %s",
        (max(1, MAX_WORKSPACES),),
    )
    return portal_db.rows(cur)


def _names(cur) -> List[Dict[str, Any]]:
    cur.execute(
        "SELECT client_id, profile->>'business_name' AS business_name"
        " FROM " + portal_db._q(portal_db.PROFILE_TABLE),
    )
    return portal_db.rows(cur)


def _autonomy(cur) -> List[Dict[str, Any]]:
    cur.execute(
        "SELECT client_id, autonomy, updated_at FROM " +
        portal_db._q("portal_brain_settings"),
    )
    return portal_db.rows(cur)


def _agents(cur) -> List[Dict[str, Any]]:
    cur.execute(
        "SELECT client_id, COUNT(*) AS total,"
        " COUNT(*) FILTER (WHERE is_active) AS active,"
        " COUNT(*) FILTER (WHERE is_active AND can_auto_reply = FALSE)"
        " AS draft_only"
        " FROM " + portal_db._q("portal_agents") + " GROUP BY client_id",
    )
    return portal_db.rows(cur)


def _usage(cur, days: int) -> List[Dict[str, Any]]:
    cur.execute(
        "SELECT client_id, model, COUNT(*) AS calls,"
        " COUNT(*) FILTER (WHERE NOT ok) AS failed,"
        " COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,"
        " COALESCE(SUM(completion_tokens), 0) AS completion_tokens,"
        " MAX(created_at) AS last_call_at"
        " FROM " + portal_db._q("portal_ai_usage") +
        " WHERE created_at > NOW() - make_interval(days => %s)"
        " GROUP BY client_id, model",
        (days,),
    )
    return portal_db.rows(cur)


def _escalations(cur) -> List[Dict[str, Any]]:
    cur.execute(
        "SELECT client_id, COUNT(*) AS open FROM " +
        portal_db._q("portal_escalations") +
        " WHERE status = 'open' GROUP BY client_id",
    )
    return portal_db.rows(cur)


def _approvals(cur) -> List[Dict[str, Any]]:
    import portal_approvals

    cur.execute(
        "SELECT client_id, COUNT(*) AS pending FROM " +
        portal_db._q(portal_approvals.TABLE) +
        " WHERE status = 'pending' GROUP BY client_id",
    )
    return portal_db.rows(cur)


def _traces(cur, days: int) -> List[Dict[str, Any]]:
    cur.execute(
        "SELECT client_id, decision,"
        " (COALESCE(grounding->>'reason', '') = 'injection_suspected')"
        " AS blocked, COUNT(*) AS n FROM " +
        portal_db._q("portal_brain_traces") +
        " WHERE kind = 'ingest_answer'"
        " AND created_at > NOW() - make_interval(days => %s)"
        " GROUP BY client_id, decision, blocked",
        (days,),
    )
    return portal_db.rows(cur)


def _recent(cur, days: int) -> List[Dict[str, Any]]:
    import portal_ai_audit

    cur.execute(
        "SELECT id, client_id, action, actor_kind, conversation_id, note,"
        " created_at FROM " + portal_db._q(portal_ai_audit.LOG_TABLE) +
        " WHERE created_at > NOW() - make_interval(days => %s)"
        " AND (actor_kind = ANY(%s) OR action LIKE ANY(%s))"
        " ORDER BY id DESC LIMIT %s",
        (days, list(portal_ai_audit.AI_ACTOR_KINDS),
         portal_ai_audit._patterns(), max(1, RECENT_LIMIT)),
    )
    return portal_db.rows(cur)


def overview(cur, days: int = DEFAULT_DAYS) -> Dict[str, Any]:
    """Every workspace's AI posture + platform totals (read-only)."""
    days = _days(days)
    import portal_ai_usage
    import portal_ai_audit

    workspaces = _guarded(cur, "workspaces", lambda: _workspaces(cur)) or []
    names = _by_client(_guarded(cur, "names", lambda: _names(cur)))
    autonomy = _by_client(_guarded(cur, "autonomy", lambda: _autonomy(cur)))
    agents = _by_client(_guarded(cur, "agents", lambda: _agents(cur)))
    usage_rows = _guarded(cur, "usage", lambda: _usage(cur, days)) or []
    escalations = _by_client(_guarded(cur, "escalations",
                                      lambda: _escalations(cur)))
    approvals = _by_client(_guarded(cur, "approvals", lambda: _approvals(cur)))
    trace_rows = _guarded(cur, "traces", lambda: _traces(cur, days)) or []
    recent_rows = _guarded(cur, "recent", lambda: _recent(cur, days)) or []

    price_table = portal_ai_usage.prices()
    usage: Dict[int, Dict[str, Any]] = {}
    for row in usage_rows:
        cid = int(row.get("client_id") or 0)
        entry = usage.setdefault(cid, {"calls": 0, "failed": 0, "tokens": 0,
                                       "cost_usd": 0.0, "priced": False,
                                       "last_call_at": None})
        prompt = int(row.get("prompt_tokens") or 0)
        completion = int(row.get("completion_tokens") or 0)
        entry["calls"] += int(row.get("calls") or 0)
        entry["failed"] += int(row.get("failed") or 0)
        entry["tokens"] += prompt + completion
        cost = portal_ai_usage.estimate_cost(
            str(row.get("model") or ""), prompt, completion, price_table)
        if cost is not None:
            entry["cost_usd"] = round(entry["cost_usd"] + cost, 4)
            entry["priced"] = True
        last = row.get("last_call_at")
        if last and (entry["last_call_at"] is None
                     or _iso(last) > str(entry["last_call_at"])):
            entry["last_call_at"] = _iso(last)

    traces: Dict[int, Dict[str, int]] = {}
    for row in trace_rows:
        cid = int(row.get("client_id") or 0)
        entry = traces.setdefault(cid, {"answers": 0, "handoffs": 0,
                                        "blocked": 0})
        if str(row.get("decision") or "") == "send":
            entry["answers"] += int(row.get("n") or 0)
        else:
            entry["handoffs"] += int(row.get("n") or 0)
            if row.get("blocked") is True:
                entry["blocked"] += int(row.get("n") or 0)

    # Universe: every workspace with users, plus any workspace that shows
    # AI activity but no user row (never hide activity).
    known = {int(w.get("client_id") or 0) for w in workspaces}
    extra = (set(usage) | set(autonomy) | set(agents)) - known - {0}
    for cid in sorted(extra):
        workspaces.append({"client_id": cid, "email": "", "owner": "",
                           "users": 0})

    items: List[Dict[str, Any]] = []
    totals = {"workspaces": 0, "auto": 0, "suggest": 0, "off": 0,
              "agents_active": 0, "calls": 0, "failed": 0, "tokens": 0,
              "cost_usd": 0.0, "priced": bool(price_table),
              "open_escalations": 0, "pending_approvals": 0,
              "answers": 0, "handoffs": 0, "blocked": 0}
    for ws in workspaces:
        cid = int(ws.get("client_id") or 0)
        if cid <= 0:
            continue
        level = str((autonomy.get(cid) or {}).get("autonomy") or "suggest")
        if level not in AUTONOMY_LEVELS:
            level = "suggest"
        use = usage.get(cid) or {"calls": 0, "failed": 0, "tokens": 0,
                                 "cost_usd": 0.0, "priced": False,
                                 "last_call_at": None}
        agent = agents.get(cid) or {}
        trace = traces.get(cid) or {"answers": 0, "handoffs": 0,
                                    "blocked": 0}
        item = {
            "client_id": cid,
            "name": str((names.get(cid) or {}).get("business_name") or ""),
            "owner": str(ws.get("owner") or ""),
            "email": str(ws.get("email") or ""),
            "users": int(ws.get("users") or 0),
            "autonomy": level,
            "autonomy_updated_at": _iso((autonomy.get(cid) or {}).get(
                "updated_at")),
            "agents_active": int(agent.get("active") or 0),
            "agents_total": int(agent.get("total") or 0),
            "agents_draft_only": int(agent.get("draft_only") or 0),
            "calls": int(use["calls"]),
            "failed": int(use["failed"]),
            "tokens": int(use["tokens"]),
            "cost_usd": (round(float(use["cost_usd"]), 4)
                         if use.get("priced") else None),
            "last_call_at": use.get("last_call_at"),
            "open_escalations": int((escalations.get(cid) or {}).get(
                "open") or 0),
            "pending_approvals": int((approvals.get(cid) or {}).get(
                "pending") or 0),
            "answers": int(trace["answers"]),
            "handoffs": int(trace["handoffs"]),
            "blocked": int(trace.get("blocked") or 0),
        }
        items.append(item)
        totals["workspaces"] += 1
        totals[level] += 1
        totals["agents_active"] += item["agents_active"]
        totals["calls"] += item["calls"]
        totals["failed"] += item["failed"]
        totals["tokens"] += item["tokens"]
        if item["cost_usd"] is not None:
            totals["cost_usd"] = round(totals["cost_usd"] + item["cost_usd"], 4)
        totals["open_escalations"] += item["open_escalations"]
        totals["pending_approvals"] += item["pending_approvals"]
        totals["answers"] += item["answers"]
        totals["handoffs"] += item["handoffs"]
        totals["blocked"] += item["blocked"]
    items.sort(key=lambda i: (-i["calls"], i["client_id"]))

    recent = []
    for row in recent_rows:
        recent.append({
            "id": int(row.get("id") or 0),
            "client_id": int(row.get("client_id") or 0),
            "action": str(row.get("action") or ""),
            "category": portal_ai_audit.categorize(
                row.get("action"), row.get("actor_kind")),
            "actor_kind": str(row.get("actor_kind") or ""),
            "conversation_id": (int(row["conversation_id"])
                                if row.get("conversation_id") else None),
            "note": str(row.get("note") or "")[:300],
            "created_at": _iso(row.get("created_at")),
        })

    return {
        "days": days,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "controls": platform_settings.ai_controls(),
        "totals": totals,
        "workspaces": items,
        "recent": recent,
    }


@bp.get("/eval")
def get_behavioral_eval():
    """Run the bounded, deterministic AI behavior contracts.

    This intentionally makes zero provider calls and touches no tenant data;
    it is a deploy-time smoke signal, not a customer-message evaluator.
    """
    try:
        import portal_ai_eval

        return jsonify(portal_ai_eval.run_contract_suite()), 200
    except Exception as error:
        logger.warning("admin ai behavioral eval failed: %s", error)
        return jsonify({"error": {
            "code": "ai_eval_unavailable",
            "message": "AI behavioral evaluation temporarily unavailable.",
        }}), 503




@bp.get("/quality")
def get_live_quality():
    """Platform-wide live quality sample over brain traces + usage.
    Service-key only (before_request). Zero LLM cost. Optional
    ?client_id= filters to one workspace; ?days=1|7|14|30."""
    try:
        import portal_ai_quality
        days = request.args.get("days")
        raw_client = request.args.get("client_id")
        client_id = None
        if raw_client not in (None, ""):
            try:
                client_id = int(raw_client)
                if client_id <= 0:
                    client_id = None
            except Exception:
                client_id = None
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                data = portal_ai_quality.sample_quality(
                    cur, client_id, days=days or portal_ai_quality.DEFAULT_DAYS
                )
            conn.commit()
        finally:
            conn.close()
        return jsonify(data), 200
    except Exception as error:
        logger.warning("admin ai quality sample failed: %s", error)
        return jsonify({"error": {
            "code": "ai_quality_unavailable",
            "message": "Live AI quality sampling temporarily unavailable.",
        }}), 503


@bp.get("/overview")
def get_overview():
    days = _days(request.args.get("days"))
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                payload = overview(cur, days)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("admin ai overview failed: %s", error)
        return jsonify({"error": {"code": "db_unavailable",
                                  "message": "AI overview temporarily"
                                             " unavailable."}}), 503
    return jsonify(payload), 200


# ---------------------------------------------------------------------------
# per-workspace autonomy override
# ---------------------------------------------------------------------------

def set_autonomy(cur, client_id: int, autonomy: str, reason: str = "") -> None:
    """Upsert one workspace's brain autonomy (platform admin override) and
    audit it as actor ``platform_admin`` - inside the caller's transaction."""
    import portal_brain

    portal_brain._ensure_ddl(cur)
    cur.execute(
        "INSERT INTO " + portal_db._q(portal_brain.SETTINGS_TABLE) +
        " (client_id, autonomy, updated_at) VALUES (%s, %s, NOW())"
        " ON CONFLICT (client_id) DO UPDATE SET autonomy = EXCLUDED.autonomy,"
        " updated_at = NOW()",
        (client_id, autonomy),
    )
    portal_db.log_action(
        cur, client_id, "brain.autonomy_override", "platform_admin", None, None,
        ("Platform admin set AI autonomy to " + autonomy
         + ((": " + reason) if reason else ""))[:200],
    )


@bp.post("/clients/<int:client_id>/autonomy")
def post_autonomy(client_id: int):
    payload = request.get_json(silent=True) or {}
    autonomy = str(payload.get("autonomy") or "").strip().lower()
    reason = str(payload.get("reason") or "").strip()[:200]
    if autonomy not in AUTONOMY_LEVELS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "autonomy must be off, suggest"
                                             " or auto."}}), 400
    if client_id <= 0:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "client_id is required."}}), 400
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                set_autonomy(cur, client_id, autonomy, reason)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("admin ai autonomy override failed: %s", error)
        return jsonify({"error": {"code": "db_unavailable",
                                  "message": "Could not update autonomy."}}), 503
    try:
        import portal_notify

        portal_notify.notify(
            client_id, "system", "AI autonomy changed by the OmniFlow team",
            "Your Business Brain now runs at autonomy '" + autonomy + "'."
            + ((" Reason: " + reason) if reason else "")
            + " You can review this under Settings > AI Brain.",
            severity="high" if autonomy == "off" else "normal",
            dedupe_key="autonomy_override:" + str(client_id) + ":" + autonomy)
    except Exception:
        pass
    return jsonify({"ok": True, "client_id": client_id,
                    "autonomy": autonomy}), 200
