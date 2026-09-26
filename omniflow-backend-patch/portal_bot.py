"""
OmniFlow Control Plane — portal AI agent (bot) configuration (customer Bearer).

GET /api/v1/portal/bot  -> normalized agent config (defaults when unsaved)
PUT /api/v1/portal/bot  {agent_name, tone, greeting, fallback,
                         working_hours_enabled, working_hours_start,
                         working_hours_end, human_handoff_enabled}
                        -> {ok, updated_at}

The connector (laptop bot) reads the same config via
GET /api/v1/connector/bot so the running bot always matches the portal.

Contract (consumed by the website portal UI):
  200 GET  snake_case config keys + updated_at (null when never saved)
  200 PUT  {ok: true, updated_at}
  400 validation_error | 401 unauthorized | 503 portal_unavailable
"""

import logging
import re
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db


logger = logging.getLogger("omniflow.portal-bot")

bp = Blueprint("portal_bot", __name__, url_prefix="/api/v1/portal")

TONES = ("friendly", "professional", "concise")
_NAME_RE = re.compile(r"^.{1,64}$", re.DOTALL)
_TEXT_RE = re.compile(r"^.{0,2000}$", re.DOTALL)
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

DEFAULTS: Dict[str, Any] = {
    "agent_name": "OmniFlow Assistant",
    "tone": "friendly",
    "greeting": "",
    "fallback": "",
    "working_hours_enabled": False,
    "working_hours_start": "09:00",
    "working_hours_end": "18:00",
    "human_handoff_enabled": False,
}


def _iso(value: Any) -> Optional[str]:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return None


def _pick(payload: Dict[str, Any], *keys: str) -> Any:
    """Accept snake_case or camelCase (website sends snake_case)."""
    for key in keys:
        if key in payload:
            return payload[key]
    return None


def _as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in ("true", "1", "yes", "on"):
            return True
        if lowered in ("false", "0", "no", "off", ""):
            return False
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    return default


def _validated_config(payload: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Returns (config, error_message)."""
    agent_name = _pick(payload, "agent_name", "agentName")
    agent_name = (agent_name or "").strip() if isinstance(agent_name, str) else ""
    if not _NAME_RE.match(agent_name):
        return None, "Agent name 1-64 characters ka hona chahiye."

    tone = _pick(payload, "tone")
    tone = (tone or "").strip() if isinstance(tone, str) else ""
    if tone not in TONES:
        return None, "Tone friendly, professional ya concise ho sakta hai."

    greeting = _pick(payload, "greeting")
    greeting = greeting if isinstance(greeting, str) else ""
    fallback = _pick(payload, "fallback")
    fallback = fallback if isinstance(fallback, str) else ""
    if not _TEXT_RE.match(greeting) or not _TEXT_RE.match(fallback):
        return None, "Greeting/fallback 2000 characters se chhote rakhein."

    wh_enabled = _as_bool(_pick(payload, "working_hours_enabled", "workingHoursEnabled"), False)
    wh_start = _pick(payload, "working_hours_start", "workingHoursStart")
    wh_end = _pick(payload, "working_hours_end", "workingHoursEnd")
    wh_start = (wh_start or "").strip() if isinstance(wh_start, str) else DEFAULTS["working_hours_start"]
    wh_end = (wh_end or "").strip() if isinstance(wh_end, str) else DEFAULTS["working_hours_end"]
    if wh_enabled:
        if not _TIME_RE.match(wh_start) or not _TIME_RE.match(wh_end):
            return None, "Working hours HH:MM format me hon (jaise 09:00)."
        if wh_start >= wh_end:
            return None, "Working hours ka start end se pehle hona chahiye."

    handoff = _as_bool(_pick(payload, "human_handoff_enabled", "humanHandoffEnabled"), False)

    config = {
        "agent_name": agent_name,
        "tone": tone,
        "greeting": greeting,
        "fallback": fallback,
        "working_hours_enabled": wh_enabled,
        "working_hours_start": wh_start,
        "working_hours_end": wh_end,
        "human_handoff_enabled": handoff,
    }
    return config, None


@bp.get("/bot")
def get_bot_config():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return jsonify({"error": {"code": "portal_unavailable",
                                  "message": str(error)}}), 503
    if principal is None:
        return jsonify({"error": {"code": "unauthorized",
                                  "message": "Sign in required."}}), 401

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT agent_name, tone, greeting, fallback,"
                    " working_hours_enabled, working_hours_start, working_hours_end,"
                    " human_handoff_enabled, updated_at"
                    " FROM " + portal_db._q(portal_db.BOT_TABLE) +
                    " WHERE client_id = %s",
                    (principal["client_id"],),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "bot config read")[0]), 503

    config = dict(DEFAULTS)
    updated_at = None
    if found:
        row = found[0]
        config = {
            "agent_name": row.get("agent_name") or DEFAULTS["agent_name"],
            "tone": row.get("tone") if row.get("tone") in TONES else DEFAULTS["tone"],
            "greeting": row.get("greeting") or "",
            "fallback": row.get("fallback") or "",
            "working_hours_enabled": row.get("working_hours_enabled") is True,
            "working_hours_start": row.get("working_hours_start") or DEFAULTS["working_hours_start"],
            "working_hours_end": row.get("working_hours_end") or DEFAULTS["working_hours_end"],
            "human_handoff_enabled": row.get("human_handoff_enabled") is True,
        }
        updated_at = _iso(row.get("updated_at"))

    body = dict(config)
    body["updated_at"] = updated_at
    return jsonify(body), 200


@bp.put("/bot")
def put_bot_config():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return jsonify({"error": {"code": "portal_unavailable",
                                  "message": str(error)}}), 503
    if principal is None:
        return jsonify({"error": {"code": "unauthorized",
                                  "message": "Sign in required."}}), 401

    forbidden = ensure_human_principal(principal)
    if forbidden:
        return forbidden

    payload = request.get_json(silent=True) or {}
    config, error = _validated_config(payload)
    if error or config is None:
        return jsonify({"error": {"code": "validation_error",
                                  "message": error or "Invalid configuration."}}), 400

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(portal_db.BOT_TABLE) +
                    " (client_id, agent_name, tone, greeting, fallback,"
                    " working_hours_enabled, working_hours_start, working_hours_end,"
                    " human_handoff_enabled, updated_by, updated_at) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW()) "
                    "ON CONFLICT (client_id) DO UPDATE SET "
                    " agent_name = EXCLUDED.agent_name,"
                    " tone = EXCLUDED.tone,"
                    " greeting = EXCLUDED.greeting,"
                    " fallback = EXCLUDED.fallback,"
                    " working_hours_enabled = EXCLUDED.working_hours_enabled,"
                    " working_hours_start = EXCLUDED.working_hours_start,"
                    " working_hours_end = EXCLUDED.working_hours_end,"
                    " human_handoff_enabled = EXCLUDED.human_handoff_enabled,"
                    " updated_by = EXCLUDED.updated_by,"
                    " updated_at = NOW() "
                    "RETURNING updated_at",
                    (principal["client_id"], config["agent_name"], config["tone"],
                     config["greeting"], config["fallback"],
                     config["working_hours_enabled"], config["working_hours_start"],
                     config["working_hours_end"], config["human_handoff_enabled"],
                     principal["user_id"]),
                )
                inserted = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "bot config write")[0]), 503

    updated_at = _iso(inserted[0].get("updated_at")) if inserted else None
    logger.info("bot config saved client_id=%s by user_id=%s",
                principal["client_id"], principal["user_id"])
    return jsonify({"ok": True, "updated_at": updated_at}), 200
