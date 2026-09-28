"""AI Agents engine (MASTER-UPGRADE Router+Agents).

Agents are NAMED AI PERSONAS the owner creates - e.g. "Sales Aunty"
(warm, upsells), "Support Pro" (formal, policy-strict). Each agent:

  * has a tone + free-form instructions the Business Brain follows when
    the conversation belongs to it (portal_brain reads the agent through
    agent_for_conversation - read-only, fail-soft);
  * can be a ROUTING TARGET: routing rules with target_type='agent'
    assign matching conversations to the agent (portal_routing);
  * carries an escalation_user_id (the teammate complex cases go to);
  * is versioned: every save writes a portal_agent_versions snapshot
    row, so config drift is always explainable; GET /agents/<id>/versions
    lists the history and POST /agents/<id>/rollback restores one
    snapshot AS A NEW VERSION (history is never rewritten);
  * carries PERMISSIONS - the envelope the AI may act inside when a
    conversation belongs to the agent: ``allowed_actions`` (registry
    names, null = every action), ``max_risk`` (low|medium|high - the
    highest action risk it may trigger; HIGH-risk actions still need
    owner approval, permissions never bypass the approval gate) and
    ``can_auto_reply`` (false = drafts only, the brain never auto-sends
    under this persona). ``permits()`` is the single check
    portal_actions.execute and the brain call - AI never bypasses app
    permissions.

Fail-soft everywhere: a missing table, a bad id or an inactive agent
just means "no agent" - the brain keeps its default persona and routing
keeps working with user targets. Owner-only API (API keys get 403) -
agents steer the AI and must never be drivable by automation keys.
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
    ensure_human_principal,
)

logger = logging.getLogger("omniflow.portal-agents")

bp = Blueprint("portal_agents", __name__, url_prefix="/api/v1/portal")

AGENTS_TABLE = "portal_agents"
VERSIONS_TABLE = "portal_agent_versions"
CONV_AGENTS_TABLE = "portal_conversation_agents"

MAX_AGENTS = int(os.environ.get("OF_AGENTS_MAX", "10") or 10)
MAX_NAME_CHARS = 60
MAX_TONE_CHARS = 120
MAX_INSTRUCTIONS_CHARS = int(
    os.environ.get("OF_AGENT_INSTRUCTIONS_MAX", "1000") or 1000)
MAX_VERSIONS_LISTED = int(os.environ.get("OF_AGENT_VERSIONS_LIST", "30") or 30)

RISK_LEVELS = ("low", "medium", "high")
RISK_ORDER = {"low": 0, "medium": 1, "high": 2}
DEFAULT_MAX_RISK = "high"

#: columns every read path selects (keep in one place: brain + routing +
#: the owner API all shape rows through _shape()).
AGENT_COLUMNS = ("id, name, tone, instructions, escalation_user_id,"
                 " is_active, updated_at, allowed_actions, max_risk,"
                 " can_auto_reply")

_DDL_READY = False

_DDL = """
CREATE TABLE IF NOT EXISTS portal_agents (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  tone TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  escalation_user_id BIGINT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_agents
  ON portal_agents (client_id, is_active, id DESC);
CREATE TABLE IF NOT EXISTS portal_agent_versions (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  agent_id BIGINT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, agent_id, version)
);
CREATE TABLE IF NOT EXISTS portal_conversation_agents (
  client_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  agent_id BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, conversation_id)
);
ALTER TABLE portal_agents
  ADD COLUMN IF NOT EXISTS allowed_actions JSONB;
ALTER TABLE portal_agents
  ADD COLUMN IF NOT EXISTS max_risk TEXT NOT NULL DEFAULT 'high';
ALTER TABLE portal_agents
  ADD COLUMN IF NOT EXISTS can_auto_reply BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE portal_agent_versions
  ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';
"""


def _ensure_ddl(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    _DDL_READY = True


def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": str(error)}}), 503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}),
                      401)
    return principal, None


def _allowed_list(value: Any) -> Optional[List[str]]:
    """allowed_actions column -> list of names, or None (= every action)."""
    if isinstance(value, str):
        try:
            value = json.loads(value or "null")
        except Exception:
            return None
    if not isinstance(value, list):
        return None
    out: List[str] = []
    for item in value:
        text = str(item or "").strip()
        if text and text not in out:
            out.append(text[:60])
    return out


def _risk(value: Any) -> str:
    text = str(value or "").strip().lower()
    return text if text in RISK_LEVELS else DEFAULT_MAX_RISK


def _shape(row: Dict[str, Any]) -> Dict[str, Any]:
    escalation = row.get("escalation_user_id")
    return {"id": int(row.get("id") or 0),
            "name": str(row.get("name") or ""),
            "tone": str(row.get("tone") or ""),
            "instructions": str(row.get("instructions") or ""),
            "escalation_user_id": int(escalation) if escalation else None,
            "is_active": bool(row.get("is_active")),
            "updated_at": str(row.get("updated_at") or ""),
            "allowed_actions": _allowed_list(row.get("allowed_actions")),
            "max_risk": _risk(row.get("max_risk")),
            "can_auto_reply": (True if row.get("can_auto_reply") is None
                               else bool(row.get("can_auto_reply")))}


def permits(agent: Optional[Dict[str, Any]], action: str,
            risk: str = "low") -> Tuple[bool, str]:
    """(allowed, reason) - may ``agent`` trigger ``action`` at ``risk``?

    No agent = no persona envelope = allowed (the caller's own gates
    still apply). Reasons: ``action_not_allowed`` | ``risk_above_max``.
    """
    if not agent:
        return True, ""
    allowed = agent.get("allowed_actions")
    if isinstance(allowed, list) and str(action or "") not in allowed:
        return False, "action_not_allowed"
    max_risk = _risk(agent.get("max_risk"))
    if RISK_ORDER.get(_risk(risk), 0) > RISK_ORDER.get(max_risk, 2):
        return False, "risk_above_max"
    return True, ""


# ---------------------------------------------------------------------------
# Helpers (read-side, fail-soft) - used by routing + the brain
#
# They select AGENT_COLUMNS (incl. the permission columns) and run NO DDL
# themselves (slot-neutral for callers); the lazy DDL rides along the
# brain, workflow and routing DDL chains plus every owner endpoint, so
# the columns exist before any read path needs them.
# ---------------------------------------------------------------------------

def load_agent(cur, client_id: int, agent_id: int) -> Optional[Dict[str, Any]]:
    """One active agent row (None when missing/foreign/inactive)."""
    try:
        cur.execute(
            "SELECT " + AGENT_COLUMNS + " FROM " + portal_db._q(AGENTS_TABLE) +
            " WHERE id = %s AND client_id = %s AND is_active = TRUE"
            " LIMIT 1",
            (agent_id, client_id),
        )
        rows = portal_db.rows(cur)
        return _shape(rows[0]) if rows else None
    except Exception as error:
        logger.warning("load_agent failed: %s", error)
        return None


def agent_for_conversation(cur, client_id: int,
                           conversation_id: int) -> Optional[Dict[str, Any]]:
    """The agent a conversation is currently assigned to (the brain's
    read path - fail-soft: any problem means no agent)."""
    try:
        cur.execute(
            "SELECT " + ", ".join("a." + c.strip()
                                  for c in AGENT_COLUMNS.split(",")) +
            " FROM " + portal_db._q(CONV_AGENTS_TABLE) + " ca"
            " JOIN " + portal_db._q(AGENTS_TABLE) + " a ON a.id = ca.agent_id"
            " WHERE ca.client_id = %s AND ca.conversation_id = %s"
            " AND a.is_active = TRUE LIMIT 1",
            (client_id, conversation_id),
        )
        rows = portal_db.rows(cur)
        return _shape(rows[0]) if rows else None
    except Exception as error:
        logger.warning("agent_for_conversation failed: %s", error)
        return None


def assign_agent(cur, client_id: int, conversation_id: int,
                 agent_id: int) -> None:
    """Record/replace the conversation's agent (routing's write path)."""
    cur.execute(
        "INSERT INTO " + portal_db._q(CONV_AGENTS_TABLE) +
        " (client_id, conversation_id, agent_id, updated_at)"
        " VALUES (%s, %s, %s, NOW())"
        " ON CONFLICT (client_id, conversation_id) DO UPDATE SET"
        " agent_id = EXCLUDED.agent_id, updated_at = NOW()",
        (client_id, conversation_id, agent_id),
    )


# ---------------------------------------------------------------------------
# Owner API: agents CRUD (human-only)
# ---------------------------------------------------------------------------

@bp.get("/agents")
def list_agents():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = int(principal.get("client_id") or 0)
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "SELECT " + AGENT_COLUMNS + " FROM " +
                portal_db._q(AGENTS_TABLE) +
                " WHERE client_id = %s"
                " ORDER BY is_active DESC, id ASC LIMIT %s",
                (client_id, max(1, min(50, MAX_AGENTS * 2))),
            )
            rows = portal_db.rows(cur)
            cur.execute(
                "SELECT agent_id, COUNT(*) AS versions FROM " +
                portal_db._q(VERSIONS_TABLE) +
                " WHERE client_id = %s GROUP BY agent_id",
                (client_id,),
            )
            counts = {int(r.get("agent_id") or 0):
                      int(r.get("versions") or 0) for r in portal_db.rows(cur)}
        conn.commit()
    finally:
        conn.close()
    out = []
    for row in rows:
        item = _shape(row)
        item["versions"] = counts.get(item["id"], 0)
        out.append(item)
    return jsonify({"agents": out}), 200


def _validate_payload(payload: Dict[str, Any]) -> Tuple[Optional[dict], int]:
    """(error_json, status) - (None, 200) when the payload is valid."""
    name = str(payload.get("name") or "").strip()
    tone = str(payload.get("tone") or "").strip()
    instructions = str(payload.get("instructions") or "").strip()
    if not name or len(name) > MAX_NAME_CHARS:
        return (jsonify({"error": {
            "code": "bad_request",
            "message": "name is required (max " + str(MAX_NAME_CHARS)
                       + " characters)."}}), 400)
    if len(tone) > MAX_TONE_CHARS:
        return (jsonify({"error": {
            "code": "bad_request",
            "message": "tone is too long (max " + str(MAX_TONE_CHARS)
                       + ")."}}), 400)
    if len(instructions) > MAX_INSTRUCTIONS_CHARS:
        return (jsonify({"error": {
            "code": "bad_request",
            "message": "instructions are too long (max "
                       + str(MAX_INSTRUCTIONS_CHARS) + ")."}}), 400)
    escalation = payload.get("escalation_user_id")
    if escalation is not None:
        if isinstance(escalation, bool) or not isinstance(escalation, int) \
                or escalation <= 0:
            return (jsonify({"error": {
                "code": "bad_request",
                "message": "escalation_user_id must be a positive"
                           " integer."}}), 400)
    allowed = payload.get("allowed_actions")
    if allowed is not None:
        if not isinstance(allowed, list) \
                or any(not isinstance(a, str) for a in allowed):
            return (jsonify({"error": {
                "code": "bad_request",
                "message": "allowed_actions must be a list of action"
                           " names (or null for every action)."}}), 400)
        unknown = [a for a in allowed if a not in _known_actions()]
        if unknown:
            return (jsonify({"error": {
                "code": "bad_request",
                "message": "Unknown action: " + ", ".join(
                    sorted(set(unknown))[:5]) + "."}}), 400)
    max_risk = payload.get("max_risk")
    if max_risk is not None and str(max_risk).strip().lower() \
            not in RISK_LEVELS:
        return (jsonify({"error": {
            "code": "bad_request",
            "message": "max_risk must be low, medium or high."}}), 400)
    can_auto = payload.get("can_auto_reply")
    if can_auto is not None and not isinstance(can_auto, bool):
        return (jsonify({"error": {
            "code": "bad_request",
            "message": "can_auto_reply must be true or false."}}), 400)
    return None, 200


def _known_actions() -> List[str]:
    """Registry names permissions may reference (fail-soft: empty list
    means the registry could not be loaded - nothing validates)."""
    try:
        import portal_actions

        return list(portal_actions.ACTIONS.keys())
    except Exception:
        return []


def _permissions_from(payload: Dict[str, Any],
                      current: Optional[Dict[str, Any]] = None
                      ) -> Dict[str, Any]:
    """Validated permission fields; unspecified keys keep ``current``
    (defaults: every action, max_risk high, auto-reply on)."""
    base = {"allowed_actions": None, "max_risk": DEFAULT_MAX_RISK,
            "can_auto_reply": True}
    if current:
        base.update({k: current.get(k, base[k]) for k in base})
    if "allowed_actions" in payload:
        base["allowed_actions"] = _allowed_list(payload.get("allowed_actions"))
    if payload.get("max_risk") is not None:
        base["max_risk"] = _risk(payload.get("max_risk"))
    if isinstance(payload.get("can_auto_reply"), bool):
        base["can_auto_reply"] = payload["can_auto_reply"]
    return base


def _snapshot(name: str, tone: str, instructions: str, escalation,
              is_active: bool, permissions: Dict[str, Any]) -> Dict[str, Any]:
    return {"name": name, "tone": tone, "instructions": instructions,
            "escalation_user_id": escalation, "is_active": is_active,
            "allowed_actions": permissions.get("allowed_actions"),
            "max_risk": permissions.get("max_risk") or DEFAULT_MAX_RISK,
            "can_auto_reply": bool(permissions.get("can_auto_reply", True))}


def _permissions_json(permissions: Dict[str, Any]) -> Optional[str]:
    allowed = permissions.get("allowed_actions")
    return json.dumps(allowed) if isinstance(allowed, list) else None


@bp.post("/agents")
def create_agent():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True) or {}
    invalid, status = _validate_payload(payload)
    if invalid:
        return invalid, status
    name = str(payload.get("name") or "").strip()
    tone = str(payload.get("tone") or "").strip()
    instructions = str(payload.get("instructions") or "").strip()
    escalation = payload.get("escalation_user_id")
    permissions = _permissions_from(payload)
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "SELECT COUNT(*) AS total FROM " + portal_db._q(AGENTS_TABLE) +
                " WHERE client_id = %s",
                (client_id,),
            )
            rows = portal_db.rows(cur)
            if int((rows[0] if rows else {}).get("total") or 0) >= MAX_AGENTS:
                return jsonify({"error": {
                    "code": "bad_request",
                    "message": "Max " + str(MAX_AGENTS) + " agents."}}), 400
            cur.execute(
                "INSERT INTO " + portal_db._q(AGENTS_TABLE) +
                " (client_id, name, tone, instructions, escalation_user_id,"
                " allowed_actions, max_risk, can_auto_reply)"
                " VALUES (%s, %s, %s, %s, %s, CAST(%s AS JSONB), %s, %s)"
                " RETURNING id",
                (client_id, name[:MAX_NAME_CHARS], tone[:MAX_TONE_CHARS],
                 instructions[:MAX_INSTRUCTIONS_CHARS], escalation,
                 _permissions_json(permissions), permissions["max_risk"],
                 bool(permissions["can_auto_reply"])),
            )
            rows = portal_db.rows(cur)
            agent_id = int((rows[0] if rows else {}).get("id") or 0)
            snapshot = _snapshot(name, tone, instructions, escalation, True,
                                 permissions)
            cur.execute(
                "INSERT INTO " + portal_db._q(VERSIONS_TABLE) +
                " (client_id, agent_id, version, snapshot, note)"
                " VALUES (%s, %s, 1, CAST(%s AS JSONB), %s)",
                (client_id, agent_id,
                 json.dumps(snapshot, ensure_ascii=False), "Created"),
            )
            portal_db.log_action(
                cur, client_id, "agents.saved", "human",
                principal.get("user_id"), None,
                ("Agent created: " + name)[:200],
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"agent": {"id": agent_id, "name": name, "tone": tone,
                              "instructions": instructions,
                              "escalation_user_id": escalation,
                              "is_active": True, "versions": 1,
                              "allowed_actions":
                                  permissions["allowed_actions"],
                              "max_risk": permissions["max_risk"],
                              "can_auto_reply":
                                  bool(permissions["can_auto_reply"])}}), 200


@bp.put("/agents/<int:agent_id>")
def update_agent(agent_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True) or {}
    invalid, status = _validate_payload(payload)
    if invalid:
        return invalid, status
    name = str(payload.get("name") or "").strip()
    tone = str(payload.get("tone") or "").strip()
    instructions = str(payload.get("instructions") or "").strip()
    escalation = payload.get("escalation_user_id")
    is_active = payload.get("is_active", True)
    if not isinstance(is_active, bool):
        is_active = bool(is_active)
    permissions = _permissions_from(payload)
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "UPDATE " + portal_db._q(AGENTS_TABLE) +
                " SET name = %s, tone = %s, instructions = %s,"
                " escalation_user_id = %s, is_active = %s,"
                " allowed_actions = CAST(%s AS JSONB), max_risk = %s,"
                " can_auto_reply = %s, updated_at = NOW()"
                " WHERE id = %s AND client_id = %s RETURNING id",
                (name[:MAX_NAME_CHARS], tone[:MAX_TONE_CHARS],
                 instructions[:MAX_INSTRUCTIONS_CHARS], escalation,
                 is_active, _permissions_json(permissions),
                 permissions["max_risk"], bool(permissions["can_auto_reply"]),
                 agent_id, client_id),
            )
            rows = portal_db.rows(cur)
            if not rows:
                conn.rollback()
                return jsonify({"error": {
                    "code": "not_found",
                    "message": "No such agent in this workspace."}}), 404
            snapshot = _snapshot(name, tone, instructions, escalation,
                                 is_active, permissions)
            _insert_version(cur, client_id, agent_id, snapshot, "Saved")
            portal_db.log_action(
                cur, client_id, "agents.saved", "human",
                principal.get("user_id"), None,
                ("Agent updated: " + name)[:200],
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True}), 200


def _insert_version(cur, client_id: int, agent_id: int,
                    snapshot: Dict[str, Any], note: str) -> int:
    """Append the next version row for an agent; returns its number."""
    cur.execute(
        "INSERT INTO " + portal_db._q(VERSIONS_TABLE) +
        " (client_id, agent_id, version, snapshot, note)"
        " SELECT %s, %s, COALESCE(MAX(version), 0) + 1, CAST(%s AS"
        " JSONB), %s FROM " + portal_db._q(VERSIONS_TABLE) +
        " WHERE client_id = %s AND agent_id = %s RETURNING version",
        (client_id, agent_id, json.dumps(snapshot, ensure_ascii=False),
         str(note or "")[:120], client_id, agent_id),
    )
    rows = portal_db.rows(cur)
    return int((rows[0] if rows else {}).get("version") or 0)


def _shape_version(row: Dict[str, Any]) -> Dict[str, Any]:
    snapshot = row.get("snapshot")
    if isinstance(snapshot, str):
        try:
            snapshot = json.loads(snapshot or "{}")
        except Exception:
            snapshot = {}
    if not isinstance(snapshot, dict):
        snapshot = {}
    created = row.get("created_at")
    return {"version": int(row.get("version") or 0),
            "note": str(row.get("note") or ""),
            "created_at": (created.isoformat() if hasattr(created, "isoformat")
                           else str(created or "")),
            "snapshot": {
                "name": str(snapshot.get("name") or ""),
                "tone": str(snapshot.get("tone") or ""),
                "instructions": str(snapshot.get("instructions") or ""),
                "escalation_user_id": snapshot.get("escalation_user_id"),
                "is_active": snapshot.get("is_active", True) is not False,
                "allowed_actions": _allowed_list(
                    snapshot.get("allowed_actions")),
                "max_risk": _risk(snapshot.get("max_risk")),
                "can_auto_reply": snapshot.get("can_auto_reply", True)
                is not False,
                "restored_from": snapshot.get("restored_from")}}


@bp.get("/agents/<int:agent_id>/versions")
def list_versions(agent_id: int):
    """Version history (newest first) - every save and every restore."""
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = int(principal.get("client_id") or 0)
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "SELECT id FROM " + portal_db._q(AGENTS_TABLE) +
                " WHERE id = %s AND client_id = %s",
                (agent_id, client_id),
            )
            if not portal_db.rows(cur):
                return jsonify({"error": {
                    "code": "not_found",
                    "message": "No such agent in this workspace."}}), 404
            cur.execute(
                "SELECT version, snapshot, note, created_at FROM " +
                portal_db._q(VERSIONS_TABLE) +
                " WHERE client_id = %s AND agent_id = %s"
                " ORDER BY version DESC LIMIT %s",
                (client_id, agent_id, max(1, MAX_VERSIONS_LISTED)),
            )
            rows = portal_db.rows(cur)
        conn.commit()
    finally:
        conn.close()
    return jsonify({"versions": [_shape_version(r) for r in rows]}), 200


@bp.post("/agents/<int:agent_id>/rollback")
def rollback_agent(agent_id: int):
    """Restore one snapshot as the NEW current config (a fresh version row
    noted "Restored from version N"); the history is never rewritten."""
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True) or {}
    version = payload.get("version")
    if isinstance(version, bool) or not isinstance(version, int) \
            or version <= 0:
        return jsonify({"error": {
            "code": "bad_request",
            "message": "version must be a positive integer."}}), 400
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "SELECT version, snapshot, note, created_at FROM " +
                portal_db._q(VERSIONS_TABLE) +
                " WHERE client_id = %s AND agent_id = %s AND version = %s",
                (client_id, agent_id, version),
            )
            rows = portal_db.rows(cur)
            if not rows:
                return jsonify({"error": {
                    "code": "not_found",
                    "message": "No such version for this agent."}}), 404
            wanted = _shape_version(rows[0])["snapshot"]
            permissions = {"allowed_actions": wanted["allowed_actions"],
                           "max_risk": wanted["max_risk"],
                           "can_auto_reply": wanted["can_auto_reply"]}
            escalation = wanted.get("escalation_user_id")
            if isinstance(escalation, bool) or not isinstance(escalation, int) \
                    or escalation <= 0:
                escalation = None
            name = (wanted["name"] or "Agent")[:MAX_NAME_CHARS]
            cur.execute(
                "UPDATE " + portal_db._q(AGENTS_TABLE) +
                " SET name = %s, tone = %s, instructions = %s,"
                " escalation_user_id = %s, is_active = TRUE,"
                " allowed_actions = CAST(%s AS JSONB), max_risk = %s,"
                " can_auto_reply = %s, updated_at = NOW()"
                " WHERE id = %s AND client_id = %s RETURNING id",
                (name, wanted["tone"][:MAX_TONE_CHARS],
                 wanted["instructions"][:MAX_INSTRUCTIONS_CHARS], escalation,
                 _permissions_json(permissions), permissions["max_risk"],
                 bool(permissions["can_auto_reply"]), agent_id, client_id),
            )
            if not portal_db.rows(cur):
                conn.rollback()
                return jsonify({"error": {
                    "code": "not_found",
                    "message": "No such agent in this workspace."}}), 404
            snapshot = _snapshot(name, wanted["tone"], wanted["instructions"],
                                 escalation, True, permissions)
            snapshot["restored_from"] = version
            new_version = _insert_version(
                cur, client_id, agent_id, snapshot,
                "Restored from version " + str(version))
            portal_db.log_action(
                cur, client_id, "agents.rolled_back", "human",
                principal.get("user_id"), None,
                ("Agent " + name + " restored to version " + str(version)
                 + " (now version " + str(new_version) + ")")[:200],
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "version": new_version,
                    "restored_from": version}), 200


@bp.delete("/agents/<int:agent_id>")
def archive_agent(agent_id: int):
    """Soft delete: agents steer past conversations' context - they are
    archived, never destroyed (data-preserving)."""
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = int(principal.get("client_id") or 0)
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "UPDATE " + portal_db._q(AGENTS_TABLE) +
                " SET is_active = FALSE, updated_at = NOW()"
                " WHERE id = %s AND client_id = %s RETURNING id",
                (agent_id, client_id),
            )
            rows = portal_db.rows(cur)
            if not rows:
                conn.rollback()
                return jsonify({"error": {
                    "code": "not_found",
                    "message": "No such agent in this workspace."}}), 404
            portal_db.log_action(
                cur, client_id, "agents.archived", "human",
                principal.get("user_id"), None,
                ("Agent archived (id " + str(agent_id) + ")")[:200],
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True}), 200
