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

D5 adds the PHONE AI ASSISTANT on the same inbound webhook. The platform
admin assigns a Twilio number to a workspace; when that workspace has
switched the assistant on (and its brain runs at 'auto'), the caller is
greeted inside a TwiML <Gather input="speech">. Twilio recognises the
speech, /voice/turn hands the words to portal_brain.voice_answer (the
same guard -> tools -> policy pipeline as chat answers, spoken-reply
rules) and reads the reply back. Anything the assistant should not
handle - needs_human, low confidence, a policy or guard block, silence,
the turn limit - goes to a live transfer (forward number) or the
existing voicemail. Every public webhook verifies Twilio's
X-Twilio-Signature (enforce|log|off, admin panel voice.signature_check).
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

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


TURNS_TABLE = "portal_voice_turns"

_DDL_MIGRATE_D5 = (
    "ALTER TABLE " + portal_db._q(CALLS_TABLE) +
    " ADD COLUMN IF NOT EXISTS ai_turns INT NOT NULL DEFAULT 0,"
    " ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT ''"
)
_DDL_TURNS = (
    "CREATE TABLE IF NOT EXISTS " + portal_db._q(TURNS_TABLE) + " ("
    " id BIGSERIAL PRIMARY KEY,"
    " client_id BIGINT NOT NULL,"
    " call_sid TEXT NOT NULL,"
    " role TEXT NOT NULL DEFAULT 'caller',"
    " text TEXT NOT NULL DEFAULT '',"
    " decision TEXT NOT NULL DEFAULT '',"
    " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"
    ")"
)
_DDL_TURNS_INDEX = (
    "CREATE INDEX IF NOT EXISTS portal_voice_turns_idx ON "
    + portal_db._q(TURNS_TABLE) + " (client_id, call_sid, id)"
)


def _ensure_ddl(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    cur.execute(_DDL_MIGRATE)
    cur.execute(_DDL_INDEX)
    cur.execute(_DDL_MIGRATE_D5)
    cur.execute(_DDL_TURNS)
    cur.execute(_DDL_TURNS_INDEX)
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
        "ai_turns": int(row.get("ai_turns") or 0),
        "outcome": str(row.get("outcome") or ""),
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
                    " duration_seconds, ai_turns, outcome, created_at FROM "
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
    rejected = _twilio_guard()
    if rejected is not None:
        return rejected
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
    rejected = _twilio_guard()
    if rejected is not None:
        return rejected
    sid = str(request.form.get("CallSid") or "").strip()[:64]
    from_raw = str(request.form.get("From") or "").strip()[:32]
    if not sid or not _digits(from_raw):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Missing call details."}}), 400
    from_digits = _digits(from_raw)
    to_digits = _digits(str(request.form.get("To") or "").strip()[:32])
    phone = from_raw if from_raw.startswith("+") \
        else "+" + from_digits
    client_id, conversation_id = 0, None
    voice_settings: Optional[Dict[str, Any]] = None
    ai_active = False
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                mapped = 0
                if to_digits:
                    mapped, voice_settings = _client_for_number(cur, to_digits)
                if mapped:
                    # D5: the dialled number decides the workspace; the
                    # caller is matched only inside that workspace.
                    client_id = mapped
                    conversation_id = _match_caller_in(cur, mapped,
                                                       from_digits)
                else:
                    client_id, conversation_id = _match_caller(cur,
                                                               from_digits)
                cur.execute(
                    "INSERT INTO " + portal_db._q(CALLS_TABLE) +
                    " (client_id, contact_id, phone, sid, status,"
                    " message, direction) VALUES (%s, %s, %s, %s, %s,"
                    " %s, 'inbound')",
                    (client_id, str(conversation_id or ""), phone, sid,
                     "in-progress", "Inbound call"),
                )
                if mapped and voice_settings is not None:
                    status = voice_ai_status(cur, mapped, voice_settings)
                    ai_active = bool(status.get("active"))
                    if ai_active:
                        portal_db.log_action(
                            cur, mapped, "voice.ai_answered", "automation",
                            None, conversation_id,
                            ("Phone assistant answered ..."
                             + from_digits[-4:])[:200],
                        )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        logger.warning("inbound call log failed", exc_info=True)
        ai_active = False
    if ai_active and voice_settings is not None:
        greeting = voice_settings.get("greeting") or AI_GREETING_DEFAULT
        return _twiml(_gather(voice_settings, _say(greeting, voice_settings),
                              miss=0)
                      + _handoff_verbs(voice_settings))
    greeting = _greeting()
    # Voicemail path: the workspace's handoff line ("leave a message"), not
    # the assistant greeting (which invites a conversation).
    if voice_settings is not None and voice_settings.get("handoff_message"):
        greeting = str(voice_settings["handoff_message"])
    return _twiml("<Say>" + _xml_escape(greeting) + "</Say>"
                  + _record_verb())


@public_bp.post("/voice/record")
def voice_record():
    """Twilio post-recording webhook: attach the voicemail to the call."""
    rejected = _twilio_guard()
    if rejected is not None:
        return rejected
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
                    " AND client_id = %s"
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


# ===========================================================================
# D5: phone AI assistant (speech loop) + Twilio webhook signatures
# ===========================================================================

def _env_int(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(str(os.environ.get(name, default)).strip())
    except Exception:
        return default
    return max(low, min(high, value))


VOICE_SETTINGS_KEY = "voice_ai"
MAX_TURNS_DEFAULT = _env_int("OF_VOICE_MAX_TURNS", 6, 1, 20)
MAX_TURNS_LIMIT = 20
GATHER_TIMEOUT_SECONDS = _env_int("OF_VOICE_GATHER_TIMEOUT", 5, 2, 15)
DIAL_TIMEOUT_SECONDS = _env_int("OF_VOICE_DIAL_TIMEOUT", 20, 5, 60)
SPEECH_REPLY_CHARS = _env_int("OF_VOICE_REPLY_CHARS", 400, 80, 1000)
UTTERANCE_CHARS = 500
TRANSCRIPT_LIMIT = 40
#: Speech-recognition languages offered to owners (Twilio <Gather> codes;
#: availability depends on Twilio's speech model). Env-overridable.
SPEECH_LANGUAGES = tuple(
    code.strip() for code in os.environ.get(
        "OF_VOICE_LANGUAGES", "en-US,en-GB,en-IN,hi-IN,ur-PK").split(",")
    if code.strip()) or ("en-US",)
AI_GREETING_DEFAULT = os.environ.get(
    "OF_VOICE_AI_GREETING",
    "Hello! You are speaking with our virtual assistant. How can I help"
    " you today?")
HANDOFF_LINE_DEFAULT = os.environ.get(
    "OF_VOICE_HANDOFF_LINE",
    "Let me pass this to our team. Please leave your name and message"
    " after the tone and we will call you back.")
TRANSFER_LINE = os.environ.get(
    "OF_VOICE_TRANSFER_LINE", "Please hold while I connect you to our team.")
RETRY_LINE = os.environ.get(
    "OF_VOICE_RETRY_LINE", "Sorry, I did not catch that. Could you say it"
    " again?")

_E164 = re.compile(r"^\+[1-9][0-9]{7,14}$")
_SAFE_TOKEN = re.compile(r"^[A-Za-z0-9._\-]{1,60}$")
_CS_READY = False


def valid_e164(number: str) -> bool:
    return bool(_E164.match(str(number or "").strip()))


def _ensure_client_settings(cur) -> None:
    global _CS_READY
    if _CS_READY:
        return
    cur.execute(
        "CREATE TABLE IF NOT EXISTS " + portal_db._q("client_settings") +
        " (client_id BIGINT PRIMARY KEY,"
        " settings JSONB NOT NULL DEFAULT '{}'::jsonb,"
        " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    )
    _CS_READY = True


def default_voice_settings() -> Dict[str, Any]:
    return {"enabled": False, "greeting": "", "handoff_message": "",
            "language": SPEECH_LANGUAGES[0], "speech_model": "",
            "tts_voice": "", "max_turns": MAX_TURNS_DEFAULT,
            "forward_to": "", "number": ""}


def _clean_voice_settings(stored: Any) -> Dict[str, Any]:
    """Tolerant read of client_settings.voice_ai (bad values -> defaults)."""
    out = default_voice_settings()
    if isinstance(stored, str):
        try:
            stored = json.loads(stored)
        except Exception:
            stored = None
    if not isinstance(stored, dict):
        return out
    if isinstance(stored.get("enabled"), bool):
        out["enabled"] = stored["enabled"]
    for key in ("greeting", "handoff_message"):
        if isinstance(stored.get(key), str):
            out[key] = stored[key].strip()[:200]
    if stored.get("language") in SPEECH_LANGUAGES:
        out["language"] = stored["language"]
    for key in ("speech_model", "tts_voice"):
        value = str(stored.get(key) or "").strip()
        if value and _SAFE_TOKEN.match(value):
            out[key] = value
    try:
        out["max_turns"] = max(1, min(MAX_TURNS_LIMIT,
                                      int(stored.get("max_turns"))))
    except Exception:
        pass
    for key in ("forward_to", "number"):
        if valid_e164(stored.get(key)):
            out[key] = str(stored[key]).strip()
    return out


def load_voice_settings(cur, client_id: int) -> Dict[str, Any]:
    try:
        cur.execute(
            "SELECT settings -> 'voice_ai' AS voice_ai FROM "
            + portal_db._q("client_settings") + " WHERE client_id = %s",
            (client_id,),
        )
        rows = portal_db.rows(cur)
        return _clean_voice_settings(rows[0].get("voice_ai")
                                     if rows and rows[0] else None)
    except Exception as error:
        logger.warning("voice settings load failed: %s", error)
        return default_voice_settings()


def _save_voice_settings(cur, client_id: int,
                         settings: Dict[str, Any]) -> Dict[str, Any]:
    clean = _clean_voice_settings(settings)
    stored = dict(clean, number_digits=_digits(clean.get("number")))
    _ensure_client_settings(cur)
    cur.execute(
        "INSERT INTO " + portal_db._q("client_settings") +
        " (client_id, settings) VALUES (%s, %s::jsonb)"
        " ON CONFLICT (client_id) DO UPDATE SET"
        " settings = client_settings.settings || EXCLUDED.settings,"
        " updated_at = NOW()",
        (client_id, json.dumps({VOICE_SETTINGS_KEY: stored})),
    )
    return clean


def validate_voice_update(raw: Dict[str, Any], current: Dict[str, Any]
                          ) -> Tuple[Optional[Dict[str, Any]], str]:
    """Owner PUT -> (merged settings, "") or (None, message). The phone
    number itself is admin-assigned and never taken from the owner."""
    merged = dict(current)
    if "enabled" in raw:
        if not isinstance(raw.get("enabled"), bool):
            return None, "enabled must be true or false."
        merged["enabled"] = raw["enabled"]
    for key, label in (("greeting", "The greeting"),
                       ("handoff_message", "The handoff message")):
        if key in raw:
            value = str(raw.get(key) or "").strip()
            if len(value) > 200:
                return None, label + " must be 200 characters or fewer."
            merged[key] = value
    if "language" in raw:
        if raw.get("language") not in SPEECH_LANGUAGES:
            return None, ("language must be one of: "
                          + ", ".join(SPEECH_LANGUAGES) + ".")
        merged["language"] = raw["language"]
    for key in ("speech_model", "tts_voice"):
        if key in raw:
            value = str(raw.get(key) or "").strip()
            if value and not _SAFE_TOKEN.match(value):
                return None, (key + " may only use letters, digits, dots,"
                              " dashes and underscores.")
            merged[key] = value
    if "max_turns" in raw:
        try:
            turns = int(raw.get("max_turns"))
        except Exception:
            turns = 0
        if not 1 <= turns <= MAX_TURNS_LIMIT:
            return None, ("max_turns must be between 1 and "
                          + str(MAX_TURNS_LIMIT) + ".")
        merged["max_turns"] = turns
    if "forward_to" in raw:
        value = str(raw.get("forward_to") or "").strip()
        if value and not valid_e164(value):
            return None, ("The transfer number must use the full"
                          " international format, e.g. +923001234567.")
        merged["forward_to"] = value
    return merged, ""


# ---- number -> workspace mapping (admin-owned) ----------------------------

def _client_for_number(cur, to_digits: str
                       ) -> Tuple[int, Optional[Dict[str, Any]]]:
    """Workspace whose admin-assigned number was dialled, with its voice
    settings; (0, None) when the number is not assigned."""
    if len(to_digits) < 8:
        return 0, None
    _ensure_client_settings(cur)
    cur.execute(
        "SELECT client_id, settings -> 'voice_ai' AS voice_ai FROM "
        + portal_db._q("client_settings") +
        " WHERE settings -> 'voice_ai' ->> 'number_digits' = %s"
        " ORDER BY client_id LIMIT 1",
        (to_digits,),
    )
    rows = portal_db.rows(cur)
    if not rows:
        return 0, None
    return int(rows[0].get("client_id") or 0), \
        _clean_voice_settings(rows[0].get("voice_ai"))


def _match_caller_in(cur, client_id: int, from_digits: str) -> Optional[int]:
    """Latest conversation of THIS workspace for the caller's number."""
    if len(from_digits) < 10:
        return None
    cur.execute(
        "SELECT id FROM " + portal_db._q("portal_conversations") +
        " WHERE client_id = %s"
        " AND right(regexp_replace(contact_id, '\\D', '', 'g'), 9) = %s"
        " ORDER BY id DESC LIMIT 1",
        (client_id, from_digits[-9:]),
    )
    rows = portal_db.rows(cur)
    return int(rows[0].get("id") or 0) or None if rows else None


def list_number_assignments(cur) -> List[Dict[str, Any]]:
    _ensure_client_settings(cur)
    cur.execute(
        "SELECT client_id, settings -> 'voice_ai' ->> 'number' AS number,"
        " COALESCE((settings -> 'voice_ai' ->> 'enabled')::boolean, FALSE)"
        " AS enabled FROM " + portal_db._q("client_settings") +
        " WHERE COALESCE(settings -> 'voice_ai' ->> 'number', '') <> ''"
        " ORDER BY client_id"
    )
    return [{"client_id": int(r.get("client_id") or 0),
             "number": str(r.get("number") or ""),
             "enabled": bool(r.get("enabled"))}
            for r in portal_db.rows(cur)]


def assign_number(cur, client_id: int, number: str) -> Dict[str, Any]:
    """Admin: give (or remove, number="") a workspace's phone number.
    One number answers for one workspace only."""
    number = str(number or "").strip()
    _ensure_client_settings(cur)
    if number:
        cur.execute(
            "SELECT client_id FROM " + portal_db._q("client_settings") +
            " WHERE settings -> 'voice_ai' ->> 'number_digits' = %s"
            " AND client_id <> %s LIMIT 1",
            (_digits(number), client_id),
        )
        taken = portal_db.rows(cur)
        if taken:
            return {"error": "That number already answers for workspace "
                             + str(taken[0].get("client_id")) + "."}
    current = load_voice_settings(cur, client_id)
    current["number"] = number
    saved = _save_voice_settings(cur, client_id, current)
    return {"number": saved.get("number", "")}


# ---- Twilio signature -------------------------------------------------------

def _signature_mode() -> str:
    try:
        return platform_settings.voice_platform()["signature_check"]
    except Exception:
        return "enforce"


def _candidate_urls() -> List[str]:
    """Public URLs Twilio may have signed (proxies rewrite scheme/host)."""
    tail = request.path
    query = request.query_string.decode("utf8", "replace")
    if query:
        tail += "?" + query
    bases = []
    for env in ("OMNIFLOW_TWILIO_WEBHOOK_BASE", "OMNIFLOW_SITE_URL"):
        value = os.environ.get(env, "").strip().rstrip("/")
        if value:
            bases.append(value)
    panel_base = _panel_webhook_base()
    if panel_base:
        bases.append(panel_base)
    host = (request.headers.get("X-Forwarded-Host") or request.host or "")
    host = host.split(",")[0].strip()
    proto = (request.headers.get("X-Forwarded-Proto") or "https")
    proto = proto.split(",")[0].strip() or "https"
    if host:
        bases.append(proto + "://" + host)
        bases.append("https://" + host)
    bases.append(request.host_url.rstrip("/"))
    seen, urls = set(), []
    for base in bases:
        url = base + tail
        if url not in seen:
            seen.add(url)
            urls.append(url)
    return urls


def twilio_signature(auth_token: str, url: str,
                     params: List[Tuple[str, str]]) -> str:
    """Twilio's scheme: HMAC-SHA1(url + sorted key+value pairs), base64."""
    payload = url + "".join(k + v for k, v in sorted(params))
    digest = hmac.new(auth_token.encode("utf8"), payload.encode("utf8"),
                      hashlib.sha1).digest()
    return base64.b64encode(digest).decode("ascii")


def _signature_valid(auth_token: str) -> bool:
    supplied = request.headers.get("X-Twilio-Signature", "").strip()
    if not supplied:
        return False
    params = [(k, v) for k in request.form for v in request.form.getlist(k)]
    for url in _candidate_urls():
        if hmac.compare_digest(twilio_signature(auth_token, url, params),
                               supplied):
            return True
    return False


def _twilio_guard():
    """None when the request may proceed, else a 403 response. Without a
    saved auth token there is nothing to verify against (voicemail keeps
    working before the keys are saved)."""
    mode = _signature_mode()
    if mode == "off":
        return None
    token = str(_voice_keys().get("auth_token") or "")
    if not token:
        return None
    if _signature_valid(token):
        return None
    if mode == "log":
        logger.warning("twilio signature mismatch on %s (log mode)",
                       request.path)
        return None
    logger.warning("twilio signature rejected on %s", request.path)
    return jsonify({"error": {"code": "forbidden",
                              "message": "Invalid Twilio signature."}}), 403


# ---- Twilio number setup (§214) -------------------------------------------
#
# The admin used to paste two webhook URLs into the Twilio console by hand
# for every number. The Integrations > Phone numbers panel now reads the
# account's numbers (IncomingPhoneNumbers) and points a number's Voice URL
# and status callback at this Control Plane with one click. Numbers wired
# to a TwiML app or SIP trunk are never taken over silently - Twilio
# ignores voice_url while either is set, so the admin must detach it in
# the Twilio console first.

TWILIO_API_BASE = (os.environ.get("OF_TWILIO_API_BASE", "").strip().rstrip("/")
                   or "https://api.twilio.com")
INCOMING_PATH = "/api/v1/public/voice/incoming"
STATUS_PATH = "/api/v1/public/voice/webhook"
TWILIO_PAGE_SIZE = _env_int("OF_TWILIO_NUMBERS_PAGE_SIZE", 200, 20, 1000)


class TwilioApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = int(status or 502)
        self.message = str(message or "Twilio rejected the request.")[:300]


def _env_webhook_base() -> str:
    try:
        return platform_settings.clean_webhook_base(
            os.environ.get("OMNIFLOW_TWILIO_WEBHOOK_BASE", ""))
    except Exception:
        return ""


def _panel_webhook_base() -> str:
    try:
        return str(platform_settings.voice_platform().get("webhook_base")
                   or "")
    except Exception:
        return ""


def webhook_base() -> Tuple[str, str]:
    """(public https origin Twilio should call, where it came from):
    env OMNIFLOW_TWILIO_WEBHOOK_BASE, then the admin panel
    (voice.webhook_base), then this request's public host."""
    base = _env_webhook_base()
    if base:
        return base, "env"
    base = _panel_webhook_base()
    if base:
        return base, "panel"
    try:
        host = (request.headers.get("X-Forwarded-Host") or request.host
                or "").split(",")[0].strip()
    except RuntimeError:
        host = ""
    if host and not host.startswith(("localhost", "127.", "0.0.0.0")):
        return platform_settings.clean_webhook_base("https://" + host), \
            "request"
    return "", "none"


def _twilio_api(keys: Dict[str, str], method: str, path: str,
                params: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """One call to Twilio's REST API (module-level so tests can stub it).
    Raises TwilioApiError with Twilio's own message on failure."""
    url = (TWILIO_API_BASE + "/2010-04-01/Accounts/"
           + urllib.parse.quote(keys["account_sid"], safe="") + path)
    data = None
    if params and method.upper() == "GET":
        url += "?" + urllib.parse.urlencode(params)
    elif params is not None:
        data = urllib.parse.urlencode(params).encode("utf8")
    token = base64.b64encode(
        (keys["account_sid"] + ":" + keys["auth_token"]).encode("utf8")
    ).decode("ascii")
    headers = {"Authorization": "Basic " + token, "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, method=method.upper(),
                                 headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            parsed = json.loads(resp.read().decode("utf8") or "{}")
            return parsed if isinstance(parsed, dict) else {}
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read().decode("utf8", "replace") or "{}")
        except Exception:
            detail = {}
        message = detail.get("message") if isinstance(detail, dict) else None
        raise TwilioApiError(error.code, message or (
            "Twilio answered HTTP " + str(error.code) + "."))
    except (urllib.error.URLError, TimeoutError, OSError):
        raise TwilioApiError(502, "Twilio is unreachable right now.")
    except ValueError:
        raise TwilioApiError(502, "Twilio returned an unreadable answer.")


def _host_of(url: str) -> str:
    try:
        return urllib.parse.urlsplit(str(url or "")).hostname or ""
    except ValueError:
        return ""


def twilio_number_state(number: Dict[str, Any], base: str) -> Dict[str, Any]:
    """Public view of one Twilio number and whether it reaches us.
    state: connected | partial | elsewhere | app | trunk | not_set"""
    voice_url = str(number.get("voice_url") or "").strip()
    status_url = str(number.get("status_callback") or "").strip()
    want_voice = (base + INCOMING_PATH) if base else ""
    want_status = (base + STATUS_PATH) if base else ""
    voice_ok = bool(want_voice) and voice_url.rstrip("/") == want_voice
    status_ok = bool(want_status) and status_url.rstrip("/") == want_status
    if number.get("trunk_sid"):
        state = "trunk"
    elif number.get("voice_application_sid"):
        state = "app"
    elif voice_ok and status_ok:
        state = "connected"
    elif voice_ok:
        state = "partial"
    elif voice_url:
        state = "elsewhere"
    else:
        state = "not_set"
    caps = number.get("capabilities")
    # §244: SMS routing of the same number (portal_sms webhook)
    import portal_sms

    sms_url = str(number.get("sms_url") or "").strip()
    want_sms = (base + portal_sms.INCOMING_PATH) if base else ""
    if number.get("sms_application_sid"):
        sms_state = "app"
    elif want_sms and sms_url.rstrip("/") == want_sms:
        sms_state = "connected"
    elif sms_url:
        sms_state = "elsewhere"
    else:
        sms_state = "not_set"
    return {
        "sid": str(number.get("sid") or ""),
        "phone_number": str(number.get("phone_number") or ""),
        "friendly_name": str(number.get("friendly_name") or "")[:64],
        "state": state,
        "voice_host": _host_of(voice_url),
        "voice_capable": bool(caps.get("voice", True))
        if isinstance(caps, dict) else True,
        "sms_state": sms_state,
        "sms_host": _host_of(sms_url),
        "sms_capable": bool(caps.get("sms", False))
        if isinstance(caps, dict) else False,
    }


def list_twilio_numbers(keys: Dict[str, str]) -> Tuple[List[Dict[str, Any]],
                                                       bool]:
    """(raw IncomingPhoneNumbers, truncated)."""
    payload = _twilio_api(keys, "GET", "/IncomingPhoneNumbers.json",
                          {"PageSize": str(TWILIO_PAGE_SIZE)})
    numbers = payload.get("incoming_phone_numbers")
    numbers = [n for n in numbers if isinstance(n, dict)] \
        if isinstance(numbers, list) else []
    return numbers, bool(payload.get("next_page_uri"))


def get_twilio_number(keys: Dict[str, str], sid: str) -> Dict[str, Any]:
    return _twilio_api(keys, "GET", "/IncomingPhoneNumbers/"
                       + urllib.parse.quote(sid, safe="") + ".json")


def connect_twilio_number(keys: Dict[str, str], sid: str, base: str
                          ) -> Dict[str, Any]:
    """Point one number's Voice URL + status callback at this Control
    Plane. Only the four voice routing fields are sent."""
    return _twilio_api(keys, "POST", "/IncomingPhoneNumbers/"
                       + urllib.parse.quote(sid, safe="") + ".json", {
                           "VoiceUrl": base + INCOMING_PATH,
                           "VoiceMethod": "POST",
                           "StatusCallback": base + STATUS_PATH,
                           "StatusCallbackMethod": "POST",
                       })


def connect_twilio_sms(keys: Dict[str, str], sid: str, base: str) -> Dict[str, Any]:
    """§244: point one number's SMS webhook at this Control Plane (portal_sms).
    Only the two SMS routing fields are sent - voice routing is untouched."""
    import portal_sms

    return _twilio_api(keys, "POST", "/IncomingPhoneNumbers/"
                       + urllib.parse.quote(sid, safe="") + ".json", {
                           "SmsUrl": base + portal_sms.INCOMING_PATH,
                           "SmsMethod": "POST",
                       })


# ---- assistant readiness ----------------------------------------------------

def voice_ai_status(cur, client_id: int,
                    settings: Optional[Dict[str, Any]] = None
                    ) -> Dict[str, Any]:
    """Why the phone assistant would (not) answer this workspace's calls.

    reason: active | off | platform_off | no_twilio | no_number | no_llm
            | autonomy
    """
    settings = settings if settings is not None \
        else load_voice_settings(cur, client_id)
    try:
        platform = platform_settings.voice_platform()
    except Exception:
        platform = {"ai_loop": "on"}
    twilio_ready = voice_configured(_voice_keys())
    llm_ready = False
    try:
        import portal_llm

        runtime = portal_llm._runtime()
        llm_ready = bool(runtime.get("enabled") and runtime.get("api_key"))
    except Exception:
        llm_ready = False
    autonomy = "off"
    if settings.get("enabled") and platform.get("ai_loop") != "off" \
            and twilio_ready and settings.get("number") and llm_ready:
        try:
            import portal_brain

            portal_brain._ensure_ddl(cur)
            brain = portal_brain._load_settings(cur, client_id)
            autonomy = portal_brain.effective_autonomy(
                str(brain.get("autonomy") or ""))
        except Exception:
            autonomy = "off"
    if not settings.get("enabled"):
        reason = "off"
    elif platform.get("ai_loop") == "off":
        reason = "platform_off"
    elif not twilio_ready:
        reason = "no_twilio"
    elif not settings.get("number"):
        reason = "no_number"
    elif not llm_ready:
        reason = "no_llm"
    elif autonomy != "auto":
        reason = "autonomy"
    else:
        reason = "active"
    return {"active": reason == "active", "reason": reason,
            "number": settings.get("number") or "",
            "twilio_ready": twilio_ready, "llm_ready": llm_ready,
            "platform_ai_loop": platform.get("ai_loop", "on"),
            "autonomy": autonomy}


# ---- TwiML builders -------------------------------------------------------

def _attr(text: str) -> str:
    return _xml_escape(text).replace('"', "&quot;")


def _public_base() -> str:
    """Origin for TwiML action URLs. A configured Twilio webhook base wins
    (so the follow-up requests are signed for the same URL Twilio was set
    up with); otherwise the previous behaviour is unchanged."""
    return (_env_webhook_base() or _panel_webhook_base()
            or os.environ.get("OMNIFLOW_SITE_URL", "").strip().rstrip("/")
            or request.host_url.rstrip("/"))


def _twiml(inner: str) -> Tuple[str, int, Dict[str, str]]:
    return ('<?xml version="1.0" encoding="UTF-8"?><Response>' + inner
            + "</Response>", 200, {"Content-Type": "application/xml"})


def _say(text: str, settings: Dict[str, Any]) -> str:
    attrs = ""
    if settings.get("tts_voice"):
        attrs = (' voice="' + _attr(settings["tts_voice"]) + '" language="'
                 + _attr(settings.get("language") or "en-US") + '"')
    return "<Say" + attrs + ">" + _xml_escape(text) + "</Say>"


def _gather(settings: Dict[str, Any], prompt: str, miss: int) -> str:
    action = _public_base() + "/api/v1/public/voice/turn?miss=" + str(miss)
    attrs = (' input="speech" method="POST" action="' + _attr(action) + '"'
             ' actionOnEmptyResult="true" speechTimeout="auto"'
             ' timeout="' + str(GATHER_TIMEOUT_SECONDS) + '"'
             ' language="' + _attr(settings.get("language") or "en-US") + '"')
    if settings.get("speech_model"):
        attrs += ' speechModel="' + _attr(settings["speech_model"]) + '"'
    return "<Gather" + attrs + ">" + prompt + "</Gather>"


def _record_verb() -> str:
    action = _public_base() + "/api/v1/public/voice/record"
    return ('<Record transcribe="0" maxLength="' + str(INBOUND_MAX_SECONDS)
            + '" method="POST" action="' + _attr(action) + '"/>')


def _handoff_verbs(settings: Dict[str, Any]) -> str:
    """Live transfer to the owner's number when set, else voicemail."""
    if settings.get("forward_to"):
        action = _public_base() + "/api/v1/public/voice/dialed"
        return (_say(TRANSFER_LINE, settings)
                + '<Dial timeout="' + str(DIAL_TIMEOUT_SECONDS)
                + '" method="POST" action="' + _attr(action) + '">'
                + _xml_escape(settings["forward_to"]) + "</Dial>")
    return (_say(settings.get("handoff_message") or HANDOFF_LINE_DEFAULT,
                 settings) + _record_verb())


_URL_RE = re.compile(r"https?://\S+|www\.\S+", re.I)
_MARKUP_RE = re.compile(r"[*_#`>~^]")
_BRACKET_RE = re.compile(r"[\[\]{}|]")


def speakable(text: str) -> str:
    """Plain speech for <Say>: no links, markup or emoji; sentence-capped."""
    text = _URL_RE.sub(" ", str(text or ""))
    text = _MARKUP_RE.sub("", text)
    text = _BRACKET_RE.sub(" ", text)
    text = "".join(ch for ch in text
                   if ord(ch) < 0x2190 or 0x3000 <= ord(ch) < 0xFE00
                   or 0x0600 <= ord(ch) <= 0x06FF)
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\s+([.,!?;:])", r"\1", text)
    if len(text) <= SPEECH_REPLY_CHARS:
        return text
    cut = text[:SPEECH_REPLY_CHARS]
    stop = max(cut.rfind(". "), cut.rfind("? "), cut.rfind("! "))
    return (cut[:stop + 1] if stop > 40 else cut).strip()


# ---- call helpers -----------------------------------------------------------

def _load_call(cur, sid: str) -> Optional[Dict[str, Any]]:
    cur.execute(
        "SELECT client_id, contact_id, phone, ai_turns FROM "
        + portal_db._q(CALLS_TABLE) +
        " WHERE sid = %s AND direction = 'inbound' ORDER BY id DESC LIMIT 1",
        (sid,),
    )
    rows = portal_db.rows(cur)
    return rows[0] if rows else None


def _add_turn(cur, client_id: int, sid: str, role: str, text: str,
              decision: str = "") -> None:
    cur.execute(
        "INSERT INTO " + portal_db._q(TURNS_TABLE) +
        " (client_id, call_sid, role, text, decision)"
        " VALUES (%s, %s, %s, %s, %s)",
        (client_id, sid, role, str(text or "")[:1000], decision[:40]),
    )


def _call_transcript(cur, client_id: int, sid: str) -> List[Dict[str, str]]:
    cur.execute(
        "SELECT role, text FROM " + portal_db._q(TURNS_TABLE) +
        " WHERE client_id = %s AND call_sid = %s ORDER BY id LIMIT %s",
        (client_id, sid, TRANSCRIPT_LIMIT),
    )
    return [{"role": str(r.get("role") or ""), "text": str(r.get("text") or "")}
            for r in portal_db.rows(cur)]


def _set_outcome(cur, sid: str, turns: int, outcome: str) -> None:
    cur.execute(
        "UPDATE " + portal_db._q(CALLS_TABLE) +
        " SET ai_turns = %s, outcome = %s"
        " WHERE sid = %s AND direction = 'inbound'",
        (turns, outcome[:40], sid),
    )


def _conversation_contact(cur, client_id: int,
                          conversation_id: int) -> Tuple[str, str]:
    cur.execute(
        "SELECT contact_id, contact_name FROM "
        + portal_db._q("portal_conversations") +
        " WHERE id = %s AND client_id = %s LIMIT 1",
        (conversation_id, client_id),
    )
    rows = portal_db.rows(cur)
    if not rows:
        return "", ""
    return str(rows[0].get("contact_id") or ""), \
        str(rows[0].get("contact_name") or "")


# ---- public webhooks: the speech loop ---------------------------------------

@public_bp.post("/voice/turn")
def voice_turn():
    """One assistant turn: caller speech in (Twilio SpeechResult), spoken
    reply + next <Gather> out, or a handoff (transfer / voicemail)."""
    rejected = _twilio_guard()
    if rejected is not None:
        return rejected
    sid = str(request.form.get("CallSid") or "").strip()[:64]
    speech = str(request.form.get("SpeechResult") or "").strip()
    speech = speech[:UTTERANCE_CHARS]
    try:
        miss = max(0, min(5, int(request.args.get("miss", "0"))))
    except ValueError:
        miss = 0
    fallback = default_voice_settings()
    if not sid:
        return _twiml(_handoff_verbs(fallback))
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                result = _run_turn(cur, sid, speech, miss)
            conn.commit()
        finally:
            conn.close()
    except Exception:
        logger.warning("voice turn failed", exc_info=True)
        return _twiml(_handoff_verbs(fallback))
    return _twiml(result)


def _run_turn(cur, sid: str, speech: str, miss: int) -> str:
    """Decide one turn and return the TwiML body (inside <Response>)."""
    call = _load_call(cur, sid)
    client_id = int((call or {}).get("client_id") or 0)
    if client_id <= 0:
        return _handoff_verbs(default_voice_settings())
    settings = load_voice_settings(cur, client_id)
    turns = int(call.get("ai_turns") or 0)
    if not voice_ai_status(cur, client_id, settings).get("active"):
        _set_outcome(cur, sid, turns, "voicemail")
        return _handoff_verbs(settings)
    if not speech:
        if miss >= 1:
            _add_turn(cur, client_id, sid, "system", "No speech heard.",
                      "no_speech")
            _set_outcome(cur, sid, turns, "no_speech")
            return _handoff_verbs(settings)
        return (_gather(settings, _say(RETRY_LINE, settings), miss + 1)
                + _handoff_verbs(settings))
    transcript = _call_transcript(cur, client_id, sid)
    _add_turn(cur, client_id, sid, "caller", speech)
    conversation_id = 0
    try:
        conversation_id = int(str(call.get("contact_id") or "0") or 0)
    except ValueError:
        conversation_id = 0
    contact_id, contact_name = "", ""
    if conversation_id > 0:
        contact_id, contact_name = _conversation_contact(
            cur, client_id, conversation_id)
    if not contact_id:
        contact_id = "tel:" + str(call.get("phone") or "")
    import portal_brain

    # The brain swallows its own errors; a savepoint keeps a failed
    # statement inside it from poisoning this call's transcript/outcome.
    cur.execute("SAVEPOINT of_voice_turn")
    decision, reply, grounding = portal_brain.voice_answer(
        cur, client_id, conversation_id, contact_id, contact_name, speech,
        transcript)
    if str(grounding.get("reason") or "") == "error":
        cur.execute("ROLLBACK TO SAVEPOINT of_voice_turn")
    else:
        cur.execute("RELEASE SAVEPOINT of_voice_turn")
    turns += 1
    spoken = speakable(reply) if decision == "send" else ""
    if decision == "send" and spoken:
        _add_turn(cur, client_id, sid, "assistant", spoken, "send")
        if turns >= int(settings.get("max_turns") or MAX_TURNS_DEFAULT):
            _set_outcome(cur, sid, turns, "turn_limit")
            return _say(spoken, settings) + _handoff_verbs(settings)
        _set_outcome(cur, sid, turns, "ai")
        return (_gather(settings, _say(spoken, settings), 0)
                + _handoff_verbs(settings))
    reason = str(grounding.get("reason") or "handoff")[:40]
    _add_turn(cur, client_id, sid, "system", "Handed to the team (" + reason
              + ").", "handoff")
    _set_outcome(cur, sid, turns, "handoff")
    portal_db.log_action(
        cur, client_id, "voice.ai_handoff", "automation", None,
        conversation_id or None, ("Phone assistant handoff: " + reason)[:200])
    return _handoff_verbs(settings)


@public_bp.post("/voice/dialed")
def voice_dialed():
    """<Dial> finished: hang up after a real conversation, otherwise fall
    back to voicemail so the caller is never dropped silently."""
    rejected = _twilio_guard()
    if rejected is not None:
        return rejected
    status = str(request.form.get("DialCallStatus") or "").strip().lower()
    sid = str(request.form.get("CallSid") or "").strip()[:64]
    if status == "completed":
        return _twiml("<Hangup/>")
    settings = default_voice_settings()
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                call = _load_call(cur, sid) if sid else None
                client_id = int((call or {}).get("client_id") or 0)
                if client_id > 0:
                    settings = load_voice_settings(cur, client_id)
                    _set_outcome(cur, sid, int(call.get("ai_turns") or 0),
                                 "transfer_missed")
            conn.commit()
        finally:
            conn.close()
    except Exception:
        logger.warning("voice dialed fallback failed", exc_info=True)
    return _twiml(_say(settings.get("handoff_message")
                       or HANDOFF_LINE_DEFAULT, settings) + _record_verb())


# ---- owner API --------------------------------------------------------------

def _voice_settings_public(settings: Dict[str, Any]) -> Dict[str, Any]:
    return {key: settings.get(key) for key in default_voice_settings()}


@bp.get("/voice/ai-settings")
def get_voice_ai_settings():
    principal, _ = _principal_or_error()
    if principal is None:
        return jsonify({"error": {"code": "unauthorized",
                                  "message": "Sign in required."}}), 401
    client_id = int(principal["client_id"])
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_client_settings(cur)
                settings = load_voice_settings(cur, client_id)
                status = voice_ai_status(cur, client_id, settings)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(
            error, "voice settings")[0]), 503
    return jsonify({"settings": _voice_settings_public(settings),
                    "status": status,
                    "languages": list(SPEECH_LANGUAGES),
                    "max_turns_limit": MAX_TURNS_LIMIT}), 200


@bp.put("/voice/ai-settings")
def put_voice_ai_settings():
    principal, _ = _principal_or_error()
    if principal is None:
        return jsonify({"error": {"code": "unauthorized",
                                  "message": "Sign in required."}}), 401
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    raw = request.get_json(silent=True) or {}
    raw = raw.get("settings", raw) if isinstance(raw, dict) else {}
    if not isinstance(raw, dict):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "settings must be an"
                                             " object."}}), 400
    client_id = int(principal["client_id"])
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_client_settings(cur)
                current = load_voice_settings(cur, client_id)
                merged, error = validate_voice_update(raw, current)
                if merged is None:
                    conn.rollback()
                    return jsonify({"error": {"code": "bad_request",
                                              "message": error}}), 400
                saved = _save_voice_settings(cur, client_id, merged)
                portal_db.log_action(
                    cur, client_id, "voice.ai_settings", "human",
                    principal.get("user_id"), None,
                    ("Phone assistant "
                     + ("on" if saved.get("enabled") else "off") + ".")[:200])
                status = voice_ai_status(cur, client_id, saved)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(
            error, "voice settings")[0]), 503
    return jsonify({"ok": True, "settings": _voice_settings_public(saved),
                    "status": status}), 200


@bp.get("/voice/calls/<sid>/transcript")
def voice_call_transcript(sid: str):
    principal, _ = _principal_or_error()
    if principal is None:
        return jsonify({"error": {"code": "unauthorized",
                                  "message": "Sign in required."}}), 401
    sid = sid.strip()[:64]
    client_id = int(principal["client_id"])
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                turns = _call_transcript(cur, client_id, sid)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(
            error, "call transcript")[0]), 503
    return jsonify({"sid": sid, "turns": turns}), 200
