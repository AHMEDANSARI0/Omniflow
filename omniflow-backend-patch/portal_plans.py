"""Plans + entitlements + usage (V2 B15).

A self-serve plan layer: the owner picks a plan, sees live usage
against its limits, and new features can consult one helper instead
of growing hard-coded paid flags. Every workspace starts on the
"legacy" plan - unlimited everything - so existing tenants never
change behaviour until they deliberately switch.

Limits use None for "unlimited". The check helper is the single
integration point for future enforcement (B16+).
"""
import logging
from typing import Any, Dict, Optional, Tuple

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
)
import portal_db

bp = Blueprint("portal_plans", __name__, url_prefix="/api/v1/portal")
logger = logging.getLogger(__name__)

SETTINGS_TABLE = "portal_plan_settings"

# ---------------------------------------------------------------------------
# Plan catalog (data - adjust limits here, nothing else to touch)
# ---------------------------------------------------------------------------

PLANS: Dict[str, Dict[str, Any]] = {
    "legacy": {
        "label": "Legacy (unlimited)",
        "description": "Default for every existing workspace - nothing "
                       "is capped.",
        "limits": {
            "broadcasts_per_month": None,
            "team_seats": None,
            "kb_entries": None,
            "alert_rules": None,
            "courier_providers": None,
            "brands": None,
        },
    },
    "free": {
        "label": "Free",
        "description": "Try everything with small caps.",
        "limits": {
            "broadcasts_per_month": 100,
            "team_seats": 1,
            "kb_entries": 20,
            "alert_rules": 5,
            "courier_providers": 1,
            "brands": 1,
        },
    },
    "growth": {
        "label": "Growth",
        "description": "For busy shops - room for a small team.",
        "limits": {
            "broadcasts_per_month": 1000,
            "team_seats": 5,
            "kb_entries": 100,
            "alert_rules": 25,
            "courier_providers": 3,
            "brands": 5,
        },
    },
    "pro": {
        "label": "Pro",
        "description": "Everything unlocked.",
        "limits": {
            "broadcasts_per_month": None,
            "team_seats": None,
            "kb_entries": None,
            "alert_rules": None,
            "courier_providers": None,
            "brands": None,
        },
    },
}

DEFAULT_PLAN = "legacy"


def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": "Try again shortly."}}),
                      503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}),
                      401)
    if principal.get("via_api_key"):
        return None, (jsonify({"error": {"code": "forbidden",
                                         "message": "Owner sign-in"
                                                    " required."}}),
                      403)
    return principal, None


_DDL_READY = False

_DDL = """
CREATE TABLE IF NOT EXISTS portal_plan_settings (
  client_id BIGINT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'legacy',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""


def _ensure_ddl(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    _DDL_READY = True


def _load_plan(cur, client_id: int) -> str:
    cur.execute(
        "SELECT plan FROM " + portal_db._q(SETTINGS_TABLE) +
        " WHERE client_id = %s LIMIT 1",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    plan = str(rows[0].get("plan") or "") if rows else ""
    return plan if plan in PLANS else DEFAULT_PLAN


def _count(cur, sql: str, args: tuple) -> int:
    cur.execute(sql, args)
    rows = portal_db.rows(cur)
    return int(rows[0].get("n") or 0) if rows else 0


def _usage(cur, client_id: int) -> Dict[str, int]:
    """Live counters - one indexed query each."""
    return {
        "broadcasts_per_month": _count(
            cur,
            "SELECT COUNT(*) AS n FROM "
            + portal_db._q(portal_db.BROADCASTS_TABLE) +
            " WHERE client_id = %s"
            " AND created_at >= date_trunc('month', NOW())",
            (client_id,)),
        "team_seats": _count(
            cur,
            "SELECT COUNT(*) AS n FROM " + portal_db._q(portal_db.TEAM_TABLE)
            + " WHERE client_id = %s", (client_id,)),
        "kb_entries": _count(
            cur,
            "SELECT COUNT(*) AS n FROM portal_kb_entries"
            " WHERE client_id = %s", (client_id,)),
        "alert_rules": _count(
            cur,
            "SELECT COUNT(*) AS n FROM portal_listen_rules"
            " WHERE client_id = %s", (client_id,)),
        "courier_providers": _count(
            cur,
            "SELECT COUNT(*) AS n FROM portal_courier_providers"
            " WHERE client_id = %s", (client_id,)),
        "brands": _count(
            cur,
            "SELECT COUNT(*) AS n FROM portal_brands"
            " WHERE client_id = %s", (client_id,)),
    }


def check(cur, client_id: int, limit_key: str) -> Dict[str, Any]:
    """THE integration point for future enforcement.

    Returns {ok, used, limit} - limit None (or plan legacy) is always
    ok. Pass a cursor from the caller's transaction; never raises on
    missing tables (a failed COUNT reads as unlimited, fail-open).
    """
    try:
        plan = _load_plan(cur, client_id)
        limits = PLANS[plan]["limits"]
        limit = limits.get(limit_key)
        if limit is None:
            return {"ok": True, "used": None, "limit": None,
                    "plan": plan}
        usage = _usage(cur, client_id)
        used = int(usage.get(limit_key) or 0)
        return {"ok": used < limit, "used": used, "limit": limit,
                "plan": plan}
    except Exception as error:  # fail-open by design
        logger.warning("entitlement check failed: %s", error)
        return {"ok": True, "used": None, "limit": None,
                "plan": DEFAULT_PLAN}


def enforce(cur, client_id: int, limit_key: str, label: str):
    """Endpoint guard: returns a (response, 409) tuple when the plan
    cap is reached, None when the action may proceed. Fail-open like
    check(); the message names the Settings card that fixes it."""
    result = check(cur, client_id, limit_key)
    if result["ok"]:
        return None
    return (jsonify({"error": {"code": "plan_limit",
                               "message": label + " plan limit reached ("
                                          + str(result["limit"])
                                          + ") - switch plans in Settings"
                                          " > Plan & usage to"
                                          " continue."}}), 409)


@bp.get("/plans")
def get_plans():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            plan = _load_plan(cur, client_id)
            usage = _usage(cur, client_id)
        conn.commit()
    finally:
        conn.close()
    return jsonify({
        "plan": plan,
        "limits": PLANS[plan]["limits"],
        "usage": usage,
        "catalog": [{"key": key, "label": entry["label"],
                     "description": entry["description"],
                     "limits": entry["limits"]}
                    for key, entry in PLANS.items()],
    }), 200


@bp.put("/plans")
def put_plans():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    payload = request.get_json(silent=True) or {}
    plan = str(payload.get("plan") or "").strip().lower()
    if plan not in PLANS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "plan must be one of: "
                                             + ", ".join(PLANS)
                                             + "."}}), 400
    client_id = int(principal["client_id"])
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "INSERT INTO " + portal_db._q(SETTINGS_TABLE) +
                " (client_id, plan, updated_at)"
                " VALUES (%s, %s, NOW())"
                " ON CONFLICT (client_id) DO UPDATE SET"
                " plan = EXCLUDED.plan, updated_at = EXCLUDED.updated_at",
                (client_id, plan),
            )
            portal_db.log_action(
                cur, client_id, "plan.changed", "human",
                None, None, "Plan set to " + plan,
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "plan": plan}), 200
