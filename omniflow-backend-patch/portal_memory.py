"""Customer memory + journey stages + explain (V2 B7).

One small module for three related things the owner asked for:

* MEMORY - structured, editable, deletable notes about a customer
  (kind = preference | note | fact) shown on the Customer 360 page.
  Capped per contact (OF_MEMORY_CAP, oldest trimmed), purgable in one
  call (the data-safety "forget this customer" switch), and AI-facing
  through the fail-silent remember_fact() helper for later batches.

* JOURNEY - configurable stages per tenant (seeded with New / Engaged /
  Customer, freely extendable). Moving a contact writes a state row, a
  portal_journey_events row AND a journey.stage portal_action_log event,
  so automations and webhooks can react to transitions. The first fully
  paid checkout link auto-advances a contact to the "Customer" stage
  (portal_checkout calls note_purchase; fail-silent, source automation).

* EXPLAIN - the "why did this happen" card: the customer's recent
  portal_action_log rows (ai answers, journey moves, COD confirmations,
  ...) pulled straight from the audit trail.

The whole API is human-only (API keys get 403) - customer memory is
personal data and never leaves through automation credentials.
"""

import logging
import os
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_db
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
)

logger = logging.getLogger("omniflow.portal-memory")

bp = Blueprint("portal_memory", __name__, url_prefix="/api/v1/portal")

MEMORY_TABLE = "portal_customer_memory"
STAGES_TABLE = "portal_journey_stages"
STATE_TABLE = "portal_journey_state"
EVENTS_TABLE = "portal_journey_events"

KINDS = ("preference", "note", "fact")
DEFAULT_STAGES = ("New", "Engaged", "Customer")
AUTO_STAGE_NAME = "Customer"
MAX_CONTENT_CHARS = 500
MAX_STAGES = int(os.environ.get("OF_JOURNEY_MAX_STAGES", "12") or 12)
MEMORY_CAP = int(os.environ.get("OF_MEMORY_CAP", "50") or 50)
EXPLAIN_LIMIT = 15

_DDL_READY = False

_DDL = """
CREATE TABLE IF NOT EXISTS portal_customer_memory (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  contact_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',
  content TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_customer_memory
  ON portal_customer_memory (client_id, contact_id, id DESC);
CREATE TABLE IF NOT EXISTS portal_journey_stages (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, name)
);
CREATE TABLE IF NOT EXISTS portal_journey_state (
  client_id BIGINT NOT NULL,
  contact_id TEXT NOT NULL,
  stage_id BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, contact_id)
);
CREATE TABLE IF NOT EXISTS portal_journey_events (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  contact_id TEXT NOT NULL,
  stage_name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_journey_events
  ON portal_journey_events (client_id, contact_id, id DESC);
"""


def _ensure_ddl(cur) -> None:
    """Create the memory/journey tables once per process (lazy DDL)."""
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    _DDL_READY = True


def _principal_or_error():
    """Owner/staff session required (API keys cannot touch memory)."""
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


def _clean_contact(value: Any) -> str:
    return str(value or "").strip()[:100]


# ---------------------------------------------------------------------------
# Memory (structured customer notes)
# ---------------------------------------------------------------------------

def _trim_memory(cur, client_id: int, contact_id: str) -> None:
    """Keep at most MEMORY_CAP entries per contact (oldest trimmed)."""
    cur.execute(
        "DELETE FROM " + portal_db._q(MEMORY_TABLE) +
        " WHERE client_id = %s AND contact_id = %s AND id NOT IN ("
        " SELECT id FROM " + portal_db._q(MEMORY_TABLE) +
        " WHERE client_id = %s AND contact_id = %s"
        " ORDER BY id DESC LIMIT %s)",
        (client_id, contact_id, client_id, contact_id, MEMORY_CAP),
    )


def list_memory(cur, client_id: int, contact_id: str) -> List[Dict[str, Any]]:
    cur.execute(
        "SELECT id, kind, content, created_by, created_at, updated_at"
        " FROM " + portal_db._q(MEMORY_TABLE) +
        " WHERE client_id = %s AND contact_id = %s ORDER BY id DESC",
        (client_id, contact_id),
    )
    return portal_db.rows(cur)


def add_memory(cur, client_id: int, contact_id: str, kind: str,
               content: str, created_by: str = "owner") -> Optional[int]:
    """Insert one memory entry (returns the new id, None on bad input)."""
    contact_id = _clean_contact(contact_id)
    text = str(content or "").strip()
    if not contact_id or kind not in KINDS or not text:
        return None
    cur.execute(
        "INSERT INTO " + portal_db._q(MEMORY_TABLE) +
        " (client_id, contact_id, kind, content, created_by)"
        " VALUES (%s, %s, %s, %s, %s) RETURNING id",
        (client_id, contact_id, kind, text[:MAX_CONTENT_CHARS], created_by),
    )
    rows = portal_db.rows(cur)
    _trim_memory(cur, client_id, contact_id)
    return int((rows[0] if rows else {}).get("id") or 0) or None


def remember_fact(cur, client_id: int, contact_id: str, content: str,
                  source: str = "ai") -> Optional[int]:
    """Fail-silent append for automations; skips exact duplicates."""
    try:
        text = str(content or "").strip()
        contact_id = _clean_contact(contact_id)
        if not text or not contact_id:
            return None
        cur.execute(
            "SELECT 1 FROM " + portal_db._q(MEMORY_TABLE) +
            " WHERE client_id = %s AND contact_id = %s AND content = %s"
            " LIMIT 1",
            (client_id, contact_id, text[:MAX_CONTENT_CHARS]),
        )
        if portal_db.rows(cur):
            return None
        return add_memory(cur, client_id, contact_id, "fact", text, source)
    except Exception as error:
        logger.warning("remember_fact failed: %s", error)
        return None


def update_memory(cur, client_id: int, memory_id: int, content: str,
                  kind: Optional[str] = None) -> bool:
    text = str(content or "").strip()
    if not text or (kind is not None and kind not in KINDS):
        return False
    sql = ("UPDATE " + portal_db._q(MEMORY_TABLE) +
           " SET content = %s, updated_at = NOW()")
    params: Tuple[Any, ...] = (text[:MAX_CONTENT_CHARS],)
    if kind is not None:
        sql += ", kind = %s"
        params = (text[:MAX_CONTENT_CHARS], kind)
    sql += " WHERE id = %s AND client_id = %s RETURNING id"
    params = params + (memory_id, client_id)
    cur.execute(sql, params)
    return bool(portal_db.rows(cur))


def delete_memory(cur, client_id: int, memory_id: int) -> bool:
    cur.execute(
        "DELETE FROM " + portal_db._q(MEMORY_TABLE) +
        " WHERE id = %s AND client_id = %s RETURNING id",
        (memory_id, client_id),
    )
    return bool(portal_db.rows(cur))


def purge_memory(cur, client_id: int, contact_id: str) -> int:
    """Erase everything stored about one contact (data-safety switch)."""
    contact_id = _clean_contact(contact_id)
    if not contact_id:
        return 0
    cur.execute(
        "DELETE FROM " + portal_db._q(MEMORY_TABLE) +
        " WHERE client_id = %s AND contact_id = %s RETURNING id",
        (client_id, contact_id),
    )
    purged = len(portal_db.rows(cur))
    cur.execute(
        "DELETE FROM " + portal_db._q(STATE_TABLE) +
        " WHERE client_id = %s AND contact_id = %s",
        (client_id, contact_id),
    )
    return purged


# ---------------------------------------------------------------------------
# Journey (configurable stages + transitions-as-events)
# ---------------------------------------------------------------------------

def _ensure_stages(cur, client_id: int) -> None:
    """Seed the default stages the first time a tenant uses journeys."""
    _ensure_ddl(cur)
    cur.execute(
        "SELECT 1 FROM " + portal_db._q(STAGES_TABLE) +
        " WHERE client_id = %s LIMIT 1",
        (client_id,),
    )
    if portal_db.rows(cur):
        return
    for position, name in enumerate(DEFAULT_STAGES, start=1):
        cur.execute(
            "INSERT INTO " + portal_db._q(STAGES_TABLE) +
            " (client_id, name, position) VALUES (%s, %s, %s)"
            " ON CONFLICT (client_id, name) DO NOTHING",
            (client_id, name, position),
        )


def list_stages(cur, client_id: int) -> List[Dict[str, Any]]:
    _ensure_stages(cur, client_id)
    cur.execute(
        "SELECT id, name, position, is_active FROM " +
        portal_db._q(STAGES_TABLE) +
        " WHERE client_id = %s ORDER BY position, id",
        (client_id,),
    )
    return portal_db.rows(cur)


def add_stage(cur, client_id: int, name: str) -> Optional[Dict[str, Any]]:
    name = str(name or "").strip()[:40]
    if not name:
        return None
    cur.execute(
        "SELECT COUNT(*) AS n FROM " + portal_db._q(STAGES_TABLE) +
        " WHERE client_id = %s",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    if int((rows[0] if rows else {}).get("n") or 0) >= MAX_STAGES:
        return None
    cur.execute(
        "SELECT COALESCE(MAX(position), 0) + 1 AS next FROM " +
        portal_db._q(STAGES_TABLE) + " WHERE client_id = %s",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    position = int((rows[0] if rows else {}).get("next") or 1)
    cur.execute(
        "INSERT INTO " + portal_db._q(STAGES_TABLE) +
        " (client_id, name, position) VALUES (%s, %s, %s)"
        " ON CONFLICT (client_id, name) DO NOTHING RETURNING id",
        (client_id, name, position),
    )
    rows = portal_db.rows(cur)
    if not rows:
        return None
    return {"id": int(rows[0].get("id") or 0), "name": name,
            "position": position, "is_active": True}


def delete_stage(cur, client_id: int, stage_id: int) -> Optional[bool]:
    """Deactivate a stage; None when it is still assigned (409)."""
    cur.execute(
        "SELECT 1 FROM " + portal_db._q(STATE_TABLE) +
        " WHERE client_id = %s AND stage_id = %s LIMIT 1",
        (client_id, stage_id),
    )
    if portal_db.rows(cur):
        return None
    cur.execute(
        "UPDATE " + portal_db._q(STAGES_TABLE) +
        " SET is_active = FALSE WHERE id = %s AND client_id = %s"
        " RETURNING id",
        (stage_id, client_id),
    )
    return bool(portal_db.rows(cur))


def move_contact(cur, client_id: int, contact_id: str, stage_id: int,
                 source: str = "owner") -> Optional[Dict[str, Any]]:
    """Set a contact's stage; writes state + event + audit, returns the
    stage row (None when the stage is unknown/foreign/inactive)."""
    contact_id = _clean_contact(contact_id)
    if not contact_id:
        return None
    cur.execute(
        "SELECT id, name FROM " + portal_db._q(STAGES_TABLE) +
        " WHERE id = %s AND client_id = %s AND is_active = TRUE LIMIT 1",
        (stage_id, client_id),
    )
    rows = portal_db.rows(cur)
    if not rows:
        return None
    stage = {"id": int(rows[0].get("id") or 0),
             "name": str(rows[0].get("name") or "")}
    cur.execute(
        "SELECT stage_id FROM " + portal_db._q(STATE_TABLE) +
        " WHERE client_id = %s AND contact_id = %s LIMIT 1",
        (client_id, contact_id),
    )
    rows = portal_db.rows(cur)
    previous = int((rows[0] if rows else {}).get("stage_id") or 0)
    if previous == stage["id"]:
        return stage
    cur.execute(
        "INSERT INTO " + portal_db._q(STATE_TABLE) +
        " (client_id, contact_id, stage_id, updated_at)"
        " VALUES (%s, %s, %s, NOW())"
        " ON CONFLICT (client_id, contact_id) DO UPDATE SET"
        " stage_id = EXCLUDED.stage_id, updated_at = NOW()",
        (client_id, contact_id, stage["id"]),
    )
    cur.execute(
        "INSERT INTO " + portal_db._q(EVENTS_TABLE) +
        " (client_id, contact_id, stage_name, source)"
        " VALUES (%s, %s, %s, %s)",
        (client_id, contact_id, stage["name"], source),
    )
    portal_db.log_action(
        cur, client_id, "journey.stage", "automation" if source != "owner"
        else "human", None, None,
        ("Journey: " + contact_id + " -> " + stage["name"]
         + " (" + source + ")")[:200],
    )
    return stage


def note_purchase(cur, client_id: int, contact_id: str) -> Optional[bool]:
    """Automation hook: a fully-paid checkout advances the contact to
    the AUTO_STAGE_NAME stage (when that stage exists). Fail-silent."""
    try:
        contact_id = _clean_contact(contact_id)
        if not contact_id:
            return None
        cur.execute(
            "SELECT id FROM " + portal_db._q(STAGES_TABLE) +
            " WHERE client_id = %s AND name = %s AND is_active = TRUE"
            " LIMIT 1",
            (client_id, AUTO_STAGE_NAME),
        )
        rows = portal_db.rows(cur)
        if not rows:
            return None
        stage_id = int(rows[0].get("id") or 0)
        cur.execute(
            "SELECT stage_id FROM " + portal_db._q(STATE_TABLE) +
            " WHERE client_id = %s AND contact_id = %s LIMIT 1",
            (client_id, contact_id),
        )
        rows = portal_db.rows(cur)
        if rows and int((rows[0] if rows else {}).get("stage_id") or 0) \
                == stage_id:
            return False
        return move_contact(cur, client_id, contact_id, stage_id,
                            source="automation") is not None
    except Exception as error:
        logger.warning("note_purchase failed: %s", error)
        return None


def journey_snapshot(cur, client_id: int,
                     contact_id: str) -> Dict[str, Any]:
    """Stages + the contact's current stage + last transitions."""
    stages = list_stages(cur, client_id)
    contact_id = _clean_contact(contact_id)
    current: Optional[Dict[str, Any]] = None
    events: List[Dict[str, Any]] = []
    if contact_id:
        cur.execute(
            "SELECT s.id AS id, s.name AS name, st.updated_at AS updated_at"
            " FROM " + portal_db._q(STATE_TABLE) + " st"
            " JOIN " + portal_db._q(STAGES_TABLE) +
            " s ON s.id = st.stage_id"
            " WHERE st.client_id = %s AND st.contact_id = %s LIMIT 1",
            (client_id, contact_id),
        )
        rows = portal_db.rows(cur)
        if rows:
            current = {"stage_id": int(rows[0].get("id") or 0),
                       "name": str(rows[0].get("name") or ""),
                       "updated_at": str(rows[0].get("updated_at") or "")}
        cur.execute(
            "SELECT stage_name, source, created_at FROM " +
            portal_db._q(EVENTS_TABLE) +
            " WHERE client_id = %s AND contact_id = %s"
            " ORDER BY id DESC LIMIT 10",
            (client_id, contact_id),
        )
        events = portal_db.rows(cur)
    return {"stages": stages, "current": current, "events": events}


# ---------------------------------------------------------------------------
# Explain (audit-powered "why did this happen" card)
# ---------------------------------------------------------------------------

def explain_contact(cur, client_id: int,
                    contact_id: str) -> List[Dict[str, Any]]:
    """The contact's recent audit rows (automations + owner actions)."""
    contact_id = _clean_contact(contact_id)
    if not contact_id:
        return []
    cur.execute(
        "SELECT a.action AS action, a.actor_kind AS actor_kind,"
        " a.note AS note, a.created_at AS created_at"
        " FROM " + portal_db._q("portal_action_log") + " a"
        " WHERE a.client_id = %s AND a.conversation_id IN ("
        "  SELECT id FROM " + portal_db._q(portal_db.CONV_TABLE) +
        "  WHERE client_id = %s AND contact_id = %s)"
        " ORDER BY a.id DESC LIMIT %s",
        (client_id, client_id, contact_id, EXPLAIN_LIMIT),
    )
    return portal_db.rows(cur)


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value) or None


def _memory_public(row: Dict[str, Any]) -> dict:
    return {"id": int(row.get("id") or 0),
            "kind": str(row.get("kind") or "note"),
            "content": str(row.get("content") or ""),
            "created_by": str(row.get("created_by") or "owner"),
            "created_at": _iso(row.get("created_at")),
            "updated_at": _iso(row.get("updated_at"))}


# ---------------------------------------------------------------------------
# Owner API: memory / journey / explain (all human-only)
# ---------------------------------------------------------------------------

@bp.get("/memory")
def get_memory():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    contact = _clean_contact(request.args.get("contact"))
    if not contact:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contact is required."}}), 400
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            rows = list_memory(cur, int(principal["client_id"]), contact)
        conn.commit()
    finally:
        conn.close()
    return jsonify({"memory": [_memory_public(r) for r in rows],
                    "cap": MEMORY_CAP}), 200


@bp.post("/memory")
def create_memory():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    payload = request.get_json(silent=True) or {}
    contact = _clean_contact(payload.get("contact"))
    kind = str(payload.get("kind") or "note")
    content = str(payload.get("content") or "").strip()
    if not contact:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contact is required."}}), 400
    if kind not in KINDS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "kind must be one of"
                                             " preference|note|fact."}}), 400
    if not content:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "content is required."}}), 400
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            memory_id = add_memory(cur, client_id, contact, kind, content)
            portal_db.log_action(
                cur, client_id, "memory.added", "human", None, None,
                ("Memory " + kind + " for " + contact) + " saved",
            )
        conn.commit()
    finally:
        conn.close()
    if memory_id is None:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Could not save the entry."}}), \
            400
    return jsonify({"memory": {"id": memory_id, "kind": kind,
                               "content": content[:MAX_CONTENT_CHARS],
                               "created_by": "owner"}}), 200


@bp.put("/memory/<int:memory_id>")
def edit_memory(memory_id: int):
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    payload = request.get_json(silent=True) or {}
    content = str(payload.get("content") or "").strip()
    kind = payload.get("kind")
    if not content:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "content is required."}}), 400
    if kind is not None and kind not in KINDS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "kind must be one of"
                                             " preference|note|fact."}}), 400
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            ok = update_memory(cur, client_id, memory_id, content, kind)
        conn.commit()
    finally:
        conn.close()
    if not ok:
        return jsonify({"error": {"code": "not_found",
                                  "message": "No such entry in this"
                                             " workspace."}}), 404
    return jsonify({"ok": True}), 200


@bp.delete("/memory/<int:memory_id>")
def remove_memory(memory_id: int):
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            ok = delete_memory(cur, client_id, memory_id)
        conn.commit()
    finally:
        conn.close()
    if not ok:
        return jsonify({"error": {"code": "not_found",
                                  "message": "No such entry in this"
                                             " workspace."}}), 404
    return jsonify({"ok": True}), 200


@bp.delete("/memory")
def purge_contact_memory():
    """Erase all memory (and journey state) of one contact."""
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    contact = _clean_contact(request.args.get("contact"))
    if not contact:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contact is required."}}), 400
    client_id = int(principal["client_id"])
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            purged = purge_memory(cur, client_id, contact)
            portal_db.log_action(
                cur, client_id, "memory.purged", "human", None, None,
                ("Memory purged for " + contact) + "",
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"purged": purged}), 200


@bp.get("/journey")
def get_journey():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    contact = _clean_contact(request.args.get("contact"))
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            snapshot = journey_snapshot(cur, int(principal["client_id"]),
                                        contact)
        conn.commit()
    finally:
        conn.close()
    return jsonify(snapshot), 200


@bp.put("/journey")
def move_journey():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    payload = request.get_json(silent=True) or {}
    contact = _clean_contact(payload.get("contact"))
    try:
        stage_id = int(payload.get("stage_id") or 0)
    except Exception:
        stage_id = 0
    if not contact or stage_id <= 0:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contact and stage_id are"
                                             " required."}}), 400
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            stage = move_contact(cur, client_id, contact, stage_id)
        conn.commit()
    finally:
        conn.close()
    if stage is None:
        return jsonify({"error": {"code": "not_found",
                                  "message": "No such stage in this"
                                             " workspace."}}), 404
    return jsonify({"current": {"stage_id": stage["id"],
                                "name": stage["name"]}}), 200


@bp.post("/journey/stages")
def create_stage():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    payload = request.get_json(silent=True) or {}
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            stage = add_stage(cur, client_id,
                              str(payload.get("name") or ""))
        conn.commit()
    finally:
        conn.close()
    if stage is None:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Stage name is required (max"
                                             " " + str(MAX_STAGES) + " stages)."}}), 400
    return jsonify({"stage": stage}), 200


@bp.delete("/journey/stages/<int:stage_id>")
def remove_stage(stage_id: int):
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            result = delete_stage(cur, client_id, stage_id)
        conn.commit()
    finally:
        conn.close()
    if result is None:
        return jsonify({"error": {"code": "conflict",
                                  "message": "Contacts still sit on this"
                                             " stage - move them first."}}), 409
    if not result:
        return jsonify({"error": {"code": "not_found",
                                  "message": "No such stage in this"
                                             " workspace."}}), 404
    return jsonify({"ok": True}), 200


@bp.get("/explain")
def get_explain():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    contact = _clean_contact(request.args.get("contact"))
    if not contact:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contact is required."}}), 400
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            rows = explain_contact(cur, int(principal["client_id"]),
                                   contact)
        conn.commit()
    finally:
        conn.close()
    activity = [{"action": str(r.get("action") or ""),
                 "actor_kind": str(r.get("actor_kind") or ""),
                 "note": str(r.get("note") or ""),
                 "created_at": _iso(r.get("created_at"))}
                for r in rows]
    return jsonify({"activity": activity}), 200
