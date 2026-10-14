"""Policy / Rule engine hub (master-upgrade engine 8): one read-only
summary of every executable rule the workspace owns + a shared
evaluator for the common rule shapes.

Unify, do not duplicate: routing (portal_routing), listening
(portal_listen), negotiation bounds (portal_negotiation), business
hours + handoff (portal_bot config), the AI autonomy switch
(portal_brain settings) and the high-risk approval gate
(portal_approvals) each keep their own storage and their own ingest
hooks. This module adds the missing layer BETWEEN them:

* ``rules_summary(cur, client_id)`` - a normalised snapshot for the
  portal Rules page (count + deep link per rule family);
* ``evaluate(cur, client_id, rule_set, ctx)`` - the shared
  condition evaluator (all/any groups, keyword/starts/intent/sentiment/
  in-hours comparisons) so the next engine (Workflow) and future rule
  editors can share one implementation instead of growing per-module
  dialects;
* ``rule_fired(cur, client_id, rule_set, rule_id, label, ctx)`` - the
  unified audit line (portal_action_log) for every consumer.

Laws kept: stdlib-only, tenant-scoped, fail-soft, nothing here is
on the message hot path unless a consumer calls it.
"""

import json
import os
from typing import Any, Dict, List, Optional

import portal_db

SUMMARY_LIMIT = int(os.environ.get("OF_POLICY_SUMMARY_LIMIT", "12") or 12)

# ---------------------------------------------------------------------------
# shared evaluator (the shape future rule editors will emit)
# ---------------------------------------------------------------------------

def _keyword_hit(text: str, op: str, value) -> bool:
    haystack = " " + " ".join(str(text or "").lower().split()) + " "
    needle = str(value or "").lower().strip()
    if op == "starts_with":
        return haystack.strip().startswith(needle)
    if op == "not_contains":
        return bool(needle) and (" " + needle + " ") not in haystack
    # contains = WHOLE WORD (the kabhi/abhi law: substring matching
    # fired rules on words that merely contained the needle)
    return (" " + needle + " ") in haystack


def _value_from(ctx: Dict[str, Any], field: str):
    if field in ctx:
        return ctx.get(field)
    nested = ctx.get("intelligence")
    if isinstance(nested, dict) and field in nested:
        return nested.get(field)
    return None


def _as_text(value: Any) -> str:
    """Comparable text of a context value. Booleans read "true"/"false"
    (§236: False used to become "", so `in_hours is "false"` - outside
    business hours - never matched)."""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value or "").lower()


def match_condition(condition: Dict[str, Any],
                    ctx: Dict[str, Any]) -> bool:
    """One condition: {field, op, value}. Unknown ops never match
    (safe default - a broken rule must not widen what fires)."""
    field = str(condition.get("field") or "")
    op = str(condition.get("op") or "contains")
    value = condition.get("value")
    if field == "keyword":
        return _keyword_hit(str(ctx.get("text") or ""), op, value)
    if op in ("equals", "is"):
        return _as_text(_value_from(ctx, field)) == str(value or "").lower()
    if op == "in_hours":
        return bool(_value_from(ctx, field))
    # contains over any context value (stringified)
    actual = str(_value_from(ctx, field) or "").lower()
    return str(value or "").lower() in actual


def evaluate(rules: Dict[str, Any], ctx: Dict[str, Any]) -> bool:
    """{all: [conditions...], any: [conditions...]} -> bool.

    An empty rule set never matches (explicit is safer than implicit).
    """
    if not isinstance(rules, dict) or not rules:
        return False
    all_group = rules.get("all") or []
    any_group = rules.get("any") or []
    if not isinstance(all_group, list) or not isinstance(any_group, list):
        return False
    for condition in all_group:
        if not isinstance(condition, dict):
            return False
        if not match_condition(condition, ctx):
            return False
    if any_group:
        matched = any(
            isinstance(condition, dict)
            and match_condition(condition, ctx)
            for condition in any_group
        )
        if not matched:
            return False
    return bool(all_group or any_group)


# ---------------------------------------------------------------------------
# unified audit line
# ---------------------------------------------------------------------------

def rule_fired(cur, client_id: int, rule_set: str, rule_id, label: str,
               ctx: Optional[Dict[str, Any]] = None) -> None:
    """One portal_action_log row per consumer rule fire (never raises)."""
    try:
        portal_db.log_action(
            cur, client_id, "policy." + str(rule_set) + ".fired",
            actor_kind="system",
            note=json.dumps({
                "rule_id": rule_id, "label": str(label or "")[:160],
                "conversation_id": (ctx or {}).get("conversation_id"),
            }, default=str)[:900],
        )
    except Exception:
        pass


# ---------------------------------------------------------------------------
# rules summary (the portal Rules page reads this)
# ---------------------------------------------------------------------------

def _count_rows(cur, client_id: int, table: str) -> int:
    cur.execute(
        "SELECT COUNT(*) AS n FROM " + portal_db._q(table) +
        " WHERE client_id = %s",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    return int((rows[0] if rows else {}).get("n") or 0)


def rules_summary(cur, client_id: int) -> List[Dict[str, Any]]:
    """Normalised snapshot of every rule family (fail-soft per family:
    a missing/broken table shows 0 rules, never an error page)."""
    import portal_txn

    # §236: each family reads in its own savepoint - a missing table used
    # to abort the caller's transaction (the AI report and the Rules page)
    families: List[Dict[str, Any]] = []

    def add(rule_set, label, href, count, extra=""):
        families.append({
            "ruleSet": rule_set, "label": label, "href": href,
            "count": count, "summary": extra,
        })

    # routing: keyword -> team member assignment
    try:
        with portal_txn.savepoint(cur, None, "of_rules"):
            count = _count_rows(cur, client_id, "portal_routing_rules")
            add("routing", "Routing rules", "/dashboard/team", count,
                "Keyword par conversation team member ko assign hoti hai")
    except Exception:
        add("routing", "Routing rules", "/dashboard/team", 0)

    # listening: keyword -> alert/hit
    try:
        with portal_txn.savepoint(cur, None, "of_rules"):
            count = _count_rows(cur, client_id, "portal_listen_rules")
            add("listen", "Listening rules", "/dashboard/automations", count,
                "Keyword milne par alert/hit record hota hai")
    except Exception:
        add("listen", "Listening rules", "/dashboard/automations", 0)

    # negotiation bounds: the discount policy
    try:
        with portal_txn.savepoint(cur, None, "of_rules"):
            cur.execute(
                "SELECT enabled, floor_percent, max_percent FROM "
                + portal_db._q("portal_negotiation_settings") +
                " WHERE client_id = %s",
                (client_id,),
            )
            rows = portal_db.rows(cur)
            row = rows[0] if rows else {}
            enabled = bool(row.get("enabled"))
            add("negotiation", "Negotiation bounds", "/dashboard/settings",
                1 if enabled else 0,
                ("AI discount: " + str(row.get("floor_percent") or 0) + "%"
                 " - " + str(row.get("max_percent") or 0) + "% ke andar")
                if enabled else "Band hai — Settings me enable karein")
    except Exception:
        add("negotiation", "Negotiation bounds", "/dashboard/settings", 0)

    # business hours + handoff + autonomy (three config-backed policies)
    try:
        with portal_txn.savepoint(cur, None, "of_rules"):
            cur.execute(
                "SELECT working_hours_enabled, human_handoff_enabled,"
                " working_hours_start, working_hours_end FROM "
                + portal_db._q(portal_db.BOT_TABLE) + " WHERE client_id = %s",
                (client_id,),
            )
            row = (portal_db.rows(cur) or [{}])[0]
            hours_on = bool(row.get("working_hours_enabled"))
            add("hours", "Business hours", "/dashboard/automations",
                1 if hours_on else 0,
                ("Off-hours auto-reply chalu (" + str(row.get(
                    "working_hours_start") or "") + " - " + str(row.get(
                        "working_hours_end") or "") + ")")
                if hours_on else "24/7 mode — off-hours reply band")
            add("handoff", "Human handoff", "/dashboard/automations",
                1 if bool(row.get("human_handoff_enabled")) else 0,
                " Zaroorat par team ko saup do" if bool(
                    row.get("human_handoff_enabled")) else "Band hai")
    except Exception:
        add("hours", "Business hours", "/dashboard/automations", 0)
        add("handoff", "Human handoff", "/dashboard/automations", 0)
    try:
        with portal_txn.savepoint(cur, None, "of_rules"):
            cur.execute(
                "SELECT autonomy FROM " + portal_db._q("portal_brain_settings")
                + " WHERE client_id = %s",
                (client_id,),
            )
            rows = portal_db.rows(cur)
            autonomy = str((rows[0] if rows else {}).get("autonomy")
                           or "suggest")
            add("autonomy", "AI autonomy", "/dashboard/ai-brain",
                1 if autonomy == "auto" else 0,
                ("Auto-reply chalu — AI khud bhejta hai"
                 if autonomy == "auto"
                 else "Assist-first — AI sirf draft karta hai"))
    except Exception:
        add("autonomy", "AI autonomy", "/dashboard/ai-brain", 0)

    # workflows: trigger -> steps automations (engine 9)
    try:
        with portal_txn.savepoint(cur, None, "of_rules"):
            cur.execute(
                "SELECT COUNT(*) AS n FROM " + portal_db._q("portal_workflows")
                + " WHERE client_id = %s AND status = 'active'",
                (client_id,),
            )
            rows = portal_db.rows(cur)
            active = int((rows[0] if rows else {}).get("n") or 0)
            add("workflows", "Workflows", "/dashboard/workflows", active,
                (str(active) + " active — trigger, conditions, AI decisions,"
                 " actions and waits") if active
                else "No active workflows yet")
    except Exception:
        add("workflows", "Workflows", "/dashboard/workflows", 0)

    # approvals: the high-risk gate
    try:
        with portal_txn.savepoint(cur, None, "of_rules"):
            cur.execute(
                "SELECT COUNT(*) AS n FROM " + portal_db._q(
                    "portal_approvals") +
                " WHERE client_id = %s AND status = 'pending'",
                (client_id,),
            )
            rows = portal_db.rows(cur)
            pending = int((rows[0] if rows else {}).get("n") or 0)
            add("approvals", "Approval gate", "/dashboard/approvals", 1,
                (str(pending) + " pending — WhatsApp par 1/0 se decide karein")
                if pending else "High-risk actions aapki tasdeeq ke baghair"
                " nahi chalte")
    except Exception:
        add("approvals", "Approval gate", "/dashboard/approvals", 0)

    return families

# ---------------------------------------------------------------------------
# portal API
# ---------------------------------------------------------------------------

from flask import Blueprint, jsonify, request  # noqa: E402
from portal_auth import (  # noqa: E402
    PortalAuthUnavailable,
    authenticate_portal_request,
)

bp = Blueprint("portal_policy", __name__, url_prefix="/api/v1/portal/policy")


def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable:
        return None, (jsonify({"error": {
            "code": "portal_unavailable",
            "message": "Auth is unavailable, try again."}}), 503)
    if not principal:
        return None, (jsonify({"error": {
            "code": "unauthorized",
            "message": "Sign in zaroori hai."}}), 401)
    return principal, None


@bp.get("/rules")
def get_rules_summary():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                families = rules_summary(cur, principal["client_id"])
        finally:
            conn.close()
    except Exception as exc:
        return jsonify(portal_db.portal_unavailable(
            exc, "policy rules read")[0]), 503
    return jsonify({"families": families[:SUMMARY_LIMIT]}), 200


@bp.post("/evaluate")
def evaluate_rules():
    """Dry-run the shared evaluator (the Rules page's tester). Never
    performs side effects."""
    principal, error = _principal_or_error()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    rules = payload.get("rules")
    if not isinstance(rules, dict):
        return jsonify({"error": {
            "code": "bad_request",
            "message": "rules object zaroori hai."}}), 400
    ctx = payload.get("context")
    if not isinstance(ctx, dict):
        ctx = {}
    return jsonify({"matched": evaluate(rules, ctx)}), 200
