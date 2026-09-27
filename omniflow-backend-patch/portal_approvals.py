"""Approval engine (master-upgrade D3): high-risk AI actions need an
owner yes/no, in the portal or over WhatsApp with a plain 1 / 0 reply.

Why this module exists
----------------------
The master-upgrade brief (engine 7/23/38) requires HIGH-risk actions
(refunds, cancellations, big discounts) to carry an approval gate. The
owner asked for the loop to live where they already are:

* a pending approval shows in the portal (Approvals page);
* the owner's WhatsApp gets one message: customer name, basic details,
  the customer's actual query and a ref code — reply ``1`` to approve,
  ``0`` to reject (``1 AP-XXXX`` when several are pending);
* the portal can decide too; everything is audited.

Design laws kept:
- lightweight: plain Postgres, lazy DDL, no new infrastructure;
- the WhatsApp send rides the existing connector command queue
  (``portal_connector_commands``, action send_message) like every other
  customer-facing send;
- fail-soft everywhere: an approval problem must never break ingest;
- tenant isolation: every query is client_id-scoped; the approver is
  resolved server-side (config number or the connector's own number for
  self-chat) and re-checked on every 1/0 reply;
- v1 producers: high-risk request keywords on inbound customer messages
  (refund / cancel / big-discount language) create a pending approval.
  When the Action Engine lands, its HIGH-risk actions call
  ``create_approval`` directly before executing anything.
"""

import json
import os
import re
import secrets
from typing import Any, Dict, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_db
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
)

bp = Blueprint("portal_approvals", __name__,
               url_prefix="/api/v1/portal/approvals")

TABLE = os.environ.get("OF_APPROVALS_TABLE", "portal_approvals")
CONFIG_TABLE = os.environ.get("OF_APPROVALS_CONFIG_TABLE",
                              "portal_approvals_config")

#: Pending approvals expire after this many hours (lazy, on read).
DEFAULT_EXPIRE_HOURS = 24
#: At most this many pending approvals are matched against one reply.
MAX_PENDING_SCAN = 20

_REF_RE = re.compile(r"AP-([0-9A-Z]{4,8})$", re.IGNORECASE)
_DECIDE_RE = re.compile(r"^\s*(1|0)\s*(AP-[0-9A-Z]{4,8})?\s*$",
                        re.IGNORECASE)

# ---------------------------------------------------------------------------
# DDL / helpers
# ---------------------------------------------------------------------------

def _ensure_ddl(cur) -> None:
    """Idempotent lazy DDL (safe to call on every request)."""
    cur.execute(
        "CREATE TABLE IF NOT EXISTS " + portal_db._q(TABLE) + " ("
        " id BIGSERIAL PRIMARY KEY,"
        " client_id BIGINT NOT NULL,"
        " conversation_id BIGINT,"
        " contact_id TEXT NOT NULL,"
        " contact_name TEXT,"
        " action TEXT NOT NULL,"
        " summary TEXT NOT NULL,"
        " customer_query TEXT,"
        " context_json JSONB NOT NULL DEFAULT '{}'::jsonb,"
        " status TEXT NOT NULL DEFAULT 'pending',"
        " source TEXT NOT NULL DEFAULT 'ai',"
        " ref_code TEXT NOT NULL,"
        " decided_by TEXT,"
        " decided_via TEXT,"
        " decided_at TIMESTAMPTZ,"
        " expires_at TIMESTAMPTZ,"
        " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
        " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"
        ")"
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS portal_approvals_pending_idx ON "
        + portal_db._q(TABLE) + " (client_id, status, created_at DESC)"
    )
    cur.execute(
        "CREATE TABLE IF NOT EXISTS " + portal_db._q(CONFIG_TABLE) + " ("
        " client_id BIGINT PRIMARY KEY,"
        " approval_number TEXT,"
        " auto_expire_hours INT NOT NULL DEFAULT "
        + str(DEFAULT_EXPIRE_HOURS) + ","
        " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"
        ")"
    )


def _digits(value: Any) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def _audit(cur, client_id: int, action: str, detail: dict,
           actor_kind: str = "system") -> None:
    """One portal_action_log row (note = compact JSON); never raises."""
    try:
        portal_db.log_action(
            cur, client_id, action, actor_kind=actor_kind,
            note=json.dumps(detail, default=str)[:900],
        )
    except Exception:
        pass


def _load_config(cur, client_id: int) -> Dict[str, Any]:
    cur.execute(
        "SELECT approval_number, auto_expire_hours FROM "
        + portal_db._q(CONFIG_TABLE) + " WHERE client_id = %s",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    if not rows:
        return {"approval_number": "", "auto_expire_hours":
                DEFAULT_EXPIRE_HOURS}
    return {
        "approval_number": str(rows[0].get("approval_number") or ""),
        "auto_expire_hours": int(rows[0].get("auto_expire_hours")
                                 or DEFAULT_EXPIRE_HOURS),
    }


def _connector_phone(cur, client_id: int) -> str:
    """The WhatsApp number the connector currently runs (self-chat)."""
    cur.execute(
        "SELECT phone FROM " + portal_db._q(portal_db.STATUS_TABLE)
        + " WHERE client_id = %s",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    return _digits(rows[0].get("phone")) if rows else ""


def _approver_digits(cur, client_id: int) -> Tuple[str, str]:
    """(configured owner number, connector self number) — digits only."""
    config = _load_config(cur, client_id)
    return _digits(config.get("approval_number")), \
        _connector_phone(cur, client_id)


def _queue_send(cur, client_id: int, to_digits: str, body: str) -> None:
    """Queue a WhatsApp message through the connector command queue."""
    payload = {
        "external_user_id": _digits(to_digits) + "@c.us",
        "body": str(body or "")[:1500],
        "source": "approval",
    }
    cur.execute(
        "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
        " (client_id, channel, action, payload, status, requested_by,"
        " created_at, updated_at) "
        "VALUES (%s, 'whatsapp', 'send_message', CAST(%s AS JSONB),"
        " 'pending', NULL, NOW(), NOW())",
        (client_id, json.dumps(payload)),
    )


# ---------------------------------------------------------------------------
# Creation (v1 producer: high-risk request keywords; Action Engine later)
# ---------------------------------------------------------------------------

_RISK_RULES = (
    ("refund", ("refund", "paisay wapis", "paise wapis", "paisa wapis",
                "rupay wapis", "payment wapis", "amount wapis")),
    ("cancel_order", ("cancel order", "order cancel", "cancel kar do order",
                      "order kaansal")),
    ("discount", ("discount zyada", "aur discount", "zyada chhut",
                  "bada discount", "special discount")),
)


def _detect_risk_action(body: str) -> Optional[Tuple[str, str]]:
    """(action, plain label) when the message asks for a high-risk thing."""
    text = " ".join(str(body or "").lower().split())
    if not text:
        return None
    for action, needles in _RISK_RULES:
        for needle in needles:
            if needle in text:
                return action, {
                    "refund": "Refund request",
                    "cancel_order": "Order cancellation",
                    "discount": "Extra discount request",
                }[action]
    return None


def create_approval(cur, client_id: int, conversation_id, contact_id: str,
                    contact_name: Optional[str], action: str,
                    summary: str, customer_query: str,
                    context: Optional[dict] = None,
                    source: str = "ai") -> Optional[Dict[str, Any]]:
    """Create one pending approval + notify the owner on WhatsApp.

    Returns the created row dict ({id, ref_code, ...}) or None on any
    problem (fail-soft; callers never let this break their flow).
    """
    try:
        _ensure_ddl(cur)
        # one pending approval per (contact, action) — no spam
        cur.execute(
            "SELECT id, ref_code FROM " + portal_db._q(TABLE) +
            " WHERE client_id = %s AND contact_id = %s AND action = %s"
            " AND status = 'pending'"
            " ORDER BY created_at DESC LIMIT 1",
            (client_id, contact_id, action),
        )
        existing = portal_db.rows(cur)
        if existing:
            return None

        ref_code = "AP-" + secrets.token_hex(2).upper()
        config = _load_config(cur, client_id)
        cur.execute(
            "INSERT INTO " + portal_db._q(TABLE) +
            " (client_id, conversation_id, contact_id, contact_name,"
            " action, summary, customer_query, context_json, status,"
            " source, ref_code, expires_at)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s, CAST(%s AS JSONB),"
            " 'pending', %s, %s, NOW() + (%s || ' hours')::interval)"
            " RETURNING id",
            (client_id, conversation_id, contact_id,
             (contact_name or "")[:120] or None, action, summary[:500],
             (customer_query or "")[:500],
             json.dumps(context or {}), source, ref_code,
             str(config.get("auto_expire_hours") or DEFAULT_EXPIRE_HOURS)),
        )
        created = portal_db.rows(cur)
        approval_id = created[0]["id"] if created else None

        owner_digits, self_digits = _approver_digits(cur, client_id)
        target = owner_digits or self_digits
        name = (contact_name or contact_id or "Customer").strip()
        query_line = (customer_query or "").strip()
        if target:
            lines = [
                "\U0001F514 Approval " + ref_code,
                "Customer: " + name,
            ]
            contact_digits = _digits(contact_id)
            if contact_digits:
                lines[1] += " (" + contact_digits[-10:] + ")"
            lines.append("Maqsad: " + summary)
            if query_line:
                lines.append("Query: \"" + query_line[:200] + "\"")
            lines.append("Reply: 1 = approve, 0 = reject")
            lines.append("(kai pending hon to: \"1 " + ref_code + "\")")
            _queue_send(cur, client_id, target, "\n".join(lines))

        _audit(cur, client_id, "approval.created", {
            "approval_id": approval_id, "ref": ref_code,
            "action": action, "contact": contact_id,
            "notified": bool(target),
        })
        return {"id": approval_id, "ref_code": ref_code,
                "status": "pending", "action": action}
    except Exception:
        return None


def maybe_request(client_id: int, conversation_id, contact_id: str,
                  contact_name: Optional[str], body: str,
                  direction: str, conn) -> bool:
    """Inbound side-effect hook: risky customer requests become approvals.

    Never claims the message and never raises (fail-soft, like listen /
    routing). The AI's own reply flow stays untouched.
    """
    if direction != "in":
        return False
    hit = _detect_risk_action(body)
    if not hit:
        return False
    action, label = hit
    try:
        cur = conn.cursor()
        created = create_approval(
            cur, client_id, conversation_id, contact_id, contact_name,
            action, label + " — owner ki tasdeeq chahiye", body,
            {"detected_from": "inbound_message"}, source="ai",
        )
        return bool(created)
    except Exception:
        return False


# ---------------------------------------------------------------------------
# WhatsApp 1 / 0 decision loop
# ---------------------------------------------------------------------------

def decide(cur, client_id: int, approval_id: int, approve: bool,
           decided_by: str, decided_via: str) -> bool:
    """Mark one approval decided (pending only) + audit. True on success."""
    cur.execute(
        "UPDATE " + portal_db._q(TABLE) +
        " SET status = %s, decided_by = %s, decided_via = %s,"
        " decided_at = NOW(), updated_at = NOW()"
        " WHERE id = %s AND client_id = %s AND status = 'pending'",
        ("approved" if approve else "rejected", decided_by, decided_via,
         approval_id, client_id),
    )
    if (getattr(cur, "rowcount", 0) or 0) < 1:
        return False
    try:  # Action Engine se juri approval ho to asli effect ab chalega
        cur.execute(
            "SELECT * FROM " + portal_db._q(TABLE) + " WHERE id = %s",
            (approval_id,),
        )
        rows = portal_db.rows(cur)
        if rows:
            import portal_actions

            portal_actions.resolve_approval(
                cur, client_id, rows[0], approved)
    except Exception:
        pass
    _audit(cur, client_id,
           "approval." + ("approved" if approve else "rejected"), {
               "approval_id": approval_id, "by": decided_by,
               "via": decided_via,
           })
    return True


def maybe_decide(client_id: int, conversation_id, contact_id: str,
                 body: str, direction: str, conn) -> bool:
    """Claiming hook: the owner's 1/0 reply decides a pending approval.

    Runs FIRST in the inbound claim chain — an owner's ``1`` must never
    trigger away/brain/kb replies. Returns True when the message was an
    owner decision (or an owner attempt worth claiming, e.g. the
    multiple-pending hint) so nothing else answers it.
    """
    if direction != "in":
        return False
    match = _DECIDE_RE.match(str(body or ""))
    if not match:
        return False
    try:
        cur = conn.cursor()
        owner_digits, self_digits = _approver_digits(cur, client_id)
        sender = _digits(contact_id)
        if not sender or sender not in (n for n in (owner_digits,
                                                    self_digits) if n):
            return False

        approve = match.group(1) == "1"
        code = (match.group(2) or "").upper()

        cur.execute(
            "SELECT id, ref_code FROM " + portal_db._q(TABLE)
            + " WHERE client_id = %s AND status = 'pending'"
            " AND (expires_at IS NULL OR expires_at > NOW())"
            " ORDER BY created_at DESC LIMIT "
            + str(MAX_PENDING_SCAN),
            (client_id,),
        )
        pending = portal_db.rows(cur)
        if not pending:
            _queue_send(cur, client_id, sender,
                        "Koi pending approval nahi mila.")
            return True

        chosen = None
        if code:
            wanted = code.replace("AP-", "")
            chosen = next((row for row in pending
                           if str(row.get("ref_code", ""))
                           .upper().endswith(wanted)), None)
        elif len(pending) == 1:
            chosen = pending[0]

        if chosen is None:
            refs = ", ".join(str(row.get("ref_code"))
                             for row in pending[:5])
            _queue_send(cur, client_id, sender,
                        "Zyada pending approvals hain — code likhein,"
                        " maslan: \"1 " + (refs.split(",")[0].strip())
                        + "\". Pending: " + refs)
            return True

        ok = decide(cur, client_id, chosen["id"], approve,
                    sender, "whatsapp")
        if not ok:
            _queue_send(cur, client_id, sender,
                        "Ye approval already decide ho chuki hai.")
            return True
        _queue_send(
            cur, client_id, sender,
            ("\u2705 Approved " if approve else "\u274C Rejected ")
            + str(chosen.get("ref_code")) + ".",
        )
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Portal API
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


def _serialize(row: Dict[str, Any]) -> Dict[str, Any]:
    def _iso(value):
        try:
            return value.isoformat() if value is not None else None
        except Exception:
            return str(value) if value is not None else None
    context = row.get("context_json")
    if isinstance(context, str):
        try:
            context = json.loads(context)
        except Exception:
            context = {}
    return {
        "id": row.get("id"),
        "conversationId": row.get("conversation_id"),
        "contactId": row.get("contact_id"),
        "contactName": row.get("contact_name"),
        "action": row.get("action"),
        "summary": row.get("summary"),
        "customerQuery": row.get("customer_query"),
        "context": context or {},
        "status": row.get("status"),
        "source": row.get("source"),
        "refCode": row.get("ref_code"),
        "decidedBy": row.get("decided_by"),
        "decidedVia": row.get("decided_via"),
        "decidedAt": _iso(row.get("decided_at")),
        "expiresAt": _iso(row.get("expires_at")),
        "createdAt": _iso(row.get("created_at")),
    }


@bp.get("")
def list_approvals():
    principal, error = _principal_or_error()
    if error:
        return error
    status = (request.args.get("status") or "pending").strip().lower()
    if status not in ("pending", "approved", "rejected", "all"):
        status = "pending"
    where = "client_id = %(client)s"
    params: Dict[str, Any] = {"client": principal["client_id"],
                              "limit": 50}
    if status != "all":
        where += " AND status = %(status)s"
        params["status"] = status
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                cur.execute(
                    "UPDATE " + portal_db._q(TABLE) +
                    " SET status = 'expired', updated_at = NOW()"
                    " WHERE client_id = %(client)s AND status = 'pending'"
                    " AND expires_at IS NOT NULL AND expires_at < NOW()",
                    {"client": principal["client_id"]},
                )
                cur.execute(
                    "SELECT * FROM " + portal_db._q(TABLE) +
                    " WHERE " + where +
                    " ORDER BY created_at DESC LIMIT %(limit)s",
                    params,
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as exc:
        return jsonify(portal_db.portal_unavailable(
            exc, "approvals list")[0]), 503
    return jsonify({"approvals": [_serialize(row) for row in rows]}), 200


@bp.post("/<int:approval_id>/decide")
def decide_approval(approval_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    decision = str(payload.get("decision") or "").strip().lower()
    if decision not in ("approve", "reject"):
        return jsonify({"error": {
            "code": "bad_request",
            "message": "decision approve|reject hon."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                cur.execute(
                    "SELECT id, ref_code FROM " + portal_db._q(TABLE) +
                    " WHERE id = %s AND client_id = %s AND"
                    " status = 'pending'",
                    (approval_id, principal["client_id"]),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    return jsonify({"error": {
                        "code": "not_found",
                        "message": "Pending approval nahi mili."}}), 404
                ok = decide(cur, principal["client_id"], approval_id,
                            decision == "approve",
                            str(principal.get("email")
                                or principal.get("user_id")),
                            "portal")
                if not ok:
                    return jsonify({"error": {
                        "code": "conflict",
                        "message": "Already decided."}}), 409
        finally:
            conn.close()
    except Exception as exc:
        return jsonify(portal_db.portal_unavailable(
            exc, "approvals decide")[0]), 503
    return jsonify({"ok": True,
                    "status": "approved" if decision == "approve"
                    else "rejected"}), 200


@bp.get("/config")
def get_config():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                config = _load_config(cur, principal["client_id"])
                owner_digits, self_digits = _approver_digits(
                    cur, principal["client_id"])
        finally:
            conn.close()
    except Exception as exc:
        return jsonify(portal_db.portal_unavailable(
            exc, "approvals config")[0]), 503
    return jsonify({
        "approvalNumber": config.get("approval_number") or "",
        "autoExpireHours": config.get("auto_expire_hours"),
        "selfChatAvailable": bool(self_digits),
    }), 200


@bp.put("/config")
def put_config():
    principal, error = _principal_or_error()
    if error:
        return error
    if str(principal.get("role") or "") != "owner":
        return jsonify({"error": {
            "code": "forbidden",
            "message": "Sirf owner approval settings badal sakta hai."}}), \
            403
    payload = request.get_json(silent=True) or {}
    number = _digits(payload.get("approvalNumber"))
    if number and len(number) < 10:
        return jsonify({"error": {
            "code": "bad_request",
            "message": "WhatsApp number mukammal likhein (e.g. 92300...)."
        }}), 400
    try:
        hours = int(payload.get("autoExpireHours")
                    or DEFAULT_EXPIRE_HOURS)
    except (TypeError, ValueError):
        hours = DEFAULT_EXPIRE_HOURS
    hours = max(1, min(168, hours))
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                cur.execute(
                    "INSERT INTO " + portal_db._q(CONFIG_TABLE) +
                    " (client_id, approval_number, auto_expire_hours,"
                    " updated_at) VALUES (%s, %s, %s, NOW())"
                    " ON CONFLICT (client_id) DO UPDATE SET"
                    " approval_number = EXCLUDED.approval_number,"
                    " auto_expire_hours = EXCLUDED.auto_expire_hours,"
                    " updated_at = NOW()",
                    (principal["client_id"], number or None, hours),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        return jsonify(portal_db.portal_unavailable(
            exc, "approvals config save")[0]), 503
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _audit(cur, principal["client_id"],
                       "approval.config", {"number_set": bool(number),
                                           "hours": hours})
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass
    return jsonify({"ok": True}), 200
