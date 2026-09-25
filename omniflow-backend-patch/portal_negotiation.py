"""Negotiation guardrails: merchant-set discount limits plus a deterministic
counter-offer calculator (no AI)."""

import logging

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db
from typing import Any, Dict

bp = Blueprint("portal_negotiation", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

NEGOTIATION_TABLE = "portal_negotiation_settings"

DEFAULT_FLOOR = 0
DEFAULT_MAX = 25

_NEGOTIATION_DDL_READY = False


def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": str(error)}}), 503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}), 401)
    return principal, None


def _ensure_negotiation_tables(conn) -> None:
    global _NEGOTIATION_DDL_READY
    if _NEGOTIATION_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(NEGOTIATION_TABLE) +
            " (client_id BIGINT PRIMARY KEY,"
            " enabled BOOLEAN NOT NULL DEFAULT FALSE,"
            " floor_percent INT NOT NULL DEFAULT " + str(DEFAULT_FLOOR) + ","
            " max_percent INT NOT NULL DEFAULT " + str(DEFAULT_MAX) + ","
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
    conn.commit()
    _NEGOTIATION_DDL_READY = True


def _load_settings(cur, client_id) -> Dict[str, Any]:
    cur.execute(
        "SELECT enabled, floor_percent, max_percent FROM " +
        portal_db._q(NEGOTIATION_TABLE) + " WHERE client_id = %s",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    if not rows:
        return {"enabled": False, "floor_percent": DEFAULT_FLOOR,
                "max_percent": DEFAULT_MAX}
    row = rows[0]
    return {
        "enabled": row.get("enabled") is True,
        "floor_percent": int(row.get("floor_percent") or DEFAULT_FLOOR),
        "max_percent": int(row.get("max_percent") or DEFAULT_MAX),
    }


@bp.get("/negotiation/settings")
def get_negotiation_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_negotiation_tables(conn)
            with conn.cursor() as cur:
                settings = _load_settings(cur, principal["client_id"])
        finally:
            conn.close()
    except Exception as error:
        logger.warning("negotiation settings read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "negotiation settings read")[0]), 503
    return jsonify({"settings": settings}), 200


@bp.put("/negotiation/settings")
def put_negotiation_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    enabled = payload.get("enabled")
    floor = payload.get("floor_percent", DEFAULT_FLOOR)
    maxp = payload.get("max_percent", DEFAULT_MAX)
    if enabled is not None and not isinstance(enabled, bool):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "enabled must be true or"
                                             " false."}}), 400
    for name, value in (("floor_percent", floor), ("max_percent", maxp)):
        if isinstance(value, bool) or not isinstance(value, int) or not (
                0 <= value <= 70):
            return jsonify({"error": {"code": "bad_request",
                                      "message": name + " must be 0-70."}}), 400
    if maxp < floor:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "max_percent must be at least"
                                             " floor_percent."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_negotiation_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(NEGOTIATION_TABLE) +
                    " (client_id, enabled, floor_percent, max_percent)"
                    " VALUES (%s, %s, %s, %s)"
                    " ON CONFLICT (client_id) DO UPDATE SET"
                    " enabled = EXCLUDED.enabled,"
                    " floor_percent = EXCLUDED.floor_percent,"
                    " max_percent = EXCLUDED.max_percent, updated_at = NOW()",
                    (principal["client_id"], enabled is True, floor, maxp),
                )
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "negotiation.settings",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Negotiation limits: floor " + str(floor) + "%, max "
                     + str(maxp) + "%")[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("negotiation settings save failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "negotiation settings save")[0]), 503
    return jsonify({"ok": True, "settings": {
        "enabled": enabled is True,
        "floor_percent": floor,
        "max_percent": maxp,
    }}), 200


@bp.get("/negotiation/quote")
def negotiation_quote():
    """Deterministic counter-offer: customer ask vs listed price, within the
    merchant's max discount. No AI, no memory, pure arithmetic."""
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        ask = round(float(request.args.get("ask") or ""), 2)
        price = round(float(request.args.get("price") or ""), 2)
    except ValueError:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "ask and price must be"
                                             " numbers."}}), 400
    if ask <= 0 or price <= 0:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "ask and price must be"
                                             " positive."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_negotiation_tables(conn)
            with conn.cursor() as cur:
                settings = _load_settings(cur, principal["client_id"])
        finally:
            conn.close()
    except Exception as error:
        logger.warning("negotiation quote failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "quote")[0]), 503
    max_percent = int(settings["max_percent"])
    discount_pct = 0.0
    if ask < price:
        discount_pct = round((price - ask) / price * 100.0, 1)
    verdict = "accept"
    counter = ask
    if discount_pct > max_percent:
        verdict = "counter"
        counter = round(price * (1.0 - max_percent / 100.0), 2)
    return jsonify({
        "ask": ask,
        "price": price,
        "discount_percent": discount_pct,
        "verdict": verdict,
        "counter": counter,
        "max_percent": max_percent,
        "enabled": settings["enabled"],
    }), 200
