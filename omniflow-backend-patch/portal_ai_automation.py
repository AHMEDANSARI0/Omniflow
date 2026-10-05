"""AI + automation analytics quadrant (§240, gap analysis row 64).

The Analytics page showed conversations and CSAT; the engines that do the
work already keep ledgers, but nothing put them side by side for a window.
This module only READS those ledgers - no new table, no new engine:

  - AI answers (``portal_brain_traces``): automatic answers (ingest / voice),
    sent by the AI vs handed to the team, drafts, confidence bands, tools
    the AI used, why it handed off, answers per agent.
  - AI engine (``portal_ai_usage.usage_report``): calls, failures, tokens,
    latency, cost - cost only when model prices are set (never invented).
  - workflows (``portal_workflow_runs``): runs by outcome, steps, busiest
    workflows, latest failures.
  - actions (``portal_action_runs``, kept ``OF_ACTION_RUNS_KEEP_DAYS``): by
    outcome and by who started them (AI / workflow / approval / person).
  - follow-up sequences (``portal_sequence_enrollments`` + step log).

Every block is probed (``to_regclass``) and runs in its own savepoint: a
missing or broken ledger gives that block ``available: false`` with zeros,
the rest still answers. Shares are 0..1 rounded to 3 places, ``None`` when
there is nothing to divide. Read-only: the request rolls back at the end.

``GET /api/v1/portal/analytics/ai-automation?days=1..90`` (default 30),
human principals of the workspace (any team role); API keys get 403.
"""

import copy
import logging
import os
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from flask import Blueprint, jsonify, request

import portal_db
import portal_txn
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)

bp = Blueprint("portal_ai_automation", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

TRACES_TABLE = "portal_brain_traces"
USAGE_TABLE = "portal_ai_usage"
AGENTS_TABLE = "portal_agents"
WORKFLOWS_TABLE = "portal_workflows"
RUNS_TABLE = "portal_workflow_runs"
ACTION_RUNS_TABLE = "portal_action_runs"
ENROLLMENTS_TABLE = "portal_sequence_enrollments"
STEP_LOG_TABLE = "portal_sequence_step_log"

DEFAULT_DAYS = 30
MAX_DAYS = 90
TOP_TOOLS = 10
TOP_REASONS = 6
TOP_WORKFLOWS = 5
RECENT_FAILURES = 5
TOP_FEATURES = 5
MAX_ERROR_CHARS = 200

AUTO_KINDS = ("ingest_answer", "voice_answer")
DRAFT_KIND = "draft"


def _env_float(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, "") or default)
    except ValueError:
        value = default
    return max(0.0, min(1.0, value))


#: confidence at or above this = "high" (low = below the brain's own bar)
HIGH_CONFIDENCE = _env_float("OF_AI_ANALYTICS_HIGH_CONFIDENCE", 0.8)

TOOL_LABELS = {
    "search_kb": "Knowledge base",
    "business_facts": "Business facts",
    "customer_orders": "Customer orders",
    "customer_memory": "Customer memory",
    "customer_profile": "Customer profile",
    "agent_persona": "Agent persona",
    "sales_context": "Sales playbook",
    "loyalty_context": "Loyalty and offers",
}

BRAIN_REASONS = {
    "low_confidence": "AI was not confident",
    "needs_human": "Customer needs a person",
    "injection_suspected": "Suspicious message blocked",
    "llm_unavailable": "AI engine unavailable",
    "policy": "Blocked by a business rule",
    "output_guard": "Reply held back by a safety check",
    "empty_reply": "AI gave no reply",
    "autonomy_not_auto": "Autonomy is not set to automatic",
    "agent_draft_only": "Agent is set to drafts only",
    "error": "Something went wrong",
    "unknown": "No reason recorded",
}

ACTION_OUTCOMES = ("executed", "approval_required", "denied", "error", "running")
ACTOR_KINDS = ("ai", "workflow", "approval", "person")
#: same mapping as portal_actions._shape_run (executed WITH params: %% = %)
ACTOR_KIND_SQL = (
    "CASE WHEN actor LIKE 'workflow:%%' THEN 'workflow'"
    " WHEN actor = 'approval' THEN 'approval'"
    " WHEN actor LIKE 'brain%%' OR actor LIKE 'agent%%' OR actor LIKE 'ai%%'"
    " THEN 'ai' ELSE 'person' END"
)

WINDOW = " AND {col} > NOW() - make_interval(days => %s)"
CONF_SQL = ("CASE WHEN jsonb_typeof(grounding->'confidence') = 'number'"
            " THEN (grounding->>'confidence')::float END")
TOOLS_SQL = ("CASE WHEN jsonb_typeof(grounding->'tools') = 'array'"
             " THEN grounding->'tools' ELSE '[]'::jsonb END")
AGENT_SQL = ("CASE WHEN grounding->>'agent_id' ~ '^[0-9]{1,18}$'"
             " THEN (grounding->>'agent_id')::bigint END")


def parse_days(raw: Any) -> Optional[int]:
    """Blank -> 30; a whole number 1..90 -> it; anything else -> None."""
    text = str(raw if raw is not None else "").strip()
    if not text:
        return DEFAULT_DAYS
    if not (text.isascii() and text.isdigit()) or len(text) > 3:
        return None
    days = int(text)
    return days if 1 <= days <= MAX_DAYS else None


def _share(part: Any, whole: Any) -> Optional[float]:
    whole = float(whole or 0)
    return round(float(part or 0) / whole, 3) if whole > 0 else None


def _int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _exists(cur, table: str) -> bool:
    cur.execute("SELECT to_regclass(%s) AS oid", (table,))
    rows = portal_db.rows(cur)
    return bool(rows and rows[0].get("oid"))


def _block(cur, tables: tuple, empty: Dict[str, Any],
           fn: Callable[[], Dict[str, Any]]) -> Dict[str, Any]:
    """One fail-soft block: probe its ledgers, run it in a savepoint."""
    fallback = dict(copy.deepcopy(empty), available=False)
    try:
        for table in tables:
            if not _exists(cur, table):
                return fallback
        with portal_txn.savepoint(cur, None, "of_quadrant"):
            data = fn()
    except Exception as error:
        logger.warning("ai/automation block %s failed: %s", tables[0], error)
        return fallback
    return dict(data, available=True)


# ---------------------------------------------------------------------------
# AI: answers (brain traces) + engine usage
# ---------------------------------------------------------------------------

EMPTY_ANSWERS: Dict[str, Any] = {
    "automatic": 0, "sent": 0, "handed_off": 0, "sent_share": None,
    "drafts": 0, "drafts_usable": 0,
    "confidence": {"average": None, "scored": 0, "high": 0, "ok": 0, "low": 0},
    "tools": [], "no_tool": 0, "reasons": [], "agents": [],
}

EMPTY_USAGE: Dict[str, Any] = {
    "calls": 0, "failed": 0, "fail_share": None, "tokens": 0,
    "avg_latency_ms": 0, "cost_usd": None, "priced": False, "features": [],
}


def _usage(cur, client_id: int, days: int) -> Dict[str, Any]:
    import portal_ai_usage

    report = portal_ai_usage.usage_report(cur, client_id, days)
    totals = report.get("totals") or {}
    calls = _int(totals.get("calls"))
    return {
        "calls": calls,
        "failed": _int(totals.get("failed")),
        "fail_share": _share(totals.get("failed"), calls),
        "tokens": _int(totals.get("tokens")),
        "avg_latency_ms": _int(totals.get("avg_latency_ms")),
        "cost_usd": totals.get("cost_usd") if totals.get("priced") else None,
        "priced": bool(totals.get("priced")),
        "features": [{"feature": item.get("feature"), "label": item.get("label"),
                      "calls": _int(item.get("calls")),
                      "cost_usd": item.get("cost_usd")}
                     for item in (report.get("by_feature") or [])[:TOP_FEATURES]],
        # internal: merged into the per-agent rows, not sent as is
        "_by_agent": report.get("by_agent") or [],
    }


def _reason_key(raw: Any) -> str:
    text = str(raw or "").strip()
    return text.split(":", 1)[0] if text else "unknown"


def _answers(cur, client_id: int, days: int,
             usage_by_agent: List[Dict[str, Any]]) -> Dict[str, Any]:
    window = WINDOW.format(col="created_at")
    table = portal_db._q(TRACES_TABLE)
    kinds = "(" + ", ".join("'" + k + "'" for k in AUTO_KINDS + (DRAFT_KIND,)) + ")"
    auto = "(" + ", ".join("'" + k + "'" for k in AUTO_KINDS) + ")"
    out = copy.deepcopy(EMPTY_ANSWERS)
    cur.execute(
        "SELECT kind, decision, COUNT(*) AS n FROM " + table +
        " WHERE client_id = %s AND kind IN " + kinds + window +
        " GROUP BY kind, decision",
        (client_id, days),
    )
    for row in portal_db.rows(cur):
        kind, decision, n = row.get("kind"), row.get("decision"), _int(row.get("n"))
        if kind in AUTO_KINDS:
            out["automatic"] += n
            out["sent"] += n if decision == "send" else 0
            out["handed_off"] += n if decision == "handoff" else 0
        elif kind == DRAFT_KIND:
            out["drafts"] += n
            out["drafts_usable"] += n if decision == "send" else 0
    out["sent_share"] = _share(out["sent"], out["automatic"])
    total = out["automatic"] + out["drafts"]
    low_below = _low_below()
    cur.execute(
        "SELECT COUNT(conf) AS scored, AVG(conf) AS average,"
        " COUNT(*) FILTER (WHERE conf >= %s) AS high,"
        " COUNT(*) FILTER (WHERE conf < %s) AS low,"
        " COUNT(*) FILTER (WHERE tools = 0) AS no_tool"
        " FROM (SELECT " + CONF_SQL + " AS conf,"
        " jsonb_array_length(" + TOOLS_SQL + ") AS tools FROM " + table +
        " WHERE client_id = %s AND kind IN " + kinds + window + ") AS t",
        (HIGH_CONFIDENCE, low_below, client_id, days),
    )
    rows = portal_db.rows(cur)
    row = rows[0] if rows else {}
    scored, high, low = _int(row.get("scored")), _int(row.get("high")), _int(row.get("low"))
    average = row.get("average")
    out["confidence"] = {
        "average": round(float(average), 3) if average is not None and scored else None,
        "scored": scored, "high": high, "low": low, "ok": max(0, scored - high - low),
    }
    out["no_tool"] = _int(row.get("no_tool"))
    cur.execute(
        "SELECT t.tool, COUNT(*) AS n FROM " + table + " AS b"
        " CROSS JOIN LATERAL jsonb_array_elements_text("
        + TOOLS_SQL.replace("grounding", "b.grounding") + ") AS t (tool)"
        " WHERE b.client_id = %s AND b.kind IN " + kinds +
        WINDOW.format(col="b.created_at") +
        " GROUP BY t.tool ORDER BY n DESC, t.tool LIMIT " + str(TOP_TOOLS),
        (client_id, days),
    )
    out["tools"] = [{"key": str(r.get("tool") or ""),
                     "label": TOOL_LABELS.get(str(r.get("tool") or ""), str(r.get("tool") or "")),
                     "count": _int(r.get("n")), "share": _share(r.get("n"), total)}
                    for r in portal_db.rows(cur)]
    cur.execute(
        "SELECT split_part(COALESCE(NULLIF(grounding->>'reason', ''), 'unknown'),"
        " ':', 1) AS reason, COUNT(*) AS n FROM " + table +
        " WHERE client_id = %s AND decision = 'handoff' AND kind IN " + auto + window +
        " GROUP BY 1 ORDER BY n DESC, 1 LIMIT " + str(TOP_REASONS),
        (client_id, days),
    )
    out["reasons"] = [{"reason": _reason_key(r.get("reason")),
                       "label": BRAIN_REASONS.get(_reason_key(r.get("reason")),
                                                  _reason_key(r.get("reason"))),
                       "count": _int(r.get("n"))}
                      for r in portal_db.rows(cur)]
    cur.execute(
        "SELECT " + AGENT_SQL + " AS agent_id, COUNT(*) AS answers,"
        " COUNT(*) FILTER (WHERE decision = 'send') AS sent,"
        " COUNT(*) FILTER (WHERE decision = 'handoff') AS handed_off,"
        " AVG(" + CONF_SQL + ") AS avg_confidence FROM " + table +
        " WHERE client_id = %s AND kind IN " + auto + window +
        " GROUP BY 1",
        (client_id, days),
    )
    out["agents"] = _merge_agents(cur, client_id, portal_db.rows(cur), usage_by_agent)
    return out


def _merge_agents(cur, client_id: int, trace_rows: List[Dict[str, Any]],
                  usage_by_agent: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Answers per agent (traces) + calls / cost per agent (usage ledger)."""
    merged: Dict[int, Dict[str, Any]] = {}

    def entry(agent_id: int) -> Dict[str, Any]:
        return merged.setdefault(agent_id, {
            "agent_id": agent_id or None, "name": "", "answers": 0, "sent": 0,
            "handed_off": 0, "avg_confidence": None, "calls": 0, "cost_usd": None})

    for row in trace_rows:
        item = entry(_int(row.get("agent_id")))
        item["answers"] += _int(row.get("answers"))
        item["sent"] += _int(row.get("sent"))
        item["handed_off"] += _int(row.get("handed_off"))
        if row.get("avg_confidence") is not None:
            item["avg_confidence"] = round(float(row.get("avg_confidence")), 3)
    for row in usage_by_agent:
        item = entry(_int(row.get("agent_id")))
        item["calls"] += _int(row.get("calls"))
        item["cost_usd"] = row.get("cost_usd")
    ids = sorted(aid for aid in merged if aid > 0)
    names: Dict[int, str] = {}
    if ids and _exists(cur, AGENTS_TABLE):
        cur.execute(
            "SELECT id, name FROM " + portal_db._q(AGENTS_TABLE) +
            " WHERE client_id = %s AND id = ANY(%s)",
            (client_id, ids),
        )
        names = {_int(r.get("id")): str(r.get("name") or "") for r in portal_db.rows(cur)}
    for aid, item in merged.items():
        item["name"] = ("Default assistant" if aid == 0
                        else names.get(aid) or "Agent #" + str(aid))
    return sorted(merged.values(),
                  key=lambda r: (-r["answers"], -r["calls"], r["name"].lower()))


def _low_below() -> float:
    try:
        import portal_brain

        return float(portal_brain.MIN_CONFIDENCE)
    except Exception:
        return 0.6


# ---------------------------------------------------------------------------
# automation: workflows, actions, sequences
# ---------------------------------------------------------------------------

EMPTY_WORKFLOWS: Dict[str, Any] = {
    "runs": 0, "completed": 0, "goal_reached": 0, "stopped": 0, "failed": 0,
    "in_progress": 0, "waiting_approval": 0, "steps": 0, "goal_share": None,
    "failure_share": None, "top": [], "failures": [],
}
#: run status -> counter (running and waiting are both "in progress")
RUN_GROUPS = {"completed": "completed", "goal_reached": "goal_reached",
              "stopped": "stopped", "failed": "failed", "running": "in_progress",
              "waiting": "in_progress", "waiting_approval": "waiting_approval"}


def _workflow_name(row: Dict[str, Any]) -> str:
    return str(row.get("name") or "").strip() or "Workflow #" + str(_int(row.get("workflow_id")))


def _workflows(cur, client_id: int, days: int) -> Dict[str, Any]:
    window = WINDOW.format(col="r.started_at")
    runs, flows = portal_db._q(RUNS_TABLE), portal_db._q(WORKFLOWS_TABLE)
    join = (" FROM " + runs + " AS r LEFT JOIN " + flows + " AS w"
            " ON w.id = r.workflow_id AND w.client_id = r.client_id")
    out = copy.deepcopy(EMPTY_WORKFLOWS)
    cur.execute(
        "SELECT r.status, COUNT(*) AS n, COALESCE(SUM(r.steps_done), 0) AS steps"
        " FROM " + runs + " AS r WHERE r.client_id = %s" + window +
        " GROUP BY r.status",
        (client_id, days),
    )
    for row in portal_db.rows(cur):
        n = _int(row.get("n"))
        out["runs"] += n
        out["steps"] += _int(row.get("steps"))
        group = RUN_GROUPS.get(str(row.get("status") or ""))
        if group:
            out[group] += n
    out["goal_share"] = _share(out["goal_reached"], out["runs"])
    out["failure_share"] = _share(out["failed"], out["runs"])
    cur.execute(
        "SELECT r.workflow_id, w.name, COUNT(*) AS runs,"
        " COUNT(*) FILTER (WHERE r.status = 'goal_reached') AS goal_reached,"
        " COUNT(*) FILTER (WHERE r.status = 'failed') AS failed" + join +
        " WHERE r.client_id = %s" + window +
        " GROUP BY r.workflow_id, w.name",
        (client_id, days),
    )
    top = [{"workflow_id": _int(r.get("workflow_id")), "name": _workflow_name(r),
            "runs": _int(r.get("runs")), "goal_reached": _int(r.get("goal_reached")),
            "failed": _int(r.get("failed"))} for r in portal_db.rows(cur)]
    out["top"] = sorted(top, key=lambda row: (-row["runs"], row["name"].lower()))[:TOP_WORKFLOWS]
    cur.execute(
        "SELECT r.id AS run_id, r.workflow_id, w.name, r.last_error,"
        " COALESCE(r.finished_at, r.updated_at) AS at" + join +
        " WHERE r.client_id = %s AND r.status = 'failed'" + window +
        " ORDER BY r.id DESC LIMIT " + str(RECENT_FAILURES),
        (client_id, days),
    )
    out["failures"] = [{"run_id": _int(r.get("run_id")), "workflow_id": _int(r.get("workflow_id")),
                        "name": _workflow_name(r),
                        "error": str(r.get("last_error") or "")[:MAX_ERROR_CHARS],
                        "at": _iso(r.get("at"))} for r in portal_db.rows(cur)]
    return out


def _keep_days() -> int:
    try:
        import portal_actions

        return int(portal_actions.RUNS_KEEP_DAYS)
    except Exception:
        return 30


EMPTY_ACTIONS: Dict[str, Any] = {
    "total": 0, "by_outcome": {key: 0 for key in ACTION_OUTCOMES},
    "by_actor": {key: 0 for key in ACTOR_KINDS}, "kept_days": 30,
}


def _actions(cur, client_id: int, days: int) -> Dict[str, Any]:
    out = dict(copy.deepcopy(EMPTY_ACTIONS), kept_days=_keep_days())
    cur.execute(
        "SELECT status, " + ACTOR_KIND_SQL + " AS actor_kind, COUNT(*) AS n"
        " FROM " + portal_db._q(ACTION_RUNS_TABLE) +
        " WHERE client_id = %s" + WINDOW.format(col="created_at") +
        " GROUP BY 1, 2",
        (client_id, days),
    )
    for row in portal_db.rows(cur):
        n = _int(row.get("n"))
        out["total"] += n
        status, actor = str(row.get("status") or ""), str(row.get("actor_kind") or "")
        if status in out["by_outcome"]:
            out["by_outcome"][status] += n
        if actor in out["by_actor"]:
            out["by_actor"][actor] += n
    return out


EMPTY_SEQUENCES: Dict[str, Any] = {
    "enrolled": 0, "active": 0, "completed": 0, "stopped": 0, "paused": 0,
    "sent": 0, "skipped": 0,
}
#: enrolment status -> counter (an unenrolled contact counts as stopped)
ENROLL_GROUPS = {"active": "active", "completed": "completed", "stopped": "stopped",
                 "cancelled": "stopped", "paused": "paused"}


def _sequences(cur, client_id: int, days: int) -> Dict[str, Any]:
    out = copy.deepcopy(EMPTY_SEQUENCES)
    cur.execute(
        "SELECT status, COUNT(*) AS n FROM " + portal_db._q(ENROLLMENTS_TABLE) +
        " WHERE client_id = %s" + WINDOW.format(col="enrolled_at") +
        " GROUP BY status",
        (client_id, days),
    )
    for row in portal_db.rows(cur):
        n = _int(row.get("n"))
        out["enrolled"] += n
        group = ENROLL_GROUPS.get(str(row.get("status") or ""))
        if group:
            out[group] += n
    cur.execute(
        "SELECT action, COUNT(*) AS n FROM " + portal_db._q(STEP_LOG_TABLE) +
        " WHERE client_id = %s AND action IN ('sent', 'skipped')" +
        WINDOW.format(col="created_at") + " GROUP BY action",
        (client_id, days),
    )
    for row in portal_db.rows(cur):
        out[str(row.get("action"))] = _int(row.get("n"))
    return out


# ---------------------------------------------------------------------------
# report + HTTP
# ---------------------------------------------------------------------------

def build(cur, client_id: int, days: int) -> Dict[str, Any]:
    usage = _block(cur, (USAGE_TABLE,), EMPTY_USAGE,
                   lambda: _usage(cur, client_id, days))
    by_agent = usage.pop("_by_agent", [])
    answers = _block(cur, (TRACES_TABLE,), EMPTY_ANSWERS,
                     lambda: _answers(cur, client_id, days, by_agent))
    return {
        "days": days,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "ai": {
            "answers": answers,
            "usage": usage,
            "confidence_bands": {"high_from": HIGH_CONFIDENCE, "low_below": _low_below()},
        },
        "automation": {
            "workflows": _block(cur, (RUNS_TABLE, WORKFLOWS_TABLE), EMPTY_WORKFLOWS,
                                lambda: _workflows(cur, client_id, days)),
            "actions": _block(cur, (ACTION_RUNS_TABLE,), EMPTY_ACTIONS,
                              lambda: _actions(cur, client_id, days)),
            "sequences": _block(cur, (ENROLLMENTS_TABLE, STEP_LOG_TABLE), EMPTY_SEQUENCES,
                                lambda: _sequences(cur, client_id, days)),
        },
    }


@bp.get("/analytics/ai-automation")
def ai_automation():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return jsonify({"error": {"code": "portal_unavailable", "message": str(error)}}), 503
    if principal is None:
        return jsonify({"error": {"code": "unauthorized", "message": "Sign in required."}}), 401
    forbidden = ensure_human_principal(principal)
    if forbidden:
        return forbidden
    days = parse_days(request.args.get("days"))
    if days is None:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "days must be a whole number from 1 to "
                                             + str(MAX_DAYS) + "."}}), 400
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                report = build(cur, int(principal["client_id"]), days)
            conn.rollback()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("ai/automation analytics failed: %s", error)
        return jsonify({"error": {"code": "portal_unavailable",
                                  "message": "Analytics are unavailable right now."}}), 503
    return jsonify(report), 200
