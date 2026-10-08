"""
OmniFlow Control Plane — portal WhatsApp channel endpoints (customer Bearer).

GET  /api/v1/portal/channels/whatsapp   -> {state, account_name, phone, last_seen_at}
POST /api/v1/portal/channels/whatsapp   {action: connect|disconnect}
                                        -> {ok, message}  (command queued)

The actual WhatsApp session lives on the customer's connector (home laptop)
and NEVER on the server. These endpoints only read reported state and queue
commands that the connector picks up via /api/v1/connector/whatsapp/commands.

Contract (consumed by the website portal UI):
  200 GET  body keys: state | account_name | phone | last_seen_at
  200 POST body keys: ok | message
  401 unauthorized -> website BFF triggers its refresh flow
  503 portal_unavailable -> website shows the graceful pending state
"""

import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db


logger = logging.getLogger("omniflow.portal-channels")

bp = Blueprint("portal_channels", __name__, url_prefix="/api/v1/portal")

ALLOWED_STATES = ("disconnected", "connecting", "connected")
ALLOWED_ACTIONS = ("connect", "disconnect")


def channel_for_contact(contact_id: Any) -> str:
    """Return the outbound adapter for a canonical external contact id."""
    value = str(contact_id or "").strip().lower()
    if value.startswith("tg:"):
        return "telegram"
    if value.startswith(("ig:", "igc:")):
        return "instagram"
    if value.startswith(("fb:", "fbc:")):
        return "messenger"
    if value.startswith("em:"):
        return "email"  # §243: sent by the Control Plane over SMTP
    if value.startswith("sms:"):
        return "sms"  # §244: sent by the Control Plane through Twilio
    # §255: social channels (portal_social) - API mode is sent by the
    # Control Plane, login mode by the social login bridge
    if value.startswith(("tt:", "ttc:")):
        return "tiktok"
    if value.startswith(("x:", "xc:")):
        return "x"
    if value.startswith(("li:", "lic:")):
        return "linkedin"
    if value.startswith("ytc:"):
        return "youtube"
    if value.startswith("tgu:"):
        return "telegram_user"
    return "whatsapp"


def dispatch_now(client_id: Any, channel: str) -> None:
    """§244: deliver a just-queued reply on a Control-Plane channel right
    away (laptop bridges poll on their own). Fail-soft, never raises."""
    if channel in ("tiktok", "x", "linkedin", "youtube"):
        try:
            import portal_social

            # §255: sent now when the channel runs in API mode
            portal_social.dispatch(client_id, channel)
        except Exception:
            pass
        return
    if channel in ("instagram", "messenger"):
        try:
            import portal_instagram

            # §256: Meta replies leave from the Control Plane now
            portal_instagram.send_pending(int(client_id), portal_instagram.DISPATCH_LIMIT)
        except Exception:
            pass
        return
    if channel != "sms":
        return
    try:
        import portal_sms

        portal_sms.send_pending(int(client_id), portal_sms.DISPATCH_LIMIT)
    except Exception:
        pass


def _iso(value: Any) -> Optional[str]:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return None


@bp.get("/channels/whatsapp")
def get_whatsapp_status():
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
                    "SELECT state, phone, account_name, last_seen_at "
                    "FROM " + portal_db._q(portal_db.STATUS_TABLE) +
                    " WHERE client_id = %s",
                    (principal["client_id"],),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "wa status read")[0]), 503

    row: Dict[str, Any] = found[0] if found else {}
    state = row.get("state")
    if state not in ALLOWED_STATES:
        state = "disconnected"

    return jsonify({
        "state": state,
        "account_name": row.get("account_name"),
        "phone": row.get("phone"),
        "last_seen_at": _iso(row.get("last_seen_at")),
    }), 200


@bp.post("/channels/whatsapp")
def post_whatsapp_action():
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
    action = payload.get("action")
    if action not in ALLOWED_ACTIONS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Unknown action."}}), 400

    message = (
        "Connect request queued — your connector will link the WhatsApp account shortly."
        if action == "connect"
        else "Disconnect request queued — your connector will log the account out."
    )

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
                    " (client_id, channel, action, payload, status, requested_by,"
                    " created_at, updated_at) "
                    "VALUES (%s, 'whatsapp', %s, CAST(%s AS JSONB), 'pending', %s, NOW(), NOW()) "
                    "RETURNING id, created_at",
                    (principal["client_id"], action,
                     json.dumps(payload.get("payload") or {}),
                     principal["user_id"]),
                )
                inserted = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "wa command queue")[0]), 503

    logger.info(
        "whatsapp command queued id=%s client_id=%s action=%s",
        inserted[0].get("id") if inserted else "?",
        principal["client_id"],
        action,
    )
    return jsonify({"ok": True, "message": message}), 200
