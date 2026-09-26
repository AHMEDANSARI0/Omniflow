"""Voice channel slice one: owner click-to-call via Twilio.

The platform voice keys live in the admin panel (Integrations > Voice:
Twilio account SID, auth token, from number) or the OF_TWILIO_*
environment variables. With keys saved, the owner can call any
customer right from the conversation: Twilio places the call and reads
the short message aloud (TwiML <Say>), the call lands in a small log,
and Twilio's status webhook keeps the status column fresh.

Standard library only (urllib + base64), fail-soft like every other
provider adapter: a missing config is a clean 409, a Twilio error a
502, and nothing here ever blocks the ingest loop.
"""

import base64
import logging
import os
import urllib.parse
import urllib.request
from typing import Any, Dict

from flask import Blueprint, jsonify, request, Response

import platform_settings
import portal_auth
import portal_db
from portal_auth import authenticate_portal_request
from portal_auth import ensure_human_principal

logger = logging.getLogger("omniflow.portal-voice")

bp = Blueprint("portal_voice", __name__, url_prefix="/api/v1/portal")
public_bp = Blueprint("portal_voice_public", __name__,
                      url_prefix="/api/v1/public")

CALLS_TABLE = "portal_voice_calls"
NAME_MAX = 300
LOG_LIMIT = 20

_DDL_READY = False

_DDL = (
    "CREATE TABLE IF NOT EXISTS " + portal_db._q(CALLS_TABLE) + " ("
    " id BIGSERIAL PRIMARY KEY,"
    " client_id BIGINT NOT NULL,"
    " contact_id TEXT NOT NULL DEFAULT '',"
    " phone TEXT NOT NULL,"
    " sid TEXT NOT NULL DEFAULT '',"
    " status TEXT NOT NULL DEFAULT 'queued',"
    " message TEXT NOT NULL DEFAULT '',"
    " direction TEXT NOT NULL DEFAULT 'outbound',"
    " recording_url TEXT NOT NULL DEFAULT '',"
    " duration_seconds INT NOT NULL DEFAULT 0,"
    " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"
    ")"
)
_DDL_MIGRATE = (
    "ALTER TABLE " + portal_db._q(CALLS_TABLE) +
    " ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'outbound',"
    " ADD COLUMN IF NOT EXISTS recording_url TEXT NOT NULL DEFAULT '',"
    " ADD COLUMN IF NOT EXISTS duration_seconds INT NOT NULL DEFAULT 0"
)
_DDL_INDEX = (
    "CREATE INDEX IF NOT EXISTS portal_voice_calls_idx ON "
    + portal_db._q(CALLS_TABLE) + " (client_id, id DESC)"
)


def _ensure_ddl(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    cur.execute(_DDL_MIGRATE)
    cur.execute(_DDL_INDEX)
    _DDL_READY = True


def _principal_or_error():
    """Module-level indirection so the test rig can stub auth."""
    return authenticate_portal_request(), None


def _voice_keys() -> Dict[str, str]:
    stored = {}
    try:
        stored = platform_settings.get_group("voice")
    except Exception:
        stored = {}
    def pick(name, env):
        return str(stored.get(name) or "").strip() or \
            os.environ.get(env, "").strip()
    return {
        "account_sid": pick("account_sid", "OF_TWILIO_ACCOUNT_SID"),
        "auth_token": str(stored.get("auth_token") or "")
                      or os.environ.get("OF_TWILIO_AUTH_TOKEN", ""),
        "from_number": pick("from_number", "OF_TWILIO_FROM_NUMBER"),
    }


def voice_configured(keys: Dict[str, str]) -> bool:
    return bool(keys.get("account_sid") and keys.get("auth_token")
                and keys.get("from_number"))


def _twilio_create_call(keys: Dict[str, str], to_number: str,
                        message: str) -> Dict[str, Any]:
    """POST the create-call request; dict response or {'_error': ...}."""
    try:
        endpoint = ("https://api.twilio.com/2010-04-01/Accounts/"
                    + keys["account_sid"] + "/Calls.json")
        twiml = ("<Response><Say>" + _xml_escape(message)
                 + "</Say></Response>")
        body = urllib.parse.urlencode({
            "To": to_number,
            "From": keys["from_number"],
            "Twiml": twiml,
        }).encode("utf8")
        token = base64.b64encode(
            (keys["account_sid"] + ":" + keys["auth_token"])
            .encode("utf8")).decode("ascii")
        req = urllib.request.Request(
            endpoint, data=body, method="POST",
            headers={
                "Authorization": "Basic " + token,
                "Content-Type": "application/x-www-form-urlencoded",
            },
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            import json
            return {"_status": resp.status,
                    **json.loads(resp.read().decode("utf8"))}
    except Exception as error:
        return {"_error": str(error) or "twilio request failed"}


def _xml_escape(text: str) -> str:
    return (str(text or "").replace("&", "&amp;")
            .replace("<", "&lt;").replace(">", "&gt;"))


DEFAULT_GREETING = ("Thank you for calling! Please leave your message "
                    "after the tone.")
INBOUND_MAX_SECONDS = 120


def _greeting() -> str:
    """Owner-recorded greeting (admin panel voice group) or the default."""
    try:
        stored = platform_settings.get_group("voice") or {}
    except Exception:
        stored = {}
    return str(stored.get("greeting") or "").strip()[:200] \
        or DEFAULT_GREETING


def _digits(raw: str) -> str:
    return "".join(ch for ch in str(raw or "") if ch.isdigit())


def _match_caller(cur, from_digits: str):
    """Find the conversation whose contact jid shares the caller's last
    9 digits (the Pakistani national number). Returns (client_id,
    conversation_id) or (0, None) for unknown callers."""
    tail = from_digits[-9:]
    if len(from_digits) < 10:
        return 0, None
    cur.execute(
        "SELECT client_id, id FROM " + portal_db._q("portal_conversations") +
        " WHERE right(regexp_replace(contact_id, '\\D', '', 'g'), 9) = %s"
        " ORDER BY id DESC LIMIT 1",
        (tail,),
    )
    rows = portal_db.rows(cur)
    if not rows:
        return 0, None
    return int(rows[0].get("client_id") or 0), \
        int(rows[0].get("id") or 0)


def _media_url(recording_url: str) -> str:
    """Twilio serves recordings at <RecordingUrl>.mp3."""
    url = str(recording_url or "")
    if not url.endswith(".mp3") and not url.endswith(".wav"):
        url = url + ".mp3"
    return url


def _twilio_fetch_media(keys: Dict[str, str], recording_url: str) -> bytes:
    """GET the recording media from Twilio (Basic auth) - raw bytes."""
    url = _media_url(recording_url)
    token = base64.b64encode(
        (keys["account_sid"] + ":" + keys["auth_token"])
        .encode("utf8")).decode("ascii")
    req = urllib.request.Request(url, method="GET", headers={
        "Authorization": "Basic " + token,
    })
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read()


def _row_public(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": int(row.get("id") or 0),
        "contact_id": str(row.get("contact_id") or ""),
        "phone": str(row.get("phone") or ""),
        "sid": str(row.get("sid") or ""),
        "status": str(row.get("status") or "queued"),
        "message": str(row.get("message") or ""),
        "direction": str(row.get("direction") or "outbound"),
        "has_recording": bool(row.get("recording_url")),
        "duration_seconds": int(row.get("duration_seconds") or 0),
        "created_at": str(row.get("created_at") or ""),
    }


@bp.get("/voice/calls")
def list_voice_calls():
    principal, _ = _principal_or_error()
    if principal is None:
        return jsonify({"error": {"code": "unauthorized",
                                  "message": "Sign in required."}}), 401
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                cur.execute(
                    "SELECT id, contact_id, phone, sid, status,"
                    " message, direction, recording_url,"
                    " duration_seconds, created_at FROM "
                    + portal_db._q(CALLS_TABLE) +
                    " WHERE client_id = %s ORDER BY id DESC LIMIT %s",
                    (principal["client_id"], LOG_LIMIT),
                )
                rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(
            error, "voice calls")[0]), 503
    return jsonify({"calls": [_row_public(r) for r in rows]}), 200


@bp.post("/voice/calls")
def create_voice_call():
    principal, _ = _principal_or_error()
    if principal is None:
        return jsonify({"error": {"code": "unauthorized",
                                  "message": "Sign in required."}}), 401
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    phone = str(payload.get("phone") or "").strip()
    message = str(payload.get("message") or "").strip()[:NAME_MAX]
    contact_id = str(payload.get("contact_id") or "").strip()[:100]
    if not phone.startswith("+") or not phone[1:].isdigit():
        return jsonify({"error": {"code": "bad_request",
                                  "message": "phone must be E.164, e.g."
                                             " +923001234567."}}), 400
    if not message:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Write the short message the"
                                             " call should read."}}), 400
    keys = _voice_keys()
    if not voice_configured(keys):
        return jsonify({"error": {"code": "not_configured",
                                  "message": "Voice is not configured -"
                                             " add the Twilio keys in the"
                                             " admin panel Integrations"
                                             " page."}}), 409
    result = _twilio_create_call(keys, phone, message)
    if "_error" in result or "_status" not in result \
            or int(result["_status"]) >= 300:
        logger.warning("twilio call failed: %s", result.get("_error"))
        return jsonify({"error": {"code": "twilio_error",
                                  "message": "Twilio rejected the call -"
                                             " check the saved keys and"
                                             " the from number."}}), 502
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                cur.execute(
                    "INSERT INTO " + portal_db._q(CALLS_TABLE) +
                    " (client_id, contact_id, phone, sid, status,"
                    " message) VALUES (%s, %s, %s, %s, %s, %s)"
                    " RETURNING id, contact_id, phone, sid, status,"
                    " message, created_at",
                    (principal["client_id"], contact_id, phone,
                     str(result.get("sid") or ""),
                     str(result.get("status") or "queued"), message),
                )
                created = portal_db.rows(cur)
                portal_db.log_action(
                    cur, principal["client_id"], "voice.called", "human",
                    principal.get("user_id"), None,
                    ("Twilio call to " + phone[-4:])[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(
            error, "voice call")[0]), 503
    return jsonify({"ok": True, "call": _row_public(created[0])}), 200


@public_bp.post("/voice/webhook")
def voice_webhook():
    """Twilio status callback: update the call status by CallSid."""
    sid = str(request.form.get("CallSid") or "").strip()[:64]
    status = str(request.form.get("CallStatus") or "").strip()[:32]
    if sid and status:
        try:
            portal_db.ensure_tables()
            conn = portal_db._conn()
            try:
                with conn.cursor() as cur:
                    _ensure_ddl(cur)
                    cur.execute(
                        "UPDATE " + portal_db._q(CALLS_TABLE) +
                        " SET status = %s WHERE sid = %s",
                        (status, sid),
                    )
                conn.commit()
            finally:
                conn.close()
        except Exception:
            logger.warning("voice webhook update failed", exc_info=True)
    return "", 204


@public_bp.post("/voice/incoming")
def voice_incoming():
    """Twilio inbound-call webhook: greet the caller and take a voicemail.

    The caller is matched to a conversation by phone digits so the
    voicemail lands in the right workspace's call log; unknown callers
    are recorded under the platform inbox (client 0).
    """
    sid = str(request.form.get("CallSid") or "").strip()[:64]
    from_raw = str(request.form.get("From") or "").strip()[:32]
    if not sid or not _digits(from_raw):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Missing call details."}}), 400
    from_digits = _digits(from_raw)
    phone = from_raw if from_raw.startswith("+") \
        else "+" + from_digits
    client_id, conversation_id = 0, None
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                client_id, conversation_id = _match_caller(cur, from_digits)
                cur.execute(
                    "INSERT INTO " + portal_db._q(CALLS_TABLE) +
                    " (client_id, contact_id, phone, sid, status,"
                    " message, direction) VALUES (%s, %s, %s, %s, %s,"
                    " %s, 'inbound')",
                    (client_id, str(conversation_id or ""), phone, sid,
                     "in-progress", "Inbound call"),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        logger.warning("inbound call log failed", exc_info=True)
    site = (os.environ.get("OMNIFLOW_SITE_URL", "").strip()
            or request.host_url.rstrip("/"))
    action = site + "/api/v1/public/voice/record"
    twiml = ('<?xml version="1.0" encoding="UTF-8"?><Response><Say>'
             + _xml_escape(_greeting())
             + '</Say><Record transcribe="0" maxLength="'
             + str(INBOUND_MAX_SECONDS)
             + '" method="POST" action="' + _xml_escape(action)
             + '"/></Response>')
    return twiml, 200, {"Content-Type": "application/xml"}


@public_bp.post("/voice/record")
def voice_record():
    """Twilio post-recording webhook: attach the voicemail to the call."""
    sid = str(request.form.get("CallSid") or "").strip()[:64]
    recording_url = str(request.form.get("RecordingUrl") or "").strip()[:500]
    duration = str(request.form.get("RecordingDuration") or "0").strip()
    try:
        duration_seconds = min(3600, max(0, int(duration)))
    except ValueError:
        duration_seconds = 0
    if not sid or not recording_url:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Missing recording"
                                             " details."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                cur.execute(
                    "UPDATE " + portal_db._q(CALLS_TABLE) +
                    " SET status = 'recorded', recording_url = %s,"
                    " duration_seconds = %s"
                    " WHERE sid = %s AND direction = 'inbound'"
                    " RETURNING client_id, contact_id",
                    (recording_url, duration_seconds, sid),
                )
                updated = portal_db.rows(cur)
                if updated and int(updated[0].get("client_id") or 0) > 0:
                    portal_db.log_action(
                        cur, int(updated[0]["client_id"]),
                        "voice.inbound", "customer",
                        None, None,
                        ("Voicemail from ..."
                         + _digits(str(request.form.get("From") or ""))[-4:]
                         )[:200],
                    )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        logger.warning("voicemail attach failed", exc_info=True)
    return ('<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
            200, {"Content-Type": "application/xml"})


@bp.get("/voice/recordings/<sid>")
def voice_recording(sid: str):
    """Stream a voicemail from Twilio to the signed-in portal user."""
    sid = sid.strip()[:64]
    principal, _ = _principal_or_error()
    if principal is None:
        return jsonify({"error": {"code": "unauthorized",
                                  "message": "Sign in required."}}), 401
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                cur.execute(
                    "SELECT recording_url FROM "
                    + portal_db._q(CALLS_TABLE) +
                    " WHERE sid = %s AND recording_url <> ''"
                    " AND (client_id = %s OR direction = 'inbound')"
                    " ORDER BY id DESC LIMIT 1",
                    (sid, principal["client_id"]),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(
            error, "voicemail")[0]), 503
    if not rows:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Voicemail not found."}}), 404
    keys = _voice_keys()
    if not voice_configured(keys):
        return jsonify({"error": {"code": "not_configured",
                                  "message": "Voice is not configured -"
                                             " add the Twilio keys in the"
                                             " admin panel Integrations"
                                             " page."}}), 409
    try:
        media = _twilio_fetch_media(keys, rows[0].get("recording_url"))
    except Exception:
        logger.warning("voicemail fetch failed", exc_info=True)
        return jsonify({"error": {"code": "twilio_error",
                                  "message": "Twilio would not serve the"
                                             " recording - check the"
                                             " saved keys."}}), 502
    return Response(media, content_type="audio/mpeg",
                    headers={"Cache-Control": "no-store"})
