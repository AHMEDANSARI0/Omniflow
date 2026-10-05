"""AI execution traces + audit linkage (§241, gap analysis rows 27 and 31).

Every AI answer already leaves a ``portal_brain_traces`` row (what the
brain read, its confidence, why it handed off). This module READS those
rows and lays each one out as the steps the answer went through:

    customer message -> guard -> agent -> tools -> model -> decision -> reply

No new table. The links come from the transaction the answer ran in: the
trace, the queued reply (``portal_connector_commands``), the audit rows
(``portal_action_log``) and the inbound message are all written by the same
transaction, so they share one ``NOW()``. The message and reply TEXT are
read from their own tables at request time (never copied into the trace),
so retention and deletes keep covering them.

  - ``GET /api/v1/portal/ai/traces?days=&kind=&decision=&agent_id=
    &conversation_id=&limit=`` newest first, one summary per answer.
  - ``GET /api/v1/portal/ai/traces/<id>`` the steps + linked audit rows.
  - ``link_audit()`` gives ``GET /ai/audit`` rows a ``trace`` link
    (trace id, agent, model).

Human principals of the workspace only (a trace shows customer text); API
keys get 403. Tenant-scoped; read-only (the request rolls back). Cost is
shown only when model prices are configured (never invented). Optional
reads (agents, messages, replies, audit) are probed with ``to_regclass``
and run in a savepoint: a missing table blanks only that part.
"""

import json
import logging
from typing import Any, Callable, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_ai_automation as quadrant
import portal_db
import portal_txn
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)

bp = Blueprint("portal_ai_traces", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

TRACES_TABLE = "portal_brain_traces"
AGENTS_TABLE = "portal_agents"
VERSIONS_TABLE = "portal_agent_versions"
LOG_TABLE = "portal_action_log"

KINDS = {
    "ingest_answer": "Automatic reply",
    "voice_answer": "Phone call reply",
    "draft": "Draft for the team",
}
DECISIONS = ("send", "handoff")
DEFAULT_DAYS = 7
MAX_DAYS = 90
DEFAULT_LIMIT = 50
MAX_LIMIT = 100
MAX_BODY_CHARS = 1000
MAX_REFS = 10
MAX_CITATIONS = 3
INBOUND_SQL = "direction IN ('in', 'inbound')"


# ---------------------------------------------------------------------------
# parsing
# ---------------------------------------------------------------------------

def _whole(raw: Any, max_len: int) -> Optional[int]:
    """ASCII digits only (no signs, no non-ASCII digits) -> int, else None."""
    text = str(raw if raw is not None else "").strip()
    if not text or len(text) > max_len or not (text.isascii() and text.isdigit()):
        return None
    return int(text)


def parse_filters(args: Any) -> Tuple[Optional[Dict[str, Any]], str]:
    """Query string -> (filters, "") or (None, message)."""
    def arg(name: str) -> str:
        return str(args.get(name) or "").strip()

    filters: Dict[str, Any] = {"days": DEFAULT_DAYS, "kind": "", "decision": "",
                               "agent_id": 0, "conversation_id": 0,
                               "limit": DEFAULT_LIMIT}
    if arg("days"):
        days = _whole(arg("days"), 3)
        if days is None or not 1 <= days <= MAX_DAYS:
            return None, "days must be a whole number from 1 to " + str(MAX_DAYS) + "."
        filters["days"] = days
    if arg("kind"):
        if arg("kind") not in KINDS:
            return None, "kind must be one of " + ", ".join(KINDS) + "."
        filters["kind"] = arg("kind")
    if arg("decision"):
        if arg("decision") not in DECISIONS:
            return None, "decision must be send or handoff."
        filters["decision"] = arg("decision")
    for name in ("agent_id", "conversation_id"):
        if arg(name):
            value = _whole(arg(name), 18)
            if not value:
                return None, name + " must be a positive whole number."
            filters[name] = value
    if arg("limit"):
        limit = _whole(arg("limit"), 3)
        if not limit:
            return None, "limit must be a whole number from 1 to " + str(MAX_LIMIT) + "."
        filters["limit"] = min(limit, MAX_LIMIT)
    return filters, ""


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------

def _grounding(raw: Any) -> Dict[str, Any]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return {}
    return raw if isinstance(raw, dict) else {}


def _id(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    return _whole(value, 18) or None


def _ids(value: Any) -> List[Any]:
    return list(value)[:MAX_REFS] if isinstance(value, list) else []


def _count(n: int, noun: str, plural: str = "") -> str:
    return str(n) + " " + (noun if n == 1 else plural or noun + "s")


def _calls(g: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw = g.get("model_calls")
    return [c for c in raw if isinstance(c, dict)] if isinstance(raw, list) else []


def _cost(calls: List[Dict[str, Any]], prices: Dict[str, Any]) -> Optional[float]:
    """USD for the calls, or None when any of them has no price."""
    import portal_ai_usage

    if not calls or not prices:
        return None
    total = 0.0
    for call in calls:
        cost = portal_ai_usage.estimate_cost(
            call.get("model"), quadrant._int(call.get("prompt_tokens")),
            quadrant._int(call.get("completion_tokens")), prices)
        if cost is None:
            return None
        total += cost
    return round(total, 6)


def _prices() -> Dict[str, Any]:
    try:
        import portal_ai_usage

        return portal_ai_usage.prices()
    except Exception:
        return {}


def _optional(cur, tables: Tuple[str, ...], fn: Callable[[], Any], default: Any) -> Any:
    """One optional read: probe its tables, run it in a savepoint."""
    try:
        for table in tables:
            if not quadrant._exists(cur, table):
                return default
        with portal_txn.savepoint(cur, None, "of_trace_read"):
            return fn()
    except Exception as error:
        logger.info("ai trace read %s skipped: %s", tables[0], error)
        return default


def _agent_names(cur, client_id: int, ids: List[int]) -> Dict[int, str]:
    ids = sorted({i for i in ids if i})
    if not ids:
        return {}

    def read() -> Dict[int, str]:
        cur.execute(
            "SELECT id, name FROM " + portal_db._q(AGENTS_TABLE) +
            " WHERE client_id = %s AND id = ANY(%s)",
            (client_id, ids),
        )
        return {quadrant._int(r.get("id")): str(r.get("name") or "")
                for r in portal_db.rows(cur)}

    return _optional(cur, (AGENTS_TABLE,), read, {})


def _reason(g: Dict[str, Any], decision: str) -> Optional[Dict[str, str]]:
    raw = str(g.get("reason") or "")
    if not raw and decision == "send":
        return None
    key = quadrant._reason_key(raw)
    return {"key": key, "label": quadrant.BRAIN_REASONS.get(key) or raw,
            "detail": raw.split(":", 1)[1] if ":" in raw else ""}


def _confidence(g: Dict[str, Any]) -> Optional[float]:
    value = g.get("confidence")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return round(float(value), 3)


def _agent(g: Dict[str, Any], names: Dict[int, str]) -> Optional[Dict[str, Any]]:
    agent_id = _id(g.get("agent_id"))
    if not agent_id:
        return None
    name = names.get(agent_id) or str(g.get("agent_name") or "")
    return {"id": agent_id, "name": name or "Agent #" + str(agent_id)}


# ---------------------------------------------------------------------------
# list
# ---------------------------------------------------------------------------

def _summary(row: Dict[str, Any], names: Dict[int, str],
             prices: Dict[str, Any]) -> Dict[str, Any]:
    g = _grounding(row.get("grounding"))
    decision = str(row.get("decision") or "")
    kind = str(row.get("kind") or "")
    calls = _calls(g)
    return {
        "id": quadrant._int(row.get("id")),
        "created_at": quadrant._iso(row.get("created_at")),
        "kind": kind,
        "kind_label": KINDS.get(kind, kind),
        "decision": decision,
        "conversation_id": _id(row.get("conversation_id")),
        "agent": _agent(g, names),
        "model": str(calls[0].get("model") or "") or None if calls else None,
        "tokens": sum(quadrant._int(c.get("prompt_tokens")) +
                      quadrant._int(c.get("completion_tokens")) for c in calls),
        "latency_ms": (sum(quadrant._int(c.get("latency_ms")) for c in calls)
                       if calls else None),
        "cost_usd": _cost(calls, prices),
        "confidence": _confidence(g),
        "reason": _reason(g, decision),
        "tools": [quadrant.TOOL_LABELS.get(str(t), str(t))
                  for t in (g.get("tools") or []) if isinstance(t, str)],
        "llm_called": g.get("llm_called") is True,
    }


def list_traces(cur, client_id: int, filters: Dict[str, Any]) -> Dict[str, Any]:
    prices = _prices()
    out: Dict[str, Any] = {
        "days": filters["days"],
        "filters": {k: filters[k] for k in ("kind", "decision", "agent_id",
                                            "conversation_id")},
        "kinds": [{"key": k, "label": v} for k, v in KINDS.items()],
        "prices_configured": bool(prices),
        "items": [],
    }
    if not quadrant._exists(cur, TRACES_TABLE):
        return out
    sql = ("SELECT id, conversation_id, kind, decision, grounding, created_at"
           " FROM " + portal_db._q(TRACES_TABLE) +
           " WHERE client_id = %s"
           " AND created_at > NOW() - make_interval(days => %s)")
    params: List[Any] = [client_id, filters["days"]]
    for column in ("kind", "decision", "conversation_id"):
        if filters[column]:
            sql += " AND " + column + " = %s"
            params.append(filters[column])
    if filters["agent_id"]:
        sql += " AND " + quadrant.AGENT_SQL + " = %s"
        params.append(filters["agent_id"])
    sql += " ORDER BY id DESC LIMIT %s"
    params.append(filters["limit"])
    cur.execute(sql, tuple(params))
    rows = portal_db.rows(cur)
    names = _agent_names(cur, client_id, [
        _id(_grounding(r.get("grounding")).get("agent_id")) or 0 for r in rows])
    out["items"] = [_summary(r, names, prices) for r in rows]
    return out


# ---------------------------------------------------------------------------
# detail: the steps of one answer
# ---------------------------------------------------------------------------

def _tool_items(g: Dict[str, Any], agent: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    read = g.get("conversation_messages")
    if isinstance(read, int) and not isinstance(read, bool):
        items.append({"key": "conversation", "label": "Recent conversation",
                      "detail": _count(read, "message") + " read", "refs": []})
    for key in g.get("tools") or []:
        if not isinstance(key, str):
            continue
        detail, refs = "", []
        if key == "customer_orders":
            refs = _ids(g.get("order_ids"))
            detail = _count(len(g.get("order_ids") or []), "order")
        elif key == "search_kb":
            entries = len(g.get("kb_ids") or [])
            passages = len(g.get("knowledge_ids") or [])
            detail = _count(entries, "entry", "entries") + ", " + \
                _count(passages, "document passage")
            refs = [str(c.get("section") or c.get("source") or "")
                    for c in (g.get("citations") or [])[:MAX_CITATIONS]
                    if isinstance(c, dict)]
        elif key == "business_facts":
            refs = _ids(g.get("fact_ids"))
            detail = _count(len(g.get("fact_ids") or []), "fact")
        elif key == "customer_memory":
            refs = _ids(g.get("memory_ids"))
            detail = _count(len(g.get("memory_ids") or []), "memory", "memories")
        elif key == "agent_persona":
            detail = agent["name"] if agent else ""
        elif key == "customer_profile":
            detail = "Preferred language known"
        elif key == "sales_context":
            sales = g.get("sales") if isinstance(g.get("sales"), dict) else {}
            parts = ["stage " + str(sales.get("stage") or "unknown")]
            if sales.get("ask_next"):
                parts.append("asks next: " + str(sales.get("ask_next")))
            if sales.get("objection"):
                parts.append("concern: " + str(sales.get("objection")) +
                             (" (approved answer)" if sales.get("approved_answer") else ""))
            detail = ", ".join(parts)
        elif key == "loyalty_context":
            loyalty = g.get("loyalty") if isinstance(g.get("loyalty"), dict) else {}
            detail = "tier " + str(loyalty.get("tier") or "none") + ", " + \
                _count(quadrant._int(loyalty.get("orders")), "past order")
        items.append({"key": key, "label": quadrant.TOOL_LABELS.get(key, key),
                      "detail": detail, "refs": refs})
    return items


def _input_message(cur, client_id: int, conversation_id: Optional[int], at: Any,
                   input_chars: Any) -> Optional[Dict[str, Any]]:
    """The customer message the answer was about: the newest inbound message
    up to the trace time. ``exact`` = written in the same transaction (and,
    when the trace knows it, the same length)."""
    if not conversation_id or at is None:
        return None

    def read() -> Optional[Dict[str, Any]]:
        cur.execute(
            "SELECT id, body, created_at FROM " + portal_db._q(portal_db.MSGS_TABLE) +
            " WHERE client_id = %s AND conversation_id = %s AND " + INBOUND_SQL +
            " AND created_at <= %s ORDER BY created_at DESC, id DESC LIMIT 5",
            (client_id, conversation_id, at),
        )
        rows = portal_db.rows(cur)
        if not rows:
            return None
        same = [r for r in rows if r.get("created_at") == at]
        sized = [r for r in same if isinstance(input_chars, int)
                 and len(str(r.get("body") or "").strip()) == input_chars]
        pick = (sized or same or rows)[0]
        return {"message_id": quadrant._int(pick.get("id")),
                "body": str(pick.get("body") or "")[:MAX_BODY_CHARS],
                "created_at": quadrant._iso(pick.get("created_at")),
                "match": "exact" if (sized or (same and not isinstance(input_chars, int)))
                else ("same_time" if same else "nearest")}

    return _optional(cur, (portal_db.MSGS_TABLE,), read, None)


def _queued_reply(cur, client_id: int, conversation_id: Optional[int],
                  at: Any) -> Optional[Dict[str, Any]]:
    if not conversation_id or at is None:
        return None

    def read() -> Optional[Dict[str, Any]]:
        cur.execute(
            "SELECT id, status, payload->>'body' AS body, created_at FROM " +
            portal_db._q(portal_db.CMD_TABLE) +
            " WHERE client_id = %s AND action = 'send_message'"
            " AND created_at = %s AND payload->>'source' = 'ai_brain'"
            " AND payload->>'conversation_id' = %s ORDER BY id LIMIT 1",
            (client_id, at, str(conversation_id)),
        )
        rows = portal_db.rows(cur)
        if not rows:
            return None
        row = rows[0]
        return {"command_id": quadrant._int(row.get("id")),
                "status": str(row.get("status") or ""),
                "body": str(row.get("body") or "")[:MAX_BODY_CHARS]}

    return _optional(cur, (portal_db.CMD_TABLE,), read, None)


def _audit_rows(cur, client_id: int, conversation_id: Optional[int],
                at: Any) -> List[Dict[str, Any]]:
    if not conversation_id or at is None:
        return []

    def read() -> List[Dict[str, Any]]:
        cur.execute(
            "SELECT id, action, actor_kind, note FROM " + portal_db._q(LOG_TABLE) +
            " WHERE client_id = %s AND conversation_id = %s AND created_at = %s"
            " ORDER BY id",
            (client_id, conversation_id, at),
        )
        return [{"id": quadrant._int(r.get("id")), "action": str(r.get("action") or ""),
                 "actor_kind": str(r.get("actor_kind") or ""),
                 "note": str(r.get("note") or "")} for r in portal_db.rows(cur)]

    return _optional(cur, (LOG_TABLE,), read, [])


def _agent_version(cur, client_id: int, agent_id: int, at: Any) -> Optional[int]:
    """The persona version that was live when the answer ran."""
    if at is None:
        return None

    def read() -> Optional[int]:
        cur.execute(
            "SELECT MAX(version) AS version FROM " + portal_db._q(VERSIONS_TABLE) +
            " WHERE client_id = %s AND agent_id = %s AND created_at <= %s",
            (client_id, agent_id, at),
        )
        rows = portal_db.rows(cur)
        version = (rows[0] if rows else {}).get("version")
        return quadrant._int(version) or None

    return _optional(cur, (VERSIONS_TABLE,), read, None)


def _response(kind: str, decision: str, queued: Optional[Dict[str, Any]],
              audit: List[Dict[str, Any]]) -> Dict[str, Any]:
    if decision != "send":
        escalated = any(a["action"].startswith("escalation.") for a in audit)
        return {"key": "response", "label": "Reply", "status": "skipped",
                "detail": {"type": "handoff", "escalated": escalated,
                           "note": "No reply sent: handed to the team."}}
    if kind == "draft":
        return {"key": "response", "label": "Reply", "status": "ok",
                "detail": {"type": "draft",
                           "note": "Shown to the team member as a draft (drafts are not stored)."}}
    if kind == "voice_answer":
        return {"key": "response", "label": "Reply", "status": "ok",
                "detail": {"type": "voice", "note": "Spoken on the phone call."}}
    if queued:
        return {"key": "response", "label": "Reply", "status": "ok",
                "detail": dict(queued, type="message")}
    return {"key": "response", "label": "Reply", "status": "unknown",
            "detail": {"type": "message",
                       "note": "The queued reply is no longer on record."}}


def build_detail(cur, client_id: int, row: Dict[str, Any]) -> Dict[str, Any]:
    g = _grounding(row.get("grounding"))
    at = row.get("created_at")
    kind = str(row.get("kind") or "")
    decision = str(row.get("decision") or "")
    conversation_id = _id(row.get("conversation_id"))
    prices = _prices()
    agent_id = _id(g.get("agent_id"))
    names = _agent_names(cur, client_id, [agent_id or 0])
    agent = _agent(g, names)
    reason = _reason(g, decision)
    blocked = reason is not None and reason["key"] == "injection_suspected"
    calls = _calls(g)

    message = _input_message(cur, client_id, conversation_id, at, g.get("input_chars"))
    audit = _audit_rows(cur, client_id, conversation_id, at)
    queued = (_queued_reply(cur, client_id, conversation_id, at)
              if kind == "ingest_answer" and decision == "send" else None)

    guard = g.get("guard") if isinstance(g.get("guard"), dict) else None
    steps: List[Dict[str, Any]] = [
        {"key": "input", "label": "Customer message",
         "status": "ok" if message else "unknown",
         "detail": message or {"input_chars": g.get("input_chars"),
                               "note": "The message is not on record (deleted, or not a chat message)."}},
        {"key": "guard", "label": "Safety check",
         "status": "blocked" if blocked else ("ok" if guard else "skipped"),
         "detail": guard or {}},
    ]
    if agent:
        agent_detail = dict(agent, version=_agent_version(cur, client_id, agent["id"], at),
                            in_hours=g.get("agent_in_hours"),
                            auto_reply=g.get("agent_auto_reply"))
        steps.append({"key": "agent", "label": "Agent", "status": "ok",
                      "detail": agent_detail})
    else:
        steps.append({"key": "agent", "label": "Agent",
                      "status": "skipped" if blocked else "ok",
                      "detail": {"name": "Default assistant"}})
    steps.append({"key": "tools", "label": "Context it read",
                  "status": "skipped" if blocked else "ok",
                  "detail": {"items": _tool_items(g, agent)}})
    steps.append({
        "key": "model", "label": "AI model",
        "status": ("skipped" if blocked or not (calls or "llm_called" in g)
                   else "ok" if g.get("llm_called") is True else "failed"),
        "detail": {"calls": [dict(c, cost_usd=_cost([c], prices)) for c in calls],
                   "timings_ms": g.get("timings_ms") if isinstance(g.get("timings_ms"), dict) else None,
                   "cost_usd": _cost(calls, prices),
                   "prices_configured": bool(prices)}})
    steps.append({"key": "decision", "label": "Decision",
                  "status": "ok" if decision == "send" else ("blocked" if blocked else "warn"),
                  "detail": {"decision": decision, "confidence": _confidence(g),
                             "reason": reason,
                             "policy_violations": g.get("policy_violations") or [],
                             "output_violations": g.get("output_violations") or []}})
    steps.append(_response(kind, decision, queued, audit))
    return {
        "id": quadrant._int(row.get("id")),
        "created_at": quadrant._iso(at),
        "kind": kind,
        "kind_label": KINDS.get(kind, kind),
        "decision": decision,
        "conversation_id": conversation_id,
        "channel": str(g.get("channel") or "") or None,
        "steps": steps,
        "audit": audit,
    }


def get_trace(cur, client_id: int, trace_id: int) -> Optional[Dict[str, Any]]:
    if not quadrant._exists(cur, TRACES_TABLE):
        return None
    cur.execute(
        "SELECT id, conversation_id, kind, decision, grounding, created_at FROM " +
        portal_db._q(TRACES_TABLE) + " WHERE client_id = %s AND id = %s",
        (client_id, trace_id),
    )
    rows = portal_db.rows(cur)
    return build_detail(cur, client_id, rows[0]) if rows else None


# ---------------------------------------------------------------------------
# audit linkage (GET /ai/audit)
# ---------------------------------------------------------------------------

def link_audit(cur, client_id: int, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Give audit rows written with an AI answer a ``trace`` link (trace id,
    agent, model): same workspace, conversation and transaction time. When
    one transaction answered several messages, the n-th ``ai.answer`` row
    pairs with the n-th sent automatic reply; other rows take the first."""
    wanted = [i for i in items if i.get("conversation_id") and i.get("created_at")]
    if not wanted or not quadrant._exists(cur, TRACES_TABLE):
        return items
    cur.execute(
        "SELECT id, conversation_id, kind, decision, created_at, grounding FROM " +
        portal_db._q(TRACES_TABLE) +
        " WHERE client_id = %s AND conversation_id = ANY(%s)"
        " AND created_at = ANY(CAST(%s AS timestamptz[])) ORDER BY id",
        (client_id, sorted({int(i["conversation_id"]) for i in wanted}),
         sorted({str(i["created_at"]) for i in wanted})),
    )
    links: Dict[Tuple[int, str], List[Dict[str, Any]]] = {}
    for row in portal_db.rows(cur):
        key = (quadrant._int(row.get("conversation_id")),
               str(quadrant._iso(row.get("created_at"))))
        links.setdefault(key, []).append(row)
    if not links:
        return items
    names = _agent_names(cur, client_id, [
        _id(_grounding(r.get("grounding")).get("agent_id")) or 0
        for rows in links.values() for r in rows])
    answers: Dict[Tuple[int, str], List[int]] = {}
    for item in sorted(wanted, key=lambda i: quadrant._int(i.get("id"))):
        if item.get("action") == "ai.answer":
            answers.setdefault((quadrant._int(item.get("conversation_id")),
                                str(item.get("created_at"))), []).append(
                quadrant._int(item.get("id")))
    out = []
    for item in items:
        key = (quadrant._int(item.get("conversation_id")), str(item.get("created_at")))
        rows = links.get(key)
        if not rows:
            out.append(item)
            continue
        row = rows[0]
        if item.get("action") == "ai.answer":
            sent = [r for r in rows if r.get("kind") == "ingest_answer"
                    and r.get("decision") == "send"]
            rank = answers.get(key, []).index(quadrant._int(item.get("id")))
            row = sent[rank] if rank < len(sent) else row
        g = _grounding(row.get("grounding"))
        calls = _calls(g)
        out.append(dict(item, trace={
            "id": quadrant._int(row.get("id")),
            "agent": _agent(g, names),
            "model": str(calls[0].get("model") or "") or None if calls else None,
        }))
    return out


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def _human_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": str(error)}}), 503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}), 401)
    forbidden = ensure_human_principal(principal)
    if forbidden:
        return None, forbidden
    return principal, None


def _read(fn: Callable[[Any], Any]) -> Any:
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            return fn(cur)
    finally:
        try:
            conn.rollback()
        finally:
            conn.close()


DOWN = {"error": {"code": "portal_unavailable",
                  "message": "AI traces are unavailable right now."}}


@bp.get("/ai/traces")
def ai_traces():
    principal, error = _human_or_error()
    if error:
        return error
    filters, message = parse_filters(request.args)
    if filters is None:
        return jsonify({"error": {"code": "bad_request", "message": message}}), 400
    client_id = int(principal["client_id"])
    try:
        data = _read(lambda cur: list_traces(cur, client_id, filters))
    except Exception as error:
        logger.warning("ai traces list failed: %s", error)
        return jsonify(DOWN), 503
    return jsonify(data), 200


@bp.get("/ai/traces/<trace_id>")
def ai_trace(trace_id: str):
    principal, error = _human_or_error()
    if error:
        return error
    wanted = _whole(trace_id, 18)
    if not wanted:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Trace id must be a positive whole number."}}), 400
    client_id = int(principal["client_id"])
    try:
        data = _read(lambda cur: get_trace(cur, client_id, wanted))
    except Exception as error:
        logger.warning("ai trace detail failed: %s", error)
        return jsonify(DOWN), 503
    if data is None:
        return jsonify({"error": {"code": "not_found", "message": "Trace not found."}}), 404
    return jsonify(data), 200
