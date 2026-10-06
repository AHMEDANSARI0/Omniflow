"""SMS channel (§244, gap analysis row 24 / Phase 6): two-way SMS on the
workspace's OmniFlow phone number, in the same inbox, AI and workflows.

No new account and no new dependency: the platform Twilio account (admin
panel > Voice channel keys, or OF_TWILIO_*) and the number the platform
admin assigned to the workspace (D5 phone numbers) are reused. The admin
points the number's SMS webhook at this Control Plane with one click
(Integrations > Phone numbers > Connect SMS).

* In: Twilio posts each SMS to ``/api/v1/public/sms/incoming`` (signed -
  the same X-Twilio-Signature check as voice). The number tells which
  workspace it is for; nothing is imported until the workspace switched SMS
  on. The text goes through the one ingest core (contact ``sms:+<e164>``,
  deduped by MessageSid), so the brain, away replies, workflows, STOP
  opt-outs and identity links (a phone handle - the same number on WhatsApp
  is the same person) work unchanged. MMS pictures are not downloaded; the
  message says how many were sent.
* Out: replies queued for ``sms:`` contacts are sent by the Control Plane
  through Twilio's Messages API (``portal_cp_outbox`` - same ack / retry /
  refuse rules as email): right after an inbound SMS, right after a teammate
  replies, and from the connector / inbox tick. Text only; long replies are
  shortened to OF_SMS_MAX_SEGMENTS parts. Customers who sent STOP are never
  texted again (portal_optouts). A per-workspace daily limit (owner-set,
  capped by OF_SMS_DAILY_MAX) protects the platform's Twilio bill.
* Delivery: Twilio status callbacks (``/api/v1/public/sms/status``) keep a
  small log fresh (queued -> sent -> delivered / failed + Twilio error
  code); Settings > SMS channel shows today's count and recent messages.
"""

import json
import logging
import os
import re
import threading
import time
from typing import Any, Dict, List, Tuple

from flask import Blueprint, Response, jsonify, request

import portal_cp_outbox
import portal_db
import portal_txn
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)

logger = logging.getLogger("omniflow.sms_channel")

bp = Blueprint("portal_sms", __name__, url_prefix="/api/v1/portal")
public_bp = Blueprint("portal_sms_public", __name__, url_prefix="/api/v1/public")


def _env_int(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(str(os.environ.get(name, "")).strip() or default)
    except ValueError:
        value = default
    return max(low, min(high, value))


ENABLED = os.environ.get("OF_SMS_CHANNEL", "1").strip() != "0"
LOG_TABLE = os.environ.get("OF_SMS_LOG_TABLE", "portal_sms_log")
DAILY_MAX = _env_int("OF_SMS_DAILY_MAX", 500, 1, 100_000)
DAILY_DEFAULT = min(DAILY_MAX, _env_int("OF_SMS_DAILY_DEFAULT", 100, 1, 100_000))
MAX_SEGMENTS = _env_int("OF_SMS_MAX_SEGMENTS", 4, 1, 10)
MAX_SEND_PER_RUN = _env_int("OF_SMS_MAX_SEND", 10, 1, 50)
# a teammate's reply is sent inside the request: a small batch keeps the
# dashboard responsive, the tick sends the rest
DISPATCH_LIMIT = 3
POLL_SECONDS = _env_int("OF_SMS_POLL_SECONDS", 30, 5, 3600)
TEST_GAP_SECONDS = _env_int("OF_SMS_TEST_GAP_SECONDS", 60, 10, 3600)
TEST_TEXT = (os.environ.get("OF_SMS_TEST_TEXT", "").strip()
             or "OmniFlow test message - your SMS channel works.")[:300]

CHANNEL = "sms"
PREFIX = "sms:"
SETTINGS_KEY = "sms_channel"
INCOMING_PATH = "/api/v1/public/sms/incoming"
STATUS_PATH = "/api/v1/public/sms/status"
LOCK_CLASS = 24401  # pg advisory lock namespace: one sender per workspace
TEXT_ACTIONS = ("send_message", "send_interactive")
RECENT_LIMIT = 10
MAX_BODY_IN = 1600
EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
# Twilio message statuses, in the order they happen (callbacks can arrive
# out of order - a later state is never replaced by an earlier one)
STATUS_RANK = {"accepted": 1, "queued": 1, "scheduled": 1, "sending": 2, "sent": 3,
               "receiving": 3, "received": 4, "delivered": 4, "undelivered": 4,
               "failed": 4, "read": 5, "canceled": 4}

# GSM 03.38 basic set + extension table: anything else makes the whole SMS
# UCS-2 (70 characters per part instead of 160).
_GSM_BASIC = ("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?"
              "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà")
_GSM_EXT = "^{}\\[~]|€\f"

_DDL_READY = False
_LOCK = threading.Lock()
_RUNNING: set = set()
_LAST: Dict[int, float] = {}


class SmsError(Exception):
    """A problem the owner must fix (shown on the card)."""


# ---------------------------------------------------------------------------
# storage
# ---------------------------------------------------------------------------

def _ensure_ddl(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    table = portal_db._q(LOG_TABLE)
    cur.execute(
        "CREATE TABLE IF NOT EXISTS " + table + " ("
        " id BIGSERIAL PRIMARY KEY,"
        " client_id BIGINT NOT NULL,"
        " direction TEXT NOT NULL,"
        " contact_id TEXT NOT NULL DEFAULT '',"
        " sid TEXT NOT NULL DEFAULT '',"
        " status TEXT NOT NULL DEFAULT '',"
        " error_code TEXT NOT NULL DEFAULT '',"
        " segments INTEGER NOT NULL DEFAULT 0,"
        " source TEXT NOT NULL DEFAULT '',"
        " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
        " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())")
    cur.execute("CREATE INDEX IF NOT EXISTS " + portal_db._q(LOG_TABLE + "_client_idx")
                + " ON " + table + " (client_id, created_at DESC)")
    cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS " + portal_db._q(LOG_TABLE + "_sid_idx")
                + " ON " + table + " (sid) WHERE sid <> ''")
    _DDL_READY = True


def default_settings() -> Dict[str, Any]:
    return {"enabled": False, "daily_limit": DAILY_DEFAULT, "last_error": "",
            "last_sent_at": None, "last_in_at": None}


def _clean(stored: Any) -> Dict[str, Any]:
    out = default_settings()
    if not isinstance(stored, dict):
        return out
    if isinstance(stored.get("enabled"), bool):
        out["enabled"] = stored["enabled"]
    limit = stored.get("daily_limit")
    if isinstance(limit, int) and not isinstance(limit, bool):
        out["daily_limit"] = max(1, min(DAILY_MAX, limit))
    out["last_error"] = str(stored.get("last_error") or "")[:300]
    for key in ("last_sent_at", "last_in_at"):
        if isinstance(stored.get(key), str):
            out[key] = stored[key][:40]
    return out


def load_settings(cur, client_id: int) -> Dict[str, Any]:
    import portal_voice

    portal_voice._ensure_client_settings(cur)
    cur.execute("SELECT settings -> %s AS sms FROM " + portal_db._q("client_settings")
                + " WHERE client_id = %s", (SETTINGS_KEY, client_id))
    rows = portal_db.rows(cur)
    return _clean(rows[0].get("sms") if rows else None)


def save_settings(cur, client_id: int, changes: Dict[str, Any]) -> Dict[str, Any]:
    """Merge ``changes`` into the workspace's SMS settings (one JSONB key)."""
    merged = _clean(dict(load_settings(cur, client_id), **changes))
    cur.execute(
        "INSERT INTO " + portal_db._q("client_settings") + " (client_id, settings)"
        " VALUES (%s, %s::jsonb) ON CONFLICT (client_id) DO UPDATE SET"
        " settings = client_settings.settings || EXCLUDED.settings, updated_at = NOW()",
        (client_id, json.dumps({SETTINGS_KEY: merged})))
    return merged


def _now_iso(cur) -> str:
    cur.execute("SELECT to_char(NOW() AT TIME ZONE 'UTC',"
                " 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS now")
    rows = portal_db.rows(cur)
    return str(rows[0].get("now") or "") if rows else ""


def _log(cur, client_id: int, direction: str, contact: str, sid: str, status: str,
         segments: int, source: str, error_code: str = "") -> None:
    cur.execute("INSERT INTO " + portal_db._q(LOG_TABLE) +
                " (client_id, direction, contact_id, sid, status, error_code, segments, source)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)"
                " ON CONFLICT (sid) WHERE sid <> '' DO NOTHING",
                (client_id, direction, contact[:40], sid[:64], status[:20],
                 error_code[:10], segments, source[:20]))


def sent_today(cur, client_id: int) -> int:
    """Texts sent (or handed to Twilio) since 00:00 UTC - the daily limit."""
    cur.execute("SELECT COUNT(*) AS n FROM " + portal_db._q(LOG_TABLE) +
                " WHERE client_id = %s AND direction = 'out'"
                " AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')"
                " AT TIME ZONE 'UTC'", (client_id,))
    rows = portal_db.rows(cur)
    return int(rows[0].get("n") or 0) if rows else 0


def _opted_out(cur, client_id: int, contact: str) -> bool:
    """STOP / merchant opt-outs (portal_compliance, the shared check)."""
    import portal_compliance

    cur.execute("SELECT to_regclass(%s) AS t", (portal_compliance.OPTOUT_TABLE,))
    found = portal_db.rows(cur)
    if not (found and found[0].get("t")):
        return False
    return portal_compliance.is_opted_out(cur, client_id, contact)


# ---------------------------------------------------------------------------
# text
# ---------------------------------------------------------------------------

def is_gsm(text: str) -> bool:
    return all(ch in _GSM_BASIC or ch in _GSM_EXT for ch in text)


def _units(text: str, gsm: bool) -> int:
    if not gsm:
        # UCS-2 counts UTF-16 code units (an emoji is two)
        return len(text.encode("utf-16-le")) // 2
    return sum(2 if ch in _GSM_EXT else 1 for ch in text)


def segments(text: str) -> int:
    gsm = is_gsm(text)
    units = _units(text, gsm)
    single, multi = (160, 153) if gsm else (70, 67)
    if units <= single:
        return 1 if units else 0
    return -(-units // multi)


def fit(text: str, max_segments: int = 0) -> Tuple[str, int, bool]:
    """(text, parts, shortened): the reply cut at a word boundary with an
    ellipsis when it would take more than ``max_segments`` parts."""
    limit = max_segments or MAX_SEGMENTS
    text = re.sub(r"[ \t]+", " ", str(text or "")).strip()
    if segments(text) <= limit:
        return text, segments(text), False
    gsm = is_gsm(text)
    budget = (160 if limit == 1 else 153 * limit) if gsm else (70 if limit == 1 else 67 * limit)
    budget -= 3  # room for "..."
    cut = ""
    for ch in text:
        if _units(cut + ch, gsm) > budget:
            break
        cut += ch
    space = cut.rfind(" ")
    if space > len(cut) * 0.6:
        cut = cut[:space]
    cut = cut.rstrip(" ,;:-") + "..."
    return cut, segments(cut), True


def phone_of(contact: str) -> str:
    """'+<e164>' for an ``sms:`` contact, else ''."""
    import portal_voice

    value = str(contact or "")
    if not value.lower().startswith(PREFIX):
        return ""
    number = value[len(PREFIX):].strip()
    return number if portal_voice.valid_e164(number) else ""


def _mask(contact: str) -> str:
    digits = re.sub(r"\D", "", str(contact or ""))
    return ("..." + digits[-4:]) if len(digits) >= 4 else ""


# ---------------------------------------------------------------------------
# Twilio
# ---------------------------------------------------------------------------

def _keys() -> Dict[str, str]:
    import portal_voice

    return portal_voice._voice_keys()


def twilio_ready(keys: Dict[str, str]) -> bool:
    return bool(keys.get("account_sid") and keys.get("auth_token"))


def assigned_number(cur, client_id: int) -> str:
    import portal_voice

    return str(portal_voice.load_voice_settings(cur, client_id).get("number") or "")


def _status_callback() -> str:
    import portal_voice

    try:
        base, _source = portal_voice.webhook_base()
    except Exception:
        base = ""
    return (base + STATUS_PATH) if base else ""


def send_sms(keys: Dict[str, str], from_number: str, to_number: str, body: str) -> Dict[str, Any]:
    """One Twilio Messages API call; raises portal_voice.TwilioApiError."""
    import portal_voice

    params = {"To": to_number, "From": from_number, "Body": body}
    callback = _status_callback()
    if callback:
        params["StatusCallback"] = callback
    return portal_voice._twilio_api(keys, "POST", "/Messages.json", params)


def _classify(error) -> str:
    """auth (fix the keys, nothing is spent) | final (never retried) | retry"""
    status = int(getattr(error, "status", 502) or 502)
    if status in (401, 403):
        return "auth"
    if status in (400, 404):
        return "final"
    return "retry"


def refusal(cur, client_id: int, item: Dict[str, Any]) -> str:
    """Why this reply can never go out by SMS ("" = send). Final."""
    payload = item["payload"]
    if item["action"] not in TEXT_ACTIONS:
        return "SMS replies support text messages only."
    contact = str(payload.get("external_user_id") or "")
    if not phone_of(contact):
        return "This contact has no valid mobile number."
    if not str(payload.get("body") or "").strip():
        return "The reply is empty."
    if _opted_out(cur, client_id, contact):
        return "The customer asked to stop messages (opt-out) - SMS not sent."
    return ""


# ---------------------------------------------------------------------------
# sending
# ---------------------------------------------------------------------------

def send_pending(client_id: int, limit: int = 0) -> Dict[str, Any]:
    """Send the workspace's queued SMS replies now (at most ``limit``,
    default OF_SMS_MAX_SEND). Never raises."""
    result: Dict[str, Any] = {"ran": False, "reason": "", "sent": 0, "failed": 0,
                              "refused": 0, "error": ""}
    if not ENABLED:
        result["reason"] = "off"
        return result
    conn = None
    locked = False
    try:
        conn = portal_db._conn()
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            conn.commit()  # the log table stays even when this run rolls back
            settings = load_settings(cur, client_id)
            number = assigned_number(cur, client_id)
            keys = _keys()
            conn.commit()
            cur.execute("SELECT pg_try_advisory_lock(%s, %s) AS ok",
                        (LOCK_CLASS, client_id % 2147483647))
            row = cur.fetchone()
            locked = bool(row.get("ok") if isinstance(row, dict) else (row and row[0]))
            conn.commit()
            if not locked:
                result["reason"] = "busy"
                return result
            result["ran"] = True
            problem = ""
            try:
                problem = _send_all(conn, cur, client_id, settings, number, keys, result,
                                    limit or MAX_SEND_PER_RUN)
            except Exception as error:
                conn.rollback()
                logger.warning("sms send failed: %s", error)
                problem = "Sending SMS failed - try again shortly."
            changes: Dict[str, Any] = {"last_error": problem}
            if result["sent"]:
                changes["last_sent_at"] = _now_iso(cur)
            if problem != settings["last_error"] or result["sent"]:
                save_settings(cur, client_id, changes)
            result["error"] = problem
            conn.commit()
    except Exception as error:
        logger.warning("sms channel run failed: %s", error)
        result["reason"] = result["reason"] or "unavailable"
        result["error"] = result["error"] or "Sending SMS failed - try again shortly."
    finally:
        if conn is not None:
            try:
                if locked:
                    conn.rollback()
                    with conn.cursor() as cur:
                        cur.execute("SELECT pg_advisory_unlock(%s, %s)",
                                    (LOCK_CLASS, client_id % 2147483647))
                    conn.commit()
            except Exception:
                pass
            try:
                conn.close()
            except Exception:
                pass
    return result


def _send_all(conn, cur, client_id: int, settings: Dict[str, Any], number: str,
              keys: Dict[str, str], result: Dict[str, Any], limit: int) -> str:
    """Returns the problem to show ("" = fine)."""
    import portal_voice

    pending = portal_cp_outbox.pending(cur, client_id, CHANNEL, PREFIX, limit)
    conn.commit()
    if not pending:
        return ""
    if not settings["enabled"]:
        # switched off: the inbox shows why instead of waiting forever
        for item in pending:
            portal_cp_outbox.refuse(cur, client_id, CHANNEL, item,
                                    "The SMS channel is switched off in Settings.")
            conn.commit()
            result["refused"] += 1
        return ""
    if not twilio_ready(keys):
        return "SMS is not set up on the platform yet (Twilio keys missing) - replies wait."
    if not number:
        return "No phone number is assigned to this workspace yet - replies wait."
    used = sent_today(cur, client_id)
    records: List[Dict[str, Any]] = []
    problem = ""
    try:
        for item in pending:
            reason = refusal(cur, client_id, item)
            if not reason and used >= settings["daily_limit"]:
                reason = ("Daily SMS limit reached (" + str(settings["daily_limit"])
                          + ") - raise it in Settings > SMS channel.")
            if reason:
                portal_cp_outbox.refuse(cur, client_id, CHANNEL, item, reason)
                conn.commit()
                result["refused"] += 1
                continue
            payload = item["payload"]
            contact = str(payload["external_user_id"])
            text, parts, shortened = fit(str(payload["body"]))
            try:
                answer = send_sms(keys, number, phone_of(contact), text)
            except portal_voice.TwilioApiError as error:
                kind = _classify(error)
                if kind == "auth":
                    # nothing was sent and no attempt is spent
                    conn.rollback()
                    problem = "Twilio refused the platform keys - replies wait until they are fixed."
                    break
                note = "Twilio: " + error.message
                if kind == "final":
                    portal_cp_outbox.refuse(cur, client_id, CHANNEL, item, note)
                    result["refused"] += 1
                else:
                    portal_cp_outbox.retry(cur, client_id, CHANNEL, item, note)
                    result["failed"] += 1
                conn.commit()
                continue
            sid = str(answer.get("sid") or "")
            note = "SMS sent" + (" (shortened to " + str(parts) + " parts)" if shortened else "") + "."
            portal_cp_outbox.sent(cur, client_id, CHANNEL, item, note, sid or None)
            _log(cur, client_id, "out", contact, sid, str(answer.get("status") or "queued"),
                 parts, str(payload.get("source") or item["kind"]))
            conn.commit()
            used += 1
            result["sent"] += 1
            records.append({"from": contact, "body": text, "direction": "out",
                            "channel": CHANNEL, "id": "sms-out:" + (sid or str(item["id"])),
                            "provider": "twilio_sms"})
    finally:
        # the conversation shows the sent reply, like the WhatsApp bridge
        portal_cp_outbox.record_sent(client_id, CHANNEL, "sms_channel", records)
    return problem


def _job(client_id: int) -> None:
    try:
        send_pending(client_id)
    finally:
        with _LOCK:
            _RUNNING.discard(client_id)


def kick(client_id: Any) -> bool:
    """Tick hook (connector poll, inbox list): send queued SMS in the
    background at most once per OF_SMS_POLL_SECONDS per process."""
    if not ENABLED:
        return False
    try:
        client_id = int(client_id or 0)
    except Exception:
        return False
    if client_id <= 0:
        return False
    now = time.monotonic()
    with _LOCK:
        if client_id in _RUNNING or now - _LAST.get(client_id, -1e18) < POLL_SECONDS:
            return False
        _RUNNING.add(client_id)
        _LAST[client_id] = now
    try:
        threading.Thread(target=_job, args=(client_id,),
                         name="sms-" + str(client_id), daemon=True).start()
    except Exception:
        with _LOCK:
            _RUNNING.discard(client_id)
        return False
    return True


# ---------------------------------------------------------------------------
# public webhooks (Twilio)
# ---------------------------------------------------------------------------

def _twiml() -> Response:
    return Response(EMPTY_TWIML, status=200, mimetype="text/xml")


def inbound_body(form) -> str:
    body = str(form.get("Body") or "").strip()[:MAX_BODY_IN]
    try:
        media = max(0, min(10, int(form.get("NumMedia") or 0)))
    except ValueError:
        media = 0
    if media:
        note = ("[The customer sent " + str(media) + " picture" + ("s" if media > 1 else "")
                + " / file" + ("s" if media > 1 else "") + " by MMS - not shown in OmniFlow.]")
        body = (body + "\n" + note).strip()
    return body


@public_bp.post("/sms/incoming")
def sms_incoming():
    """Twilio: a customer texted a workspace number. Always answers empty
    TwiML (replies go out through the queue, not inline)."""
    import portal_voice

    guard = portal_voice._twilio_guard()
    if guard is not None:
        return guard
    if not ENABLED:
        return _twiml()
    sender = str(request.form.get("From") or "").strip()
    to_digits = portal_voice._digits(str(request.form.get("To") or ""))
    sid = str(request.form.get("MessageSid") or request.form.get("SmsSid") or "").strip()[:64]
    body = inbound_body(request.form)
    if not portal_voice.valid_e164(sender) or not sid or not body:
        return _twiml()  # short codes / alphanumeric senders cannot get replies
    if not twilio_ready(_keys()):
        # without the platform keys no signature can be checked - never
        # import an unsigned message
        return _twiml()
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                client_id, _voice = portal_voice._client_for_number(cur, to_digits)
                settings = load_settings(cur, client_id) if client_id else None
                conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("sms incoming lookup failed: %s", error)
        return jsonify({"error": {"code": "portal_unavailable",
                                  "message": "SMS is unavailable right now."}}), 503
    if not client_id or not settings or not settings["enabled"]:
        logger.info("sms for an unassigned or switched-off number ignored")
        return _twiml()
    contact = PREFIX + sender
    import connector_api

    try:
        portal_cp_outbox.ingest(client_id, CHANNEL, "sms_channel", [{
            "from": contact, "body": body, "name": None, "direction": "in",
            "channel": CHANNEL, "id": "sms:" + sid, "provider": "twilio_sms"}])
    except connector_api.IngestRateLimited:
        logger.warning("sms ingest rate limited for workspace %s", client_id)
        return _twiml()
    except Exception as error:
        logger.warning("sms ingest failed: %s", error)
        return jsonify({"error": {"code": "portal_unavailable",
                                  "message": "SMS is unavailable right now."}}), 503
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                conn.commit()
                _log(cur, client_id, "in", contact, sid, "received", segments(body), "customer")
                save_settings(cur, client_id, {"last_in_at": _now_iso(cur)})
                conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.info("sms inbound log skipped: %s", error)
    # the AI / away reply the message may have queued goes out now
    send_pending(client_id)
    return _twiml()


@public_bp.post("/sms/status")
def sms_status():
    """Twilio delivery callback for a text we sent."""
    import portal_voice

    guard = portal_voice._twilio_guard()
    if guard is not None:
        return guard
    sid = str(request.form.get("MessageSid") or request.form.get("SmsSid") or "").strip()[:64]
    status = str(request.form.get("MessageStatus") or request.form.get("SmsStatus")
                 or "").strip().lower()[:20]
    code = re.sub(r"\D", "", str(request.form.get("ErrorCode") or ""))[:10]
    if not sid or status not in STATUS_RANK or not twilio_ready(_keys()):
        return ("", 204)  # unsigned without keys: never trusted
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                conn.commit()
                cur.execute("SELECT id, status FROM " + portal_db._q(LOG_TABLE) +
                            " WHERE sid = %s AND direction = 'out' LIMIT 1", (sid,))
                rows = portal_db.rows(cur)
                if rows and STATUS_RANK.get(status, 0) >= STATUS_RANK.get(
                        str(rows[0].get("status") or ""), 0):
                    cur.execute("UPDATE " + portal_db._q(LOG_TABLE) +
                                " SET status = %s, error_code = %s, updated_at = NOW()"
                                " WHERE id = %s", (status, code, rows[0]["id"]))
                conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("sms status update failed: %s", error)
        return jsonify({"error": {"code": "portal_unavailable",
                                  "message": "SMS is unavailable right now."}}), 503
    return ("", 204)


# ---------------------------------------------------------------------------
# workspace settings API
# ---------------------------------------------------------------------------

URL = "/channels/sms"
DOWN = {"error": {"code": "portal_unavailable",
                  "message": "The SMS channel is unavailable right now."}}


def _human_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": str(error)}}), 503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}), 401)
    forbidden = ensure_human_principal(principal)
    if forbidden:
        return None, forbidden
    return principal, None


def _can_edit(principal: Dict[str, Any]) -> bool:
    import portal_notify

    return portal_notify.can_edit(principal)


def _forbidden():
    return jsonify({"error": {"code": "forbidden",
                              "message": "Only owners and admins can change the SMS channel."}}), 403


def _audit(cur, conn, client_id: int, principal: Dict[str, Any], note: str) -> None:
    try:
        with portal_txn.savepoint(cur, conn, "of_sms_log"):
            portal_db.log_action(cur, client_id, "settings.sms_channel", "user",
                                 principal.get("user_id"), None, note)
    except Exception as error:
        logger.info("sms channel audit skipped: %s", error)


def _recent(cur, client_id: int) -> List[Dict[str, Any]]:
    cur.execute("SELECT direction, contact_id, status, error_code, segments, source, created_at"
                " FROM " + portal_db._q(LOG_TABLE) + " WHERE client_id = %s"
                " ORDER BY id DESC LIMIT %s", (client_id, RECENT_LIMIT))
    out = []
    for row in portal_db.rows(cur):
        created = row.get("created_at")
        out.append({"direction": str(row.get("direction") or ""),
                    "contact": _mask(row.get("contact_id")),
                    "status": str(row.get("status") or ""),
                    "error_code": str(row.get("error_code") or ""),
                    "segments": int(row.get("segments") or 0),
                    "source": str(row.get("source") or ""),
                    "created_at": created.isoformat() if hasattr(created, "isoformat") else None})
    return out


def _state(cur, client_id: int, principal: Dict[str, Any]) -> Dict[str, Any]:
    settings = load_settings(cur, client_id)
    cur.execute("SELECT to_regclass(%s) AS t", (LOG_TABLE,))
    found = portal_db.rows(cur)
    has_log = bool(found and found[0].get("t"))
    return {
        "available": ENABLED,
        "can_edit": _can_edit(principal),
        "enabled": settings["enabled"],
        "daily_limit": settings["daily_limit"],
        "daily_max": DAILY_MAX,
        "sent_today": sent_today(cur, client_id) if has_log else 0,
        "number": assigned_number(cur, client_id),
        "twilio_ready": twilio_ready(_keys()),
        "max_segments": MAX_SEGMENTS,
        "last_error": settings["last_error"],
        "last_sent_at": settings["last_sent_at"],
        "last_in_at": settings["last_in_at"],
        "recent": _recent(cur, client_id) if has_log else [],
    }


@bp.get(URL)
def get_sms_channel():
    principal, error = _human_or_error()
    if error:
        return error
    client_id = int(principal["client_id"])
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                state = _state(cur, client_id, principal)
                conn.commit()
        finally:
            conn.close()
    except Exception as failure:
        logger.warning("sms channel read failed: %s", failure)
        return jsonify(DOWN), 503
    return jsonify(state), 200


@bp.put(URL)
def save_sms_channel():
    principal, error = _human_or_error()
    if error:
        return error
    if not _can_edit(principal):
        return _forbidden()
    payload = request.get_json(silent=True)
    payload = payload if isinstance(payload, dict) else {}
    changes: Dict[str, Any] = {}
    if "enabled" in payload:
        if not isinstance(payload["enabled"], bool):
            return jsonify({"error": {"code": "bad_request",
                                      "message": "enabled must be true or false."}}), 400
        changes["enabled"] = payload["enabled"]
    if "daily_limit" in payload:
        limit = payload["daily_limit"]
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= DAILY_MAX:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "The daily limit must be a whole number from 1 to "
                                                 + str(DAILY_MAX) + "."}}), 400
        changes["daily_limit"] = limit
    if not changes:
        return jsonify({"error": {"code": "bad_request", "message": "Nothing to save."}}), 400
    client_id = int(principal["client_id"])
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                conn.commit()  # the log table stays even when this save rolls back
                if changes.get("enabled") is True:
                    if not ENABLED:
                        conn.rollback()
                        return jsonify({"error": {"code": "disabled",
                                                  "message": "SMS is switched off on this platform."}}), 409
                    if not twilio_ready(_keys()):
                        conn.rollback()
                        return jsonify({"error": {"code": "not_ready",
                                                  "message": "SMS is not set up on the platform yet"
                                                             " - ask the platform admin."}}), 409
                    if not assigned_number(cur, client_id):
                        conn.rollback()
                        return jsonify({"error": {"code": "not_ready",
                                                  "message": "No phone number is assigned to this"
                                                             " workspace yet - ask the platform admin."}}), 409
                if changes.get("enabled") is False:
                    changes["last_error"] = ""
                saved = save_settings(cur, client_id, changes)
                _audit(cur, conn, client_id, principal,
                       ("SMS channel " + ("on" if saved["enabled"] else "off")
                        + ", daily limit " + str(saved["daily_limit"]))[:200])
                state = _state(cur, client_id, principal)
                conn.commit()
        finally:
            conn.close()
    except Exception as failure:
        logger.warning("sms channel save failed: %s", failure)
        return jsonify(DOWN), 503
    state["ok"] = True
    return jsonify(state), 200


@bp.post(URL + "/test")
def test_sms_channel():
    """Owners / admins: text one number from the workspace number (counts
    towards the daily limit; at most one test per OF_SMS_TEST_GAP_SECONDS)."""
    import portal_voice

    principal, error = _human_or_error()
    if error:
        return error
    if not _can_edit(principal):
        return _forbidden()
    payload = request.get_json(silent=True)
    to_number = str((payload or {}).get("to") or "").strip() if isinstance(payload, dict) else ""
    if not portal_voice.valid_e164(to_number):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Use the full international format, e.g. +923001234567."}}), 400
    if not ENABLED:
        return jsonify({"error": {"code": "disabled",
                                  "message": "SMS is switched off on this platform."}}), 409
    client_id = int(principal["client_id"])
    keys = _keys()
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                conn.commit()
                number = assigned_number(cur, client_id)
                settings = load_settings(cur, client_id)
                if not twilio_ready(keys) or not number:
                    conn.rollback()
                    return jsonify({"error": {"code": "not_ready",
                                              "message": "SMS needs the platform Twilio keys and a phone"
                                                         " number assigned to this workspace."}}), 409
                cur.execute("SELECT 1 AS hit FROM " + portal_db._q(LOG_TABLE) +
                            " WHERE client_id = %s AND source = 'test' AND created_at > NOW()"
                            " - (%s * INTERVAL '1 second') LIMIT 1", (client_id, TEST_GAP_SECONDS))
                if portal_db.rows(cur):
                    conn.rollback()
                    return jsonify({"error": {"code": "rate_limited",
                                              "message": "One test message per minute - try again shortly."}}), 429
                if sent_today(cur, client_id) >= settings["daily_limit"]:
                    conn.rollback()
                    return jsonify({"error": {"code": "rate_limited",
                                              "message": "Today's SMS limit is reached."}}), 429
                try:
                    answer = send_sms(keys, number, to_number, TEST_TEXT)
                except portal_voice.TwilioApiError as failure:
                    conn.rollback()
                    return jsonify({"error": {"code": "twilio_error",
                                              "message": "Twilio: " + failure.message}}), \
                        (409 if _classify(failure) != "retry" else 503)
                _log(cur, client_id, "out", PREFIX + to_number, str(answer.get("sid") or ""),
                     str(answer.get("status") or "queued"), segments(TEST_TEXT), "test")
                _audit(cur, conn, client_id, principal, "SMS test message sent to " + _mask(to_number))
                conn.commit()
        finally:
            conn.close()
    except Exception as failure:
        logger.warning("sms test failed: %s", failure)
        return jsonify(DOWN), 503
    return jsonify({"ok": True, "status": str(answer.get("status") or "queued")}), 200
