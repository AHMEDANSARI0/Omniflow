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

v2 (batch 224)
--------------
* generic kinds (``action`` / ``workflow_step`` / ``customer_request`` /
  ``config_change`` / ``other``) - legacy rows get theirs derived from
  ``source`` + ``action``; future engines plug in a resolver with
  ``register_resolver(kind, fn)`` instead of growing this module;
* impact (what approving / rejecting does, money at stake) is computed on
  read from the stored context, so old rows show it too;
* evidence (recent messages, order history, customer notes, earlier
  decisions, matching business policies) on the detail endpoint, each
  source fail-soft behind its own savepoint;
* edit-before-approve for Action Engine approvals: scalar args and simple
  item lists only, type-preserving, ids never editable;
* optional reply to the customer and a decision note on every decision;
* the outcome of approving (executed / failed / recorded / reply sent) is
  stored and shown, and a failed execution can be retried once fixed;
* only human owner/admin sessions decide in the portal
  (``OF_APPROVAL_DECIDE_ROLES``); API keys stay read-only.
"""

import json
import math
import os
import re
import secrets
from typing import Any, Callable, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_db
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
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

#: Roles that may decide an approval in the portal (WhatsApp 1/0 stays
#: limited to the configured owner number / the connector self-chat).
DECIDE_ROLES = tuple(
    role.strip().lower() for role in (
        os.environ.get("OF_APPROVAL_DECIDE_ROLES") or "owner,admin"
    ).split(",") if role.strip()) or ("owner", "admin")

KINDS = (
    ("action", "AI action"),
    ("workflow_step", "Workflow step"),
    ("customer_request", "Customer request"),
    ("config_change", "Settings change"),
    ("social_post", "Social post"),  # §255: portal_social registers the resolver
    ("other", "Other"),
)
KIND_LABELS = dict(KINDS)
#: legacy keyword approvals (maybe_request) -> customer_request
CUSTOMER_REQUEST_ACTIONS = ("refund", "cancel_order", "discount")
#: args the owner may never edit (identity / references / internals)
_LOCKED_ARGS = ("contact_id", "conversation_id", "customer_query")
MAX_EDIT_TEXT = 1500
MAX_REPLY = 1000
MAX_NOTE = 300

_RESOLVERS: Dict[str, Callable[..., Dict[str, Any]]] = {}

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
    # v2 columns: a DO block so the steady state takes no table lock
    # (ALTER ... IF NOT EXISTS would lock on every call) and a rolled-back
    # first run simply repeats next time.
    table_literal = TABLE.replace("'", "''")
    cur.execute(
        "CREATE INDEX IF NOT EXISTS portal_approvals_pending_idx ON "
        + portal_db._q(TABLE) + " (client_id, status, created_at DESC);"
        " DO $of$ BEGIN IF NOT EXISTS (SELECT 1 FROM"
        " information_schema.columns WHERE table_schema = current_schema()"
        " AND table_name = '" + table_literal + "'"
        " AND column_name = 'outcome_detail') THEN"
        " ALTER TABLE " + portal_db._q(TABLE) +
        " ADD COLUMN IF NOT EXISTS kind TEXT,"
        " ADD COLUMN IF NOT EXISTS risk TEXT,"
        " ADD COLUMN IF NOT EXISTS edits_json JSONB,"
        " ADD COLUMN IF NOT EXISTS decision_note TEXT,"
        " ADD COLUMN IF NOT EXISTS customer_reply TEXT,"
        " ADD COLUMN IF NOT EXISTS outcome TEXT,"
        " ADD COLUMN IF NOT EXISTS outcome_detail TEXT;"
        " END IF; END $of$"
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


def _queue_customer_reply(cur, client_id: int, contact_id: str,
                          body: str) -> bool:
    """Owner-written reply to the customer on the contact's own channel.

    Same command queue + opt-out guard as the Action Engine message tool.
    """
    target = str(contact_id or "").strip()
    text = str(body or "").strip()[:MAX_REPLY]
    if not target or target == "unknown" or not text:
        return False
    import portal_channels

    cur.execute(
        "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
        " (client_id, channel, action, payload, status, requested_by,"
        " created_at, updated_at)"
        " SELECT %s, %s, 'send_message', CAST(%s AS JSONB), 'pending',"
        " NULL, NOW(), NOW()"
        " WHERE NOT EXISTS (SELECT 1 FROM " + portal_db._q("portal_optouts")
        + " WHERE client_id = %s AND contact_id = %s)",
        (client_id, portal_channels.channel_for_contact(target),
         json.dumps({"external_user_id": target, "body": text,
                     "source": "approval"}), client_id, target),
    )
    return (getattr(cur, "rowcount", 0) or 0) > 0


# ---------------------------------------------------------------------------
# v2: kinds, impact, edit-before-approve, evidence, resolvers
# ---------------------------------------------------------------------------

def register_resolver(kind: str,
                      fn: Callable[..., Dict[str, Any]]) -> None:
    """Plug in what approving a ``kind`` does.

    ``fn(cur, client_id, row, approved, args_override, customer_reply)``
    returns ``{"outcome": str, "detail": str}`` and raises on failure (the
    caller wraps it in a savepoint, so the decision itself is kept).
    """
    _RESOLVERS[str(kind)] = fn


def _context(row: Dict[str, Any]) -> Dict[str, Any]:
    context = row.get("context_json")
    if isinstance(context, str):
        try:
            context = json.loads(context or "{}")
        except Exception:
            context = {}
    return context if isinstance(context, dict) else {}


def _edits(row: Dict[str, Any]) -> Dict[str, Any]:
    edits = row.get("edits_json")
    if isinstance(edits, str):
        try:
            edits = json.loads(edits or "{}")
        except Exception:
            edits = {}
    return edits if isinstance(edits, dict) else {}


def kind_of(row: Dict[str, Any]) -> str:
    """Stored kind, or the one a legacy (pre-v2) row implies."""
    kind = str(row.get("kind") or "")
    if kind in KIND_LABELS:
        return kind
    source = str(row.get("source") or "")
    if source == "agent":
        return "action"
    if source == "workflow":
        return "workflow_step"
    if str(row.get("action") or "") in CUSTOMER_REQUEST_ACTIONS:
        return "customer_request"
    return "other"


def _action_args(row: Dict[str, Any]) -> Dict[str, Any]:
    """Args the action will run with: stored args + the owner's edits."""
    args = dict(_context(row).get("args") or {})
    edited = _edits(row).get("args")
    if isinstance(edited, dict):
        args.update(edited)
    return args


def risk_of(row: Dict[str, Any]) -> str:
    risk = str(row.get("risk") or "")
    if risk:
        return risk
    kind = kind_of(row)
    if kind == "action":
        try:
            import portal_actions

            name = str(_context(row).get("action") or row.get("action") or "")
            if name in portal_actions.ACTIONS:
                return portal_actions._effective_risk(name, _action_args(row))
        except Exception:
            pass
        return "high"
    if kind == "customer_request":
        return "high"
    return ""


def _number(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _money(args: Dict[str, Any]) -> Dict[str, float]:
    """Money at stake, from the args the action actually runs with."""
    out: Dict[str, float] = {}
    items = args.get("items")
    if isinstance(items, list) and items:
        subtotal = 0.0
        for item in items:
            if not isinstance(item, dict):
                continue
            qty = _number(item.get("qty")) or 1.0
            price = _number(item.get("price")) or 0.0
            subtotal += max(0.0, qty) * max(0.0, price)
        out["subtotal"] = round(subtotal, 2)
    for key in ("discount", "amount", "refund_amount", "total"):
        number = _number(args.get(key))
        if number is not None and number > 0:
            out[key] = round(number, 2)
    if "subtotal" in out and "total" not in out:
        out["total"] = round(max(out["subtotal"] - out.get("discount", 0.0),
                                 0.0), 2)
    return out


_ACTION_EFFECTS = {
    "request_refund": (
        "Marks the refund request as approved in your action requests."
        " No money is moved automatically - pay it out as you normally do.",
        "The customer gets a short note that the request could not be"
        " processed right now (or your reply, if you write one)."),
    "request_order_cancel": (
        "Marks the cancellation as approved in your action requests."
        " Update the order in your store or with the courier as usual.",
        "The customer gets a short note that the request could not be"
        " processed right now (or your reply, if you write one)."),
    "create_checkout_link": (
        "Creates a checkout link for the customer with the amounts below.",
        "No link is created."),
    "queue_whatsapp_message": (
        "Sends the message below to the customer.",
        "Nothing is sent."),
}


def impact_of(row: Dict[str, Any]) -> Dict[str, Any]:
    """What approving / rejecting does - computed from the stored context."""
    kind = kind_of(row)
    context = _context(row)
    if kind == "action":
        name = str(context.get("action") or row.get("action") or "")
        effect, on_reject = _ACTION_EFFECTS.get(name, ("", "Nothing runs."))
        if not effect:
            try:
                import portal_actions

                spec = portal_actions.ACTIONS.get(name) or {}
                effect = "Runs: " + str(spec.get("description") or name) + "."
            except Exception:
                effect = "Runs the requested action."
        return {"effect": effect, "onReject": on_reject,
                "money": _money(_action_args(row)),
                "action": name}
    if kind == "workflow_step":
        return {"effect": "Workflow #" + str(context.get("workflow_id") or "?")
                + " continues after step "
                + str(context.get("step_no") or "?") + ".",
                "onReject": "The workflow run stops here.", "money": {}}
    if kind == "customer_request":
        return {"effect": "Records your decision. Nothing runs automatically"
                          " - add a reply below to tell the customer.",
                "onReject": "Records your decision. Add a reply below to"
                            " tell the customer.", "money": {}}
    if kind == "config_change":
        return {"effect": "Applies the settings change described above.",
                "onReject": "The settings stay as they are.", "money": {}}
    return {"effect": "Records your decision.",
            "onReject": "Records your decision.", "money": {}}


def _editable_key(key: str) -> bool:
    return (not key.startswith("_") and not key.endswith("_id")
            and key not in _LOCKED_ARGS)


def _scalar_type(value: Any) -> str:
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "text"
    return ""


def editable_fields(row: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Fields the owner may change before approving (action kind only)."""
    if kind_of(row) != "action" or row.get("status") != "pending":
        return []
    original = dict(_context(row).get("args") or {})
    current = _action_args(row)
    fields: List[Dict[str, Any]] = []
    for key in sorted(original):
        if not _editable_key(key):
            continue
        value = current.get(key, original[key])
        kind = _scalar_type(original[key])
        if kind:
            fields.append({"key": key, "type": kind, "value": value,
                           "label": key.replace("_", " ").capitalize()})
            continue
        items = original[key]
        if (isinstance(items, list) and items
                and all(isinstance(item, dict) for item in items)):
            columns: Dict[str, str] = {}
            for item in items:
                for name, cell in item.items():
                    cell_type = _scalar_type(cell)
                    if cell_type and not name.endswith("_id"):
                        columns.setdefault(name, cell_type)
            if columns:
                fields.append({
                    "key": key, "type": "items",
                    "label": key.replace("_", " ").capitalize(),
                    "columns": [{"key": name, "type": columns[name]}
                                for name in columns],
                    "value": value if isinstance(value, list) else items})
    return fields


def _clean_scalar(expected: Any, value: Any, label: str) -> Any:
    kind = _scalar_type(expected)
    if kind == "boolean":
        if not isinstance(value, bool):
            raise ValueError(label + " must be yes or no.")
        return value
    if kind == "number":
        number = _number(value)
        if number is None or isinstance(value, bool) \
                or abs(number) > 1e9:
            raise ValueError(label + " must be a number.")
        return int(number) if isinstance(expected, int) \
            and float(number).is_integer() else number
    if kind == "text":
        if not isinstance(value, str):
            raise ValueError(label + " must be text.")
        text = value.strip()
        if len(text) > MAX_EDIT_TEXT:
            raise ValueError(label + " is too long.")
        return text
    raise ValueError(label + " cannot be edited.")


def apply_edits(row: Dict[str, Any], edits: Any) -> Dict[str, Any]:
    """Validate the owner's edits against the stored args.

    Type-preserving; only keys that exist and are editable; item lists may
    change values or drop rows (at least one stays) but never gain keys.
    Returns the cleaned ``{key: value}`` map (only changed keys).
    Raises ValueError with a plain message.
    """
    if edits in (None, {}):
        return {}
    if not isinstance(edits, dict):
        raise ValueError("args must be an object.")
    if kind_of(row) != "action":
        raise ValueError("Only AI action approvals can be edited.")
    original = dict(_context(row).get("args") or {})
    cleaned: Dict[str, Any] = {}
    for key, value in edits.items():
        key = str(key)
        if key not in original or not _editable_key(key):
            raise ValueError(key + " cannot be edited.")
        label = key.replace("_", " ").capitalize()
        expected = original[key]
        if _scalar_type(expected):
            new_value = _clean_scalar(expected, value, label)
        elif isinstance(expected, list) and expected \
                and all(isinstance(item, dict) for item in expected):
            if not isinstance(value, list) or not value \
                    or len(value) > len(expected):
                raise ValueError(label + ": keep between 1 and "
                                 + str(len(expected)) + " rows.")
            template: Dict[str, Any] = {}
            for item in expected:
                for name, cell in item.items():
                    template.setdefault(name, cell)
            new_value = []
            for item in value:
                if not isinstance(item, dict):
                    raise ValueError(label + ": each row must be an object.")
                clean_item = {}
                for name, cell in item.items():
                    if name not in template or name.endswith("_id") \
                            or not _scalar_type(template[name]):
                        raise ValueError(label + ": " + str(name)
                                         + " cannot be edited.")
                    clean_item[name] = _clean_scalar(
                        template[name], cell, label + " " + str(name))
                new_value.append(clean_item)
        else:
            raise ValueError(label + " cannot be edited.")
        if new_value != expected:
            cleaned[key] = new_value
    try:
        import portal_actions

        name = str(_context(row).get("action") or "")
        spec = portal_actions.ACTIONS.get(name) or {}
        merged = dict(original)
        merged.update(cleaned)
        missing = [key for key in spec.get("required", [])
                   if not merged.get(key)]
        if missing:
            raise ValueError(", ".join(missing) + " cannot be empty.")
    except ValueError:
        raise
    except Exception:
        pass
    return cleaned


def _evidence_part(cur, name: str, fn: Callable[[], Any],
                   out: Dict[str, Any]) -> None:
    """Run one evidence query behind a savepoint (missing tables etc. never
    break the detail view or the surrounding transaction)."""
    cur.execute("SAVEPOINT approval_evidence")
    try:
        value = fn()
        cur.execute("RELEASE SAVEPOINT approval_evidence")
        if value not in (None, [], {}):
            out[name] = value
    except Exception:
        cur.execute("ROLLBACK TO SAVEPOINT approval_evidence")


def _iso_value(value: Any) -> Optional[str]:
    if value is None:
        return None
    try:
        return value.isoformat()
    except Exception:
        return str(value)


_POLICY_KINDS = {
    "refund": ("refund", "policy"), "request_refund": ("refund", "policy"),
    "cancel_order": ("refund", "policy"),
    "request_order_cancel": ("refund", "policy"),
    "discount": ("pricing", "policy"),
    "create_checkout_link": ("pricing", "policy"),
}


def evidence_for(cur, client_id: int, row: Dict[str, Any]) -> Dict[str, Any]:
    """Why this approval exists + what the owner should know before deciding."""
    out: Dict[str, Any] = {}
    contact_id = str(row.get("contact_id") or "")
    has_contact = bool(contact_id) and contact_id != "unknown"
    conversation_id = row.get("conversation_id")
    context = _context(row)

    trigger = {"source": str(row.get("source") or "")}
    if context.get("detected_from"):
        trigger["detectedFrom"] = str(context.get("detected_from"))
    if context.get("actor"):
        trigger["actor"] = str(context.get("actor"))[:80]
    if context.get("workflow_id"):
        trigger["workflowId"] = context.get("workflow_id")
        trigger["stepNo"] = context.get("step_no")
    out["trigger"] = trigger

    if conversation_id:
        def messages():
            cur.execute(
                "SELECT direction, body, created_at FROM "
                + portal_db._q("portal_messages") +
                " WHERE client_id = %s AND conversation_id = %s"
                " ORDER BY id DESC LIMIT 6",
                (client_id, conversation_id),
            )
            return [{"direction": str(r.get("direction") or ""),
                     "body": str(r.get("body") or "")[:300],
                     "at": _iso_value(r.get("created_at"))}
                    for r in reversed(portal_db.rows(cur))]
        _evidence_part(cur, "recentMessages", messages, out)

    if has_contact:
        def orders():
            import portal_risk

            history = portal_risk.build_history(cur, client_id, contact_id)
            if not any(history.get(key) for key in
                       ("delivered", "returned", "cancelled", "open")):
                return None
            return {key: history.get(key) for key in
                    ("delivered", "returned", "cancelled", "open",
                     "avg_value")}
        _evidence_part(cur, "orders", orders, out)

        def notes():
            import portal_memory

            return [{"kind": str(r.get("kind") or ""),
                     "content": str(r.get("content") or "")[:200]}
                    for r in portal_memory.list_memory(
                        cur, client_id, contact_id)[:5]]
        _evidence_part(cur, "customerNotes", notes, out)

        def earlier():
            cur.execute(
                "SELECT action, status, summary, decided_at FROM "
                + portal_db._q(TABLE) +
                " WHERE client_id = %s AND contact_id = %s AND id <> %s"
                " AND status <> 'pending' ORDER BY id DESC LIMIT 5",
                (client_id, contact_id, row.get("id")),
            )
            return [{"action": str(r.get("action") or ""),
                     "status": str(r.get("status") or ""),
                     "summary": str(r.get("summary") or "")[:120],
                     "decidedAt": _iso_value(r.get("decided_at"))}
                    for r in portal_db.rows(cur)]
        _evidence_part(cur, "earlierDecisions", earlier, out)

    action = str(context.get("action") or row.get("action") or "")
    kinds = _POLICY_KINDS.get(action)
    if kinds:
        def policies():
            cur.execute(
                "SELECT kind, label, content FROM "
                + portal_db._q("portal_brain_facts") +
                " WHERE client_id = %s AND is_active = TRUE"
                " AND kind IN %s ORDER BY id DESC LIMIT 3",
                (client_id, tuple(kinds)),
            )
            return [{"kind": str(r.get("kind") or ""),
                     "label": str(r.get("label") or ""),
                     "content": str(r.get("content") or "")[:400]}
                    for r in portal_db.rows(cur)]
        _evidence_part(cur, "policies", policies, out)
    return out


def _resolve(cur, client_id: int, row: Dict[str, Any], approved: bool,
             reply: str) -> Dict[str, Any]:
    """What the decision does. Raises on failure (caller holds a savepoint)."""
    kind = kind_of(row)
    resolver = _RESOLVERS.get(kind)
    if resolver is None and kind == "action":
        import portal_actions

        resolver = portal_actions.resolve_approval
    if resolver is not None:
        edited = _edits(row).get("args")
        result = resolver(cur, client_id, row, approved,
                          args_override=edited if isinstance(edited, dict)
                          else None,
                          customer_reply=reply)
        if isinstance(result, dict) and result.get("outcome"):
            return {"outcome": str(result["outcome"]),
                    "detail": str(result.get("detail") or "")[:300]}
        return {"outcome": "recorded", "detail": ""}
    if reply:
        sent = _queue_customer_reply(cur, client_id,
                                     str(row.get("contact_id") or ""), reply)
        return {"outcome": "reply_sent" if sent else "recorded",
                "detail": "" if sent else
                "Reply not sent (customer opted out or no contact)."}
    return {"outcome": "recorded", "detail": ""}


def _apply_outcome(cur, client_id: int, row: Dict[str, Any],
                   approved: bool, reply: str) -> Dict[str, Any]:
    """Run the resolver behind a savepoint and store the outcome."""
    cur.execute("SAVEPOINT approval_resolve")
    try:
        outcome = _resolve(cur, client_id, row, approved, reply)
        cur.execute("RELEASE SAVEPOINT approval_resolve")
    except Exception as error:
        cur.execute("ROLLBACK TO SAVEPOINT approval_resolve")
        outcome = {"outcome": "failed",
                   "detail": (type(error).__name__ + ": "
                              + str(error))[:300]}
    cur.execute(
        "UPDATE " + portal_db._q(TABLE) +
        " SET outcome = %s, outcome_detail = %s, updated_at = NOW()"
        " WHERE id = %s AND client_id = %s",
        (outcome["outcome"], outcome["detail"] or None, row.get("id"),
         client_id),
    )
    return outcome


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
                    source: str = "ai", kind: Optional[str] = None,
                    risk: Optional[str] = None) -> Optional[Dict[str, Any]]:
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
        probe = {"source": source, "action": action,
                 "context_json": context or {}}
        kind = kind if kind in KIND_LABELS else kind_of(probe)
        probe["kind"] = kind
        risk = str(risk or risk_of(probe) or "")[:16] or None
        cur.execute(
            "INSERT INTO " + portal_db._q(TABLE) +
            " (client_id, conversation_id, contact_id, contact_name,"
            " action, summary, customer_query, context_json, status,"
            " source, ref_code, expires_at, kind, risk)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s, CAST(%s AS JSONB),"
            " 'pending', %s, %s, NOW() + (%s || ' hours')::interval,"
            " %s, %s)"
            " RETURNING id",
            (client_id, conversation_id, contact_id,
             (contact_name or "")[:120] or None, action, summary[:500],
             (customer_query or "")[:500],
             json.dumps(context or {}, default=str), source, ref_code,
             str(config.get("auto_expire_hours") or DEFAULT_EXPIRE_HOURS),
             kind, risk),
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
            money = impact_of(probe).get("money") or {}
            if money:
                lines.append("Raqam: " + ", ".join(
                    key + " Rs " + format(value, ",.0f")
                    for key, value in money.items()))
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
        try:
            import portal_notify

            portal_notify.notify(
                client_id, "approval",
                "Approval " + ref_code + ": " + str(summary or action)[:120],
                ("Customer " + name + (": \"" + query_line[:160] + "\""
                                       if query_line else "")
                 + ". Reply 1 to approve or 0 to reject on WhatsApp, or"
                 " decide in Approvals."),
                severity="high", dedupe_key="approval:" + str(approval_id),
                conversation_id=conversation_id)
        except Exception:
            pass
        return {"id": approval_id, "ref_code": ref_code,
                "status": "pending", "action": action, "kind": kind}
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
           decided_by: str, decided_via: str, note: str = "",
           reply: str = "", edits: Optional[Dict[str, Any]] = None) -> bool:
    """Public seam (bool): see ``_decide``."""
    return _decide(cur, client_id, approval_id, approve, decided_by,
                   decided_via, note, reply, edits) is not None


def _decide(cur, client_id: int, approval_id: int, approve: bool,
            decided_by: str, decided_via: str, note: str = "",
            reply: str = "", edits: Optional[Dict[str, Any]] = None
            ) -> Optional[Dict[str, Any]]:
    """Mark one approval decided (pending, not expired) + run its effect.

    The decision row is written first; the effect (Action Engine run,
    workflow resume flag, customer reply) runs behind a savepoint so a
    failing effect never loses the decision - it is stored as outcome
    ``failed`` and can be retried. Returns the outcome dict when this call
    made the decision, None when it was already decided / expired.
    """
    note = str(note or "").strip()[:MAX_NOTE]
    reply = str(reply or "").strip()[:MAX_REPLY]
    cur.execute(
        "UPDATE " + portal_db._q(TABLE) +
        " SET status = %s, decided_by = %s, decided_via = %s,"
        " decided_at = NOW(), updated_at = NOW(),"
        " decision_note = %s, customer_reply = %s,"
        " edits_json = COALESCE(CAST(%s AS JSONB), edits_json)"
        " WHERE id = %s AND client_id = %s AND status = 'pending'"
        " AND (expires_at IS NULL OR expires_at > NOW())",
        ("approved" if approve else "rejected", decided_by, decided_via,
         note or None, reply or None,
         json.dumps({"args": edits}, default=str) if edits else None,
         approval_id, client_id),
    )
    if (getattr(cur, "rowcount", 0) or 0) < 1:
        return None
    cur.execute(
        "SELECT * FROM " + portal_db._q(TABLE) + " WHERE id = %s"
        " AND client_id = %s",
        (approval_id, client_id),
    )
    rows = portal_db.rows(cur)
    outcome = {"outcome": "recorded", "detail": ""}
    if rows:
        outcome = _apply_outcome(cur, client_id, rows[0], approve, reply)
    detail = {"approval_id": approval_id, "by": decided_by,
              "via": decided_via, "outcome": outcome["outcome"]}
    if edits:
        detail["edited"] = sorted(edits)
    if note:
        detail["note"] = note[:120]
    if reply:
        detail["reply"] = True
    _audit(cur, client_id,
           "approval." + ("approved" if approve else "rejected"), detail)
    return outcome


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

        outcome = _decide(cur, client_id, chosen["id"], approve,
                          sender, "whatsapp")
        if outcome is None:
            _queue_send(cur, client_id, sender,
                        "Ye approval already decide ho chuki hai.")
            return True
        _queue_send(
            cur, client_id, sender,
            ("\u2705 Approved " if approve else "\u274C Rejected ")
            + str(chosen.get("ref_code")) + "."
            + (" Lekin action nahi chal saka - portal ke Approvals page"
               " par Retry karein." if outcome.get("outcome") == "failed"
               else ""),
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


def _decider_error(principal: Dict[str, Any]):
    """Portal decisions: human session with an owner/admin role only."""
    forbidden = ensure_human_principal(principal)
    if forbidden:
        return forbidden
    if str(principal.get("role") or "").lower() not in DECIDE_ROLES:
        return (jsonify({"error": {
            "code": "forbidden",
            "message": "Only " + " / ".join(DECIDE_ROLES)
                       + " can decide approvals."}}), 403)
    return None


def _serialize(row: Dict[str, Any]) -> Dict[str, Any]:
    _iso = _iso_value
    context = _context(row)
    kind = kind_of(row)
    edited = _edits(row).get("args")
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
        "kind": kind,
        "kindLabel": KIND_LABELS.get(kind, "Other"),
        "risk": risk_of(row),
        "impact": impact_of(row),
        "edits": edited if isinstance(edited, dict) else {},
        "decisionNote": row.get("decision_note"),
        "customerReply": row.get("customer_reply"),
        "outcome": row.get("outcome"),
        "outcomeDetail": row.get("outcome_detail"),
        "canReply": kind != "action" or str(context.get("action") or "")
        in ("request_refund", "request_order_cancel"),
    }


def _expire_pending(cur, client_id: int) -> None:
    cur.execute(
        "UPDATE " + portal_db._q(TABLE) +
        " SET status = 'expired', updated_at = NOW()"
        " WHERE client_id = %(client)s AND status = 'pending'"
        " AND expires_at IS NOT NULL AND expires_at < NOW()",
        {"client": client_id},
    )


@bp.get("")
def list_approvals():
    principal, error = _principal_or_error()
    if error:
        return error
    status = (request.args.get("status") or "pending").strip().lower()
    if status not in ("pending", "approved", "rejected", "expired", "all"):
        status = "pending"
    kind = (request.args.get("kind") or "").strip().lower()
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
                _expire_pending(cur, principal["client_id"])
                cur.execute(
                    "SELECT * FROM " + portal_db._q(TABLE) +
                    " WHERE " + where +
                    " ORDER BY created_at DESC LIMIT %(limit)s",
                    params,
                )
                rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        return jsonify(portal_db.portal_unavailable(
            exc, "approvals list")[0]), 503
    items = [_serialize(row) for row in rows]
    if kind in KIND_LABELS:
        items = [item for item in items if item["kind"] == kind]
    return jsonify({"approvals": items,
                    "kinds": [{"key": key, "label": label}
                              for key, label in KINDS]}), 200


@bp.get("/<int:approval_id>")
def get_approval(approval_id: int):
    """One approval + editable fields + evidence for the decision panel."""
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                _expire_pending(cur, client_id)
                cur.execute(
                    "SELECT * FROM " + portal_db._q(TABLE) +
                    " WHERE id = %s AND client_id = %s",
                    (approval_id, client_id),
                )
                rows = portal_db.rows(cur)
                evidence = evidence_for(cur, client_id, rows[0]) \
                    if rows else {}
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        return jsonify(portal_db.portal_unavailable(
            exc, "approval detail")[0]), 503
    if not rows:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Approval not found."}}), 404
    body = _serialize(rows[0])
    body["editable"] = editable_fields(rows[0])
    body["evidence"] = evidence
    body["canDecide"] = (not principal.get("via_api_key")
                         and str(principal.get("role") or "").lower()
                         in DECIDE_ROLES)
    return jsonify({"approval": body}), 200


@bp.post("/<int:approval_id>/decide")
def decide_approval(approval_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    denied = _decider_error(principal)
    if denied:
        return denied
    payload = request.get_json(silent=True) or {}
    decision = str(payload.get("decision") or "").strip().lower()
    if decision not in ("approve", "reject"):
        return jsonify({"error": {
            "code": "bad_request",
            "message": "decision must be approve or reject."}}), 400
    note = payload.get("note")
    reply = payload.get("reply")
    if (note is not None and not isinstance(note, str)) or \
            (reply is not None and not isinstance(reply, str)):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "note and reply must be text."}}), 400
    if reply and len(reply.strip()) > MAX_REPLY:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Reply is too long (max "
                                  + str(MAX_REPLY) + " characters)."}}), 400
    client_id = principal["client_id"]
    actor = str(principal.get("email") or principal.get("user_id"))
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                cur.execute(
                    "SELECT * FROM " + portal_db._q(TABLE) +
                    " WHERE id = %s AND client_id = %s FOR UPDATE",
                    (approval_id, client_id),
                )
                rows = portal_db.rows(cur)
                if not rows or rows[0].get("status") != "pending":
                    conn.rollback()
                    if not rows:
                        return jsonify({"error": {
                            "code": "not_found",
                            "message": "Approval not found."}}), 404
                    return jsonify({"error": {
                        "code": "conflict",
                        "message": "This approval was already "
                                   + str(rows[0].get("status")) + "."}}), 409
                edits: Dict[str, Any] = {}
                if decision == "approve":
                    try:
                        edits = apply_edits(rows[0], payload.get("args"))
                    except ValueError as bad:
                        conn.rollback()
                        return jsonify({"error": {
                            "code": "bad_request",
                            "message": str(bad)}}), 400
                if edits:
                    _audit(cur, client_id, "approval.edited", {
                        "approval_id": approval_id, "by": actor,
                        "fields": sorted(edits)}, actor_kind="customer_user")
                outcome = _decide(cur, client_id, approval_id,
                                  decision == "approve", actor, "portal",
                                  note=note or "", reply=reply or "",
                                  edits=edits or None)
                if outcome is None:
                    conn.rollback()
                    return jsonify({"error": {
                        "code": "conflict",
                        "message": "This approval has expired."}}), 409
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        return jsonify(portal_db.portal_unavailable(
            exc, "approvals decide")[0]), 503
    return jsonify({"ok": True,
                    "status": "approved" if decision == "approve"
                    else "rejected",
                    "outcome": outcome.get("outcome"),
                    "outcomeDetail": outcome.get("detail") or ""}), 200


@bp.post("/<int:approval_id>/retry")
def retry_approval(approval_id: int):
    """Approved but the effect failed (e.g. a missing table, a bad item):
    run it again once the cause is fixed. Never re-runs a success."""
    principal, error = _principal_or_error()
    if error:
        return error
    denied = _decider_error(principal)
    if denied:
        return denied
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                cur.execute(
                    "UPDATE " + portal_db._q(TABLE) +
                    " SET outcome = 'retrying', updated_at = NOW()"
                    " WHERE id = %s AND client_id = %s"
                    " AND status = 'approved' AND outcome = 'failed'"
                    " RETURNING *",
                    (approval_id, client_id),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    conn.rollback()
                    return jsonify({"error": {
                        "code": "conflict",
                        "message": "Only approved items whose action failed"
                                   " can be retried."}}), 409
                outcome = _apply_outcome(
                    cur, client_id, rows[0], True,
                    str(rows[0].get("customer_reply") or ""))
                _audit(cur, client_id, "approval.retried", {
                    "approval_id": approval_id,
                    "by": str(principal.get("email")
                              or principal.get("user_id")),
                    "outcome": outcome["outcome"]},
                    actor_kind="customer_user")
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        return jsonify(portal_db.portal_unavailable(
            exc, "approvals retry")[0]), 503
    return jsonify({"ok": True, "outcome": outcome["outcome"],
                    "outcomeDetail": outcome["detail"]}), 200


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
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or "approvalNumber" not in payload:
        # a body that did not parse must never wipe the saved number
        return jsonify({"error": {
            "code": "bad_request",
            "message": "Send JSON with approvalNumber and autoExpireHours."
        }}), 400
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
                try:
                    import portal_snapshots

                    portal_snapshots.before_change(
                        cur, principal["client_id"], "approvals",
                        str(principal.get("email")
                            or principal.get("user_id") or ""))
                except Exception:
                    pass
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
