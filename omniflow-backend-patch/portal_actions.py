"""Action engine v2 (master-upgrade engine 7): one registry for every
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

v2 (§225)
---------
- every action declares typed ``args`` (validated + normalised before
  anything runs; catalog() publishes them for builders);
- preview()/``dry_run``: the verdict (risk, permission, approval) with
  zero writes;
- execution ledger ``portal_action_runs`` written in the SAME transaction
  as the effect, with optional idempotency keys (exactly-once per
  workspace: workflows key every step, the API takes ``Idempotency-Key``,
  approvals key ``approval:<id>``);
- executors run atomically in a savepoint with a statement-timeout and a
  transient-retry budget; failures come back as ``status: error``.
"""

import json
import logging
import os
import re
import secrets
import time
from typing import Any, Dict, List, Optional, Tuple

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

logger = logging.getLogger(__name__)


def _env_int(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)) or default)
    except ValueError:
        value = default
    return max(low, min(high, value))


# §225 v2 ledger / budget knobs (env-tunable, no hardcoded policy)
RUNS_TABLE = "portal_action_runs"
TIMEOUT_MS = _env_int("OF_ACTION_TIMEOUT_MS", 8000, 0, 120000)
RETRIES = _env_int("OF_ACTION_RETRIES", 1, 0, 3)
RUNS_KEEP_DAYS = _env_int("OF_ACTION_RUNS_KEEP_DAYS", 30, 1, 365)
STALE_RUNNING_MINUTES = 10
REPLAYABLE = ("executed", "approval_required", "denied")
RUN_STATUSES = ("running", "executed", "approval_required", "denied",
                "error")
#: serialization failure, deadlock, lock timeout -> safe to retry
_TRANSIENT_CODES = ("40001", "40P01", "55P03")
_KEY_RE = re.compile(r"^[A-Za-z0-9:_.\-]{1,160}$")
_RUNS_DDL_READY = False
_RUNS_DDL = """
CREATE TABLE IF NOT EXISTS portal_action_runs (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  risk TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  idempotency_key TEXT,
  conversation_id BIGINT,
  args JSONB NOT NULL DEFAULT '{}'::jsonb,
  outcome JSONB,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  approval_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_action_runs_key
  ON portal_action_runs (client_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_portal_action_runs_client
  ON portal_action_runs (client_id, id DESC);
"""
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
    import portal_channels

    contact_id = str(args.get("contact_id") or "")
    channel = portal_channels.channel_for_contact(contact_id)
    cur.execute(
        "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
        " (client_id, channel, action, payload, status, requested_by,"
        " created_at, updated_at) "
        "SELECT %s, %s, 'send_message', CAST(%s AS JSONB),"
        " 'pending', NULL, NOW(), NOW()"
        " WHERE NOT EXISTS (SELECT 1 FROM "
        + portal_db._q("portal_optouts") + " WHERE client_id = %s AND"
        " contact_id = %s)",
        (client_id, channel, json.dumps(payload), client_id, contact_id),
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

_CONTACT = {"type": "str", "max": 120, "strict": True}
_CONV = {"type": "int"}
_QUERY = {"customer_query": {"type": "str", "max": 300}}


def _schema(**fields) -> Dict[str, Dict[str, Any]]:
    """Declared args of one action (+ the shared optional customer_query
    that approvals show the owner)."""
    merged = dict(_QUERY)
    merged.update(fields)
    return merged


ACTIONS: Dict[str, Dict[str, Any]] = {
    "read_customer_memory": {
        "description": "Read a customer's saved memory notes",
        "risk": RISK_LOW, "required": ["contact_id"],
        "args": _schema(contact_id=_CONTACT),
        "run": _run_read_memory},
    "search_catalog": {
        "description": "Search the product catalog by name",
        "risk": RISK_LOW, "required": ["query"],
        "args": _schema(query={"type": "str", "max": 60}),
        "run": _run_search_catalog},
    "check_order_status": {
        "description": "Latest checkout orders for a customer",
        "risk": RISK_LOW, "required": ["contact_id"],
        "args": _schema(contact_id=_CONTACT),
        "run": _run_order_status},
    "check_optout": {
        "description": "Whether a customer opted out of messages",
        "risk": RISK_LOW, "required": ["contact_id"],
        "args": _schema(contact_id=_CONTACT),
        "run": _run_check_optout},
    "analyze_message": {
        "description": "Shared intelligence result for a message",
        "risk": RISK_LOW, "required": ["text"],
        "args": _schema(text={"type": "str", "max": 2000},
                        contact_id=_CONTACT),
        "run": _run_analyze},
    "add_customer_note": {
        "description": "Save one AI memory note about a customer",
        "risk": RISK_MEDIUM, "required": ["contact_id", "content"],
        "args": _schema(contact_id=_CONTACT,
                        content={"type": "str", "max": 400}),
        "run": _run_add_note},
    "queue_whatsapp_message": {
        "description": "Queue one service WhatsApp message (no marketing)",
        "risk": RISK_MEDIUM, "required": ["contact_id", "body"],
        "args": _schema(contact_id=_CONTACT,
                        body={"type": "str", "max": 1000}),
        "run": _run_queue_message},
    "create_checkout_link": {
        "description": "Create a checkout link (discount 0 = MEDIUM,"
                       " with discount = HIGH approval)",
        "risk": RISK_MEDIUM, "required": ["contact_id", "items"],
        "args": _schema(contact_id=_CONTACT,
                        items={"type": "list", "max": 10,
                               "items": "object"},
                        discount={"type": "number", "min": 0,
                                  "max": 100000},
                        title={"type": "str", "max": 80}),
        "run": _run_create_checkout,
        "high_when": lambda args: float(args.get("discount") or 0) > 0},
    "request_order_cancel": {
        "description": "Customer wants an order cancelled — needs owner"
                       " approval",
        "risk": RISK_HIGH, "required": ["conversation_id"],
        "args": _schema(conversation_id=_CONV, contact_id=_CONTACT,
                        note={"type": "str", "max": 300}),
        "run": lambda cur, client_id, args: _run_action_request(
            cur, client_id, args, "cancel_order", "Order cancellation")},
    "request_refund": {
        "description": "Customer wants a refund — needs owner approval",
        "risk": RISK_HIGH, "required": ["conversation_id"],
        "args": _schema(conversation_id=_CONV, contact_id=_CONTACT,
                        note={"type": "str", "max": 300}),
        "run": lambda cur, client_id, args: _run_action_request(
            cur, client_id, args, "refund_request", "Refund request")},
    # workflow-engine additions (shared registry: the brain and future
    # engines get them too - no per-engine action dialects)
    "add_conversation_tag": {
        "description": "Add a tag to the conversation",
        "risk": RISK_MEDIUM, "required": ["conversation_id", "tag"],
        "args": _schema(conversation_id=_CONV,
                        tag={"type": "str", "max": 64}),
        "run": _run_add_tag},
    "assign_conversation": {
        "description": "Assign the conversation to a teammate (email)",
        "risk": RISK_MEDIUM, "required": ["conversation_id", "assignee"],
        "args": _schema(conversation_id=_CONV,
                        assignee={"type": "str", "max": 160}),
        "run": _run_assign_conversation},
    "assign_agent": {
        "description": "Hand the conversation to an AI agent persona",
        "risk": RISK_MEDIUM, "required": ["conversation_id", "agent_id"],
        "args": _schema(conversation_id=_CONV, agent_id={"type": "int"}),
        "run": _run_assign_agent},
    "set_pipeline_stage": {
        "description": "Move the contact to a pipeline stage",
        "risk": RISK_MEDIUM, "required": ["contact_id", "stage"],
        "args": _schema(contact_id=_CONTACT,
                        stage={"type": "str", "max": 40}),
        "run": _run_set_stage},
    "enroll_in_sequence": {
        "description": "Enroll the conversation in a message series",
        "risk": RISK_MEDIUM, "required": ["conversation_id", "sequence_id"],
        "args": _schema(conversation_id=_CONV, sequence_id={"type": "int"}),
        "run": _run_enroll_sequence},
}


def catalog() -> list:
    return [{"action": name, "description": spec["description"],
             "risk": spec["risk"], "required": spec["required"],
             "args": [{"name": key, "type": rule["type"],
                       "required": key in spec["required"],
                       "max": rule.get("max")}
                      for key, rule in sorted(spec["args"].items())]}
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
# v2: argument schemas (§225)
# ---------------------------------------------------------------------------

def _coerce(rule: Dict[str, Any], value: Any) -> Tuple[Any, bool]:
    """(normalised value, ok). Strings are capped at ``max`` (``strict``
    identifiers are rejected instead); numbers accept numeric strings."""
    kind = rule["type"]
    if isinstance(value, bool):
        return value, False
    if kind == "str":
        if isinstance(value, (int, float)):
            value = str(value)
        if not isinstance(value, str):
            return value, False
        limit = int(rule.get("max") or 0)
        if limit and len(value) > limit:
            if rule.get("strict"):
                return value, False
            value = value[:limit]
        return value, True
    if kind == "int":
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        if isinstance(value, str) and value.strip().isdigit():
            value = int(value.strip())
        return value, isinstance(value, int) and value > 0
    if kind == "number":
        if isinstance(value, str):
            try:
                value = float(value.strip())
            except ValueError:
                return value, False
        if not isinstance(value, (int, float)) or value != value:
            return value, False
        low, high = rule.get("min"), rule.get("max")
        ok = (low is None or value >= low) and (high is None or value <= high)
        return value, ok
    if kind == "list":
        if not isinstance(value, list):
            return value, False
        if rule.get("items") == "object" and not all(
                isinstance(item, dict) for item in value):
            return value, False
        return value[:int(rule.get("max") or len(value) or 1)], True
    return value, False


def validate_args(action: str, args: Dict[str, Any]
                  ) -> Tuple[Dict[str, Any], List[str]]:
    """Normalise the declared args of ``action``; undeclared keys pass
    through untouched (engine-internal ``_actor`` etc.). Returns
    (args, invalid field names)."""
    spec = ACTIONS[action]
    clean = dict(args or {})
    errors: List[str] = []
    for key, rule in spec["args"].items():
        if clean.get(key) is None:
            continue
        value, ok = _coerce(rule, clean[key])
        if ok:
            clean[key] = value
        else:
            errors.append(key)
    return clean, sorted(errors)


def _prepare(action: str, args: Optional[Dict[str, Any]], actor: str
             ) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Shared front half of execute()/preview(). Raises ValueError."""
    spec = ACTIONS.get(action)
    if spec is None:
        raise ValueError("unknown_action")
    args = dict(args or {})
    args.setdefault("_actor", str(actor or ""))
    missing = [key for key in spec["required"] if not args.get(key)]
    if missing:
        raise ValueError("missing_args:" + ",".join(missing))
    args, invalid = validate_args(action, args)
    if invalid:
        raise ValueError("invalid_args:" + ",".join(invalid))
    return spec, args


def preview(cur, client_id: int, actor: str, action: str,
            args: Dict[str, Any], agent: Optional[Dict[str, Any]] = None
            ) -> Dict[str, Any]:
    """Dry run: what WOULD happen - validation, effective risk, the
    agent permission verdict and the approval gate. Writes nothing.
    Raises ValueError like execute()."""
    spec, args = _prepare(action, args, actor)
    risk = _effective_risk(action, args)
    permitted, reason = True, ""
    if agent:
        import portal_agents

        permitted, reason = portal_agents.permits(agent, action, risk)
    outcome = ("denied" if not permitted else
               "approval_required" if risk == RISK_HIGH else "executed")
    return {"status": "preview", "action": action, "risk": risk,
            "wouldBe": outcome, "permitted": bool(permitted),
            "reason": reason or "", "summary": _summary_for(action, args),
            "description": spec["description"],
            "args": _public_args(args)}


# ---------------------------------------------------------------------------
# v2: execution ledger + idempotency (§225)
# ---------------------------------------------------------------------------

def _public_args(args: Dict[str, Any]) -> Dict[str, Any]:
    """Args as stored/shown: engine-internal keys dropped, values capped."""
    out: Dict[str, Any] = {}
    for key, value in (args or {}).items():
        if str(key).startswith("_"):
            continue
        if isinstance(value, str):
            value = value[:200]
        elif isinstance(value, list):
            value = value[:10]
        out[str(key)] = value
    return out


def _json_capped(value: Any, limit: int = 4000) -> str:
    text = json.dumps(value, default=str)
    if len(text) > limit:
        text = json.dumps({"truncated": True,
                           "preview": text[:limit // 2]})
    return text


def _clean_key(raw: Any) -> Optional[str]:
    key = str(raw or "").strip()
    if not key:
        return None
    return key[:160] if _KEY_RE.match(key[:160]) else None


def _ensure_runs_ddl(cur) -> None:
    """Create the ledger once. The cheap existence probe comes first: a
    CREATE INDEX IF NOT EXISTS would hold a table lock until the caller's
    (possibly long) transaction commits on every cold start."""
    global _RUNS_DDL_READY
    if _RUNS_DDL_READY:
        return
    cur.execute("SELECT to_regclass(%s) IS NOT NULL AS ready", (RUNS_TABLE,))
    rows = portal_db.rows(cur)
    if not (rows and rows[0].get("ready")):
        cur.execute(_RUNS_DDL)
    _RUNS_DDL_READY = True


def _guarded(cur, name: str, work):
    """Run ``work()`` inside SAVEPOINT ``name``: a ledger failure rolls back
    only its own statements, never the caller's transaction. Returns the
    work result or None on failure (logged)."""
    try:
        cur.execute("SAVEPOINT " + name)
    except Exception as error:
        logger.warning("action ledger unavailable: %s", error)
        return None
    try:
        result = work()
        cur.execute("RELEASE SAVEPOINT " + name)
        return result
    except Exception as error:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT " + name)
        except Exception:
            pass
        logger.warning("action ledger write failed: %s", error)
        return None


def _ledger_claim(cur, client_id: int, action: str, actor: str, risk: str,
                  key: Optional[str], conversation_id: Any,
                  args: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Open one ledger row. With an idempotency key an earlier FINISHED
    outcome is returned as ``{"replay": outcome}`` instead (the action is
    not run twice); an earlier failure is re-opened for this attempt.
    Returns {"id"} | {"replay"} | None (ledger unavailable: fail-soft)."""
    try:
        conv = int(conversation_id) if conversation_id else None
    except (TypeError, ValueError):
        conv = None

    def work():
        _ensure_runs_ddl(cur)
        params = (client_id, action, str(actor or "")[:160], risk, key,
                  conv, _json_capped(_public_args(args), 2000))
        if key is None:
            cur.execute(
                "INSERT INTO " + portal_db._q(RUNS_TABLE) +
                " (client_id, action, actor, risk, idempotency_key,"
                " conversation_id, args) VALUES"
                " (%s, %s, %s, %s, %s, %s, CAST(%s AS JSONB)) RETURNING id",
                params)
            return _after_insert(cur, client_id, portal_db.rows(cur))
        cur.execute(
            "INSERT INTO " + portal_db._q(RUNS_TABLE) +
            " (client_id, action, actor, risk, idempotency_key,"
            " conversation_id, args) VALUES"
            " (%s, %s, %s, %s, %s, %s, CAST(%s AS JSONB))"
            " ON CONFLICT (client_id, idempotency_key)"
            " WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id",
            params)
        made = portal_db.rows(cur)
        if made:
            return _after_insert(cur, client_id, made)
        cur.execute(
            "SELECT id, action, status, outcome,"
            " created_at < NOW() - make_interval(mins => %s) AS stale"
            " FROM " + portal_db._q(RUNS_TABLE) +
            " WHERE client_id = %s AND idempotency_key = %s",
            (STALE_RUNNING_MINUTES, client_id, key))
        rows = portal_db.rows(cur)
        prior = rows[0] if rows else {}
        status = str(prior.get("status") or "")
        if str(prior.get("action") or "") != action:
            return {"replay": {"status": "error", "risk": risk,
                               "error": "idempotency_key_reused"}}
        if status in REPLAYABLE:
            outcome = prior.get("outcome")
            if isinstance(outcome, str):
                outcome = json.loads(outcome or "{}")
            outcome = dict(outcome or {"status": status})
            outcome.update({"replayed": True, "runId": prior.get("id")})
            return {"replay": outcome}
        if status == "running" and not prior.get("stale"):
            return {"replay": {"status": "in_progress", "risk": risk,
                               "runId": prior.get("id")}}
        cur.execute(
            "UPDATE " + portal_db._q(RUNS_TABLE) +
            " SET status = 'running', actor = %s, risk = %s, error = NULL,"
            " outcome = NULL, finished_at = NULL, created_at = NOW()"
            " WHERE id = %s AND client_id = %s RETURNING id",
            (str(actor or "")[:160], risk, prior.get("id"), client_id))
        again = portal_db.rows(cur)
        return {"id": again[0]["id"]} if again else None

    return _guarded(cur, "of_action_ledger", work)


def _after_insert(cur, client_id: int, rows) -> Optional[Dict[str, Any]]:
    if not rows:
        return None
    run_id = int(rows[0]["id"])
    if run_id % 100 == 0:  # cheap, deterministic retention sweep
        cur.execute(
            "DELETE FROM " + portal_db._q(RUNS_TABLE) +
            " WHERE client_id = %s"
            " AND created_at < NOW() - make_interval(days => %s)",
            (client_id, RUNS_KEEP_DAYS))
    return {"id": run_id}


def _ledger_finish(cur, client_id: int, claim: Optional[Dict[str, Any]],
                   status: str, outcome: Dict[str, Any], error: str = "",
                   attempts: int = 0, started: Optional[float] = None
                   ) -> None:
    if not claim or not claim.get("id"):
        return
    duration = None if started is None else int(
        (time.monotonic() - started) * 1000)

    def work():
        cur.execute(
            "UPDATE " + portal_db._q(RUNS_TABLE) +
            " SET status = %s, outcome = CAST(%s AS JSONB), error = %s,"
            " attempts = %s, duration_ms = %s, approval_id = %s,"
            " finished_at = NOW() WHERE id = %s AND client_id = %s",
            (status, _json_capped(outcome), (error or None) and error[:300],
             int(attempts), duration, outcome.get("approvalId"),
             claim["id"], client_id))
        return True

    _guarded(cur, "of_action_ledger", work)


# ---------------------------------------------------------------------------
# v2: timeout + transient-retry budget (§225)
# ---------------------------------------------------------------------------

class ActionTimeout(Exception):
    """The action's database work exceeded its statement budget."""


def _run_guarded(cur, spec: Dict[str, Any], client_id: int,
                 args: Dict[str, Any]) -> Tuple[Any, int]:
    """Run the executor atomically inside a savepoint: a failure leaves no
    partial writes and never poisons the caller's transaction. DB work is
    capped by ``statement_timeout`` (spec ``timeout_ms`` or
    OF_ACTION_TIMEOUT_MS; external HTTP inside an executor keeps its own
    timeout). Serialization/deadlock/lock-timeout errors are retried up to
    OF_ACTION_RETRIES times. Returns (result, attempts)."""
    timeout_ms = int(spec.get("timeout_ms") or TIMEOUT_MS)
    attempt = 0
    while True:
        attempt += 1
        try:
            cur.execute("SAVEPOINT of_action")
        except Exception:
            return spec["run"](cur, client_id, args), attempt
        try:
            previous = None
            if timeout_ms > 0:
                cur.execute("SELECT current_setting('statement_timeout')"
                            " AS value")
                rows = portal_db.rows(cur)
                previous = str((rows[0] if rows else {}).get("value") or "0")
                cur.execute("SELECT set_config('statement_timeout', %s, true)",
                            (str(timeout_ms),))
            result = spec["run"](cur, client_id, args)
            if previous is not None:
                cur.execute("SELECT set_config('statement_timeout', %s, true)",
                            (previous,))
            cur.execute("RELEASE SAVEPOINT of_action")
            return result, attempt
        except Exception as error:
            try:
                cur.execute("ROLLBACK TO SAVEPOINT of_action")
            except Exception:
                pass
            code = str(getattr(error, "pgcode", "") or "")
            if code in _TRANSIENT_CODES and attempt <= RETRIES:
                continue
            if code == "57014":
                raise ActionTimeout(str(error)[:200]) from error
            raise


# ---------------------------------------------------------------------------
# execute + approval resolution
# ---------------------------------------------------------------------------

def execute(cur, client_id: int, actor: str, action: str,
            args: Dict[str, Any], conversation_id=None,
            agent: Optional[Dict[str, Any]] = None,
            idempotency_key: Optional[str] = None,
            dry_run: bool = False) -> Dict[str, Any]:
    """One entry point. HIGH risk -> approval (no execution yet).

    ``agent`` (optional) is the AI persona acting - its permissions
    (portal_agents.permits: allowed_actions + max_risk) are checked FIRST;
    a denied action is audited (``action.denied``) and never runs. The
    approval gate still applies after the permission check - permissions
    never bypass it (AI never bypasses app permissions).

    v2 (§225): args are validated against the action's schema; every call
    lands in the execution ledger (portal_action_runs); an
    ``idempotency_key`` makes the call exactly-once per workspace (a
    repeat returns the stored outcome with ``replayed: true``);
    ``dry_run`` returns preview() and writes nothing; the executor runs
    atomically with a timeout + transient-retry budget, and an unexpected
    failure returns ``status: error`` instead of poisoning the caller's
    transaction.

    Returns {status: executed|approval_required|denied|error|in_progress|
    preview, ...}. Raises ValueError on unknown action / bad args and on
    the executor's own domain errors (e.g. assignee_not_found).
    """
    if dry_run:
        return preview(cur, client_id, actor, action, args, agent)
    spec, args = _prepare(action, args, actor)
    risk = _effective_risk(action, args)
    claim = _ledger_claim(cur, client_id, action, actor, risk,
                          _clean_key(idempotency_key), conversation_id, args)
    if claim and claim.get("replay"):
        return claim["replay"]
    if agent:
        import portal_agents

        allowed, reason = portal_agents.permits(agent, action, risk)
        if not allowed:
            try:
                portal_db.log_action(
                    cur, client_id, "action.denied", actor_kind="system",
                    conversation_id=conversation_id,
                    note=json.dumps({"actor": actor, "action": action,
                                     "risk": risk, "reason": reason,
                                     "agent_id": agent.get("id"),
                                     "agent": agent.get("name")},
                                    default=str)[:900],
                )
            except Exception:
                pass
            out = {"status": "denied", "risk": risk, "reason": reason,
                   "agent_id": agent.get("id"),
                   "agent": str(agent.get("name") or "")}
            _ledger_finish(cur, client_id, claim, "denied", out,
                           error=str(reason or ""))
            return out
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
            out = {"status": "error", "error": "approval_not_created"}
            _ledger_finish(cur, client_id, claim, "error", out,
                           error="approval_not_created")
            return out
        out = {"status": "approval_required", "risk": risk,
               "approvalId": made.get("id"),
               "refCode": made.get("ref_code")}
        _ledger_finish(cur, client_id, claim, "approval_required", out)
        return out

    started = time.monotonic()
    try:
        result, attempts = _run_guarded(cur, spec, client_id, args)
    except ValueError as error:
        _ledger_finish(cur, client_id, claim, "error",
                       {"status": "error", "error": str(error)[:120]},
                       error=str(error), attempts=1, started=started)
        raise
    except Exception as error:
        code = "timeout" if isinstance(error, ActionTimeout) \
            else "action_failed"
        logger.warning("action %s failed: %s", action, error)
        out = {"status": "error", "risk": risk, "error": code}
        _ledger_finish(cur, client_id, claim, "error", out,
                       error=code + ": " + str(error)[:200], attempts=1,
                       started=started)
        return out
    try:
        portal_db.log_action(
            cur, client_id, "action." + action, actor_kind="system",
            note=json.dumps({"actor": actor, "risk": risk,
                             "result": result}, default=str)[:900],
        )
    except Exception:
        pass
    out = {"status": "executed", "risk": risk, "result": result}
    _ledger_finish(cur, client_id, claim, "executed", out,
                   attempts=attempts, started=started)
    return out


def resolve_approval(cur, client_id: int, approval: Dict[str, Any],
                     approved: bool, args_override: Optional[Dict[str, Any]] = None,
                     customer_reply: str = "") -> Dict[str, Any]:
    """Called by portal_approvals for Action Engine approvals.

    approved: run the stored action for real (with the owner's edits when
    given); refund/cancel rows land as done. rejected: only the customer
    hold message goes out (the owner's own reply replaces it when written).
    Returns {"outcome", "detail"}; RAISES when the action fails - the
    caller holds a savepoint, so the decision is kept and can be retried.
    §225: the approved run is ledgered under ``approval:<id>`` - a second
    resolve of the same approval never runs the action twice.
    """
    context = approval.get("context_json") or {}
    if isinstance(context, str):
        context = json.loads(context or "{}")
    action = str(context.get("action") or "")
    args = dict(context.get("args") or {})
    if args_override:
        args.update(args_override)
    spec = ACTIONS.get(action)
    if spec is None:
        return {"outcome": "recorded",
                "detail": "No runnable action is linked to this approval."}
    contact_id = str(args.get("contact_id") or "")
    reply = str(customer_reply or "").strip()
    if approved:
        claim = _ledger_claim(
            cur, client_id, action, "approval", RISK_HIGH,
            ("approval:" + str(approval.get("id")))
            if approval.get("id") else None,
            args.get("conversation_id"), args)
        if claim and claim.get("replay"):
            return {"outcome": "executed",
                    "detail": "Already ran for this approval."}
        started = time.monotonic()
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
            contact_id = str(result.get("contactId") or contact_id)
        portal_db.log_action(
            cur, client_id, "action." + action + ".approved",
            actor_kind="system",
            note=json.dumps({"result": result,
                             "edited": sorted(args_override or {})},
                            default=str)[:900],
        )
        _ledger_finish(cur, client_id, claim, "executed",
                       {"status": "executed", "risk": RISK_HIGH,
                        "result": result, "approvalId": approval.get("id")},
                       attempts=1, started=started)
        detail = ACTIONS[action]["description"]
        if reply and contact_id:
            _queue_hold(cur, client_id, contact_id, reply)
            detail += " - your reply was queued"
        return {"outcome": "executed", "detail": detail[:300]}
    if action in ("request_refund", "request_order_cancel") and contact_id:
        _queue_hold(cur, client_id, contact_id, reply or _HOLD_REJECTED)
        return {"outcome": "reply_sent" if reply else "recorded",
                "detail": "Customer told the request was not processed."}
    return {"outcome": "recorded", "detail": "Nothing was run."}


def _queue_hold(cur, client_id: int, contact_id: str, body: str) -> None:
    """Approval follow-up to the customer on their own channel."""
    import portal_channels

    cur.execute(
        "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
        " (client_id, channel, action, payload, status,"
        " requested_by, created_at, updated_at)"
        " VALUES (%s, %s, 'send_message',"
        " CAST(%s AS JSONB), 'pending', NULL, NOW(), NOW())",
        (client_id, portal_channels.channel_for_contact(contact_id),
         json.dumps({
             "external_user_id": contact_id,
             "body": str(body or "")[:1000],
             "source": "approval",
         })),
    )


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


_ERROR_MESSAGES = {
    "missing_args": "args adhoore hain.",
    "invalid_args": "Some args have the wrong type or format.",
    "unknown_action": "Unknown action.",
}


def _value_error(exc: ValueError):
    code = str(exc).split(":")[0]
    if code not in _ERROR_MESSAGES:
        return jsonify({"error": {"code": "action_rejected",
                                  "message": str(exc)[:160]}}), 400
    return jsonify({"error": {"code": code, "message": _ERROR_MESSAGES[code],
                              "fields": str(exc).partition(":")[2]
                              .split(",") if ":" in str(exc) else []}}), 400


def _payload_args(payload: Dict[str, Any]) -> Dict[str, Any]:
    args = payload.get("args")
    return args if isinstance(args, dict) else {}


@bp.post("/execute")
def execute_action():
    principal, error = _principal_or_error()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    action = str(payload.get("action") or "").strip()
    args = _payload_args(payload)
    conversation_id = payload.get("conversation_id")
    actor = str(principal.get("email") or principal.get("user_id"))
    raw_key = str(request.headers.get("Idempotency-Key")
                  or payload.get("idempotency_key") or "").strip()
    key = None
    if raw_key:
        key = _clean_key("api:" + raw_key)
        if key is None:
            return jsonify({"error": {
                "code": "bad_idempotency_key",
                "message": "Idempotency keys use letters, digits and"
                           " : _ . - (max 150)."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                outcome = execute(cur, principal["client_id"], actor,
                                  action, args, conversation_id,
                                  idempotency_key=key,
                                  dry_run=bool(payload.get("dry_run")))
            conn.commit()
        finally:
            conn.close()
    except ValueError as exc:
        return _value_error(exc)
    except Exception as exc:
        return jsonify(portal_db.portal_unavailable(
            exc, "action execute")[0]), 503
    return jsonify(outcome), 200


@bp.post("/preview")
def preview_action():
    """Dry run for the owner / builders: validation, risk, permission and
    approval verdict without any write."""
    principal, error = _principal_or_error()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    action = str(payload.get("action") or "").strip()
    actor = str(principal.get("email") or principal.get("user_id"))
    try:
        agent = None
        conn = None
        if payload.get("agent_id"):
            import portal_agents

            portal_db.ensure_tables()
            conn = portal_db._conn()
            try:
                with conn.cursor() as cur:
                    agent = portal_agents.load_agent(
                        cur, principal["client_id"],
                        int(payload.get("agent_id") or 0))
            finally:
                conn.close()
            if agent is None:
                return jsonify({"error": {"code": "not_found",
                                          "message": "Agent not found."}}), 404
        outcome = preview(None, principal["client_id"], actor, action,
                          _payload_args(payload), agent)
    except ValueError as exc:
        return _value_error(exc)
    except Exception as exc:
        return jsonify(portal_db.portal_unavailable(
            exc, "action preview")[0]), 503
    return jsonify(outcome), 200


def _iso(value: Any) -> Optional[str]:
    try:
        return value.isoformat() if value is not None else None
    except AttributeError:
        return str(value)


def _shape_run(row: Dict[str, Any]) -> Dict[str, Any]:
    outcome = row.get("outcome")
    if isinstance(outcome, str):
        try:
            outcome = json.loads(outcome or "{}")
        except ValueError:
            outcome = {}
    actor = str(row.get("actor") or "")
    kind = ("workflow" if actor.startswith("workflow:") else
            "approval" if actor == "approval" else
            "ai" if actor.startswith(("brain", "agent", "ai")) else "person")
    spec = ACTIONS.get(str(row.get("action") or "")) or {}
    return {
        "id": row.get("id"),
        "action": row.get("action"),
        "label": spec.get("description") or row.get("action"),
        "status": row.get("status"),
        "risk": row.get("risk"),
        "actor": actor,
        "actorKind": kind,
        "conversationId": row.get("conversation_id"),
        "error": row.get("error"),
        "attempts": int(row.get("attempts") or 0),
        "durationMs": row.get("duration_ms"),
        "approvalId": row.get("approval_id"),
        "idempotent": bool(row.get("idempotency_key")),
        "args": row.get("args") if isinstance(row.get("args"), dict) else {},
        "createdAt": _iso(row.get("created_at")),
        "finishedAt": _iso(row.get("finished_at")),
    }


@bp.get("/runs")
def list_runs():
    """Execution ledger for the owner: newest first + 7-day counts."""
    principal, error = _principal_or_error()
    if error:
        return error
    status = str(request.args.get("status") or "").strip()
    if status and status not in RUN_STATUSES:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Unknown status filter."}}), 400
    try:
        limit = max(1, min(100, int(request.args.get("limit") or 50)))
    except ValueError:
        limit = 50
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_runs_ddl(cur)
                cur.execute(
                    "SELECT id, action, actor, risk, status, idempotency_key,"
                    " conversation_id, args, outcome, error, attempts,"
                    " duration_ms, approval_id, created_at, finished_at"
                    " FROM " + portal_db._q(RUNS_TABLE) +
                    " WHERE client_id = %s AND (%s = '' OR status = %s)"
                    " ORDER BY id DESC LIMIT %s",
                    (client_id, status, status, limit))
                found = portal_db.rows(cur)
                cur.execute(
                    "SELECT status, COUNT(*) AS n FROM "
                    + portal_db._q(RUNS_TABLE) +
                    " WHERE client_id = %s"
                    " AND created_at > NOW() - make_interval(days => 7)"
                    " GROUP BY status", (client_id,))
                counts = {str(r.get("status")): int(r.get("n") or 0)
                          for r in portal_db.rows(cur)}
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        return jsonify(portal_db.portal_unavailable(
            exc, "action runs")[0]), 503
    return jsonify({
        "runs": [_shape_run(row) for row in found],
        "counts": {key: counts.get(key, 0) for key in RUN_STATUSES},
        "keepDays": RUNS_KEEP_DAYS,
    }), 200
