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
    row, so config drift is always explainable.

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


def _shape(row: Dict[str, Any]) -> Dict[str, Any]:
    escalation = row.get("escalation_user_id")
    return {"id": int(row.get("id") or 0),
            "name": str(row.get("name") or ""),
            "tone": str(row.get("tone") or ""),
            "instructions": str(row.get("instructions") or ""),
            "escalation_user_id": int(escalation) if escalation else None,
            "is_active": bool(row.get("is_active")),
            "updated_at": str(row.get("updated_at") or "")}


# ---------------------------------------------------------------------------
# Helpers (read-side, fail-soft) - used by routing + the brain
# ---------------------------------------------------------------------------

def load_agent(cur, client_id: int, agent_id: int) -> Optional[Dict[str, Any]]:
    """One active agent row (None when missing/foreign/inactive)."""
    try:
        cur.execute(
            "SELECT id, name, tone, instructions, escalation_user_id,"
            " is_active, updated_at FROM " + portal_db._q(AGENTS_TABLE) +
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
            "SELECT a.id, a.name, a.tone, a.instructions,"
            " a.escalation_user_id, a.is_active, a.updated_at"
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
                "SELECT id, name, tone, instructions, escalation_user_id,"
                " is_active, updated_at FROM " + portal_db._q(AGENTS_TABLE) +
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
    return None, 200


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
                " (client_id, name, tone, instructions, escalation_user_id)"
                " VALUES (%s, %s, %s, %s, %s) RETURNING id",
                (client_id, name[:MAX_NAME_CHARS], tone[:MAX_TONE_CHARS],
                 instructions[:MAX_INSTRUCTIONS_CHARS], escalation),
            )
            rows = portal_db.rows(cur)
            agent_id = int((rows[0] if rows else {}).get("id") or 0)
            snapshot = {"name": name, "tone": tone,
                        "instructions": instructions,
                        "escalation_user_id": escalation}
            cur.execute(
                "INSERT INTO " + portal_db._q(VERSIONS_TABLE) +
                " (client_id, agent_id, version, snapshot)"
                " VALUES (%s, %s, 1, CAST(%s AS JSONB))",
                (client_id, agent_id,
                 json.dumps(snapshot, ensure_ascii=False)),
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
                              "is_active": True, "versions": 1}}), 200


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
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "UPDATE " + portal_db._q(AGENTS_TABLE) +
                " SET name = %s, tone = %s, instructions = %s,"
                " escalation_user_id = %s, is_active = %s, updated_at = NOW()"
                " WHERE id = %s AND client_id = %s RETURNING id",
                (name[:MAX_NAME_CHARS], tone[:MAX_TONE_CHARS],
                 instructions[:MAX_INSTRUCTIONS_CHARS], escalation,
                 is_active, agent_id, client_id),
            )
            rows = portal_db.rows(cur)
            if not rows:
                conn.rollback()
                return jsonify({"error": {
                    "code": "not_found",
                    "message": "No such agent in this workspace."}}), 404
            snapshot = {"name": name, "tone": tone,
                        "instructions": instructions,
                        "escalation_user_id": escalation,
                        "is_active": is_active}
            cur.execute(
                "INSERT INTO " + portal_db._q(VERSIONS_TABLE) +
                " (client_id, agent_id, version, snapshot)"
                " SELECT %s, %s, COALESCE(MAX(version), 0) + 1, CAST(%s AS"
                " JSONB) FROM " + portal_db._q(VERSIONS_TABLE) +
                " WHERE client_id = %s AND agent_id = %s",
                (client_id, agent_id,
                 json.dumps(snapshot, ensure_ascii=False),
                 client_id, agent_id),
            )
            portal_db.log_action(
                cur, client_id, "agents.saved", "human",
                principal.get("user_id"), None,
                ("Agent updated: " + name)[:200],
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True}), 200


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
