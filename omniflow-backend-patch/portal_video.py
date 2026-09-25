"""Video channel slice one: send a live meeting link into a chat.

The platform video keys live in the admin panel (Integrations > Video)
or the OF_VIDEO_* environment variables. The owner clicks "Send video
invite" on a conversation: the module creates a room with the
configured provider (Whereby, Daily or Zoom), drops the link into the
conversation through the normal WhatsApp command queue, and keeps a
small log so the owner can re-open the room later.

Standard library only; every provider hiccup maps to a clean 502 with
the provider named.
"""

import json
import logging
import os
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Dict

from flask import Blueprint, jsonify, request

import platform_settings
import portal_auth
import portal_db
from portal_auth import authenticate_portal_request
import portal_growth
from portal_auth import ensure_human_principal

CONVERSATIONS_TABLE = "portal_conversations"

logger = logging.getLogger("omniflow.portal-video")

bp = Blueprint("portal_video", __name__, url_prefix="/api/v1/portal")

ROOMS_TABLE = "portal_video_rooms"
TITLE_MAX = 120
PROVIDERS = ("whereby", "daily", "zoom")
LOG_LIMIT = 10

_DDL_READY = False

_DDL = (
    "CREATE TABLE IF NOT EXISTS " + portal_db._q(ROOMS_TABLE) + " ("
    " id BIGSERIAL PRIMARY KEY,"
    " client_id BIGINT NOT NULL,"
    " conversation_id BIGINT NOT NULL,"
    " contact_id TEXT NOT NULL DEFAULT '',"
    " provider TEXT NOT NULL DEFAULT 'whereby',"
    " url TEXT NOT NULL,"
    " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"
    ")"
)
_DDL_INDEX = (
    "CREATE INDEX IF NOT EXISTS portal_video_rooms_idx ON "
    + portal_db._q(ROOMS_TABLE) + " (client_id, id DESC)"
)


def _ensure_ddl(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    cur.execute(_DDL_INDEX)
    _DDL_READY = True


def _principal_or_error():
    """Module-level indirection so the test rig can stub auth."""
    return authenticate_portal_request(), None


def _post_json(url: str, headers: Dict[str, str],
               payload: Dict[str, Any]) -> Dict[str, Any]:
    try:
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode("utf8"), method="POST",
            headers={"Content-Type": "application/json", **headers},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return {"_status": resp.status,
                    **json.loads(resp.read().decode("utf8"))}
    except Exception as error:
        return {"_error": str(error) or "provider request failed"}


def _post_form(url: str, headers: Dict[str, str],
               body: bytes) -> Dict[str, Any]:
    try:
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded",
                     **headers},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return {"_status": resp.status,
                    **json.loads(resp.read().decode("utf8"))}
    except Exception as error:
        return {"_error": str(error) or "provider request failed"}


def _create_room(provider: str, config: Dict[str, str],
                 title: str) -> Dict[str, Any]:
    """Create one room; returns {'url': ...} or {'_error': ...}."""
    ends = (datetime.now(timezone.utc) + timedelta(days=1))
    ends_at = ends.strftime("%Y-%m-%dT%H:%M:%SZ")
    if provider == "whereby":
        data = _post_json(
            "https://api.whereby.dev/v1/meetings",
            {"Authorization": "Bearer " + config["api_key"]},
            {"endDate": ends_at, "meetingName": title[:60] or "meeting"},
        )
        if "_error" in data:
            return data
        url = str(data.get("meetingUrl") or "")
        return {"url": url} if url else {"_error": "no meetingUrl"}
    if provider == "daily":
        data = _post_json(
            "https://api.daily.co/v1/rooms",
            {"Authorization": "Bearer " + config["api_key"]},
            {"properties": {"exp": int(ends.timestamp())}},
        )
        if "_error" in data:
            return data
        url = str(data.get("url") or "")
        return {"url": url} if url else {"_error": "no room url"}
    if provider == "zoom":
        token_resp = _post_form(
            "https://zoom.us/oauth/token",
            {},
            ("grant_type=account_credentials&account_id="
             + urllib_request_quote(config["zoom_account_id"])
             ).encode("utf8"),
        )
        token = str(token_resp.get("access_token") or "")
        if not token:
            return {"_error": "zoom token rejected"}
        data = _post_json(
            "https://api.zoom.us/v2/users/me/meetings",
            {"Authorization": "Bearer " + token},
            {"topic": title[:TITLE_MAX] or "Meeting", "type": 1},
        )
        if "_error" in data:
            return data
        url = str(data.get("join_url") or "")
        return {"url": url} if url else {"_error": "no join_url"}
    return {"_error": "unknown provider"}


def urllib_request_quote(text: str) -> str:
    import urllib.parse
    return urllib.parse.quote(text or "", safe="")


def _row_public(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": int(row.get("id") or 0),
        "conversation_id": int(row.get("conversation_id") or 0),
        "contact_id": str(row.get("contact_id") or ""),
        "provider": str(row.get("provider") or ""),
        "url": str(row.get("url") or ""),
        "created_at": str(row.get("created_at") or ""),
    }


@bp.get("/video/rooms")
def list_video_rooms():
    principal, _ = _principal_or_error()
    if principal is None:
        return jsonify({"error": {"code": "unauthorized",
                                  "message": "Sign in required."}}), 401
    try:
        conversation_id = int(request.args.get("conversation_id") or 0)
    except Exception:
        conversation_id = 0
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                if conversation_id > 0:
                    cur.execute(
                        "SELECT id, conversation_id, contact_id,"
                        " provider, url, created_at FROM "
                        + portal_db._q(ROOMS_TABLE) +
                        " WHERE client_id = %s AND conversation_id = %s"
                        " ORDER BY id DESC LIMIT %s",
                        (principal["client_id"], conversation_id,
                         LOG_LIMIT),
                    )
                else:
                    cur.execute(
                        "SELECT id, conversation_id, contact_id,"
                        " provider, url, created_at FROM "
                        + portal_db._q(ROOMS_TABLE) +
                        " WHERE client_id = %s ORDER BY id DESC LIMIT %s",
                        (principal["client_id"], LOG_LIMIT),
                    )
                rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(
            error, "video rooms")[0]), 503
    return jsonify({"rooms": [_row_public(r) for r in rows]}), 200


@bp.post("/video/rooms")
def create_video_room():
    principal, _ = _principal_or_error()
    if principal is None:
        return jsonify({"error": {"code": "unauthorized",
                                  "message": "Sign in required."}}), 401
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    try:
        conversation_id = int(payload.get("conversation_id") or 0)
    except Exception:
        conversation_id = 0
    title = str(payload.get("title") or "").strip()[:TITLE_MAX]
    provider = str(payload.get("provider") or "").strip().lower()
    if conversation_id <= 0:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "conversation_id is"
                                             " required."}}), 400
    config = platform_settings.video_config()
    if not provider:
        provider = str(config.get("provider") or "whereby")
    if provider not in PROVIDERS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "provider must be one of: "
                                             + ", ".join(PROVIDERS)
                                             + "."}}), 400
    if provider == "zoom":
        if not (config.get("zoom_account_id")
                and config.get("zoom_client_id")
                and config.get("zoom_client_secret")):
            return jsonify({"error": {"code": "not_configured",
                                      "message": "Zoom needs the account"
                                                 " id, client id and"
                                                 " client secret in the"
                                                 " admin panel."}}), 409
    elif not config.get("api_key"):
        return jsonify({"error": {"code": "not_configured",
                                  "message": "Video is not configured -"
                                             " add the provider key in"
                                             " the admin panel Integrations"
                                             " page."}}), 409
    room = _create_room(provider, config, title)
    if "_error" in room or not room.get("url"):
        logger.warning("video room create failed: %s", room.get("_error"))
        return jsonify({"error": {"code": "provider_error",
                                  "message": provider
                                             + " rejected the room -"
                                             " check the saved keys."}}), 502
    url = str(room["url"])[:500]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT contact_id FROM "
                    + portal_db._q(CONVERSATIONS_TABLE) +
                    " WHERE id = %s AND client_id = %s LIMIT 1",
                    (conversation_id, principal["client_id"]),
                )
                conv_rows = portal_db.rows(cur)
                if not conv_rows:
                    conn.rollback()
                    return jsonify({"error": {"code": "not_found",
                                              "message": "No such"
                                                         " conversation in"
                                                         " this"
                                                         " workspace."}}), 404
                contact_id = str(conv_rows[0].get("contact_id") or "")
                cur.execute(
                    "SELECT contact_name FROM "
                    + portal_db._q(CONVERSATIONS_TABLE) +
                    " WHERE id = %s AND client_id = %s LIMIT 1",
                    (conversation_id, principal["client_id"]),
                )
                name_rows = portal_db.rows(cur)
                name = str(name_rows[0].get("contact_name") or "") \
                    if name_rows else ""
                portal_growth._send_command(
                    cur, principal["client_id"], contact_id, name,
                    (title + ": " if title else "Video call: ") + url
                    + " (tap to join)",
                    "video_invite",
                )
                _ensure_ddl(cur)
                cur.execute(
                    "INSERT INTO " + portal_db._q(ROOMS_TABLE) +
                    " (client_id, conversation_id, contact_id, provider,"
                    " url) VALUES (%s, %s, %s, %s, %s)"
                    " RETURNING id, conversation_id, contact_id,"
                    " provider, url, created_at",
                    (principal["client_id"], conversation_id, contact_id,
                     provider, url),
                )
                created = portal_db.rows(cur)
                portal_db.log_action(
                    cur, principal["client_id"], "video.invited", "human",
                    principal.get("user_id"), conversation_id,
                    (provider + " invite sent to "
                     + contact_id[-4:])[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(
            error, "video invite")[0]), 503
    return jsonify({"ok": True, "room": _row_public(created[0])}), 200
