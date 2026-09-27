"""Action engine v1 (master-upgrade engine 7): one registry for every
tool the AI may use, with risk levels and an approval gate.

Why
---
portal_brain already had the first three tools (recent messages,
customer orders, KB search) with policy + provenance. This module turns
that idea into the platform-wide surface: a declared registry (name,
description, risk, required args, executor), one execute() entry point,
and the D3 approval loop for HIGH-risk actions.

Risk model (brief §23):
- LOW    reads: memory, catalog search, order status, opt-out check,
         message analysis
- MEDIUM writes that are easy to undo: customer memory note, queued
         WhatsApp message (non-marketing), checkout link (no discount)
- HIGH   money/commitments: discounted checkout, refund request,
         order-cancel request -> these create an APPROVAL (D3) and the
         real effect runs only after the owner answers 1/0.

Laws kept:
- reuses existing subsystems (no duplicates): portal_memory, portal_
  intents/portal_insights/portal_contacts via portal_intelligence, the
  connector command queue, portal_action_requests (the existing human
  action queue) and portal_approvals;
- tenant isolation everywhere (client_id from the principal);
- fail-soft resolution: an approval problem never blocks deciding;
- idempotency notes: memory additions are capped/trimmed by
  portal_memory; approval creation is deduped by portal_approvals.
"""

import json
import os
import secrets
from typing import Any, Dict, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_db
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
)

bp = Blueprint("portal_actions", __name__,
               url_prefix="/api/v1/portal/actions")

LINKS_TABLE = "portal_checkout_links"
RISK_LOW, RISK_MEDIUM, RISK_HIGH = "low", "medium", "high"
_HOLD_APPROVED = ("Aapki request approve ho gayi hai — hamari team"
                  " foran process kar rahi hai. Shukriya!")
_HOLD_REJECTED = ("Aapki request owner tak uthai gayi thi; is waqt"
                  " process nahi ho saki. Team aap se jaldi rabta"
                  " karegi.")


# ---------------------------------------------------------------------------
# executors (each: (cur, client_id, args) -> result dict | raises)
# ---------------------------------------------------------------------------

def _run_read_memory(cur, client_id, args):
    import portal_memory

    items = portal_memory.list_memory(
        cur, client_id, str(args.get("contact_id") or ""))
    return {"memory": items[:10]}


def _run_add_note(cur, client_id, args):
    import portal_memory

    memory_id = portal_memory.remember_fact(
        cur, client_id, str(args.get("contact_id") or ""),
        str(args.get("content") or "")[:400], source="ai")
    return {"memoryId": memory_id}


def _run_search_catalog(cur, client_id, args):
    query = "%" + str(args.get("query") or "").strip()[:60] + "%"
    cur.execute(
        "SELECT id, name, price, active FROM "
        + portal_db._q("portal_catalog") +
        " WHERE client_id = %s AND name ILIKE %s"
        " ORDER BY id DESC LIMIT 8",
        (client_id, query),
    )
    rows = portal_db.rows(cur)
    return {"items": [
        {"id": row.get("id"), "name": row.get("name"),
         "price": None if row.get("price") is None
         else float(row["price"]),
         "active": row.get("active")}
        for row in rows]}


def _run_order_status(cur, client_id, args):
    cur.execute(
        "SELECT token, title, status, total, created_at FROM "
        + portal_db._q(LINKS_TABLE) +
        " WHERE client_id = %s AND contact_id = %s"
        " ORDER BY id DESC LIMIT 3",
        (client_id, str(args.get("contact_id") or "")),
    )
    rows = portal_db.rows(cur)
    return {"orders": [
        {"token": row.get("token"), "title": row.get("title"),
         "status": row.get("status"),
         "total": None if row.get("total") is None
         else float(row["total"]),
         "createdAt": str(row.get("created_at") or "") or None}
        for row in rows]}


def _run_check_optout(cur, client_id, args):
    cur.execute(
        "SELECT 1 FROM " + portal_db._q("portal_optouts") +
        " WHERE client_id = %s AND contact_id = %s LIMIT 1",
        (client_id, str(args.get("contact_id") or "")),
    )
    return {"optedOut": bool(portal_db.rows(cur))}


def _run_analyze(cur, client_id, args):
    import portal_intelligence

    stored = None
    try:
        import portal_contacts

        stored = portal_contacts.stored_language(
            cur, client_id, str(args.get("contact_id") or ""))
    except Exception:
        stored = None
    return portal_intelligence.analyze(
        str(args.get("text") or ""), stored)


def _run_queue_message(cur, client_id, args):
    payload = {
        "external_user_id": str(args.get("contact_id") or ""),
        "body": str(args.get("body") or "")[:1000],
        "source": "agent",
    }
    cur.execute(
        "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
        " (client_id, channel, action, payload, status, requested_by,"
        " created_at, updated_at) "
        "SELECT %s, 'whatsapp', 'send_message', CAST(%s AS JSONB),"
        " 'pending', NULL, NOW(), NOW()"
        " WHERE NOT EXISTS (SELECT 1 FROM "
        + portal_db._q("portal_optouts") + " WHERE client_id = %s AND"
        " contact_id = %s)",
        (client_id, json.dumps(payload), client_id,
         str(args.get("contact_id") or "")),
    )
    return {"queued": True}


def _create_link_row(cur, client_id, args) -> Dict[str, Any]:
    """INSERT one checkout link (mirrors portal_checkout.create)."""
    items = [
        {"name": str(item.get("name") or "")[:80],
         "qty": max(1, min(99, int(item.get("qty") or 1))),
         "price": round(max(0.0, float(item.get("price") or 0)), 2)}
        for item in (args.get("items") or [])[:10]
        if isinstance(item, dict) and str(item.get("name") or "").strip()
    ]
    if not items:
        raise ValueError("items missing")
    subtotal = round(sum(item["qty"] * item["price"] for item in items), 2)
    discount = round(min(max(0.0, float(args.get("discount") or 0)), 100000), 2)
    total = max(round(subtotal - discount, 2), 0)
    token = secrets.token_urlsafe(16)
    cur.execute(
        "INSERT INTO " + portal_db._q(LINKS_TABLE) +
        " (client_id, contact_id, token, title, items, total, discount)"
        " VALUES (%s, %s, %s, %s, CAST(%s AS JSONB), %s, %s)"
        " RETURNING token, total",
        (client_id, str(args.get("contact_id") or ""), token,
         str(args.get("title") or "Order")[:80],
         json.dumps(items), total, discount),
    )
    return portal_db.rows(cur)[0]


def _run_create_checkout(cur, client_id, args):
    created = _create_link_row(cur, client_id, args)
    return {"token": created.get("token"),
            "total": None if created.get("total") is None
            else float(created["total"])}


def _run_action_request(cur, client_id, args, kind: str, label: str):
    """Queue the real-world action + return the linkage for approvals."""
    cur.execute(
        "SELECT contact_id FROM " + portal_db._q(portal_db.CONV_TABLE) +
        " WHERE id = %s AND client_id = %s",
        (args.get("conversation_id"), client_id),
    )
    rows = portal_db.rows(cur)
    contact_id = str((rows[0] if rows else {}).get("contact_id")
                     or args.get("contact_id") or "")
    cur.execute(
        "INSERT INTO " + portal_db._q("portal_action_requests") +
        " (client_id, conversation_id, contact_id, kind, note, status,"
        " created_at, updated_at)"
        " VALUES (%s, %s, %s, %s, %s, 'pending', NOW(), NOW())"
        " RETURNING id",
        (client_id, args.get("conversation_id"), contact_id, kind,
         str(args.get("note") or label)[:300]),
    )
    created = portal_db.rows(cur)
    return {"actionRequestId": (created[0] if created else {}).get("id"),
            "contactId": contact_id, "label": label}


def _actor_kind(args) -> str:
    """Audit actor for rows an action writes: workflow-originated writes
    are tagged 'workflow' so the workflow event poller never re-triggers
    on its own effects (loop guard)."""
    actor = str((args or {}).get("_actor") or "")
    return "workflow" if actor.startswith("workflow:") else "system"


def _run_add_tag(cur, client_id, args):
    tag = " ".join(str(args.get("tag") or "").split()).lower()[:32]
    if not tag:
        raise ValueError("missing_args:tag")
    cur.execute(
        "CREATE TABLE IF NOT EXISTS "
        + portal_db._q(portal_db.CONV_TAGS_TABLE) +
        " (id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL,"
        " conversation_id BIGINT NOT NULL, tag TEXT NOT NULL,"
        " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    )
    cur.execute(
        "INSERT INTO " + portal_db._q(portal_db.CONV_TAGS_TABLE) +
        " (client_id, conversation_id, tag)"
        " SELECT %s, %s, %s WHERE NOT EXISTS (SELECT 1 FROM "
        + portal_db._q(portal_db.CONV_TAGS_TABLE) +
        " WHERE client_id = %s AND conversation_id = %s"
        " AND LOWER(tag) = %s) RETURNING id",
        (client_id, args.get("conversation_id"), tag, client_id,
         args.get("conversation_id"), tag),
    )
    return {"tagged": bool(portal_db.rows(cur)), "tag": tag}


def _run_assign_conversation(cur, client_id, args):
    assignee = str(args.get("assignee") or "").strip()[:160]
    cur.execute(
        "SELECT 1 FROM " + portal_db._q(portal_db.TEAM_TABLE) +
        " WHERE client_id = %s AND email = %s"
        " AND (status = 'active' OR status IS NULL) LIMIT 1",
        (client_id, assignee),
    )
    if not portal_db.rows(cur):
        raise ValueError("assignee_not_found")
    cur.execute(
        "UPDATE " + portal_db._q(portal_db.CONV_TABLE) +
        " SET assigned_to = %s, updated_at = NOW()"
        " WHERE id = %s AND client_id = %s RETURNING id",
        (assignee, args.get("conversation_id"), client_id),
    )
    return {"assigned": bool(portal_db.rows(cur)), "assignee": assignee}


def _run_assign_agent(cur, client_id, args):
    import portal_agents

    try:
        agent_id = int(args.get("agent_id") or 0)
    except (TypeError, ValueError):
        agent_id = 0
    agent = portal_agents.load_agent(cur, client_id, agent_id)
    if agent is None:
        raise ValueError("agent_not_found")
    portal_agents.assign_agent(cur, client_id, args.get("conversation_id"),
                               agent_id)
    return {"assigned": True, "agent": agent.get("name")}


def _run_set_stage(cur, client_id, args):
    import portal_pipeline

    stage = str(args.get("stage") or "").strip().lower()
    if stage not in portal_pipeline.VALID_STAGE:
        raise ValueError("bad_stage")
    contact = str(args.get("contact_id") or "")[:100]
    if stage == "new":
        cur.execute(
            "DELETE FROM " + portal_db._q(portal_pipeline.STAGE_TABLE) +
            " WHERE client_id = %s AND contact_id = %s",
            (client_id, contact),
        )
    else:
        cur.execute(
            "INSERT INTO " + portal_db._q(portal_pipeline.STAGE_TABLE) +
            " (client_id, contact_id, stage) VALUES (%s, %s, %s)"
            " ON CONFLICT (client_id, contact_id)"
            " DO UPDATE SET stage = EXCLUDED.stage, updated_at = NOW()",
            (client_id, contact, stage),
        )
    # same note shape as the portal board move (workflow triggers parse it)
    portal_db.log_action(
        cur, client_id, "pipeline.stage_changed", _actor_kind(args), None,
        None, "Contact moved to '" + stage + "': " + contact + ".",
    )
    return {"stage": stage}


def _run_enroll_sequence(cur, client_id, args):
    import portal_sequences

    try:
        sequence_id = int(args.get("sequence_id") or 0)
    except (TypeError, ValueError):
        sequence_id = 0
    cur.execute(
        "SELECT id FROM " + portal_db._q(portal_sequences.SEQUENCES_TABLE) +
        " WHERE id = %s AND client_id = %s",
        (sequence_id, client_id),
    )
    if not portal_db.rows(cur):
        raise ValueError("sequence_not_found")
    cur.execute(
        "INSERT INTO " + portal_db._q(portal_sequences.ENROLLMENTS_TABLE) +
        " (client_id, sequence_id, conversation_id, contact_id,"
        " contact_name, current_step, next_at)"
        " SELECT %s, %s, c.id, c.contact_id, c.contact_name, 0,"
        " NOW() + make_interval(hours => COALESCE(MIN(st.delay_hours), 0))"
        " FROM " + portal_db._q(portal_db.CONV_TABLE) + " c"
        " LEFT JOIN " + portal_db._q(portal_sequences.STEPS_TABLE) +
        " st ON st.sequence_id = %s AND st.step_no = 1"
        " WHERE c.id = %s AND c.client_id = %s"
        " AND NOT EXISTS (SELECT 1 FROM "
        + portal_db._q(portal_sequences.ENROLLMENTS_TABLE) +
        " e WHERE e.sequence_id = %s AND e.conversation_id = c.id)"
        " GROUP BY c.id, c.contact_id, c.contact_name RETURNING id",
        (client_id, sequence_id, sequence_id, args.get("conversation_id"),
         client_id, sequence_id),
    )
    return {"enrolled": bool(portal_db.rows(cur)),
            "sequenceId": sequence_id}


# ---------------------------------------------------------------------------
# registry
# ---------------------------------------------------------------------------

ACTIONS: Dict[str, Dict[str, Any]] = {
    "read_customer_memory": {
        "description": "Read a customer's saved memory notes",
        "risk": RISK_LOW, "required": ["contact_id"],
        "run": _run_read_memory},
    "search_catalog": {
        "description": "Search the product catalog by name",
        "risk": RISK_LOW, "required": ["query"],
        "run": _run_search_catalog},
    "check_order_status": {
        "description": "Latest checkout orders for a customer",
        "risk": RISK_LOW, "required": ["contact_id"],
        "run": _run_order_status},
    "check_optout": {
        "description": "Whether a customer opted out of messages",
        "risk": RISK_LOW, "required": ["contact_id"],
        "run": _run_check_optout},
    "analyze_message": {
        "description": "Shared intelligence result for a message",
        "risk": RISK_LOW, "required": ["text"],
        "run": _run_analyze},
    "add_customer_note": {
        "description": "Save one AI memory note about a customer",
        "risk": RISK_MEDIUM, "required": ["contact_id", "content"],
        "run": _run_add_note},
    "queue_whatsapp_message": {
        "description": "Queue one service WhatsApp message (no marketing)",
        "risk": RISK_MEDIUM, "required": ["contact_id", "body"],
        "run": _run_queue_message},
    "create_checkout_link": {
        "description": "Create a checkout link (discount 0 = MEDIUM,"
                       " with discount = HIGH approval)",
        "risk": RISK_MEDIUM, "required": ["contact_id", "items"],
        "run": _run_create_checkout,
        "high_when": lambda args: float(args.get("discount") or 0) > 0},
    "request_order_cancel": {
        "description": "Customer wants an order cancelled — needs owner"
                       " approval",
        "risk": RISK_HIGH, "required": ["conversation_id"],
        "run": lambda cur, client_id, args: _run_action_request(
            cur, client_id, args, "cancel_order", "Order cancellation")},
    "request_refund": {
        "description": "Customer wants a refund — needs owner approval",
        "risk": RISK_HIGH, "required": ["conversation_id"],
        "run": lambda cur, client_id, args: _run_action_request(
            cur, client_id, args, "refund_request", "Refund request")},
    # workflow-engine additions (shared registry: the brain and future
    # engines get them too - no per-engine action dialects)
    "add_conversation_tag": {
        "description": "Add a tag to the conversation",
        "risk": RISK_MEDIUM, "required": ["conversation_id", "tag"],
        "run": _run_add_tag},
    "assign_conversation": {
        "description": "Assign the conversation to a teammate (email)",
        "risk": RISK_MEDIUM, "required": ["conversation_id", "assignee"],
        "run": _run_assign_conversation},
    "assign_agent": {
        "description": "Hand the conversation to an AI agent persona",
        "risk": RISK_MEDIUM, "required": ["conversation_id", "agent_id"],
        "run": _run_assign_agent},
    "set_pipeline_stage": {
        "description": "Move the contact to a pipeline stage",
        "risk": RISK_MEDIUM, "required": ["contact_id", "stage"],
        "run": _run_set_stage},
    "enroll_in_sequence": {
        "description": "Enroll the conversation in a message series",
        "risk": RISK_MEDIUM, "required": ["conversation_id", "sequence_id"],
        "run": _run_enroll_sequence},
}


def catalog() -> list:
    return [{"action": name, "description": spec["description"],
             "risk": spec["risk"], "required": spec["required"]}
            for name, spec in sorted(ACTIONS.items())]


def _effective_risk(name: str, args: Dict[str, Any]) -> str:
    spec = ACTIONS[name]
    if spec.get("high_when") and spec["high_when"](args):
        return RISK_HIGH
    return spec["risk"]


def _summary_for(name: str, args: Dict[str, Any]) -> str:
    labels = {
        "create_checkout_link": "Discounted checkout link",
        "request_refund": "Refund request",
        "request_order_cancel": "Order cancellation",
    }
    return labels.get(name, ACTIONS[name]["description"])


# ---------------------------------------------------------------------------
# execute + approval resolution
# ---------------------------------------------------------------------------

def execute(cur, client_id: int, actor: str, action: str,
            args: Dict[str, Any], conversation_id=None) -> Dict[str, Any]:
    """One entry point. HIGH risk -> approval (no execution yet).

    Returns {status: executed|approval_required|error, ...}.
    Raises ValueError on unknown action / missing args.
    """
    spec = ACTIONS.get(action)
    if spec is None:
        raise ValueError("unknown_action")
    args = dict(args or {})
    args.setdefault("_actor", str(actor or ""))
    missing = [key for key in spec["required"] if not args.get(key)]
    if missing:
        raise ValueError("missing_args:" + ",".join(missing))

    risk = _effective_risk(action, args)
    contact_id = str(args.get("contact_id") or "")
    if risk == RISK_HIGH:
        import portal_approvals

        made = portal_approvals.create_approval(
            cur, client_id,
            args.get("conversation_id"), contact_id or "unknown",
            None, action, _summary_for(action, args)
            + " — owner ki tasdeeq chahiye",
            str(args.get("customer_query") or ""), {
                "action": action, "args": args,
                "actor": actor, "conversation_id": conversation_id,
            }, source="agent")
        if made is None:
            return {"status": "error", "error": "approval_not_created"}
        return {"status": "approval_required", "risk": risk,
                "approvalId": made.get("id"),
                "refCode": made.get("ref_code")}

    result = spec["run"](cur, client_id, args)
    try:
        portal_db.log_action(
            cur, client_id, "action." + action, actor_kind="system",
            note=json.dumps({"actor": actor, "risk": risk,
                             "result": result}, default=str)[:900],
        )
    except Exception:
        pass
    return {"status": "executed", "risk": risk, "result": result}


def resolve_approval(cur, client_id: int, approval: Dict[str, Any],
                     approved: bool) -> None:
    """Called by portal_approvals.decide for agent approvals (fail-soft).

    approved: run the stored action for real (refund/cancel rows land
    as done); rejected: only the customer hold message goes out.
    """
    try:
        context = approval.get("context_json") or {}
        if isinstance(context, str):
            context = json.loads(context or "{}")
        action = str(context.get("action") or "")
        args = dict(context.get("args") or {})
        spec = ACTIONS.get(action)
        if spec is None:
            return
        contact_id = str(args.get("contact_id") or "")
        if approved:
            result = spec["run"](cur, client_id, args)
            if action in ("request_refund", "request_order_cancel") \
                    and isinstance(result, dict) and result.get(
                        "actionRequestId"):
                cur.execute(
                    "UPDATE " + portal_db._q("portal_action_requests") +
                    " SET status = 'done', updated_at = NOW()"
                    " WHERE id = %s AND client_id = %s",
                    (result["actionRequestId"], client_id),
                )
            try:
                portal_db.log_action(
                    cur, client_id, "action." + action + ".approved",
                    actor_kind="system",
                    note=json.dumps({"result": result},
                                    default=str)[:900],
                )
            except Exception:
                pass
        if not approved and action in ("request_refund",
                                       "request_order_cancel"):
            target = contact_id
            if target:
                cur.execute(
                    "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
                    " (client_id, channel, action, payload, status,"
                    " requested_by, created_at, updated_at)"
                    " VALUES (%s, 'whatsapp', 'send_message',"
                    " CAST(%s AS JSONB), 'pending', NULL, NOW(), NOW())",
                    (client_id, json.dumps({
                        "external_user_id": target,
                        "body": _HOLD_REJECTED,
                        "source": "approval",
                    })),
                )
    except Exception:
        pass


# ---------------------------------------------------------------------------
# portal API
# ---------------------------------------------------------------------------

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


@bp.get("")
def list_actions():
    principal, error = _principal_or_error()
    if error:
        return error
    return jsonify({"actions": catalog()}), 200


@bp.post("/execute")
def execute_action():
    principal, error = _principal_or_error()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    action = str(payload.get("action") or "").strip()
    args = payload.get("args")
    if not isinstance(args, dict):
        args = {}
    conversation_id = payload.get("conversation_id")
    actor = str(principal.get("email") or principal.get("user_id"))
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                outcome = execute(cur, principal["client_id"], actor,
                                  action, args, conversation_id)
            conn.commit()
        finally:
            conn.close()
    except ValueError as exc:
        message = "args adhoore hain." if str(exc).startswith(
            "missing_args") else "Unknown action."
        return jsonify({"error": {"code": str(exc).split(":")[0],
                                  "message": message}}), 400
    except Exception as exc:
        return jsonify(portal_db.portal_unavailable(
            exc, "action execute")[0]), 503
    return jsonify(outcome), 200
