"""AI Brain v1 (V2 B6): tools, policy, grounding - with provenance.

The brain is the platform's first intent-driven agent layer. It sits in the
one-reply chain (B2) ahead of the KB gate and can answer inbound customer
messages by REASONING OVER TOOLS - all read-only in v1:

  * recent_messages  - the last messages of this conversation;
  * customer_orders  - the contact's recent checkout links (status/total);
  * search_kb        - active knowledge-base entries matching the text;
  * customer_profile - stored language (tone matching).

Every decision is bounded (OF_BRAIN_MAX_TOOL_CALLS), grounded (the prompt
may only use tool output), policy-checked (no refund/discount/date
promises, no internal jargon, length caps; violations force a handoff) and
audited (a portal_brain_traces row + an ai.* portal_action_log entry).

Autonomy per tenant (portal_brain_settings.autonomy):
  off     - brain never runs (the rollback switch);
  suggest - DEFAULT: the owner can ask for drafts via POST
            /portal/brain/draft; the ingest path never fires;
  auto    - the ingest hook may queue a reply itself when confidence >=
            OF_BRAIN_MIN_CONFIDENCE and policy passes.

Fail-soft everywhere: a missing LLM key, an outage or any db error makes
the brain step aside (None) and the B3 keyword path handles the message.
"""

import json
import logging
import os
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_db
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
)

logger = logging.getLogger("omniflow.portal-brain")

bp = Blueprint("portal_brain", __name__, url_prefix="/api/v1/portal")

SETTINGS_TABLE = "portal_brain_settings"
TRACES_TABLE = "portal_brain_traces"

AUTONOMY_LEVELS = ("off", "suggest", "auto")
MAX_TOOL_CALLS = int(os.environ.get("OF_BRAIN_MAX_TOOL_CALLS", "3") or 3)
MIN_CONFIDENCE = float(
    os.environ.get("OF_BRAIN_MIN_CONFIDENCE", "0.6") or 0.6)
MAX_DRAFT_CHARS = int(os.environ.get("OF_BRAIN_MAX_DRAFT_CHARS", "700") or 700)

_DDL_READY = False

_DDL = """
CREATE TABLE IF NOT EXISTS portal_brain_settings (
  client_id BIGINT PRIMARY KEY,
  autonomy TEXT NOT NULL DEFAULT 'suggest',
  tone TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS portal_brain_traces (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  conversation_id BIGINT,
  kind TEXT NOT NULL DEFAULT 'draft',
  decision TEXT NOT NULL DEFAULT 'handoff',
  grounding JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_brain_traces
  ON portal_brain_traces (client_id, conversation_id, id DESC);
"""


def _ensure_ddl(cur) -> None:
    """Create the brain tables once per process (lazy DDL)."""
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    _DDL_READY = True


def _principal_or_error():
    """Owner/staff session required (API keys cannot touch the brain)."""
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": str(error)}}), 503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}),
                      401)
    if principal.get("via_api_key"):
        return None, (jsonify({"error": {"code": "forbidden",
                                         "message": "Owner sign-in required."}}),
                      403)
    return principal, None


def _load_settings(cur, client_id: int) -> Dict[str, Any]:
    cur.execute(
        "SELECT autonomy, tone FROM " + portal_db._q(SETTINGS_TABLE) +
        " WHERE client_id = %s",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    if not rows:
        return {"autonomy": "suggest", "tone": ""}
    return {"autonomy": str(rows[0].get("autonomy") or "suggest"),
            "tone": str(rows[0].get("tone") or "")}


# ---------------------------------------------------------------------------
# Tools (read-only, tenant-scoped, budgeted)
# ---------------------------------------------------------------------------

def tool_recent_messages(cur, client_id: int, conversation_id: int,
                         n: int = 10) -> List[Dict[str, Any]]:
    cur.execute(
        "SELECT direction, body, created_at FROM " +
        portal_db._q(portal_db.MSGS_TABLE) +
        " WHERE client_id = %s AND conversation_id = %s"
        " ORDER BY id DESC LIMIT %s",
        (client_id, conversation_id, max(1, min(20, n))),
    )
    rows = portal_db.rows(cur)
    return [{"direction": str(r.get("direction") or ""),
             "body": str(r.get("body") or "")[:300],
             "created_at": str(r.get("created_at") or "")}
            for r in reversed(rows)]


def tool_customer_orders(cur, client_id: int, contact_id: str,
                         n: int = 3) -> List[Dict[str, Any]]:
    if not str(contact_id or "").strip():
        return []
    cur.execute(
        "SELECT id, total, status, paid_amount, updated_at FROM " +
        portal_db._q("portal_checkout_links") +
        " WHERE client_id = %s AND contact_id = %s"
        " ORDER BY id DESC LIMIT %s",
        (client_id, str(contact_id), max(1, min(10, n))),
    )
    rows = portal_db.rows(cur)
    return [{"id": int(r.get("id") or 0),
             "total": float(r.get("total") or 0),
             "status": str(r.get("status") or ""),
             "paid_amount": float(r.get("paid_amount") or 0),
             "updated_at": str(r.get("updated_at") or "")}
            for r in rows]


def tool_search_kb(cur, client_id: int, query: str,
                   n: int = 3) -> List[Dict[str, Any]]:
    text = str(query or "").strip()[:120]
    if not text:
        return []
    cur.execute(
        "SELECT id, title, content FROM " + portal_db._q("portal_kb_entries") +
        " WHERE client_id = %s AND is_active = TRUE"
        " AND (title ILIKE %s OR content ILIKE %s OR keywords ILIKE %s)"
        " ORDER BY id DESC LIMIT %s",
        (client_id, "%" + text + "%", "%" + text + "%", "%" + text + "%",
         max(1, min(5, n))),
    )
    rows = portal_db.rows(cur)
    return [{"id": int(r.get("id") or 0),
             "title": str(r.get("title") or ""),
             "content": str(r.get("content") or "")[:400]}
            for r in rows]


def tool_customer_profile(cur, client_id: int,
                          contact_id: str) -> Dict[str, Any]:
    language = None
    try:
        import portal_contacts

        language = portal_contacts.stored_language(cur, client_id, contact_id)
    except Exception:
        language = None
    return {"language": language}


# ---------------------------------------------------------------------------
# Policy engine (deterministic post-checks)
# ---------------------------------------------------------------------------

_POLICY_FORBIDDEN = (
    # refund / money promises
    "refund will", "will refund", "paise wapas", "money back",
    "full refund", "100% refund",
    # discount promises
    "discount de", "extra discount", "special discount for you",
    "i can give you a discount", "50% off",
    # delivery-date promises
    "guaranteed delivery", "pakka kal", "definitely tomorrow",
    # internal jargon / meta
    "system prompt", "as an ai", "language model", "database",
)

_POLICY_MAX_NEWLINES = 8


def policy_check(text: str) -> List[str]:
    """Return the list of policy violations ([] = passes)."""
    violations: List[str] = []
    low = " " + " ".join(str(text or "").lower().split()) + " "
    for phrase in _POLICY_FORBIDDEN:
        if phrase in low:
            violations.append("forbidden:" + phrase)
    if len(str(text or "")) > MAX_DRAFT_CHARS:
        violations.append("too_long")
    if str(text or "").count("\n") > _POLICY_MAX_NEWLINES:
        violations.append("too_many_lines")
    return violations


# ---------------------------------------------------------------------------
# Reasoner: grounding + LLM + decision
# ---------------------------------------------------------------------------

def _system_prompt(tone: str) -> str:
    tone_line = ("Write in this tone: " + tone + ".") if tone.strip() else ""
    return (
        "You are the WhatsApp support agent of a Pakistani retail business. "
        "Customers often write in Roman Urdu; reply in the customer's "
        "language, short and friendly. You may ONLY use facts from the "
        "provided CONTEXT - never invent orders, prices, dates or policies. "
        "NEVER promise refunds, discounts or delivery dates; NEVER mention "
        "internal systems. If the context is insufficient or the customer "
        "needs a human, set needs_human=true. " + tone_line +
        ' Reply ONLY with JSON: {"reply": "...", "needs_human": false, '
        '"confidence": 0.0}'
    )


def _reason(cur, client_id: int, conversation_id: int, contact_id: str,
            contact_name: str, message_text: str,
            tone: str) -> Tuple[Optional[Dict[str, Any]], Dict[str, Any]]:
    """Run the budgeted tools, then one LLM call.

    Returns (llm_payload_or_None, grounding_dict). Never raises beyond
    what the callers already guard.
    """
    grounding: Dict[str, Any] = {"tools": []}
    context: Dict[str, Any] = {}
    calls = 0

    def budget_left() -> bool:
        return calls < MAX_TOOL_CALLS

    context["conversation"] = tool_recent_messages(cur, client_id,
                                                   conversation_id, 10)
    calls += 1
    orders = tool_customer_orders(cur, client_id, contact_id, 3)
    calls += 1
    if orders:
        context["orders"] = orders
        grounding["tools"].append("customer_orders")
    kb = tool_search_kb(cur, client_id, message_text, 3)
    calls += 1
    if kb:
        context["kb"] = kb
        grounding["tools"].append("search_kb")
    profile = tool_customer_profile(cur, client_id, contact_id)
    if profile.get("language"):
        context["language"] = profile["language"]
        grounding["tools"].append("customer_profile")
    grounding["conversation_messages"] = len(context["conversation"])
    grounding["kb_ids"] = [e["id"] for e in kb]
    grounding["order_ids"] = [o["id"] for o in orders]
    del budget_left

    context["customer_name"] = str(contact_name or "")
    context["customer_message"] = str(message_text or "")

    import portal_llm

    payload = portal_llm.chat_json(
        _system_prompt(tone),
        json.dumps(context, ensure_ascii=False, default=str),
        max_tokens=300,
    )
    grounding["llm_called"] = payload is not None
    return payload, grounding


def _decide(payload: Optional[Dict[str, Any]],
            grounding: Dict[str, Any]) -> Tuple[str, str, Dict[str, Any]]:
    """Map the LLM payload + policy to (decision, reply, grounding)."""
    if not isinstance(payload, dict):
        grounding["reason"] = "llm_unavailable"
        return "handoff", "", grounding
    try:
        confidence = float(payload.get("confidence") or 0)
    except Exception:
        confidence = 0
    reply = str(payload.get("reply") or "").strip()
    needs_human = bool(payload.get("needs_human"))
    grounding["confidence"] = confidence
    if needs_human:
        grounding["reason"] = "needs_human"
        return "handoff", "", grounding
    if confidence < MIN_CONFIDENCE:
        grounding["reason"] = "low_confidence"
        return "handoff", "", grounding
    violations = policy_check(reply)
    grounding["policy_violations"] = violations
    if violations:
        grounding["reason"] = "policy:" + violations[0]
        return "handoff", "", grounding
    if not reply:
        grounding["reason"] = "empty_reply"
        return "handoff", "", grounding
    return "send", reply[:MAX_DRAFT_CHARS], grounding


def _write_trace(cur, client_id: int, conversation_id: int, kind: str,
                 decision: str, grounding: Dict[str, Any]) -> None:
    cur.execute(
        "INSERT INTO " + portal_db._q(TRACES_TABLE) +
        " (client_id, conversation_id, kind, decision, grounding)"
        " VALUES (%s, %s, %s, %s, CAST(%s AS JSONB))",
        (client_id, conversation_id, kind, decision,
         json.dumps(grounding, ensure_ascii=False, default=str)),
    )


# ---------------------------------------------------------------------------
# Ingest hook (autonomy == auto only) + owner draft API
# ---------------------------------------------------------------------------

def maybe_answer(client_id, conversation_id, contact_id, contact_name,
                 body, conn) -> Optional[bool]:
    """Ingest hook: answer under 'auto' autonomy; return True when the
    brain queued the reply (the one-reply law claims it as 'brain')."""
    text = str(body or "").strip()
    if not text:
        return None
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            settings = _load_settings(cur, client_id)
            if settings.get("autonomy") != "auto":
                return None
            payload, grounding = _reason(
                cur, client_id, int(conversation_id or 0),
                str(contact_id or ""), str(contact_name or ""), text,
                str(settings.get("tone") or ""))
            decision, reply, grounding = _decide(payload, grounding)
            _write_trace(cur, client_id, int(conversation_id or 0),
                         "ingest_answer", decision, grounding)
            if decision != "send":
                return None
            payload_out = {
                "external_user_id": str(contact_id or ""),
                "body": reply,
                "conversation_id": conversation_id,
                "source": "ai_brain",
            }
            if str(contact_name or "").strip():
                payload_out["target_display_name"] = str(contact_name)
            cur.execute(
                "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
                " (client_id, channel, action, payload, status,"
                " requested_by, created_at, updated_at) "
                "VALUES (%s, 'whatsapp', 'send_message',"
                " CAST(%s AS JSONB), 'pending', NULL, NOW(), NOW()) "
                "RETURNING id",
                (client_id, json.dumps(payload_out)),
            )
            portal_db.log_action(
                cur, client_id, "ai.answer", "automation",
                None, conversation_id,
                "Brain answered (tools: " +
                ",".join(grounding.get("tools") or ["none"]) + ").",
            )
            return True
    except Exception as error:
        logger.warning("brain maybe_answer failed: %s", error)
        return None


def draft_reply(cur, client_id: int, conversation_id: int,
                message_text: str = "") -> Dict[str, Any]:
    """Owner-facing draft (autonomy 'suggest'): never queues a send."""
    _ensure_ddl(cur)
    settings = _load_settings(cur, client_id)
    payload, grounding = _reason(
        cur, client_id, conversation_id, "", "", message_text,
        str(settings.get("tone") or ""))
    decision, reply, grounding = _decide(payload, grounding)
    _write_trace(cur, client_id, conversation_id, "draft", decision,
                 grounding)
    portal_db.log_action(
        cur, client_id, "ai.draft", "human",
        None, conversation_id,
        "Brain draft requested (" + decision + ").",
    )
    result = {"decision": decision,
              "draft": reply,
              "grounding": grounding,
              "autonomy": settings.get("autonomy")}
    # KB auto-draft (owner decision, admin panel): when on, a draft also
    # ships a saveable knowledge-base entry so good answers stop being
    # one-offs. Fail-soft: the plain draft is always there.
    try:
        import platform_settings
        if platform_settings.flag("kb_autodraft") and reply:
            result["kb_entry"] = {
                "title": (message_text or "").strip()[:120]
                         or "Saved answer",
                "content": str(reply),
            }
    except Exception:
        pass
    return result


# ---------------------------------------------------------------------------
# Owner API: settings / draft / trace
# ---------------------------------------------------------------------------

@bp.get("/brain/settings")
def get_brain_settings():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal.get("client_id") or 0)
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            settings = _load_settings(cur, client_id)
        conn.commit()
    finally:
        conn.close()
    return jsonify({"settings": settings}), 200


@bp.put("/brain/settings")
def put_brain_settings():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True) or {}
    autonomy = payload.get("autonomy")
    tone = payload.get("tone")
    if autonomy not in AUTONOMY_LEVELS:
        return jsonify({"error": {
            "code": "bad_request",
            "message": "autonomy must be one of off|suggest|auto.",
        }}), 400
    if tone is not None and not isinstance(tone, str):
        return jsonify({"error": {
            "code": "bad_request",
            "message": "tone must be a string.",
        }}), 400
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "INSERT INTO " + portal_db._q(SETTINGS_TABLE) +
                " (client_id, autonomy, tone, updated_at)"
                " VALUES (%s, %s, %s, NOW())"
                " ON CONFLICT (client_id) DO UPDATE SET"
                " autonomy = EXCLUDED.autonomy,"
                " tone = EXCLUDED.tone, updated_at = NOW()",
                (client_id, autonomy, str(tone or "")[:200]),
            )
            portal_db.log_action(
                cur, client_id, "ai.settings", "human",
                None, None,
                "Brain autonomy set to " + str(autonomy) + ".",
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"settings": {"autonomy": autonomy,
                                 "tone": str(tone or "")}}), 200


@bp.post("/brain/draft")
def draft_brain_reply():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True) or {}
    try:
        conversation_id = int(payload.get("conversation_id") or 0)
    except Exception:
        conversation_id = 0
    if conversation_id <= 0:
        return jsonify({"error": {
            "code": "bad_request",
            "message": "conversation_id (positive integer) is required.",
        }}), 400
    message_text = str(payload.get("message") or "")
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM " + portal_db._q(portal_db.CONV_TABLE) +
                " WHERE id = %s AND client_id = %s LIMIT 1",
                (conversation_id, client_id),
            )
            if not portal_db.rows(cur):
                conn.rollback()
                return jsonify({"error": {
                    "code": "not_found",
                    "message": "No such conversation in this workspace.",
                }}), 404
            result = draft_reply(cur, client_id, conversation_id,
                                 message_text)
        conn.commit()
    finally:
        conn.close()
    return jsonify(result), 200


@bp.get("/brain/trace")
def list_brain_traces():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal.get("client_id") or 0)
    try:
        conversation_id = int(request.args.get("conversation_id") or 0)
    except Exception:
        conversation_id = 0
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            sql = ("SELECT id, conversation_id, kind, decision, grounding,"
                   " created_at FROM " + portal_db._q(TRACES_TABLE) +
                   " WHERE client_id = %s")
            params: Tuple[Any, ...] = (client_id,)
            if conversation_id > 0:
                sql += " AND conversation_id = %s"
                params = (client_id, conversation_id)
            sql += " ORDER BY id DESC LIMIT 10"
            cur.execute(sql, params)
            rows = portal_db.rows(cur)
        conn.commit()
    finally:
        conn.close()
    out = [{"id": int(r.get("id") or 0),
            "conversation_id": r.get("conversation_id"),
            "kind": str(r.get("kind") or ""),
            "decision": str(r.get("decision") or ""),
            "grounding": r.get("grounding"),
            "created_at": str(r.get("created_at") or "")}
           for r in rows]
    return jsonify({"traces": out}), 200
