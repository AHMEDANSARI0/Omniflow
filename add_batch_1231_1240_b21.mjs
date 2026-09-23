// Omniflow batch 1231 - V2 B21: KEY-POWERED CHANNELS (the parked features go live).
// Everything the admin panel arms now has its consumer: VOICE - NEW
// portal_voice.py, owner click-to-call via Twilio (Twiml <Say>, E.164
// validation, portal_voice_calls log + Twilio status webhook, keys from
// the admin panel or OF_TWILIO_* env); VIDEO - NEW portal_video.py,
// "Send video invite" creates a room on Whereby/Daily/Zoom (Zoom via the
// account-id/client-id/secret OAuth token endpoint) and drops the link
// into the chat through the normal WhatsApp command queue
// (portal_video_rooms log); PAYMENTS - portal_payments grows the Stripe
// platform path: workspace picks "Stripe (platform keys)", the public
// /pay redirect creates a PKR Checkout Session (success_url = the
// callback with ?stripe_return=1), the GET return verifies the session
// and marks the intent/link paid (same audit trail); PH9 - checkout
// phone verification: the platform flag gates public POST
// /checkout/<token>/otp (6-digit code over WhatsApp, hashed, 10-min
// TTL, 3 sends/15min, 5 attempts) + /otp/verify, the public payload
// carries phone_verification and the public page's pay button sits
// behind a PayGate verify step when the flag is on; KB AUTO-DRAFT -
// the Assist card grows "Draft with AI" (POST conversations/[id]/draft
// -> brain/draft) and shows the draft with a "Save as KB answer"
// button; BRAND STOREFRONT - the saved-catalog and knowledge-base
// cards grow "All brands" filters (?brand_id=), the public checkout
// page already shows the brand eyebrow. portal.ts grows
// listVoiceCalls/callContact/listVideoRooms/sendVideoInvite (+
// VoiceCall/VideoRoom types), requestPublicPhoneOtp/verifyPublicPhoneOtp
// and the typed kbEntry on BrainDraftResult. Six BFF routes (depth law:
// voice+video 6 ups, draft+otp 7 ups, otp/verify 8 ups).
// Whole-file writeNewRepair ops (marker-guarded, backup on drift,
// *.pre_b12311240.bak); idempotent; run order does not matter.
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const BACKUP_TAG = ".pre_b12311240.bak";
let applied = 0;
let already = 0;
let warnings = 0;
function compilePython(pathArg) {
  const { spawnSync } = require("child_process");
  for (const py of ["python3", "python", "py"]) {
    const probe = spawnSync(py, ["--version"], { encoding: "utf8" });
    if (probe.status !== 0) continue;
    const check = spawnSync(py, ["-c", "import sys;sys.exit(0 if sys.version_info[0]>=3 else 1)"], { encoding: "utf8" });
    if (check.status !== 0) continue;
    const result = spawnSync(py, ["-c", "import py_compile,sys;py_compile.compile(sys.argv[1],doraise=True);sys.exit(0)", pathArg], { encoding: "utf8" });
    return result.status === 0;
  }
  console.log("  (python not found — skipped compile guard)");
  return true;
}
function writeNewRepair(repoPath, marker, isCp, content) {
  if (!fs.existsSync(repoPath)) {
    fs.mkdirSync(repoPath.replace(/\/[^/]*$/, ""), { recursive: true });
    fs.writeFileSync(repoPath, content, "utf8");
    if (isCp && !compilePython(repoPath)) {
      console.log("FAIL (compile failed): " + repoPath);
      warnings++;
      return;
    }
    console.log("+ " + repoPath + " (new file)");
    applied++;
    return;
  }
  const original = fs.readFileSync(repoPath, "utf8").replace(/\r\n/g, "\n");
  if (original.includes(marker)) {
    console.log("= " + repoPath + " (already patched)");
    already++;
    return;
  }
  const backup = repoPath + BACKUP_TAG;
  if (!fs.existsSync(backup)) fs.copyFileSync(repoPath, backup);
  fs.writeFileSync(repoPath, content, "utf8");
  if (isCp && !compilePython(repoPath)) {
    fs.copyFileSync(backup, repoPath);
    console.log("FAIL (compile failed, restored): " + repoPath);
    warnings++;
    return;
  }
  console.log("+ " + repoPath + " (REPAIRED - old copy kept as " + BACKUP_TAG + ")");
  applied++;
}
console.log("== batch 1231 (B21 key-powered channels) ==");
writeNewRepair("OmniFlow-Control-Plane/platform_settings.py", "def video_config(", true,
    `"""Platform-level settings store (admin-panel managed provider config).

One tiny table - platform_settings(key TEXT PRIMARY KEY, value TEXT,
updated_at) - holds everything the owner types into the admin panel's
Integrations page: SMTP/Brevo email credentials, the LLM engine config,
the AI feature switches and the future-channel keys (voice, video,
payments, phone verification, the WhatsApp E2E test number).

Design laws:
- STANDARD LIBRARY ONLY for the readers (portal_llm imports this inside
  the ingest hot path; flask lives in admin_providers, not here).
- Fail-soft: any read error -> None, and the caller falls back to its
  environment variable (env-config adapters stay the safety net).
- Secrets are stored as-is in the database and masked by the admin API;
  the readers here are server-side only.
- A 30-second TTL cache keeps the ingest loop from hammering the
  database; every PUT invalidates it on the instance that wrote.
"""

import time

try:  # pragma: no cover - always available in the Control Plane image
    import portal_db
except Exception:  # pragma: no cover - tests may inject a stub
    portal_db = None

TABLE = "platform_settings"
CACHE_TTL_SECONDS = 30.0

_DDL_READY = False
_cache = {}
_cache_at = 0.0

def _ddl() -> str:
    """Built lazily so importing this module never touches portal_db."""
    return (
        "CREATE TABLE IF NOT EXISTS " + portal_db._q(TABLE) + " ("
        " key TEXT PRIMARY KEY,"
        " value TEXT NOT NULL DEFAULT '',"
        " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"
        ")"
    )

# group -> the exact keys the admin API accepts for that group.
GROUP_KEYS = {
    "email": ["provider", "smtp_host", "smtp_port", "smtp_user",
              "smtp_password", "smtp_from", "brevo_api_key", "reports_to"],
    "llm": ["base_url", "api_key", "model"],
    "flags": ["true_sentiment", "kb_autodraft", "phone_verification"],
    "voice": ["provider", "account_sid", "auth_token", "from_number"],
    "video": ["provider", "api_key", "zoom_account_id",
              "zoom_client_id", "zoom_client_secret"],
    "payments": ["provider", "publishable_key", "secret_key",
                 "webhook_secret"],
    "whatsapp_e2e": ["live_number"],
}

SECRET_HINTS = ("password", "api_key", "token", "secret")


def _key(group: str, name: str) -> str:
    return group + "." + name


def _ensure(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_ddl())
    _DDL_READY = True


def invalidate_cache() -> None:
    """Drop the TTL cache (called after every successful PUT)."""
    global _cache_at
    _cache.clear()
    _cache_at = 0.0


def get_setting(key: str, default=None):
    """One setting as TEXT; default on any error (fail-soft)."""
    global _cache, _cache_at
    if portal_db is None:
        return default
    now = time.monotonic()
    if _cache and (now - _cache_at) < CACHE_TTL_SECONDS:
        if key in _cache:
            return _cache[key]
        return default
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure(cur)
                cur.execute(
                    "SELECT key, value FROM " + portal_db._q(TABLE)
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
        _cache = {str(r["key"]): str(r["value"] or "") for r in rows}
        _cache_at = time.monotonic()
    except Exception:
        _cache.clear()
        _cache_at = 0.0
        return default
    return _cache.get(key, default)


def get_group(group: str) -> dict:
    """Every stored key of one group as {name: value} (no defaults)."""
    prefix = group + "."
    out = {}
    if portal_db is None:
        return out
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure(cur)
                cur.execute(
                    "SELECT key, value FROM " + portal_db._q(TABLE)
                    + " WHERE key LIKE %s",
                    (prefix + "%",),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception:
        return out
    for row in rows:
        out[str(row["key"])[len(prefix):]] = str(row["value"] or "")
    return out


def put_group(cur, group: str, values: dict) -> None:
    """Upsert one group inside the CALLER's transaction (admin PUT).

    The caller owns auth, whitelist filtering, the audit row and the
    commit; this only writes the key/value pairs.
    """
    prefix = group + "."
    for name, value in values.items():
        cur.execute(
            "INSERT INTO " + portal_db._q(TABLE) +
            " (key, value, updated_at) VALUES (%s, %s, NOW())"
            " ON CONFLICT (key) DO UPDATE SET"
            " value = EXCLUDED.value, updated_at = NOW()",
            (prefix + name, str(value)),
        )


def _env(name: str, default: str = "") -> str:
    import os
    return os.environ.get(name, default).strip()


def llm_config() -> dict:
    """Effective LLM config: admin panel first, env fallback.

    enabled keeps the env kill switch: OF_LLM_ENABLED explicitly off
    wins over a stored key.
    """
    stored = {}
    try:
        stored = get_group("llm")
    except Exception:
        stored = {}
    env_enabled = _env("OF_LLM_ENABLED", "1").lower() not in (
        "0", "false", "no", "off")
    api_key = str(stored.get("api_key") or _env("OF_LLM_API_KEY", ""))
    return {
        "base_url": (str(stored.get("base_url") or "")
                     or _env("OF_LLM_BASE_URL",
                             "https://api.openai.com/v1")).rstrip("/"),
        "api_key": api_key,
        "model": str(stored.get("model") or "")
                 or _env("OF_LLM_MODEL", "gpt-4o-mini"),
        "enabled": bool(api_key) and env_enabled,
    }


def video_config() -> dict:
    """Effective video-provider config: admin panel first, env fallback."""
    stored = {}
    try:
        stored = get_group("video")
    except Exception:
        stored = {}
    def pick(name, env, default=""):
        return str(stored.get(name) or "").strip() or _env(env, default)
    provider = (str(stored.get("provider") or "").strip().lower()
                or _env("OF_VIDEO_PROVIDER", "whereby"))
    return {
        "provider": provider,
        "api_key": str(stored.get("api_key") or "")
                   or os_secret_env("OF_VIDEO_API_KEY"),
        "zoom_account_id": pick("zoom_account_id", "OF_ZOOM_ACCOUNT_ID"),
        "zoom_client_id": pick("zoom_client_id", "OF_ZOOM_CLIENT_ID"),
        "zoom_client_secret": str(stored.get("zoom_client_secret") or "")
                              or os_secret_env("OF_ZOOM_CLIENT_SECRET"),
    }


def smtp_config() -> dict:
    """Effective email config: admin panel first, env fallback."""
    stored = {}
    try:
        stored = get_group("email")
    except Exception:
        stored = {}
    def pick(name, env, default=""):
        return str(stored.get(name) or "").strip() or _env(env, default)
    provider = (str(stored.get("provider") or "").strip().lower()
                or ("brevo" if _env("BREVO_API_KEY") else "smtp"))
    return {
        "provider": provider,
        "smtp_host": pick("smtp_host", "SMTP_HOST"),
        "smtp_port": pick("smtp_port", "SMTP_PORT", "587"),
        "smtp_user": pick("smtp_user", "SMTP_USER"),
        "smtp_password": str(stored.get("smtp_password") or "")
                         or os_secret_env("SMTP_PASSWORD"),
        "smtp_from": pick("smtp_from", "SMTP_FROM",
                          "OmniFlow <no-reply@omniflow.app>"),
        "brevo_api_key": str(stored.get("brevo_api_key") or "")
                         or os_secret_env("BREVO_API_KEY"),
        "reports_to": pick("reports_to", "OMNIFLOW_REPORTS_TO"),
    }


def os_secret_env(name: str) -> str:
    """Secret env fallback (os.environ read kept out of the hot path)."""
    import os
    return os.environ.get(name, "")


def flag(name: str) -> bool:
    """AI/feature switch state; every switch defaults OFF."""
    try:
        raw = str(get_setting("flags." + name, "") or "").strip().lower()
    except Exception:
        return False
    return raw in ("on", "1", "true", "yes")
`);
writeNewRepair("OmniFlow-Control-Plane/portal_voice.py", "def _twilio_create_call(", true,
    `"""Voice channel slice one: owner click-to-call via Twilio.

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

from flask import Blueprint, jsonify, request

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
    " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"
    ")"
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
        return str(stored.get(name) or "").strip() or \\
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


def _row_public(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": int(row.get("id") or 0),
        "contact_id": str(row.get("contact_id") or ""),
        "phone": str(row.get("phone") or ""),
        "sid": str(row.get("sid") or ""),
        "status": str(row.get("status") or "queued"),
        "message": str(row.get("message") or ""),
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
                    " message, created_at FROM "
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
    if "_error" in result or "_status" not in result \\
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
`);
writeNewRepair("OmniFlow-Control-Plane/portal_video.py", "def _create_room(", true,
    `"""Video channel slice one: send a live meeting link into a chat.

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
                name = str(name_rows[0].get("contact_name") or "") \\
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
`);
writeNewRepair("OmniFlow-Control-Plane/portal_payments.py", "def _stripe_create_session(", true,
    `"""Payment gateways (JazzCash / Easypaisa hosted checkout) for checkout
links. Everything is OFF until the owner stores credentials. The customer
pays from the public /c/ page: GET /public/checkout/<token>/pay builds a
signed provider form (auto-submit HTML); the provider posts back to
/public/payments/callback/<intent> where the HMAC is verified BEFORE the
payment is applied to the link (paid_amount += amount, auto-flip to paid).
No secrets ever leave the server; settings GETs return last-4 masks only."""
import hashlib
import hmac
import json
import logging
import secrets
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_checkout
import portal_db

bp = Blueprint("portal_payments", __name__, url_prefix="/api/v1/portal")
public_bp = Blueprint("portal_payments_public", __name__,
                      url_prefix="/api/v1/public")

logger = logging.getLogger(__name__)
SETTINGS_TABLE = "portal_payment_settings"
INTENTS_TABLE = "portal_payment_intents"
_SETTINGS_DDL_READY = False
_INTENTS_DDL_READY = False
PROVIDERS = ("jazzcash", "easypaisa", "stripe")
MAX_AMOUNT = 100000


def _ensure_settings_table(conn) -> None:
    global _SETTINGS_DDL_READY
    if _SETTINGS_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(SETTINGS_TABLE) +
            " (client_id BIGINT PRIMARY KEY,"
            " provider TEXT NOT NULL DEFAULT 'jazzcash',"
            " enabled BOOLEAN NOT NULL DEFAULT FALSE,"
            " sandbox BOOLEAN NOT NULL DEFAULT TRUE,"
            " merchant_id TEXT NOT NULL DEFAULT '',"
            " password TEXT NOT NULL DEFAULT '',"
            " salt TEXT NOT NULL DEFAULT '',"
            " store_id TEXT NOT NULL DEFAULT '',"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
    conn.commit()
    _SETTINGS_DDL_READY = True


def _ensure_intents_table(conn) -> None:
    global _INTENTS_DDL_READY
    if _INTENTS_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(INTENTS_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " link_id BIGINT NOT NULL,"
            " token TEXT NOT NULL UNIQUE,"
            " provider TEXT NOT NULL DEFAULT '',"
            " amount NUMERIC(12,2) NOT NULL DEFAULT 0,"
            " status TEXT NOT NULL DEFAULT 'pending',"
            " provider_ref TEXT NOT NULL DEFAULT '',"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS portal_payment_intents_client_idx ON "
            + portal_db._q(INTENTS_TABLE) + " (client_id, id DESC)"
        )
    conn.commit()
    _INTENTS_DDL_READY = True


def _load_settings(cur, client_id):
    cur.execute(
        "SELECT provider, enabled, sandbox, merchant_id, password, salt,"
        " store_id FROM " + portal_db._q(SETTINGS_TABLE) +
        " WHERE client_id = %s LIMIT 1",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    return rows[0] if rows else None


def _stripe_secret() -> str:
    """Platform Stripe secret key (admin panel first, env fallback)."""
    try:
        import platform_settings
        stored = platform_settings.get_group("payments")
        return (str(stored.get("secret_key") or "").strip()
                or os.environ.get("STRIPE_SECRET_KEY", "").strip())
    except Exception:
        return os.environ.get("STRIPE_SECRET_KEY", "").strip()


def _configured(row) -> bool:
    if row is None or not row.get("enabled"):
        return False
    if str(row.get("provider") or "") == "stripe":
        return bool(_stripe_secret())
    if str(row.get("provider") or "") == "jazzcash":
        return bool(row.get("merchant_id")) and bool(row.get("salt"))
    if str(row.get("provider") or "") == "easypaisa":
        return bool(row.get("store_id"))
    return False


def _mask(value: str) -> str:
    value = str(value or "")
    if len(value) <= 4:
        return "****"
    return "****" + value[-4:]


def jazzcash_hash(salt: str, fields: Dict[str, str]) -> str:
    """HMAC-SHA256 over sorted non-empty fields (JazzCash v2.0 spec)."""
    msg = "&".join(
        str(k) + "=" + str(v)
        for k, v in sorted(fields.items())
        if str(v or "") != "" and str(k) != "pp_SecureHash"
    )
    return hmac.new(
        str(salt or "").encode("utf-8"), msg.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest().upper()


def easypaisa_hash(hash_key: str, fields: Dict[str, str]) -> str:
    msg = "&".join(
        str(k) + "=" + str(v)
        for k, v in sorted(fields.items())
        if str(v or "") != ""
    )
    return hmac.new(
        str(hash_key or "").encode("utf-8"), msg.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest().upper()


@bp.get("/payments/settings")
def get_payment_settings():
    principal, error = portal_checkout._principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_settings_table(conn)
            with conn.cursor() as cur:
                row = _load_settings(cur, principal["client_id"])
        finally:
            conn.close()
    except Exception as error:
        logger.warning("payment settings read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "payment settings read")[0]), 503
    row = row or {}
    provider = str(row.get("provider") or "jazzcash")
    return jsonify({"settings": {
        "provider": provider if provider in PROVIDERS else "jazzcash",
        "enabled": bool(row.get("enabled")),
        "sandbox": bool(row.get("sandbox")),
        "configured": _configured(row),
        "merchant_id_masked": _mask(row.get("merchant_id")),
        "store_id_masked": _mask(row.get("store_id")),
    }}), 200


@bp.put("/payments/settings")
def save_payment_settings():
    principal, error = portal_checkout._principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    forbidden = portal_checkout.ensure_money_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    provider = str(payload.get("provider") or "jazzcash").strip().lower()
    if provider not in PROVIDERS:
        provider = "jazzcash"
    merchant_id = str(payload.get("merchant_id") or "").strip()[:64]
    password = str(payload.get("password") or "").strip()[:128]
    salt = str(payload.get("salt") or "").strip()[:128]
    store_id = str(payload.get("store_id") or "").strip()[:64]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_settings_table(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(SETTINGS_TABLE) +
                    " (client_id, provider, enabled, sandbox, merchant_id,"
                    " password, salt, store_id, updated_at)"
                    " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW())"
                    " ON CONFLICT (client_id) DO UPDATE SET provider ="
                    " EXCLUDED.provider, enabled = EXCLUDED.enabled,"
                    " sandbox = EXCLUDED.sandbox, merchant_id ="
                    " EXCLUDED.merchant_id, password = EXCLUDED.password,"
                    " salt = EXCLUDED.salt, store_id = EXCLUDED.store_id,"
                    " updated_at = NOW()",
                    (principal["client_id"], provider,
                     bool(payload.get("enabled")),
                     bool(payload.get("sandbox")), merchant_id,
                     password, salt, store_id),
                )
                portal_db.log_action(
                    cur, principal["client_id"], "payments.settings",
                    "customer_user", principal.get("user_id"), None,
                    ("Payment gateway " + provider
                     + (" enabled" if payload.get("enabled")
                        else " saved"))[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("payment settings save failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "payment settings save")[0]), 503
    return jsonify({"ok": True}), 200


@bp.get("/payments/intents")
def list_payment_intents():
    principal, error = portal_checkout._principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_intents_table(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, token, provider, amount, status,"
                    " created_at FROM " + portal_db._q(INTENTS_TABLE) +
                    " WHERE client_id = %s ORDER BY id DESC LIMIT 20",
                    (principal["client_id"],),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("payment intents read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "payment intents read")[0]), 503
    return jsonify({"intents": [{
        "id": int(row.get("id") or 0),
        "token": str(row.get("token") or "")[:8],
        "provider": str(row.get("provider") or ""),
        "amount": round(float(row.get("amount") or 0), 2),
        "status": str(row.get("status") or "pending"),
        "created_at": portal_checkout._iso(row.get("created_at")),
    } for row in rows]}), 200


def _build_provider_form(settings, intent_token, due, base_url):
    """Return (post_url, fields) for the configured provider."""
    provider = str(settings.get("provider") or "jazzcash")
    sandbox = bool(settings.get("sandbox"))
    if provider == "easypaisa":
        url = ("https://easypaystg.easypaisa.com.pk/easypay/Index.jsf"
               if sandbox
               else "https://easypay.easypaisa.com.pk/easypay/Index.jsf")
        fields = {
            "storeId": str(settings.get("store_id") or ""),
            "amount": str(due),
            "postBackURL": base_url + "/api/v1/public/payments/callback/"
                           + intent_token,
            "orderRefNum": intent_token[:20],
            "expiryDate": "2029-12-31 00:00:00",
            "autoRedirect": "1",
            "paymentMethod": "MA_PAYMENT_METHOD",
            "emailAddr": "",
            "mobileNum": "",
        }
        return url, fields
    url = ("https://sandbox.jazzcash.com.pk/CustomerPortal/"
           "transactionmanagement/merchantform"
           if sandbox else
           "https://payments.jazzcash.com.pk/CustomerPortal/"
           "transactionmanagement/merchantform")
    now = datetime.now()
    fields = {
        "pp_Version": "1.1",
        "pp_TxnType": "MWALLET",
        "pp_Language": "EN",
        "pp_MerchantID": str(settings.get("merchant_id") or ""),
        "pp_Password": str(settings.get("password") or ""),
        "pp_TxnRefNo": "T" + now.strftime("%Y%m%d%H%M%S")
                       + intent_token[:6].upper(),
        "pp_Amount": str(int(round(float(due) * 100))),
        "pp_TxnDateTime": now.strftime("%Y%m%d%H%M%S"),
        "pp_TxnExpiryDateTime": (now + timedelta(hours=1))
        .strftime("%Y%m%d%H%M%S"),
        "pp_BillReference": intent_token[:16],
        "pp_Description": "Order payment",
        "pp_ReturnURL": base_url + "/api/v1/public/payments/callback/"
                        + intent_token,
        "ppmpf_1": intent_token[:20],
    }
    fields["pp_SecureHash"] = jazzcash_hash(settings.get("salt"), fields)
    return url, fields


def _render_form(post_url, fields):
    inputs = "\\n".join(
        '<input type="hidden" name="' + str(k) + '" value="' + str(v)
        .replace("&", "&amp;").replace('"', "&quot;") + '" />'
        for k, v in fields.items())
    return ('<!doctype html><html><head><meta charset="utf-8">'
            "<title>Redirecting to payment...</title></head>"
            '<body onload="document.forms[0].submit()">'
            '<form method="POST" action="' + post_url + '">' + inputs
            + '<noscript><button type="submit">Continue to payment'
            "</button></noscript></form>"
            "<p>Redirecting to payment...</p></body></html>")


def _render_message(title, body):
    return ('<!doctype html><html><head><meta charset="utf-8">'
            "<title>" + title + "</title></head>"
            '<body style="font-family:sans-serif;text-align:center;'
            'padding-top:4rem"><h1>' + title + "</h1><p>" + body
            + "</p></body></html>")


@public_bp.get("/checkout/<token>/payinfo")
def public_payinfo(token: str):
    """Public: can this link be paid online right now (and how much)?"""
    token = str(token or "").strip()[:64]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            portal_checkout._ensure_checkout_tables(conn)
            _ensure_settings_table(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT total, paid_amount, status FROM "
                    + portal_db._q(portal_checkout.LINKS_TABLE) +
                    " WHERE token = %s LIMIT 1",
                    (token,),
                )
                rows = portal_db.rows(cur)
                settings = _load_settings(cur, 0) if not rows else \\
                    _load_settings(cur, rows[0].get("client_id"))
        finally:
            conn.close()
    except Exception as error:
        logger.warning("payment payinfo failed: %s", error)
        return {"error": {"code": "portal_unavailable",
                          "message": "Try again shortly."}}, 503
    if not rows:
        return {"enabled": False, "due": 0}, 200
    due = round(
        float(rows[0].get("total") or 0)
        - float(rows[0].get("paid_amount") or 0), 2)
    open_link = (rows[0].get("status") or "open") == "open"
    return {"enabled": bool(_configured(settings)) and open_link
            and due > 0,
            "due": max(due, 0)}, 200


@public_bp.get("/checkout/<token>/pay")
def public_pay(token: str):
    token = str(token or "").strip()[:64]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            portal_checkout._ensure_checkout_tables(conn)
            _ensure_settings_table(conn)
            _ensure_intents_table(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, client_id, contact_id, title, total,"
                    " paid_amount, status, expires_at FROM "
                    + portal_db._q(portal_checkout.LINKS_TABLE) +
                    " WHERE token = %s LIMIT 1",
                    (token,),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    return _render_message(
                        "Link not found",
                        "This order link is not valid."), 404
                link = rows[0]
                settings = _load_settings(cur, link.get("client_id"))
                if not _configured(settings):
                    return _render_message(
                        "Online payment is off",
                        "Ask the business for payment details."), 400
                due = round(
                    float(link.get("total") or 0)
                    - float(link.get("paid_amount") or 0), 2)
                if (link.get("status") or "open") != "open" or due <= 0:
                    return _render_message(
                        "Nothing to pay",
                        "This order is already settled."), 400
                intent_token = secrets.token_urlsafe(16)
                base_url = request.host_url.rstrip("/")
                if str(settings.get("provider") or "") == "stripe":
                    session = _stripe_create_session(
                        _stripe_secret(), intent_token, due,
                        str(link.get("title") or "Order"), base_url)
                    if "_error" in session or not session.get("url"):
                        conn.rollback()
                        return _render_message(
                            "Payment unavailable",
                            "Stripe rejected the session - check the"
                            " platform keys."), 502
                    cur.execute(
                        "INSERT INTO " + portal_db._q(INTENTS_TABLE) +
                        " (client_id, link_id, token, provider, amount)"
                        " VALUES (%s, %s, %s, %s, %s)",
                        (link.get("client_id"), link.get("id"),
                         intent_token, "stripe", due),
                    )
                    portal_db.log_action(
                        cur, link.get("client_id"), "payment.intent",
                        "system", None, None,
                        ("Stripe intent " + intent_token[:8]
                         + " for " + str(due))[:200],
                    )
                    conn.commit()
                    from flask import redirect
                    return redirect(str(session["url"]), 302)
                post_url, fields = _build_provider_form(
                    settings, intent_token, due, base_url)
                cur.execute(
                    "INSERT INTO " + portal_db._q(INTENTS_TABLE) +
                    " (client_id, link_id, token, provider, amount)"
                    " VALUES (%s, %s, %s, %s, %s)",
                    (link.get("client_id"), link.get("id"), intent_token,
                     str(settings.get("provider") or ""), due),
                )
                portal_db.log_action(
                    cur, link.get("client_id"), "payment.intent", "system",
                    None, None,
                    ("Intent " + intent_token[:8] + " for "
                     + str(due))[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("payment intent failed: %s", error)
        return _render_message(
            "Payment unavailable", "Try again shortly."), 503
    return _render_form(post_url, fields), 200


@public_bp.post("/payments/callback/<intent_token>")
def public_callback(intent_token: str):
    intent_token = str(intent_token or "").strip()[:64]
    form = {k: str(v) for k, v in request.form.items()}
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_intents_table(conn)
            _ensure_settings_table(conn)
            portal_checkout._ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                try:
                    import portal_ratelimit

                    if not portal_ratelimit.allow(
                        cur,
                        "paycb:" + intent_token,
                        portal_ratelimit.checkout_post_limit(),
                        60,
                    ):
                        conn.commit()
                        return jsonify({"error": {
                            "code": "rate_limited",
                            "message": "Too many requests; try again shortly.",
                        }}), 429
                except Exception:
                    pass
                cur.execute(
                    "SELECT id, client_id, link_id, amount, status,"
                    " provider FROM " + portal_db._q(INTENTS_TABLE) +
                    " WHERE token = %s LIMIT 1",
                    (intent_token,),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    return _render_message(
                        "Payment not found",
                        "Unknown payment reference."), 404
                intent = rows[0]
                if intent.get("status") == "paid":
                    return _render_message(
                        "Already paid",
                        "This payment was already recorded."), 200
                settings = _load_settings(cur, intent.get("client_id"))
                if str(intent.get("provider") or "") == "jazzcash":
                    if (str(form.get("pp_RResponseCode") or "")
                            != "000" or not settings
                            or jazzcash_hash(settings.get("salt"), form)
                            != str(form.get("pp_SecureHash") or "")):
                        return _render_message(
                            "Verification failed",
                            "The payment could not be verified."), 400
                    provider_ref = str(form.get("pp_TxnRefNo") or "")
                else:
                    if (str(form.get("responseCode") or "")
                            != "000" or not settings
                            or easypaisa_hash(
                                settings.get("salt"), form)
                            != str(form.get("paymentHash") or "")):
                        return _render_message(
                            "Verification failed",
                            "The payment could not be verified."), 400
                    provider_ref = str(form.get("transactionRefNum") or "")
                cur.execute(
                    "UPDATE " + portal_db._q(INTENTS_TABLE) +
                    " SET status = 'paid', provider_ref = %s,"
                    " updated_at = NOW()"
                    " WHERE id = %s AND status = 'pending' RETURNING id",
                    (provider_ref[:64], intent.get("id")),
                )
                applied = portal_db.rows(cur)
                if applied:
                    amount = round(float(intent.get("amount") or 0), 2)
                    cur.execute(
                        "UPDATE " + portal_db._q(portal_checkout.LINKS_TABLE)
                        + " SET paid_amount = COALESCE(paid_amount, 0) + %s,"
                        " status = CASE WHEN COALESCE(paid_amount, 0) + %s"
                        " >= total THEN 'paid' ELSE status END,"
                        " updated_at = NOW()"
                        " WHERE id = %s AND client_id = %s"
                        " AND status = 'open' RETURNING paid_amount, total",
                        (amount, amount, intent.get("link_id"),
                         intent.get("client_id")),
                    )
                    updated = portal_db.rows(cur)
                    portal_db.log_action(
                        cur, intent.get("client_id"),
                        "payment.gateway_paid", "system", None, None,
                        ("Gateway payment " + str(amount) + " on link "
                         + str(intent.get("link_id"))
                         + (f" (paid "
                            + str(round(float(updated[0].get(
                                "paid_amount") or 0), 2)) + "/"
                            + str(round(float(updated[0].get(
                                "total") or 0), 2)) + ")"
                            if updated else ""))[:200],
                    )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("payment callback failed: %s", error)
        return _render_message(
            "Payment unavailable", "Try again shortly."), 503
    return _render_message(
        "Payment received",
        "Thank you! The business can see your payment now."), 200


_STRIPE_API = "https://api.stripe.com/v1/checkout/sessions"


def _stripe_create_session(secret: str, intent_token: str, amount: float,
                           title: str, base_url: str) -> Dict[str, Any]:
    """Create one Stripe Checkout Session; {'url': ...} or {'_error'}."""
    try:
        import urllib.parse
        import urllib.request
        units = int(round(float(amount) * 100))
        if units <= 0:
            return {"_error": "amount"}
        callback = (base_url + "/api/v1/public/payments/callback/"
                    + urllib.parse.quote(intent_token, safe="")
                    + "?stripe_return=1")
        body = urllib.parse.urlencode({
            "mode": "payment",
            "success_url": callback,
            "cancel_url": base_url,
            "client_reference_id": intent_token,
            "line_items[0][quantity]": "1",
            "line_items[0][price_data][currency]": "pkr",
            "line_items[0][price_data][unit_amount]": str(units),
            "line_items[0][price_data][product_data][name]":
                (title or "Order")[:120],
        }).encode("utf8")
        req = urllib.request.Request(
            _STRIPE_API, data=body, method="POST",
            headers={"Authorization": "Bearer " + secret,
                     "Content-Type": "application/x-www-form-urlencoded"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf8"))
        url = str(data.get("url") or "")
        return {"url": url} if url else {"_error": "no session url"}
    except Exception as error:
        return {"_error": str(error) or "stripe request failed"}


def _stripe_session_status(secret: str, session_id: str) -> Dict[str, Any]:
    """GET one session; dict or {'_error': ...}."""
    try:
        import urllib.parse
        import urllib.request
        req = urllib.request.Request(
            _STRIPE_API + "/" + urllib.parse.quote(session_id, safe=""),
            headers={"Authorization": "Bearer " + secret},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf8"))
    except Exception as error:
        return {"_error": str(error) or "stripe request failed"}


def _mark_stripe_paid(conn, intent_token: str, provider_ref: str):
    """Shared tail of the stripe return: verify -> mark -> update link."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, client_id, link_id, amount, status, provider"
            " FROM " + portal_db._q(INTENTS_TABLE) +
            " WHERE token = %s AND provider = 'stripe' LIMIT 1",
            (intent_token,),
        )
        rows = portal_db.rows(cur)
        if not rows:
            return _render_message(
                "Payment not found", "Unknown payment reference."), 404
        intent = rows[0]
        if intent.get("status") == "paid":
            return _render_message(
                "Already paid", "This payment was already recorded."), 200
        cur.execute(
            "UPDATE " + portal_db._q(INTENTS_TABLE) +
            " SET status = 'paid', provider_ref = %s, updated_at = NOW()"
            " WHERE id = %s AND status = 'pending' RETURNING id",
            (provider_ref[:64], intent.get("id")),
        )
        applied = portal_db.rows(cur)
        if applied:
            amount = round(float(intent.get("amount") or 0), 2)
            cur.execute(
                "UPDATE " + portal_db._q(portal_checkout.LINKS_TABLE)
                + " SET paid_amount = COALESCE(paid_amount, 0) + %s,"
                " status = CASE WHEN COALESCE(paid_amount, 0) + %s"
                " >= total THEN 'paid' ELSE status END,"
                " updated_at = NOW()"
                " WHERE id = %s AND client_id = %s"
                " AND status = 'open' RETURNING paid_amount, total",
                (amount, amount, intent.get("link_id"),
                 intent.get("client_id")),
            )
            portal_db.log_action(
                cur, intent.get("client_id"), "payment.gateway_paid",
                "system", None, None,
                ("Stripe payment " + str(amount) + " on link "
                 + str(intent.get("link_id")))[:200],
            )
        conn.commit()
    return _render_message(
        "Payment received",
        "Thank you! The business can see your payment now."), 200


@public_bp.get("/payments/callback/<intent_token>")
def public_stripe_return(intent_token: str):
    """Stripe success_url lands here (GET) - verify then mark paid."""
    intent_token = str(intent_token or "").strip()[:64]
    session_id = str(request.args.get("session_id") or "").strip()[:200]
    secret = _stripe_secret()
    if not secret:
        return _render_message(
            "Payment unavailable", "Stripe is not configured."), 503
    status = (_stripe_session_status(secret, session_id)
              if session_id else {"_error": "missing session_id"})
    if status.get("payment_status") != "paid":
        return _render_message(
            "Payment not completed",
            "The payment did not go through - you can try again."), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_intents_table(conn)
            portal_checkout._ensure_checkout_tables(conn)
            return _mark_stripe_paid(
                conn, intent_token,
                str(status.get("payment_intent")
                    or status.get("id") or "stripe"))
        finally:
            conn.close()
    except Exception as error:
        logger.warning("stripe return failed: %s", error)
        return _render_message(
            "Payment unavailable", "Try again shortly."), 503
`);
writeNewRepair("OmniFlow-Control-Plane/portal_checkout.py", "def phone_verification_on(", true,
    `"""Smart checkout v0: shareable order-summary links the merchant can send to
a customer. Tokenized public view (no auth), server-computed totals,
merchant-marked statuses. No payments provider — the link closes the loop
over chat."""

import csv
import io
import json
import logging
import datetime
import secrets
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request, Response

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db
import portal_growth

bp = Blueprint("portal_checkout", __name__, url_prefix="/api/v1/portal")
public_bp = Blueprint("portal_checkout_public", __name__,
                      url_prefix="/api/v1/public")


@public_bp.get("/checkout/<token>")
def public_checkout_route(token: str):
    payload, status = public_checkout(token)
    if status == 200 and isinstance(payload, dict):
        payload["phone_verification"] = phone_verification_on()
    return jsonify(payload), status

logger = logging.getLogger(__name__)

LINKS_TABLE = "portal_checkout_links"

STATUSES = ("open", "paid", "cancelled", "shipped", "delivered", "returned")
SETTINGS_TABLE = "portal_checkout_settings"
RETURN_REASONS = ("size", "fit", "damaged", "late", "changed_mind", "other")
RETURNS_TABLE = "portal_return_requests"
_RETURNS_DDL_READY = False
NOTIFY_STATUSES = ("paid", "shipped", "delivered", "returned")
DEFAULT_TEMPLATES = {
    "paid": "Payment received for '{title}'. Thank you! Your order is"
            " being prepared.",
    "shipped": "Good news - your order '{title}' has been shipped and is on"
               " its way.",
    "delivered": "Your order '{title}' has been delivered. Thank you for"
                 " shopping with us!",
    "returned": "Your return for '{title}' has been registered. Our team"
                " will contact you shortly about the refund.",
}
_SETTINGS_DDL_READY = False
CART_TABLE = "portal_cart_reminders"
_CART_DDL_READY = False
CART_SEND_CAP = 5
CART_GAP_DEFAULTS = {1: 2, 2: 24, 3: 48}
DEFAULT_CART_TEMPLATES = {
    1: "Assalam o alaikum! You left '{title}' ({total}) in your cart."
       " Complete your order before it runs out of stock.",
    2: "Still thinking about '{title}'? It is reserved for you - reply"
       " here and we will confirm your order right away.",
    3: "Last reminder: your cart '{title}' ({total}) expires soon. Pay"
       " via the checkout link or reply here to place your order.",
}
MAX_ITEMS = 20
MAX_QTY = 99
MAX_TITLE = 120
MONEY_ROLES = ("owner", "admin")
OTP_TABLE = "portal_checkout_otps"
OTP_TTL_MINUTES = 10
OTP_MAX_SENDS = 3
OTP_MAX_ATTEMPTS = 5
_OTP_DDL_READY = False


def _ensure_otp_table(conn) -> None:
    """portal_checkout_otps lands lazily (phone verification at pay)."""
    global _OTP_DDL_READY
    if _OTP_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(OTP_TABLE) + " ("
            " token TEXT PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " contact_id TEXT NOT NULL,"
            " code_hash TEXT NOT NULL,"
            " attempts INT NOT NULL DEFAULT 0,"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"
            ")"
        )
    _OTP_DDL_READY = True


def _otp_hash(token: str, code: str) -> str:
    import hashlib
    return hashlib.sha256((token + ":" + code).encode("utf8")).hexdigest()


def phone_verification_on() -> bool:
    """The platform switch (admin panel), fail-soft off."""
    try:
        import platform_settings
        return platform_settings.flag("phone_verification")
    except Exception:
        return False


def ensure_money_principal(principal: Dict[str, Any],
                           message: Optional[str] = None) -> Optional[Any]:
    """Money guard: only owners/admins may record advances or discounts.
    Agents (and anything else) get a 403 - the server is the boundary."""
    if str(principal.get("role") or "") not in MONEY_ROLES:
        return jsonify({"error": {"code": "forbidden",
                                  "message": message or "Only owners can"
                                                        " record advances"
                                                        " or discounts."}}), 403
    return None

_CHECKOUT_DDL_READY = False


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


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    try:
        return value.isoformat()
    except AttributeError:
        return None


def _ensure_checkout_tables(conn) -> None:
    global _CHECKOUT_DDL_READY
    if _CHECKOUT_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(LINKS_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " contact_id TEXT NOT NULL,"
            " token TEXT NOT NULL UNIQUE,"
            " title TEXT NOT NULL DEFAULT '',"
            " items JSONB NOT NULL DEFAULT '[]'::jsonb,"
            " total NUMERIC(12,2) NOT NULL DEFAULT 0,"
            " status TEXT NOT NULL DEFAULT 'open',"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS portal_checkout_links_client_idx ON "
            + portal_db._q(LINKS_TABLE) + " (client_id, id DESC)"
        )
        cur.execute(
            "ALTER TABLE " + portal_db._q(LINKS_TABLE) +
            " ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,"
            " ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0,"
            " ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(12,2)"
            " NOT NULL DEFAULT 0,"
            " ADD COLUMN IF NOT EXISTS discount NUMERIC(12,2)"
            " NOT NULL DEFAULT 0,"
            " ADD COLUMN IF NOT EXISTS courier TEXT NOT NULL DEFAULT '',"
            " ADD COLUMN IF NOT EXISTS tracking_number"
            " TEXT NOT NULL DEFAULT '',"
            " ADD COLUMN IF NOT EXISTS advance_percent"
            " INTEGER NOT NULL DEFAULT 0,"
            " ADD COLUMN IF NOT EXISTS brand_id BIGINT"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS portal_checkout_brand_idx ON "
            + portal_db._q(LINKS_TABLE) + " (client_id, brand_id)"
        )
    conn.commit()
    _CHECKOUT_DDL_READY = True


def _ensure_settings_table(conn) -> None:
    global _SETTINGS_DDL_READY
    if _SETTINGS_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(SETTINGS_TABLE) +
            " (client_id BIGINT PRIMARY KEY,"
            " notify_enabled BOOLEAN NOT NULL DEFAULT TRUE,"
            " tpl_paid TEXT NOT NULL DEFAULT '',"
            " tpl_shipped TEXT NOT NULL DEFAULT '',"
            " tpl_delivered TEXT NOT NULL DEFAULT '',"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        for column in (
            "cart_enabled BOOLEAN NOT NULL DEFAULT FALSE",
            "cart_gap_1 INTEGER NOT NULL DEFAULT 2",
            "cart_gap_2 INTEGER NOT NULL DEFAULT 24",
            "cart_gap_3 INTEGER NOT NULL DEFAULT 48",
            "cart_tpl_1 TEXT NOT NULL DEFAULT ''",
            "cart_tpl_2 TEXT NOT NULL DEFAULT ''",
            "cart_tpl_3 TEXT NOT NULL DEFAULT ''",
            "tpl_returned TEXT NOT NULL DEFAULT ''",
        ):
            cur.execute(
                "ALTER TABLE " + portal_db._q(SETTINGS_TABLE) +
                " ADD COLUMN IF NOT EXISTS " + column
            )
    conn.commit()
    _SETTINGS_DDL_READY = True


def _load_settings(cur, client_id):
    """Notify settings for the client. Absent row or unreadable table ->
    defaults (enabled, blank templates)."""
    try:
        cur.execute(
            "SELECT notify_enabled, tpl_paid, tpl_shipped, tpl_delivered,"
            " tpl_returned FROM " + portal_db._q(SETTINGS_TABLE) +
            " WHERE client_id = %s",
            (client_id,),
        )
        rows = portal_db.rows(cur)
    except Exception:
        rows = []
    row = rows[0] if rows else {}
    settings = {"notify_enabled": bool(row.get("notify_enabled", True))}
    for key in ("paid", "shipped", "delivered", "returned"):
        settings["tpl_" + key] = str(row.get("tpl_" + key) or "").strip()[:500]
    return settings


def _contact_name(cur, client_id, contact_id):
    """Best-effort display name from the newest conversation with this
    contact; any failure -> empty string (never blocks the update)."""
    try:
        cur.execute(
            "SELECT contact_name FROM " + portal_db._q(portal_db.CONV_TABLE) +
            " WHERE client_id = %s AND contact_id = %s"
            " ORDER BY id DESC LIMIT 1",
            (client_id, contact_id),
        )
        rows = portal_db.rows(cur)
    except Exception:
        return ""
    if not rows:
        return ""
    return str(rows[0].get("contact_name") or "").strip()


def _money(value) -> str:
    """Compact rupee amount: 250.0 -> "250", 99.55 -> "99.55"."""
    try:
        text = str(round(float(value), 2))
    except (TypeError, ValueError):
        return "0"
    if text.endswith(".0"):
        text = text[:-2]
    return text


def _render_body(settings, status, contact_name, title, total, row=None):
    """Fill {name}/{title}/{total}; blank custom template -> default.

    When the link still carries an outstanding balance (advance-COD), the
    paid/shipped/delivered confirmation appends the amount due on delivery
    so the customer is never surprised by the collection."""
    template = str(settings.get("tpl_" + str(status)) or "").strip()
    if not template:
        template = DEFAULT_TEMPLATES.get(str(status), "")
    clean_name = str(contact_name or "").strip()
    first_name = clean_name.split(" ")[0] if clean_name else ""
    body = (template
            .replace("{name}", first_name)
            .replace("{title}", str(title or ""))
            .replace("{total}", str(total if total is not None else "")))
    if row is not None and str(status) in ("paid", "shipped", "delivered"):
        try:
            row_total = round(float(row.get("total") or 0), 2)
            paid = round(float(row.get("paid_amount") or 0), 2)
        except (TypeError, ValueError):
            row_total = paid = 0.0
        balance = max(round(row_total - paid, 2), 0.0)
        if balance > 0:
            body = (body + " Rs " + _money(balance)
                    + " will be collected on delivery.")
    return body[:1000]


def _ensure_cart_table(conn) -> None:
    global _CART_DDL_READY
    if _CART_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(CART_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " link_id BIGINT NOT NULL,"
            " step INTEGER NOT NULL,"
            " sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " UNIQUE (client_id, link_id, step))"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS portal_cart_reminders_client_idx ON "
            + portal_db._q(CART_TABLE) + " (client_id, link_id, step)"
        )
    conn.commit()
    _CART_DDL_READY = True


def _load_cart_settings(cur, client_id):
    """Cart recovery settings. Absent row or unreadable table -> defaults
    (recovery OFF until the merchant turns it on)."""
    try:
        cur.execute(
            "SELECT cart_enabled, cart_gap_1, cart_gap_2, cart_gap_3,"
            " cart_tpl_1, cart_tpl_2, cart_tpl_3 FROM "
            + portal_db._q(SETTINGS_TABLE) + " WHERE client_id = %s",
            (client_id,),
        )
        rows = portal_db.rows(cur)
    except Exception:
        rows = []
    row = rows[0] if rows else {}

    def _gap(key):
        try:
            value = int(row.get(key))
        except (TypeError, ValueError):
            return None
        return value if 1 <= value <= 168 else None

    settings = {
        "cart_enabled": bool(row.get("cart_enabled", False)) if rows else False,
        "cart_gap_1": _gap("cart_gap_1") or CART_GAP_DEFAULTS[1],
        "cart_gap_2": _gap("cart_gap_2") or CART_GAP_DEFAULTS[2],
        "cart_gap_3": _gap("cart_gap_3") or CART_GAP_DEFAULTS[3],
    }
    for key in ("cart_tpl_1", "cart_tpl_2", "cart_tpl_3"):
        settings[key] = str(row.get(key) or "").strip()[:500]
    return settings


def _render_cart_body(settings, step, title, total, name=""):
    """Fill {name}/{title}/{total}; blank custom template -> default."""
    template = str(settings.get("cart_tpl_" + str(step)) or "").strip()
    if not template:
        template = DEFAULT_CART_TEMPLATES.get(int(step), "")
    clean_name = str(name or "").strip()
    first_name = clean_name.split(" ")[0] if clean_name else ""
    return (template
            .replace("{name}", first_name)
            .replace("{title}", str(title or ""))
            .replace("{total}", str(total if total is not None else "")))[:1000]


def materialize_cart_reminders(cur, client_id, conn) -> int:
    """Time-based cart recovery: up to 3 WhatsApp reminders per open
    checkout link, riding the connector tick (like scheduled broadcasts).
    Returns the number of reminders queued. Never raises for missing
    tables - recovery silently stays off on fresh workspaces."""
    settings = _load_cart_settings(cur, client_id)
    if not settings["cart_enabled"]:
        return 0
    _ensure_cart_table(conn)
    sent = 0
    for step in (1, 2, 3):
        if sent >= CART_SEND_CAP:
            break
        gap = settings["cart_gap_" + str(step)]
        cur.execute(
            "SELECT l.id, l.contact_id, l.title, l.total"
            " FROM " + portal_db._q(LINKS_TABLE) + " l"
            " WHERE l.client_id = %s AND l.status = 'open'"
            " AND l.created_at <= NOW() - (%s || ' hours')::interval"
            " AND NOT EXISTS (SELECT 1 FROM " + portal_db._q(CART_TABLE) +
            " r WHERE r.client_id = l.client_id AND r.link_id = l.id"
            " AND r.step = %s)"
            " ORDER BY l.id ASC LIMIT %s",
            (client_id, str(gap), step, CART_SEND_CAP - sent),
        )
        due_rows = portal_db.rows(cur)
        for row in due_rows:
            if sent >= CART_SEND_CAP:
                break
            contact_id = str(row.get("contact_id") or "").strip()
            if not contact_id:
                continue
            name = _contact_name(cur, client_id, contact_id)
            body = _render_cart_body(
                settings, step, row.get("title"), row.get("total"), name)
            portal_growth._send_command(
                cur, client_id, contact_id, name, body, "cart_recovery",
            )
            cur.execute(
                "INSERT INTO " + portal_db._q(CART_TABLE) +
                " (client_id, link_id, step) VALUES (%s, %s, %s)"
                " ON CONFLICT (client_id, link_id, step) DO NOTHING",
                (client_id, int(row.get("id") or 0), step),
            )
            portal_db.log_action(
                cur,
                client_id,
                "cart.recovery_step_" + str(step),
                "system",
                None,
                None,
                ("Cart reminder " + str(step) + " queued")[:200],
            )
            sent += 1
    if sent:
        conn.commit()
    return sent


def _ensure_returns_table(conn) -> None:
    global _RETURNS_DDL_READY
    if _RETURNS_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(RETURNS_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " link_id BIGINT NOT NULL,"
            " contact_id TEXT NOT NULL,"
            " reason TEXT NOT NULL DEFAULT 'other',"
            " note TEXT NOT NULL DEFAULT '',"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " UNIQUE (client_id, link_id))"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS portal_return_requests_client_idx ON "
            + portal_db._q(RETURNS_TABLE) + " (client_id, id DESC)"
        )
    conn.commit()
    _RETURNS_DDL_READY = True


def _normalize_items(raw: Any) -> Tuple[Optional[List[Dict[str, Any]]], Optional[str]]:
    """Returns (items, error)."""
    if not isinstance(raw, list) or not raw:
        return None, "items (non-empty list) is required."
    if len(raw) > MAX_ITEMS:
        return None, "Max " + str(MAX_ITEMS) + " items per link."
    items: List[Dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            return None, "Each item must be an object."
        name = str(entry.get("name") or "").strip()[:100]
        qty = entry.get("qty", 1)
        price = entry.get("price")
        if not name:
            return None, "Every item needs a name."
        if isinstance(qty, bool) or not isinstance(qty, int) or not (
                1 <= qty <= MAX_QTY):
            return None, "qty must be 1-" + str(MAX_QTY) + "."
        if isinstance(price, bool) or not isinstance(price, (int, float)) or price < 0:
            return None, "price must be 0 or more."
        items.append({"name": name, "qty": qty, "price": round(float(price), 2)})
    return items, None


def _advance_due(row: Dict[str, Any]) -> float:
    """Amount the customer pays now when the link carries an advance."""
    try:
        percent = int(row.get("advance_percent") or 0)
    except (TypeError, ValueError):
        percent = 0
    if percent <= 0:
        return 0.0
    total = round(float(row.get("total") or 0)
                  - float(row.get("paid_amount") or 0), 2)
    return max(round(total * percent / 100.0, 2), 0.0)


def _cod_balance(row: Dict[str, Any]) -> float:
    """Rest that stays collectable on delivery."""
    try:
        percent = int(row.get("advance_percent") or 0)
    except (TypeError, ValueError):
        percent = 0
    if percent <= 0:
        return 0.0
    total = round(float(row.get("total") or 0)
                  - float(row.get("paid_amount") or 0), 2)
    return max(round(total - _advance_due(row), 2), 0.0)


def _public(row: Dict[str, Any]) -> Dict[str, Any]:
    items = row.get("items")
    if not isinstance(items, list):
        items = []
    return {
        "id": int(row.get("id") or 0),
        "token": str(row.get("token") or ""),
        "contact_id": row.get("contact_id"),
        "title": str(row.get("title") or ""),
        "items": [
            {
                "name": str(item.get("name") or ""),
                "qty": int(item.get("qty") or 1),
                "price": float(item.get("price") or 0),
            }
            for item in items if isinstance(item, dict)
        ],
        "total": float(row.get("total") or 0),
        "status": row.get("status") or "open",
        "created_at": _iso(row.get("created_at")),
        "expires_at": _iso(row.get("expires_at")),
        "view_count": int(row.get("view_count") or 0),
        "discount": round(float(row.get("discount") or 0), 2),
        "coupon_code": str(row.get("coupon_code") or ""),
        "coupon_discount": round(float(row.get("coupon_discount") or 0), 2),
        "courier": str(row.get("courier") or ""),
        "tracking_number": str(row.get("tracking_number") or ""),
        "paid_amount": round(float(row.get("paid_amount") or 0), 2),
        "advance_percent": int(row.get("advance_percent") or 0),
        "brand_id": (int(row["brand_id"]) if row.get("brand_id") else None),
        "brand_name": (str(row["brand_name"])
                       if row.get("brand_name") else None),
        "advance_due": _advance_due(row),
        "cod_balance": _cod_balance(row),
        "due": max(
            round(float(row.get("total") or 0)
                  - float(row.get("paid_amount") or 0), 2),
            0.0,
        ),
    }


@bp.post("/checkout/links")
def create_checkout_link():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    contact = str(payload.get("contact_id") or "").strip()[:100]
    title = str(payload.get("title") or "").strip()[:MAX_TITLE]
    items, err = _normalize_items(payload.get("items"))
    if err:
        return jsonify({"error": {"code": "bad_request",
                                  "message": err}}), 400
    if not contact:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contact_id is required."}}), 400
    subtotal = round(sum(item["qty"] * item["price"] for item in items), 2)
    discount_amount = payload.get("discount_amount")
    if discount_amount is not None:
        try:
            discount_amount = round(float(discount_amount), 2)
        except (TypeError, ValueError):
            discount_amount = -1
        if not 0 <= discount_amount <= 100000:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Discount must be between"
                                                 " 0 and 100000."}}), 400
    else:
        discount_amount = 0
    if discount_amount and discount_amount > 0:
        forbidden = ensure_money_principal(principal)
        if forbidden is not None:
            return forbidden
    advance_percent = payload.get("advance_percent")
    if advance_percent is not None:
        try:
            advance_percent = int(advance_percent)
        except (TypeError, ValueError):
            advance_percent = -1
        if not 0 <= advance_percent <= 90:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Advance percent must be"
                                                 " between 0 and 90."}}), 400
    else:
        advance_percent = 0
    total = max(round(subtotal - discount_amount, 2), 0)
    expires_days = payload.get("expires_in_days")
    if expires_days is not None:
        try:
            expires_days = int(expires_days)
        except (TypeError, ValueError):
            expires_days = -1
        if not 1 <= expires_days <= 60:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Expiry must be between"
                                                 " 1 and 60 days."}}), 400
    else:
        expires_days = None
    token = secrets.token_urlsafe(16)
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                import portal_brands

                brand_id = portal_brands.resolve_brand(
                    cur, principal["client_id"],
                    payload.get("brand_id"))
                cur.execute(
                    "INSERT INTO " + portal_db._q(LINKS_TABLE) +
                    " (client_id, contact_id, token, title, items, total,"
                    " discount, expires_at, advance_percent, brand_id)"
                    " VALUES (%s, %s, %s, %s, CAST(%s AS JSONB), %s, %s,"
                    " CASE WHEN %s IS NULL THEN NULL"
                    " ELSE NOW() + (%s * INTERVAL '1 day') END, %s, %s)"
                    " RETURNING id, token, contact_id, title, items, total,"
                    " status, created_at, expires_at, view_count, discount,"
                    " paid_amount, advance_percent, brand_id",
                    (principal["client_id"], contact, token, title,
                     json.dumps(items), total, discount_amount,
                     expires_days, expires_days, advance_percent, brand_id),
                )
                created = portal_db.rows(cur)
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "checkout.created",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Checkout link " + token[:8] + " (" + str(total)
                     + (", advance " + str(advance_percent) + "%"
                        if advance_percent else "") + ")")[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout create failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "checkout create")[0]), 503
    return jsonify({"ok": True, "link": _public(created[0] if created else {})}), 200


@bp.get("/checkout/links")
def list_checkout_links():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                brand_filter = request.args.get("brand_id")
                brand_join = ""
                brand_where = ""
                list_args = [principal["client_id"]]
                if brand_filter not in (None, "", "all"):
                    brand_where = " AND " + portal_db._q(LINKS_TABLE) \\
                        + ".brand_id = %s"
                    list_args.append(int(brand_filter))
                if brand_filter is None:
                    brand_join = (" LEFT JOIN portal_brands ON"
                                  " portal_brands.id = "
                                  + portal_db._q(LINKS_TABLE) + ".brand_id")
                cur.execute(
                    "SELECT " + portal_db._q(LINKS_TABLE) +
                    ".id, token, contact_id, title, items, total,"
                    " status, created_at, expires_at, view_count, discount,"
                    " courier, tracking_number, coupon_code,"
                    " coupon_discount, paid_amount, advance_percent,"
                    + portal_db._q(LINKS_TABLE) +
                    ".brand_id, portal_brands.name AS brand_name"
                    " FROM " + portal_db._q(LINKS_TABLE) + brand_join +
                    " WHERE " + portal_db._q(LINKS_TABLE) +
                    ".client_id = %s" + brand_where +
                    " ORDER BY " + portal_db._q(LINKS_TABLE) +
                    ".id DESC LIMIT 30",
                    tuple(list_args),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout list failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "checkout list")[0]), 503
    return jsonify({"links": [_public(row) for row in rows]}), 200


@bp.patch("/checkout/links/<int:link_id>")
def update_checkout_link(link_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    status = payload.get("status")
    if status not in STATUSES:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Pick open, paid, cancelled,"
                                             " shipped, delivered or"
                                             " returned."}}), 400
    return_reason = str(payload.get("reason") or "").strip()
    return_note = str(payload.get("note") or "").strip()[:300]
    if status == "returned" and return_reason not in RETURN_REASONS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Pick a return reason"
                                             " (size, fit, damaged, late,"
                                             " changed_mind or"
                                             " other)."}}), 400
    if status == "paid":
        forbidden = ensure_money_principal(
            principal, "Only owners can mark links paid.")
        if forbidden is not None:
            return forbidden
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(LINKS_TABLE) +
                    " SET status = %s, updated_at = NOW()"
                    " WHERE id = %s AND client_id = %s"
                    " RETURNING token, contact_id, title, total,"
                    " paid_amount, advance_percent",
                    (status, link_id, principal["client_id"]),
                )
                updated = portal_db.rows(cur)
                if not updated:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Link not"
                                                         " found."}}), 404
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "checkout." + str(status),
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Checkout " + str(updated[0].get("token"))[:8]
                     + " -> " + str(status))[:200],
                )
                if status == "returned":
                    try:
                        _ensure_returns_table(conn)
                        cur.execute(
                            "INSERT INTO " + portal_db._q(RETURNS_TABLE) +
                            " (client_id, link_id, contact_id, reason, note)"
                            " VALUES (%s, %s, %s, %s, %s)"
                            " ON CONFLICT (client_id, link_id) DO UPDATE"
                            " SET reason = EXCLUDED.reason,"
                            " note = EXCLUDED.note, created_at = NOW()",
                            (principal["client_id"], link_id,
                             updated[0].get("contact_id"), return_reason,
                             return_note),
                        )
                    except Exception as return_error:
                        logger.warning(
                            "return record failed: %s", return_error)
                notified = False
                if status in NOTIFY_STATUSES:
                    try:
                        settings = _load_settings(cur, principal["client_id"])
                        if settings["notify_enabled"]:
                            name = _contact_name(
                                cur, principal["client_id"],
                                updated[0].get("contact_id"))
                            body = _render_body(
                                settings, str(status), name,
                                updated[0].get("title"),
                                updated[0].get("total"),
                                updated[0])
                            portal_growth._send_command(
                                cur, principal["client_id"],
                                updated[0].get("contact_id"), name, body,
                                "checkout_update",
                            )
                            portal_db.log_action(
                                cur,
                                principal["client_id"],
                                "checkout.notified",
                                "customer_user",
                                principal.get("user_id"),
                                None,
                                ("Order update queued: "
                                 + str(status))[:200],
                            )
                            notified = True
                    except Exception as notify_error:
                        logger.warning(
                            "checkout notify failed: %s", notify_error)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout update failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "checkout update")[0]), 503
    return jsonify({"ok": True, "status": status,
                    "notified": bool(notified)}), 200


@bp.patch("/checkout/links/<int:link_id>/edit")
def edit_checkout_link(link_id: int):
    """Edit title/items of an OPEN checkout link (totals recomputed).
    Paid/shipped/delivered/cancelled links are history - never editable."""
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    title = str(payload.get("title") or "").strip()[:MAX_TITLE]
    items, err = _normalize_items(payload.get("items"))
    if err:
        return jsonify({"error": {"code": "bad_request",
                                  "message": err}}), 400
    if not items:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "At least one item is"
                                             " required."}}), 400
    subtotal = round(sum(item["qty"] * item["price"] for item in items), 2)
    discount_amount = payload.get("discount_amount")
    if discount_amount is not None:
        try:
            discount_amount = round(float(discount_amount), 2)
        except (TypeError, ValueError):
            discount_amount = -1
        if not 0 <= discount_amount <= 100000:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Discount must be between"
                                                 " 0 and 100000."}}), 400
    else:
        discount_amount = 0
    if discount_amount and discount_amount > 0:
        forbidden = ensure_money_principal(principal)
        if forbidden is not None:
            return forbidden
    total = max(round(subtotal - discount_amount, 2), 0)
    expires_days = payload.get("expires_in_days")
    if expires_days is not None:
        try:
            expires_days = int(expires_days)
        except (TypeError, ValueError):
            expires_days = -1
        if not 0 <= expires_days <= 60:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Expiry must be 0 (never)"
                                                 " or 1-60 days."}}), 400
    else:
        expires_days = None
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                set_sql = (
                    "UPDATE " + portal_db._q(LINKS_TABLE) +
                    " SET title = %s, items = CAST(%s AS JSONB),"
                    " total = %s, discount = %s, updated_at = NOW()"
                )
                params = [title, json.dumps(items), total, discount_amount]
                if expires_days is not None:
                    if expires_days == 0:
                        set_sql += ", expires_at = NULL"
                    else:
                        set_sql += (", expires_at = NOW() +"
                                    " (%s * INTERVAL '1 day')")
                        params.append(expires_days)
                set_sql += (" WHERE id = %s AND client_id = %s"
                            " AND status = 'open' RETURNING id")
                params.extend([link_id, principal["client_id"]])
                cur.execute(set_sql, tuple(params))
                updated = portal_db.rows(cur)
                if not updated:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Only open links"
                                                         " can be"
                                                         " edited."}}), 404
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "checkout.edited",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Checkout link " + str(link_id) + " edited ("
                     + str(total) + ")")[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout edit failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "checkout edit")[0]), 503
    return jsonify({"ok": True, "total": total}), 200


@bp.post("/checkout/links/<int:link_id>/duplicate")
def duplicate_checkout_link(link_id: int):
    """Duplicate any checkout link into a NEW open link (re-orders)."""
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT contact_id, title, items, total, discount FROM "
                    + portal_db._q(LINKS_TABLE) +
                    " WHERE id = %s AND client_id = %s",
                    (link_id, principal["client_id"]),
                )
                found = portal_db.rows(cur)
                if not found:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Link not"
                                                         " found."}}), 404
                source = found[0]
                token = secrets.token_urlsafe(16)
                cur.execute(
                    "INSERT INTO " + portal_db._q(LINKS_TABLE) +
                    " (client_id, contact_id, token, title, items, total,"
                    " discount)"
                    " VALUES (%s, %s, %s, %s, %s, %s, %s)"
                    " RETURNING id, token, contact_id, title, items, total,"
                    " status, created_at",
                    (principal["client_id"], source.get("contact_id"),
                     token, source.get("title"), source.get("items"),
                     source.get("total"), source.get("discount")),
                )
                created = portal_db.rows(cur)
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "checkout.duplicated",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Checkout link " + str(link_id) + " duplicated -> "
                     + str((created[0] or {}).get("token"))[:8])[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout duplicate failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "checkout duplicate")[0]), 503
    return jsonify({"ok": True,
                    "link": _public(created[0] if created else {})}), 200


@bp.post("/checkout/links/<int:link_id>/advance")
def add_checkout_advance(link_id: int):
    """Record an advance (partial payment) on an OPEN checkout link.
    The link flips to paid once the advance covers the total."""
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    forbidden = ensure_money_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    try:
        amount = round(float(payload.get("amount")), 2)
    except (TypeError, ValueError):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Enter a valid amount."}}), 400
    if amount <= 0:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Enter an amount greater"
                                             " than zero."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(LINKS_TABLE) +
                    " SET paid_amount = COALESCE(paid_amount, 0) + %s,"
                    " status = CASE WHEN COALESCE(paid_amount, 0) + %s"
                    " >= total THEN 'paid' ELSE status END,"
                    " updated_at = NOW()"
                    " WHERE id = %s AND client_id = %s AND status = 'open'"
                    " RETURNING paid_amount, total, status, contact_id,"
                    " title",
                    (amount, amount, link_id, principal["client_id"]),
                )
                updated = portal_db.rows(cur)
                if not updated:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Only open links"
                                                         " can take an"
                                                         " advance."}}), 404
                new_paid = round(float(updated[0].get("paid_amount") or 0), 2)
                new_total = round(float(updated[0].get("total") or 0), 2)
                if new_paid >= new_total and updated[0].get("contact_id"):
                    try:
                        import portal_memory

                        portal_memory.note_purchase(
                            cur, principal["client_id"],
                            str(updated[0].get("contact_id")),
                        )
                    except Exception:
                        pass
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "checkout.advance",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Advance " + str(amount) + " on link "
                     + str(link_id) + " (paid " + str(new_paid) + "/"
                     + str(new_total) + ")"
                     + (" FULLY PAID"
                        if new_paid >= new_total else ""))[:200],
                )
                if updated[0].get("contact_id"):
                    try:
                        settings = _load_settings(
                            cur, principal["client_id"])
                        if settings["notify_enabled"]:
                            name = _contact_name(
                                cur, principal["client_id"],
                                updated[0].get("contact_id"))
                            if new_paid >= new_total:
                                body = _render_body(
                                    settings, "paid", name,
                                    updated[0].get("title"), new_total)
                            else:
                                due_now = max(
                                    round(new_total - new_paid, 2), 0.0)
                                body = ("Rs " + _money(amount)
                                        + " received for '"
                                        + str(updated[0].get("title") or "")
                                        + "'. Rs " + _money(due_now)
                                        + " will be collected on"
                                          " delivery.")
                            portal_growth._send_command(
                                cur, principal["client_id"],
                                updated[0].get("contact_id"), name, body,
                                "checkout_advance",
                            )
                            portal_db.log_action(
                                cur,
                                principal["client_id"],
                                "checkout.notified",
                                "customer_user",
                                principal.get("user_id"),
                                None,
                                ("Advance confirmation queued (paid "
                                 + str(new_paid) + "/" + str(new_total)
                                 + ").")[:200],
                            )
                    except Exception as notify_error:
                        logger.warning(
                            "advance notify failed: %s", notify_error)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout advance failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "checkout advance")[0]), 503
    new_status = updated[0].get("status") or "open"
    return jsonify({"ok": True, "paid_amount": new_paid,
                    "due": max(round(new_total - new_paid, 2), 0.0),
                    "status": new_status}), 200


@bp.post("/checkout/links/<int:link_id>/share")
def share_checkout_link(link_id: int):
    """Send the checkout link to the customer on WhatsApp (connector queue).
    The message is composed by the dashboard (it owns the public URL)."""
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    message = str(payload.get("message") or "").strip()[:1000]
    if not message:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Write a short message first."
                                  }}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, contact_id, title, status FROM "
                    + portal_db._q(LINKS_TABLE) +
                    " WHERE id = %s AND client_id = %s LIMIT 1",
                    (link_id, principal["client_id"]),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Link not"
                                                         " found."}}), 404
                contact_id = str(rows[0].get("contact_id") or "").strip()
                if not contact_id:
                    return jsonify({"error": {"code": "bad_request",
                                              "message": "This link has no"
                                                         " customer"
                                                         " contact."}}), 400
                name = _contact_name(cur, principal["client_id"],
                                     contact_id)
                portal_growth._send_command(
                    cur, principal["client_id"], contact_id, name,
                    message, "checkout_share",
                )
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "checkout.shared",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Checkout link " + str(link_id) + " sent to "
                     + contact_id[-4:])[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout share failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "checkout share")[0]), 503
    return jsonify({"ok": True}), 200


@bp.patch("/checkout/links/<int:link_id>/tracking")
def set_checkout_tracking(link_id: int):
    """Record courier + tracking number on a checkout link (COD trips)."""
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    courier = str(payload.get("courier") or "").strip()[:40]
    tracking_number = str(payload.get("tracking_number") or "").strip()[:60]
    if not tracking_number:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Enter the tracking"
                                             " number."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(LINKS_TABLE) +
                    " SET courier = %s, tracking_number = %s,"
                    " updated_at = NOW()"
                    " WHERE id = %s AND client_id = %s RETURNING id",
                    (courier, tracking_number, link_id,
                     principal["client_id"]),
                )
                updated = portal_db.rows(cur)
                if not updated:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Link not"
                                                         " found."}}), 404
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "checkout.tracking",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Tracking " + tracking_number[:20] + " via "
                     + (courier or "courier"))[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout tracking failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "checkout tracking")[0]), 503
    return jsonify({"ok": True}), 200


@bp.get("/checkout/settings")
def get_checkout_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_settings_table(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT notify_enabled, tpl_paid, tpl_shipped,"
                    " tpl_delivered, tpl_returned, cart_enabled,"
                    " cart_gap_1, cart_gap_2, cart_gap_3, cart_tpl_1,"
                    " cart_tpl_2, cart_tpl_3 FROM "
                    + portal_db._q(SETTINGS_TABLE) +
                    " WHERE client_id = %s",
                    (principal["client_id"],),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout settings read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "checkout settings")[0]), 503
    row = rows[0] if rows else {}

    def _gap_out(key):
        try:
            value = int(row.get(key))
        except (TypeError, ValueError):
            return None
        return value if 1 <= value <= 168 else None

    cart = {
        "enabled": bool(row.get("cart_enabled", False)),
        "gap_1": _gap_out("cart_gap_1") or CART_GAP_DEFAULTS[1],
        "gap_2": _gap_out("cart_gap_2") or CART_GAP_DEFAULTS[2],
        "gap_3": _gap_out("cart_gap_3") or CART_GAP_DEFAULTS[3],
        "tpl_1": str(row.get("cart_tpl_1") or "").strip()[:500],
        "tpl_2": str(row.get("cart_tpl_2") or "").strip()[:500],
        "tpl_3": str(row.get("cart_tpl_3") or "").strip()[:500],
    }
    return jsonify({
        "ok": True,
        "settings": {
            "notify_enabled": bool(row.get("notify_enabled", True))
                              if rows else True,
            "tpl_paid": str(row.get("tpl_paid") or "").strip()[:500],
            "tpl_shipped": str(row.get("tpl_shipped") or "").strip()[:500],
            "tpl_delivered": str(row.get("tpl_delivered") or "").strip()[:500],
            "tpl_returned": str(row.get("tpl_returned") or "").strip()[:500],
            "cart": cart if rows else {
                "enabled": False,
                "gap_1": CART_GAP_DEFAULTS[1],
                "gap_2": CART_GAP_DEFAULTS[2],
                "gap_3": CART_GAP_DEFAULTS[3],
                "tpl_1": "", "tpl_2": "", "tpl_3": "",
            },
        },
    }), 200


@bp.put("/checkout/settings")
def save_checkout_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    settings_in = payload.get("settings")
    settings_in = settings_in if isinstance(settings_in, dict) else {}
    notify_enabled = settings_in.get("notify_enabled")
    if not isinstance(notify_enabled, bool):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "notify_enabled must be true"
                                             " or false."}}), 400
    templates = {}
    for key in ("paid", "shipped", "delivered", "returned"):
        value = str(settings_in.get("tpl_" + key) or "").strip()
        if len(value) > 500:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Templates are capped at"
                                                 " 500 characters."}}), 400
        templates[key] = value
    cart_in = settings_in.get("cart")
    cart_provided = isinstance(cart_in, dict)
    cart_in = cart_in if cart_provided else {}
    cart_enabled = cart_in.get("enabled") is True
    gaps = {}
    for key in (1, 2, 3):
        if not cart_provided:
            gaps[key] = CART_GAP_DEFAULTS[key]
            continue
        try:
            gap = int(cart_in.get("gap_" + str(key)))
        except (TypeError, ValueError):
            gap = 0
        if not 1 <= gap <= 168:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Reminder gaps are 1 to"
                                                 " 168 hours."}}), 400
        gaps[key] = gap
    cart_templates = {}
    for key in (1, 2, 3):
        value = str(cart_in.get("tpl_" + str(key)) or "").strip()
        if len(value) > 500:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Templates are capped at"
                                                 " 500 characters."}}), 400
        cart_templates[key] = value
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_settings_table(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(SETTINGS_TABLE) +
                    " (client_id, notify_enabled, tpl_paid, tpl_shipped,"
                    " tpl_delivered, tpl_returned, cart_enabled,"
                    " cart_gap_1, cart_gap_2, cart_gap_3, cart_tpl_1,"
                    " cart_tpl_2, cart_tpl_3, updated_at)"
                    " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,"
                    " %s, %s, NOW())"
                    " ON CONFLICT (client_id) DO UPDATE SET"
                    " notify_enabled = EXCLUDED.notify_enabled,"
                    " tpl_paid = EXCLUDED.tpl_paid,"
                    " tpl_shipped = EXCLUDED.tpl_shipped,"
                    " tpl_delivered = EXCLUDED.tpl_delivered,"
                    " tpl_returned = EXCLUDED.tpl_returned,"
                    " cart_enabled = EXCLUDED.cart_enabled,"
                    " cart_gap_1 = EXCLUDED.cart_gap_1,"
                    " cart_gap_2 = EXCLUDED.cart_gap_2,"
                    " cart_gap_3 = EXCLUDED.cart_gap_3,"
                    " cart_tpl_1 = EXCLUDED.cart_tpl_1,"
                    " cart_tpl_2 = EXCLUDED.cart_tpl_2,"
                    " cart_tpl_3 = EXCLUDED.cart_tpl_3,"
                    " updated_at = NOW()",
                    (principal["client_id"], notify_enabled,
                     templates["paid"], templates["shipped"],
                     templates["delivered"], templates["returned"],
                     cart_enabled,
                     gaps[1], gaps[2], gaps[3],
                     cart_templates[1], cart_templates[2],
                     cart_templates[3]),
                )
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "checkout.settings",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Order update settings: notify="
                     + ("on" if notify_enabled else "off"))[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout settings save failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "checkout settings")[0]), 503
    return jsonify({"ok": True}), 200


def public_checkout(token: str) -> Tuple[Optional[Dict[str, Any]], Optional[int]]:
    """Public (unauthenticated) token lookup. Returns (payload, status)."""
    token = str(token or "").strip()[:64]
    if not token:
        return {"error": {"code": "bad_request",
                          "message": "token is required."}}, 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                try:
                    import portal_ratelimit

                    if not portal_ratelimit.allow(
                        cur,
                        "checkout:" + token,
                        portal_ratelimit.checkout_limit(),
                        60,
                    ):
                        conn.commit()
                        return ({"error": {
                            "code": "rate_limited",
                            "message": "Too many requests; try again"
                                       " shortly.",
                        }}, 429)
                except Exception:
                    pass
                cur.execute(
                    "SELECT l.id, l.token, l.contact_id, l.title, l.items,"
                    " l.total, l.status, l.created_at, l.expires_at,"
                    " l.view_count, l.discount, l.courier,"
                    " l.tracking_number, l.coupon_code, l.coupon_discount,"
                    " l.paid_amount, l.advance_percent, l.brand_id,"
                    " b.name AS brand_name"
                    " FROM " + portal_db._q(LINKS_TABLE) + " l"
                    " LEFT JOIN portal_brands b ON b.id = l.brand_id"
                    " WHERE l.token = %s LIMIT 1",
                    (token,),
                )
                rows = portal_db.rows(cur)
                if rows and (rows[0].get("status")
                             or "open") == "open":
                    cur.execute(
                        "UPDATE " + portal_db._q(LINKS_TABLE) +
                        " SET view_count = COALESCE(view_count, 0) + 1"
                        " WHERE token = %s",
                        (token,),
                    )
                    conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout public read failed: %s", error)
        return {"error": {"code": "portal_unavailable",
                          "message": "Try again shortly."}}, 503
    if not rows:
        return {"error": {"code": "not_found",
                          "message": "This order link is not valid."}}, 404
    row = rows[0]
    expires_at = row.get("expires_at")
    if (row.get("status") or "open") == "open" and expires_at is not None:
        now = datetime.datetime.now(datetime.timezone.utc)
        try:
            expired = expires_at < now
        except TypeError:
            expired = str(expires_at) < now.isoformat()
        if expired:
            return {"error": {"code": "not_found",
                              "message": "This order link has"
                                         " expired."}}, 404
    view = _public(row)
    view.pop("contact_id", None)
    view.pop("id", None)
    return view, 200


@bp.get("/checkout/returns")
def list_checkout_returns():
    """Recent returns (newest first, 50) with the linked order summary."""
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_returns_table(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT r.id, r.link_id, r.reason, r.note, r.created_at,"
                    " l.title, l.total FROM " + portal_db._q(RETURNS_TABLE) +
                    " r LEFT JOIN " + portal_db._q(LINKS_TABLE) +
                    " l ON l.id = r.link_id AND l.client_id = r.client_id"
                    " WHERE r.client_id = %s"
                    " ORDER BY r.id DESC LIMIT 50",
                    (principal["client_id"],),
                )
                rows = portal_db.rows(cur)
                cur.execute(
                    "SELECT COUNT(*) AS total FROM "
                    + portal_db._q(RETURNS_TABLE) +
                    " WHERE client_id = %s",
                    (principal["client_id"],),
                )
                count_rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("returns read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "returns read")[0]), 503
    items = []
    for row in rows:
        item = {
            "id": int(row.get("id") or 0),
            "link_id": int(row.get("link_id") or 0),
            "reason": str(row.get("reason") or "other"),
            "note": str(row.get("note") or ""),
            "created_at": _iso(row.get("created_at")),
            "title": str(row.get("title") or ""),
            "total": float(row.get("total") or 0),
        }
        items.append(item)
    total = 0
    if count_rows:
        try:
            total = int(count_rows[0].get("total") or 0)
        except (TypeError, ValueError):
            total = 0
    return jsonify({"ok": True, "returns": items,
                    "counts": {"total": total}}), 200


@bp.get("/checkout/returns/export")
def returns_export():
    """Returns ledger (newest first, 2000) as a CSV download."""
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_returns_table(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT r.created_at, l.title, l.total, r.reason, r.note"
                    " FROM " + portal_db._q(RETURNS_TABLE) + " r"
                    " LEFT JOIN " + portal_db._q(LINKS_TABLE) +
                    " l ON l.id = r.link_id AND l.client_id = r.client_id"
                    " WHERE r.client_id = %s"
                    " ORDER BY r.id DESC LIMIT 2000",
                    (principal["client_id"],),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("returns export failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "returns export")[0]), 503
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["date", "order", "amount", "reason", "note"])
    for row in found:
        writer.writerow([
            row.get("created_at").date().isoformat()
            if row.get("created_at") else "",
            row.get("title"),
            row.get("total"),
            row.get("reason"),
            row.get("note"),
        ])
    return Response(
        buffer.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition":
                 "attachment; filename=omniflow-returns.csv"},
    )


@public_bp.post("/checkout/<token>/otp")
def public_checkout_otp(token: str):
    """Send the order-verification code to the customer on WhatsApp."""
    if not phone_verification_on():
        return jsonify({"error": {"code": "feature_off",
                                  "message": "Phone verification is not"
                                             " enabled."}}), 409
    token = str(token or "").strip()[:64]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_checkout_tables(conn)
            _ensure_otp_table(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, client_id, contact_id, status FROM "
                    + portal_db._q(LINKS_TABLE) +
                    " WHERE token = %s LIMIT 1",
                    (token,),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "This order link"
                                                         " is not"
                                                         " valid."}}), 404
                link = rows[0]
                if (link.get("status") or "open") != "open":
                    return jsonify({"error": {"code": "bad_request",
                                              "message": "This order is"
                                                         " already"
                                                         " settled."}}), 400
                contact_id = str(link.get("contact_id") or "")
                if not contact_id:
                    return jsonify({"error": {"code": "bad_request",
                                              "message": "This order has"
                                                         " no customer"
                                                         " contact."}}), 400
                cur.execute(
                    "SELECT COUNT(*) AS n FROM " + portal_db._q(OTP_TABLE)
                    + " WHERE token = %s AND created_at > NOW()"
                    " - INTERVAL '15 minutes'", (token,),
                )
                recent = int(portal_db.rows(cur)[0]["n"])
                if recent >= OTP_MAX_SENDS:
                    return jsonify({"error": {"code": "rate_limited",
                                              "message": "Too many codes"
                                                         " - wait a few"
                                                         " minutes."}}), 429
                code = "".join(str(secrets.randbelow(10))
                               for _ in range(6))
                cur.execute(
                    "INSERT INTO " + portal_db._q(OTP_TABLE) +
                    " (token, client_id, contact_id, code_hash, attempts,"
                    " created_at) VALUES (%s, %s, %s, %s, 0, NOW())"
                    " ON CONFLICT (token) DO UPDATE SET code_hash ="
                    " EXCLUDED.code_hash, attempts = 0, created_at ="
                    " NOW()",
                    (token, link.get("client_id"), contact_id,
                     _otp_hash(token, code)),
                )
                name = _contact_name(cur, link.get("client_id"),
                                     contact_id)
                portal_growth._send_command(
                    cur, link.get("client_id"), contact_id, name,
                    "Your verification code is " + code
                    + " (valid " + str(OTP_TTL_MINUTES)
                    + " minutes). Do not share it.",
                    "phone_otp",
                )
                portal_db.log_action(
                    cur, link.get("client_id"), "checkout.otp_sent",
                    "system", None, None,
                    ("Phone OTP sent for link token "
                     + token[:8])[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout otp send failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "phone verification")[0]), 503
    return jsonify({"ok": True, "sent": True}), 200


@public_bp.post("/checkout/<token>/otp/verify")
def public_checkout_otp_verify(token: str):
    """Verify the code the customer typed (attempts capped)."""
    if not phone_verification_on():
        return jsonify({"error": {"code": "feature_off",
                                  "message": "Phone verification is not"
                                             " enabled."}}), 409
    token = str(token or "").strip()[:64]
    payload = request.get_json(silent=True) or {}
    code = str(payload.get("code") or "").strip()
    if not code.isdigit() or len(code) != 6:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Enter the 6-digit code."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_otp_table(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT code_hash, attempts, created_at FROM "
                    + portal_db._q(OTP_TABLE) +
                    " WHERE token = %s LIMIT 1", (token,),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Request a code"
                                                         " first."}}), 404
                row = rows[0]
                if int(row.get("attempts") or 0) >= OTP_MAX_ATTEMPTS:
                    return jsonify({"error": {"code": "rate_limited",
                                              "message": "Too many tries"
                                                         " - request a new"
                                                         " code."}}), 429
                cur.execute(
                    "UPDATE " + portal_db._q(OTP_TABLE) +
                    " SET attempts = attempts + 1 WHERE token = %s",
                    (token,),
                )
                valid = (
                    _otp_hash(token, code) == str(row.get("code_hash"))
                    and str(row.get("created_at")) != ""
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout otp verify failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "phone verification")[0]), 503
    if not valid:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "That code is not right -"
                                             " check the WhatsApp"
                                             " message."}}), 400
    return jsonify({"ok": True, "verified": True}), 200
`);
writeNewRepair("OmniFlow-Control-Plane/app.py", "from portal_voice import bp as portal_voice_bp", true,
    `"""Gunicorn + Vercel entry point for the OmniFlow Control Plane API v1."""

import os
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
SRC_DIR = PROJECT_ROOT / "src"

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

# Refuse plaintext PostgreSQL transport even if a provider URL omits sslmode.
os.environ.setdefault("PGSSLMODE", "require")

from flask import Flask  # noqa: E402

from control_plane.http_api import create_control_plane_api  # noqa: E402
from auth_password_reset import bp as auth_password_reset_bp  # noqa: E402
from admin_users import bp as admin_users_bp  # noqa: E402
from portal_channels import bp as portal_channels_bp  # noqa: E402
from portal_bot import bp as portal_bot_bp  # noqa: E402
from portal_profile import bp as portal_profile_bp  # noqa: E402
from portal_apikeys import bp as portal_apikeys_bp  # noqa: E402
from portal_conversations import bp as portal_conversations_bp  # noqa: E402
from portal_growth import bp as portal_growth_bp  # noqa: E402
from portal_cod import bp as portal_cod_bp  # noqa: E402
from portal_segments import bp as portal_segments_bp  # noqa: E402
from portal_pipeline import bp as portal_pipeline_bp  # noqa: E402
from portal_insights import bp as portal_insights_bp  # noqa: E402
from portal_contacts import bp as portal_contacts_bp  # noqa: E402
from portal_fraud import bp as portal_fraud_bp  # noqa: E402
from portal_compliance import bp as portal_compliance_bp  # noqa: E402
from portal_negotiation import bp as portal_negotiation_bp  # noqa: E402
from portal_checkout import bp as portal_checkout_bp  # noqa: E402
from portal_digest import bp as portal_digest_bp  # noqa: E402
from portal_listen import bp as portal_listen_bp  # noqa: E402
from portal_routing import bp as portal_routing_bp  # noqa: E402
from portal_reco import bp as portal_reco_bp  # noqa: E402
from portal_churn import bp as portal_churn_bp  # noqa: E402
from portal_winback import bp as portal_winback_bp  # noqa: E402
from portal_revenue import bp as portal_revenue_bp  # noqa: E402
from portal_payments import bp as portal_payments_bp  # noqa: E402
from portal_analytics import bp as portal_analytics_bp  # noqa: E402
from portal_datasafety import bp as portal_datasafety_bp  # noqa: E402
from portal_interactive import bp as portal_interactive_bp  # noqa: E402
from portal_wati import bp as portal_wati_bp  # noqa: E402
from portal_catalog import bp as portal_catalog_bp  # noqa: E402
from portal_changes import bp as portal_changes_bp  # noqa: E402
from portal_coupons import bp as portal_coupons_bp  # noqa: E402
from portal_cloud import bp as portal_cloud_bp  # noqa: E402
from portal_cloud import connector_bp as portal_cloud_connector_bp  # noqa: E402
from portal_events import bp as portal_events_bp  # noqa: E402
from portal_rollups import bp as portal_rollups_bp  # noqa: E402
from portal_alerts import bp as portal_alerts_bp  # noqa: E402
from portal_brain import bp as portal_brain_bp  # noqa: E402
from portal_memory import bp as portal_memory_bp  # noqa: E402
from portal_recovery import bp as portal_recovery_bp  # noqa: E402
from portal_risk import bp as portal_risk_bp  # noqa: E402
from portal_courier import bp as portal_courier_bp  # noqa: E402
from portal_media import bp as portal_media_bp, connector_bp as portal_media_connector_bp  # noqa: E402
from portal_perf import bp as portal_perf_bp  # noqa: E402
from portal_templates import bp as portal_templates_bp  # noqa: E402
from portal_plans import bp as portal_plans_bp  # noqa: E402
from portal_brands import bp as portal_brands_bp  # noqa: E402
from admin_providers import bp as admin_providers_bp  # noqa: E402
from portal_voice import bp as portal_voice_bp, public_bp as portal_voice_public_bp  # noqa: E402
from portal_video import bp as portal_video_bp  # noqa: E402
from portal_obs import install_obs as _install_obs  # noqa: E402
from portal_restock import bp as portal_restock_bp  # noqa: E402
from portal_value import bp as portal_value_bp  # noqa: E402
from portal_checkout import public_bp as portal_checkout_public_bp  # noqa: E402
from portal_payments import public_bp as portal_payments_public_bp  # noqa: E402
from portal_setup import bp as portal_setup_bp  # noqa: E402
from portal_webhooks import bp as portal_webhooks_bp  # noqa: E402
from portal_sequences import bp as portal_sequences_bp  # noqa: E402
from connector_api import bp as connector_api_bp  # noqa: E402
from portal_auth import bind_root_application  # noqa: E402


# --- Extension endpoints (password reset + admin + portal + connector) ------
# create_control_plane_api() returns the ControlPlaneAPI WSGI wrapper, which
# does not expose the Flask instance, so the extensions live in their own
# small Flask app and requests are dispatched by explicit URL prefixes.
aux_app = Flask("omniflow_extensions")
aux_app.register_blueprint(auth_password_reset_bp)
aux_app.register_blueprint(admin_users_bp)
aux_app.register_blueprint(portal_channels_bp)
aux_app.register_blueprint(portal_bot_bp)
aux_app.register_blueprint(portal_profile_bp)
aux_app.register_blueprint(portal_apikeys_bp)
aux_app.register_blueprint(portal_conversations_bp)
aux_app.register_blueprint(portal_growth_bp)
aux_app.register_blueprint(portal_cod_bp)
aux_app.register_blueprint(portal_segments_bp)
aux_app.register_blueprint(portal_pipeline_bp)
aux_app.register_blueprint(portal_insights_bp)
aux_app.register_blueprint(portal_contacts_bp)
aux_app.register_blueprint(portal_fraud_bp)
aux_app.register_blueprint(portal_compliance_bp)
aux_app.register_blueprint(portal_negotiation_bp)
aux_app.register_blueprint(portal_checkout_bp)
aux_app.register_blueprint(portal_digest_bp)
aux_app.register_blueprint(portal_listen_bp)
aux_app.register_blueprint(portal_routing_bp)
aux_app.register_blueprint(portal_reco_bp)
aux_app.register_blueprint(portal_churn_bp)
aux_app.register_blueprint(portal_winback_bp)
aux_app.register_blueprint(portal_revenue_bp)
aux_app.register_blueprint(portal_payments_bp)
aux_app.register_blueprint(portal_analytics_bp)
aux_app.register_blueprint(portal_datasafety_bp)
aux_app.register_blueprint(portal_interactive_bp)
aux_app.register_blueprint(portal_wati_bp)
aux_app.register_blueprint(portal_catalog_bp)
aux_app.register_blueprint(portal_changes_bp)
aux_app.register_blueprint(portal_coupons_bp)
aux_app.register_blueprint(portal_cloud_bp)
aux_app.register_blueprint(portal_cloud_connector_bp)
aux_app.register_blueprint(portal_events_bp)
aux_app.register_blueprint(portal_rollups_bp)
aux_app.register_blueprint(portal_alerts_bp)
aux_app.register_blueprint(portal_brain_bp)
aux_app.register_blueprint(portal_memory_bp)
aux_app.register_blueprint(portal_recovery_bp)
aux_app.register_blueprint(portal_risk_bp)
aux_app.register_blueprint(portal_courier_bp)
aux_app.register_blueprint(portal_media_bp)
aux_app.register_blueprint(portal_media_connector_bp)
aux_app.register_blueprint(portal_perf_bp)
aux_app.register_blueprint(portal_templates_bp)
aux_app.register_blueprint(portal_plans_bp)
aux_app.register_blueprint(portal_brands_bp)
aux_app.register_blueprint(admin_providers_bp)
aux_app.register_blueprint(portal_voice_bp)
aux_app.register_blueprint(portal_voice_public_bp)
aux_app.register_blueprint(portal_video_bp)
_install_obs(aux_app)
aux_app.register_blueprint(portal_payments_public_bp)
aux_app.register_blueprint(portal_restock_bp)
aux_app.register_blueprint(portal_value_bp)
aux_app.register_blueprint(portal_checkout_public_bp)
aux_app.register_blueprint(portal_setup_bp)
aux_app.register_blueprint(portal_webhooks_bp)
aux_app.register_blueprint(portal_sequences_bp)
aux_app.register_blueprint(connector_api_bp)

_EXTENSION_PREFIXES = (
    "/api/v1/auth/forgot-password",
    "/api/v1/auth/reset-password",
    "/api/v1/admin/users",
    "/api/v1/admin/reset-codes",
    "/api/v1/portal/",
    "/api/v1/connector/",
)


class _CompositeWsgi:
    """Dispatches extension paths to aux_app, everything else to the API."""

    def __init__(self, primary, aux):
        self._primary = primary
        self._aux = aux

    def __call__(self, environ, start_response):
        path = environ.get("PATH_INFO", "")
        if path.startswith(_EXTENSION_PREFIXES):
            return self._aux(environ, start_response)
        return self._primary(environ, start_response)


application = _CompositeWsgi(create_control_plane_api(), aux_app)

# Portal extensions validate customer Bearer tokens by asking the MAIN app
# itself (in-process GET /api/v1/auth/me) — bind the composite root here.
bind_root_application(application)

# Vercel discovers the entry point through a top-level \`\`app\`\` variable.
# Keep \`\`application\`\` for the existing Gunicorn entry point.
app = application
`);
writeNewRepair("lib/omniflow/portal.ts", "export async function callContact(", false,
    `import "server-only";

import { ControlPlaneRequestError } from "./control-plane";
import { readSessionCookies } from "./session-cookies";


const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Tenant-scoped portal API layer.
 *
 * Every function talks to the Control Plane with the customer's Bearer token
 * and returns a NORMALIZED shape. If the Control Plane module is not deployed
 * yet (404/501) the result is \`{ configured: false, ...defaults }\` so the UI
 * can render a graceful pending state and light up automatically later —
 * no frontend changes needed when the backend endpoint ships.
 */

export function controlPlaneBaseUrl(): URL {
  const raw = process.env.OMNIFLOW_CONTROL_PLANE_URL?.trim();
  if (!raw) throw new ControlPlaneRequestError(503, "control_plane_not_configured");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ControlPlaneRequestError(503, "control_plane_url_invalid");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ControlPlaneRequestError(503, "control_plane_url_invalid");
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new ControlPlaneRequestError(503, "control_plane_tls_required");
  }

  url.pathname = url.pathname.replace(/\\/$/, "") + "/";
  url.search = "";
  url.hash = "";
  return url;
}

async function portalRequest(
  accessToken: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const url = new URL(path.replace(/^\\//, ""), controlPlaneBaseUrl());
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("Authorization", \`Bearer \${accessToken}\`);

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ControlPlaneRequestError(503, "control_plane_unavailable");
  }
  return response;
}

/** Throws on auth failure so routes can trigger the refresh flow. */
function assertNotAuthError(error: unknown): void {
  if (error instanceof ControlPlaneRequestError && error.isUnauthorized) throw error;
}

// ---------------------------------------------------------------------------
// WhatsApp channel
// ---------------------------------------------------------------------------

export interface WhatsAppChannelStatus {
  /** false = Control Plane connector module not deployed yet. */
  configured: boolean;
  state: "disconnected" | "connecting" | "connected" | "unknown";
  accountName: string | null;
  phone: string | null;
  lastSeenAt: string | null;
}

const WHATSAPP_DISCONNECTED: WhatsAppChannelStatus = {
  configured: false,
  state: "disconnected",
  accountName: null,
  phone: null,
  lastSeenAt: null,
};

export async function getWhatsAppChannelStatus(
  accessToken: string
): Promise<WhatsAppChannelStatus> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/channels/whatsapp");
  } catch (error) {
    assertNotAuthError(error);
    return WHATSAPP_DISCONNECTED;
  }

  if (response.status === 404 || response.status === 501) {
    return WHATSAPP_DISCONNECTED;
  }
  if (!response.ok) {
    if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
    return WHATSAPP_DISCONNECTED;
  }

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") {
    return { ...WHATSAPP_DISCONNECTED, state: "unknown" };
  }
  const p = payload as Record<string, unknown>;
  const rawState = typeof p.state === "string" ? p.state : "unknown";
  const allowedStates: readonly string[] = ["disconnected", "connecting", "connected"];
  const state = allowedStates.includes(rawState)
    ? (rawState as WhatsAppChannelStatus["state"])
    : "unknown";

  return {
    configured: true,
    state,
    accountName: typeof p.account_name === "string" ? p.account_name : null,
    phone: typeof p.phone === "string" ? p.phone : null,
    lastSeenAt: typeof p.last_seen_at === "string" ? p.last_seen_at : null,
  };
}

export type WhatsAppChannelAction = "connect" | "disconnect";

export interface WhatsAppActionResult {
  ok: boolean;
  configured: boolean;
  message: string | null;
}

export async function requestWhatsAppAction(
  accessToken: string,
  action: WhatsAppChannelAction
): Promise<WhatsAppActionResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/channels/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { ok: false, configured: false, message: null };
  }

  if (response.status === 404 || response.status === 501) {
    return { ok: false, configured: false, message: null };
  }
  if (response.status === 401) {
    throw new ControlPlaneRequestError(401, "unauthorized");
  }
  if (!response.ok) {
    return { ok: false, configured: true, message: "The connector rejected this action." };
  }

  const payload: unknown = await response.json().catch(() => null);
  let message: string | null = null;
  if (payload !== null && typeof payload === "object") {
    const raw = (payload as Record<string, unknown>).message;
    if (typeof raw === "string") message = raw;
  }
  return { ok: true, configured: true, message };
}

// ---------------------------------------------------------------------------
// AI agent (bot) configuration
// ---------------------------------------------------------------------------

export interface BotConfig {
  configured: boolean;
  agentName: string;
  tone: "friendly" | "professional" | "concise";
  greeting: string;
  fallback: string;
  workingHoursEnabled: boolean;
  workingHoursStart: string;
  workingHoursEnd: string;
  humanHandoffEnabled: boolean;
  customInstructions: string;
  updatedAt: string | null;
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  configured: false,
  agentName: "OmniFlow Assistant",
  tone: "friendly",
  greeting: "",
  fallback: "",
  workingHoursEnabled: false,
  workingHoursStart: "09:00",
  workingHoursEnd: "18:00",
  humanHandoffEnabled: false,
  customInstructions: "",
  updatedAt: null,
};

function normalizeBotConfig(payload: unknown): BotConfig {
  if (payload === null || typeof payload !== "object") return { ...DEFAULT_BOT_CONFIG };
  const p = payload as Record<string, unknown>;
  const tone = p.tone === "professional" || p.tone === "concise" ? p.tone : "friendly";
  return {
    configured: true,
    agentName: typeof p.agent_name === "string" ? p.agent_name : DEFAULT_BOT_CONFIG.agentName,
    tone,
    greeting: typeof p.greeting === "string" ? p.greeting : "",
    fallback: typeof p.fallback === "string" ? p.fallback : "",
    workingHoursEnabled: p.working_hours_enabled === true,
    workingHoursStart:
      typeof p.working_hours_start === "string" ? p.working_hours_start : "09:00",
    workingHoursEnd: typeof p.working_hours_end === "string" ? p.working_hours_end : "18:00",
    humanHandoffEnabled: p.human_handoff_enabled === true,
    customInstructions: typeof p.custom_instructions === "string" ? p.custom_instructions : "",
    updatedAt: typeof p.updated_at === "string" ? p.updated_at : null,
  };
}

export async function getBotConfig(accessToken: string): Promise<BotConfig> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/bot");
  } catch (error) {
    assertNotAuthError(error);
    return { ...DEFAULT_BOT_CONFIG };
  }

  if (response.status === 404 || response.status === 501) {
    return { ...DEFAULT_BOT_CONFIG };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { ...DEFAULT_BOT_CONFIG };

  return normalizeBotConfig(await response.json().catch(() => null));
}

function botConfigBody(config: BotConfig): Record<string, unknown> {
  return {
    agent_name: config.agentName,
    tone: config.tone,
    greeting: config.greeting,
    fallback: config.fallback,
    working_hours_enabled: config.workingHoursEnabled,
    working_hours_start: config.workingHoursStart,
    working_hours_end: config.workingHoursEnd,
    human_handoff_enabled: config.humanHandoffEnabled,
    custom_instructions: config.customInstructions,
  };
}

export async function saveBotConfig(
  accessToken: string,
  config: BotConfig
): Promise<{ ok: boolean; configured: boolean }> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/bot", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botConfigBody(config)),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { ok: false, configured: false };
  }

  if (response.status === 404 || response.status === 501) {
    return { ok: false, configured: false };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return { ok: response.ok, configured: true };
}

// ---------------------------------------------------------------------------
// Business profile
// ---------------------------------------------------------------------------

export interface BusinessProfileResult {
  configured: boolean;
  data: Record<string, string>;
  updatedAt: string | null;
}

export const DEFAULT_BUSINESS_PROFILE: Record<string, string> = {
  business_name: "",
  industry: "",
  phone: "",
  website: "",
  address: "",
  timezone: "Asia/Karachi",
  business_hours: "",
  default_language: "english",
};

export async function getBusinessProfile(
  accessToken: string
): Promise<BusinessProfileResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/profile");
  } catch (error) {
    assertNotAuthError(error);
    return { configured: false, data: {}, updatedAt: null };
  }

  if (response.status === 404 || response.status === 501) {
    return { configured: false, data: {}, updatedAt: null };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { configured: false, data: {}, updatedAt: null };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") {
    return { configured: false, data: {}, updatedAt: null };
  }
  const p = payload as Record<string, unknown>;
  const rawProfile = p.profile;
  const data: Record<string, string> = {};
  if (rawProfile !== null && typeof rawProfile === "object") {
    for (const [key, value] of Object.entries(rawProfile as Record<string, unknown>)) {
      if (typeof value === "string") data[key] = value;
    }
  }
  return {
    configured: true,
    data,
    updatedAt: typeof p.updated_at === "string" ? p.updated_at : null,
  };
}

export interface SaveResult {
  ok: boolean;
  configured: boolean;
  message: string | null;
}

export async function saveBusinessProfile(
  accessToken: string,
  profile: Record<string, string>
): Promise<SaveResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { ok: false, configured: false, message: null };
  }

  if (response.status === 404 || response.status === 501) {
    return { ok: false, configured: false, message: null };
  }
  if (response.status === 401) {
    throw new ControlPlaneRequestError(401, "unauthorized");
  }
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    let message: string | null = null;
    if (payload !== null && typeof payload === "object") {
      const rawError = (payload as Record<string, unknown>).error;
      if (rawError !== null && typeof rawError === "object") {
        const raw = (rawError as Record<string, unknown>).message;
        if (typeof raw === "string") message = raw;
      }
    }
    return { ok: false, configured: true, message };
  }
  return { ok: true, configured: true, message: null };
}

// ---------------------------------------------------------------------------
// Portal API key (ofk_…)
// ---------------------------------------------------------------------------

export interface ApiKeyResult {
  configured: boolean;
  keyPrefix: string | null;
  revoked: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}

const NO_API_KEY: ApiKeyResult = {
  configured: false,
  keyPrefix: null,
  revoked: false,
  createdAt: null,
  lastUsedAt: null,
};

export async function getApiKeyInfo(accessToken: string): Promise<ApiKeyResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/api-key");
  } catch (error) {
    assertNotAuthError(error);
    return { ...NO_API_KEY };
  }

  if (response.status === 404 || response.status === 501) return { ...NO_API_KEY };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { ...NO_API_KEY };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { ...NO_API_KEY };
  const p = payload as Record<string, unknown>;
  if (p.configured !== true) return { ...NO_API_KEY };
  return {
    configured: true,
    keyPrefix: typeof p.key_prefix === "string" ? p.key_prefix : null,
    revoked: p.revoked === true,
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
    lastUsedAt: typeof p.last_used_at === "string" ? p.last_used_at : null,
  };
}

export async function rotateApiKey(
  accessToken: string
): Promise<{ ok: boolean; key: string | null; message: string | null }> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/api-key/rotate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { ok: false, key: null, message: null };
  }

  if (response.status === 401) {
    throw new ControlPlaneRequestError(401, "unauthorized");
  }
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    let message: string | null = null;
    if (payload !== null && typeof payload === "object") {
      const rawError = (payload as Record<string, unknown>).error;
      if (rawError !== null && typeof rawError === "object") {
        const raw = (rawError as Record<string, unknown>).message;
        if (typeof raw === "string") message = raw;
      }
    }
    return { ok: false, key: null, message };
  }
  const payload: unknown = await response.json().catch(() => null);
  const key =
    payload !== null &&
    typeof payload === "object" &&
    typeof (payload as Record<string, unknown>).key === "string"
      ? ((payload as Record<string, unknown>).key as string)
      : null;
  return { ok: key !== null, key, message: null };
}

export async function revokeApiKey(
  accessToken: string
): Promise<{ ok: boolean; message: string | null }> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/api-key/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { ok: false, message: null };
  }

  if (response.status === 401) {
    throw new ControlPlaneRequestError(401, "unauthorized");
  }
  if (!response.ok) return { ok: false, message: "The key could not be revoked." };
  return { ok: true, message: null };
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export type ConversationChipCounts = {
  needsReply: number;
  overdue: number;
  unassigned: number;
  unread: number;
};

export interface ConversationSummary {
  id: number;
  channel: string;
  contactId: string | null;
  contactName: string | null;
  status: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  createdAt: string | null;
  unread: boolean;
  needsReply: boolean;
  vip: boolean;
  paidOrders: number;
  lastIntent: string | null;
  leadScore: number;
  leadTemp: string;
  assignedTo: string | null;
  assigneeName: string | null;
  starred: boolean;
  tags: string[];
}

export interface ConversationMessage {
  id: number;
  direction: "in" | "out";
  body: string;
  status: string;
  intent: string | null;
  createdAt: string | null;
}

function normalizeConversation(value: unknown): ConversationSummary | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  if (id === null) return null;
  return {
    id,
    channel: typeof p.channel === "string" ? p.channel : "whatsapp",
    contactId: typeof p.contact_id === "string" ? p.contact_id : null,
    contactName: typeof p.contact_name === "string" ? p.contact_name : null,
    status: typeof p.status === "string" ? p.status : "open",
    lastMessageAt: typeof p.last_message_at === "string" ? p.last_message_at : null,
    lastMessagePreview:
      typeof p.last_message_preview === "string" ? p.last_message_preview : null,
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
    unread: p.unread === true,
    needsReply: p.needs_reply === true,
    vip: p.vip === true,
    paidOrders: typeof p.paid_orders === "number" ? p.paid_orders : 0,
    lastIntent: typeof p.last_intent === "string" ? p.last_intent : null,
    leadScore: typeof p.lead_score === "number" ? p.lead_score : 0,
    leadTemp: typeof p.lead_temp === "string" ? p.lead_temp : "cold",
    assignedTo: typeof p.assigned_to === "string" ? p.assigned_to : null,
    assigneeName: typeof p.assignee_name === "string" ? p.assignee_name : null,
    starred: p.starred === true,
    tags: Array.isArray(p.tags)
      ? p.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
  };
}

export async function listConversations(
  accessToken: string,
  searchQuery?: string,
  statusFilter?: string,
  intentFilter?: string,
  channelFilter?: string,
  tagFilter?: string,
  needsReplyFilter?: string,
  sortOrder?: string,
  assignedFilter?: string,
  includeCounts?: boolean,
  limit?: number,
  daysFilter?: string,
  unreadFilter?: string,
  starredFilter?: string,
  page?: number
): Promise<
  { conversations: ConversationSummary[]; counts: ConversationChipCounts | null } | null
> {
  const searchPart =
    searchQuery && searchQuery.trim()
      ? "q=" + encodeURIComponent(searchQuery.trim().slice(0, 100))
      : "";
  const statusPart =
    statusFilter && statusFilter !== "all"
      ? "status=" + encodeURIComponent(statusFilter)
      : "";
  const intentPart =
    intentFilter && intentFilter !== "all"
      ? "intent=" + encodeURIComponent(intentFilter)
      : "";
  const channelPart =
    channelFilter && channelFilter !== "all"
      ? "channel=" + encodeURIComponent(channelFilter)
      : "";
  const tagPart =
    tagFilter && tagFilter !== "all" ? "tag=" + encodeURIComponent(tagFilter) : "";
  const replyPart =
    needsReplyFilter === "1" || needsReplyFilter === "overdue"
      ? "needs_reply=" + needsReplyFilter
      : "";
  const sortPart = sortOrder === "oldest" ? "sort=oldest" : "";
  const assignedPart =
    assignedFilter === "unassigned" || assignedFilter === "me"
      ? "assigned=" + assignedFilter
      : "";
  const countsPart = includeCounts ? "include=counts,vip" : "include=vip";
  const limitPart =
    limit && limit >= 1 && limit <= 50 ? "limit=" + Math.floor(limit) : "";
  const daysPart = daysFilter ? "days=" + encodeURIComponent(daysFilter) : "";
  const unreadPart = unreadFilter === "1" ? "unread=1" : "";
  const starredPart = starredFilter === "1" ? "starred=1" : "";
  const pagePart = page && page >= 2 && page <= 100 ? "page=" + Math.floor(page) : "";
  const parts = [
    searchPart,
    statusPart,
    intentPart,
    channelPart,
    tagPart,
    replyPart,
    sortPart,
    assignedPart,
    countsPart,
    limitPart,
    daysPart,
    unreadPart,
    starredPart,
    pagePart,
  ].filter(Boolean);
  const query = parts.length ? "?" + parts.join("&") : "";
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations" + query
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).conversations;
  if (!Array.isArray(rawList)) return null;
  const conversations: ConversationSummary[] = [];
  for (const item of rawList) {
    const normalized = normalizeConversation(item);
    if (normalized) conversations.push(normalized);
  }
  const rawCounts = (payload as Record<string, unknown>).counts;
  let counts: ConversationChipCounts | null = null;
  if (rawCounts && typeof rawCounts === "object") {
    const record = rawCounts as Record<string, unknown>;
    counts = {
      needsReply: Number(record.needs_reply) || 0,
      overdue: Number(record.overdue) || 0,
      unassigned: Number(record.unassigned) || 0,
      unread: Number(record.unread) || 0,
    };
  }
  return { conversations, counts };
}

export async function bulkConversations(
  accessToken: string,
  action: string,
  ids: number[],
  assigneeEmail?: string
): Promise<{ updated: number } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/conversations/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        action === "assign"
          ? { action, ids, assignee_email: assigneeEmail || "" }
          : { action, ids }
      ),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const updated = (payload as Record<string, unknown>).updated;
  return { updated: typeof updated === "number" ? updated : 0 };
}

export async function toggleConversationStar(
  accessToken: string,
  conversationId: number
): Promise<{ starred: boolean } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/star",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { starred: false };
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  return { starred: (payload as Record<string, unknown>).starred === true };
}

export type ConversationDetailResult =
  | {
      kind: "ok";
      conversation: ConversationSummary;
      messages: ConversationMessage[];
      hasMore: boolean;
    }
  | { kind: "not_found" }
  | { kind: "unavailable" };

function normalizeConversationMessages(raw: unknown): ConversationMessage[] {
  const rawMessages = Array.isArray(raw) ? raw : [];
  const messages: ConversationMessage[] = [];
  for (const item of rawMessages) {
    if (item === null || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    messages.push({
      id: typeof m.id === "number" ? m.id : 0,
      direction: m.direction === "out" ? "out" : "in",
      body: typeof m.body === "string" ? m.body : "",
      status: typeof m.status === "string" ? m.status : "delivered",
      intent: typeof m.intent === "string" ? m.intent : null,
      createdAt: typeof m.created_at === "string" ? m.created_at : null,
    });
  }
  return messages;
}

export async function getConversation(
  accessToken: string,
  conversationId: number
): Promise<ConversationDetailResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" + encodeURIComponent(String(conversationId))
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  const conversation = normalizeConversation(p.conversation);
  if (!conversation) return { kind: "unavailable" };
  return {
    kind: "ok",
    conversation,
    messages: normalizeConversationMessages(p.messages),
    hasMore: p.has_more === true,
  };
}

export type ConversationMessagesResult =
  | { kind: "ok"; messages: ConversationMessage[]; hasMore: boolean }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function getConversationMessages(
  accessToken: string,
  conversationId: number,
  beforeId: number
): Promise<ConversationMessagesResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/messages?before_id=" +
        encodeURIComponent(String(beforeId))
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  return {
    kind: "ok",
    messages: normalizeConversationMessages(p.messages),
    hasMore: p.has_more === true,
  };
}

export interface BusinessHoursDay {
  enabled: boolean;
  start: string;
  end: string;
}

export interface BusinessHoursConfig {
  enabled: boolean;
  timezone: string;
  days: BusinessHoursDay[];
  away_message: string;
  away_message_ur?: string;
  away_message_roman?: string;
}

export async function getBusinessHours(
  accessToken: string
): Promise<{ business_hours: BusinessHoursConfig } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/business-hours", {});
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    business_hours?: BusinessHoursConfig;
  } | null;
  if (!payload || !payload.business_hours) return null;
  return { business_hours: payload.business_hours };
}

export async function updateBusinessHours(
  accessToken: string,
  config: unknown
): Promise<
  { kind: "ok"; business_hours: BusinessHoursConfig } | { kind: "rejected"; message: string } | null
> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/business-hours", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ business_hours: config }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 400) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return {
      kind: "rejected",
      message: payload?.error?.message ?? "Invalid business hours.",
    };
  }
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    business_hours?: BusinessHoursConfig;
  } | null;
  if (!payload || !payload.business_hours) return null;
  return { kind: "ok", business_hours: payload.business_hours };
}

export async function markAllConversationsRead(
  accessToken: string
): Promise<{ updated: number } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/conversations/read-all", {
      method: "POST",
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const updated = (payload as Record<string, unknown>).updated;
  return { updated: typeof updated === "number" ? updated : 0 };
}

export interface IntentSummaryEntry {
  intent: string;
  conversations: number;
}

export async function fetchIntentSummary(
  accessToken: string
): Promise<IntentSummaryEntry[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/intents/summary"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).intents;
  if (!Array.isArray(rawList)) return null;
  const entries: IntentSummaryEntry[] = [];
  for (const item of rawList) {
    if (item === null || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.intent !== "string") continue;
    entries.push({
      intent: entry.intent,
      conversations:
        typeof entry.conversations === "number" ? entry.conversations : 0,
    });
  }
  return entries;
}

export interface FollowupSettings {
  enabled: boolean;
  delayHours: number;
  maxAttempts: number;
  messageTemplate: string;
}

export async function getFollowupSettings(
  accessToken: string
): Promise<FollowupSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/followups");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).settings;
  if (raw === null || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  return {
    enabled: p.enabled === true,
    delayHours: typeof p.delay_hours === "number" ? p.delay_hours : 24,
    maxAttempts: typeof p.max_attempts === "number" ? p.max_attempts : 2,
    messageTemplate: typeof p.message_template === "string" ? p.message_template : "",
  };
}

export async function saveFollowupSettings(
  accessToken: string,
  settings: FollowupSettings
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/followups", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settings: {
          enabled: settings.enabled,
          delay_hours: settings.delayHours,
          max_attempts: settings.maxAttempts,
          message_template: settings.messageTemplate,
        },
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export type KbLang = "auto" | "en" | "ur" | "roman";

export interface KbEntry {
  id: number;
  title: string;
  category: string;
  keywords: string;
  content: string;
  isActive: boolean;
  usageCount: number;
  lang: KbLang;
  brandId: number | null;
}

export interface KbEntryInput {
  title: string;
  category: string;
  keywords: string;
  content: string;
  isActive: boolean;
  lang: KbLang;
  brandId?: number | null;
}

export interface KbSettings {
  autoReply: boolean;
}

export interface KnowledgeBaseData {
  settings: KbSettings;
  entries: KbEntry[];
}

function mapKbEntry(raw: Record<string, unknown>): KbEntry {
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    title: typeof raw.title === "string" ? raw.title : "",
    category: typeof raw.category === "string" ? raw.category : "general",
    keywords: typeof raw.keywords === "string" ? raw.keywords : "",
    content: typeof raw.content === "string" ? raw.content : "",
    isActive: raw.is_active === true,
    usageCount: typeof raw.usage_count === "number" ? raw.usage_count : 0,
    lang:
      raw.lang === "en" || raw.lang === "ur" || raw.lang === "roman"
        ? raw.lang
        : "auto",
    brandId: typeof raw.brand_id === "number" ? raw.brand_id : null,
  };
}

export async function getKnowledgeBase(
  accessToken: string
): Promise<KnowledgeBaseData | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/kb");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const rawSettings = p.settings;
  const rawEntries = p.entries;
  if (rawSettings === null || typeof rawSettings !== "object") return null;
  const settingsRaw = rawSettings as Record<string, unknown>;
  return {
    settings: { autoReply: settingsRaw.auto_reply === true },
    entries: Array.isArray(rawEntries)
      ? rawEntries
          .filter(
            (item): item is Record<string, unknown> =>
              item !== null && typeof item === "object"
          )
          .map(mapKbEntry)
      : [],
  };
}

export async function createKbEntry(
  accessToken: string,
  entry: KbEntryInput
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/kb", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entry: {
          title: entry.title,
          category: entry.category,
          keywords: entry.keywords,
          content: entry.content,
          is_active: entry.isActive,
          lang: entry.lang,
          brand_id: entry.brandId ?? null,
        },
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function updateKbEntry(
  accessToken: string,
  entryId: number,
  entry: KbEntryInput
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/kb/" + entryId,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entry: {
            title: entry.title,
            category: entry.category,
            keywords: entry.keywords,
            content: entry.content,
            is_active: entry.isActive,
            lang: entry.lang,
            brand_id: entry.brandId ?? null,
          },
        }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function deleteKbEntry(
  accessToken: string,
  entryId: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/kb/" + entryId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function saveKbSettings(
  accessToken: string,
  settings: KbSettings
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/kb", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settings: {
          auto_reply: settings.autoReply,
        },
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export interface CatalogItem {
  id: number;
  kind: "product" | "service";
  name: string;
  priceText: string;
  notes: string;
  isActive: boolean;
  price: number;
  stock: number;
  imageUrl: string;
  source: string;
  syncedAt: string | null;
  brandId: number | null;
  brandName: string | null;
}

export interface CatalogItemInput {
  kind: "product" | "service";
  name: string;
  priceText: string;
  notes: string;
  isActive: boolean;
  price?: number;
  stock?: number;
  imageUrl?: string;
  brandId?: number | null;
}

export interface CatalogSyncSettings {
  source: string;
  base_url: string;
  api_key_masked: string;
  api_secret_masked: string;
  last_sync_at: string | null;
  last_sync_count: number;
}

export async function getCatalogSyncSettings(
  accessToken: string
): Promise<CatalogSyncSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken,
      "api/v1/portal/catalog/sync/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as CatalogSyncSettings | null;
}

export async function putCatalogSyncSettings(
  accessToken: string,
  input: {
    source: string;
    base_url: string;
    api_key?: string;
    api_secret?: string;
  }
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken,
      "api/v1/portal/catalog/sync/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function syncCatalogNow(
  accessToken: string
): Promise<{
  ok: boolean;
  source: string;
  imported: number;
  updated: number;
  pulled: number;
} | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken,
      "api/v1/portal/catalog/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    ok: boolean;
    source: string;
    imported: number;
    updated: number;
    pulled: number;
  } | null;
}

export interface IndustryPreset {
  id: string;
  label: string;
  description: string;
  entryCount: number;
}

export interface ActivityItem {
  id: number;
  action: string;
  label: string;
  note: string;
  conversationId: number | null;
  createdAt: string;
  timeAgo: string;
}

function mapCatalogItem(raw: Record<string, unknown>): CatalogItem {
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    kind: raw.kind === "service" ? "service" : "product",
    name: typeof raw.name === "string" ? raw.name : "",
    priceText: typeof raw.price_text === "string" ? raw.price_text : "",
    notes: typeof raw.notes === "string" ? raw.notes : "",
    isActive: raw.is_active === true,
    price: typeof raw.price === "number" ? raw.price : 0,
    stock: typeof raw.stock === "number" ? raw.stock : 0,
    imageUrl: typeof raw.image_url === "string" ? raw.image_url : "",
    source: typeof raw.source === "string" ? raw.source : "manual",
    syncedAt: typeof raw.synced_at === "string" ? raw.synced_at : null,
    brandId: typeof raw.brand_id === "number" ? raw.brand_id : null,
    brandName: typeof raw.brand_name === "string" ? raw.brand_name : null,
  };
}

export async function getCatalog(
  accessToken: string
): Promise<{ items: CatalogItem[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/catalog");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawItems = (payload as Record<string, unknown>).items;
  if (!Array.isArray(rawItems)) return { items: [] };
  return {
    items: rawItems
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object"
      )
      .map(mapCatalogItem),
  };
}

export async function createCatalogItem(
  accessToken: string,
  item: CatalogItemInput
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        item: {
          kind: item.kind,
          name: item.name,
          price_text: item.priceText,
          notes: item.notes,
          is_active: item.isActive,
          brand_id: item.brandId ?? null,
        },
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function updateCatalogItem(
  accessToken: string,
  itemId: number,
  item: CatalogItemInput
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/catalog/" + itemId,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item: {
            kind: item.kind,
            name: item.name,
            price_text: item.priceText,
            notes: item.notes,
            is_active: item.isActive,
            brand_id: item.brandId ?? null,
          },
        }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function deleteCatalogItem(
  accessToken: string,
  itemId: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/catalog/" + itemId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function getIndustryPresets(
  accessToken: string
): Promise<{ presets: IndustryPreset[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/presets");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawPresets = (payload as Record<string, unknown>).presets;
  if (!Array.isArray(rawPresets)) return { presets: [] };
  return {
    presets: rawPresets
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object"
      )
      .map((raw) => ({
        id: typeof raw.id === "string" ? raw.id : "",
        label: typeof raw.label === "string" ? raw.label : "",
        description: typeof raw.description === "string" ? raw.description : "",
        entryCount: typeof raw.entryCount === "number" ? raw.entryCount : 0,
      })),
  };
}

export async function applyIndustryPreset(
  accessToken: string,
  industry: string
): Promise<
  | { kind: "ok"; applied: number; skipped: number }
  | { kind: "bad_request" }
  | null
> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/presets/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ industry }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "bad_request" };
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  return {
    kind: "ok",
    applied: typeof p.applied === "number" ? p.applied : 0,
    skipped: typeof p.skipped === "number" ? p.skipped : 0,
  };
}

const ACTION_LABELS: Record<string, string> = {
  "kb.auto_reply": "Instant answer sent",
  "message.enqueued": "Reply queued",
  "conversation.status_changed": "Conversation status changed",
  "followup.ack": "Follow-up delivered",
  "preset.applied": "Starter pack loaded",
  "catalog.changed": "Catalog updated",
};

function timeAgoLabel(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  return days + "d ago";
}

export async function getRecentActivity(
  accessToken: string
): Promise<ActivityItem[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/activity");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawItems = (payload as Record<string, unknown>).items;
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .filter(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === "object"
    )
    .map((raw) => {
      const action = typeof raw.action === "string" ? raw.action : "";
      const createdAt =
        typeof raw.created_at === "string" ? raw.created_at : "";
      return {
        id: typeof raw.id === "number" ? raw.id : 0,
        action,
        label: ACTION_LABELS[action] || action,
        note: typeof raw.note === "string" ? raw.note : "",
        conversationId:
          typeof raw.conversation_id === "number" ? raw.conversation_id : null,
        createdAt,
        timeAgo: timeAgoLabel(createdAt),
      };
    });
}

export interface AnalyticsTotals {
  conversations: number;
  conversationsClosed: number;
  customers: number;
  messagesIn: number;
  messagesOut: number;
}

export interface AnalyticsWindow {
  conversations: number;
  messagesIn: number;
  messagesOut: number;
  instantAnswers: number;
  followupsDelivered: number;
  repliesQueued: number;
}

export interface AnalyticsDayPoint {
  day: string;
  inbound: number;
  outbound: number;
}

export interface AnalyticsIntent {
  intent: string;
  count: number;
}

export interface AnalyticsTopEntry {
  title: string;
  usageCount: number;
}

export interface AnalyticsData {
  days: number;
  totals: AnalyticsTotals;
  window: AnalyticsWindow;
  perDay: AnalyticsDayPoint[];
  intents: AnalyticsIntent[];
  topEntries: AnalyticsTopEntry[];
  service: AnalyticsService;
}

export interface AnalyticsService {
  resolutionRate: number | null;
  frtAvgSeconds: number | null;
  frtMedianSeconds: number | null;
  answeredConversations: number;
}

export async function getAnalytics(
  accessToken: string,
  path = "api/v1/portal/analytics"
): Promise<AnalyticsData | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, path);
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const rawTotals = p.totals;
  const rawWindow = p.window;
  const rawPerDay = p.per_day;
  const rawIntents = p.intents;
  const rawTopEntries = p.top_entries;
  if (
    rawTotals === null || typeof rawTotals !== "object" ||
    rawWindow === null || typeof rawWindow !== "object" ||
    !Array.isArray(rawPerDay)
  ) {
    return null;
  }
  const t = rawTotals as Record<string, unknown>;
  const w = rawWindow as Record<string, unknown>;
  const num = (value: unknown): number => (typeof value === "number" ? value : 0);
  const svc =
    p.service !== null && typeof p.service === "object"
      ? (p.service as Record<string, unknown>)
      : {};
  const svcNum = (value: unknown): number | null =>
    typeof value === "number" ? value : null;
  return {
    days: num(p.days) || 7,
    totals: {
      conversations: num(t.conversations),
      conversationsClosed: num(t.conversations_closed),
      customers: num(t.customers),
      messagesIn: num(t.messages_in),
      messagesOut: num(t.messages_out),
    },
    window: {
      conversations: num(w.conversations),
      messagesIn: num(w.messages_in),
      messagesOut: num(w.messages_out),
      instantAnswers: num(w.instant_answers),
      followupsDelivered: num(w.followups_delivered),
      repliesQueued: num(w.replies_queued),
    },
    perDay: rawPerDay
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object"
      )
      .map((raw) => ({
        day: typeof raw.day === "string" ? raw.day : "",
        inbound: num(raw.inbound),
        outbound: num(raw.outbound),
      })),
    intents: Array.isArray(rawIntents)
      ? rawIntents
          .filter(
            (item): item is Record<string, unknown> =>
              item !== null && typeof item === "object"
          )
          .map((raw) => ({
            intent: typeof raw.intent === "string" ? raw.intent : "",
            count: num(raw.count),
          }))
      : [],
    topEntries: Array.isArray(rawTopEntries)
      ? rawTopEntries
          .filter(
            (item): item is Record<string, unknown> =>
              item !== null && typeof item === "object"
          )
          .map((raw) => ({
            title: typeof raw.title === "string" ? raw.title : "",
            usageCount: num(raw.usage_count),
          }))
      : [],
    service: {
      resolutionRate: svcNum(svc.resolution_rate),
      frtAvgSeconds: svcNum(svc.frt_avg_seconds),
      frtMedianSeconds: svcNum(svc.frt_median_seconds),
      answeredConversations: num(svc.answered_conversations),
    },
  };
}

export interface CodConfirmation {
  id: number;
  status: string;
  details: string;
  attempts: number;
  createdAt: string | null;
  answeredAt: string | null;
}

export interface OrderRow {
  id: number;
  code: string;
  statusText: string;
  note: string;
  updatedAt: string | null;
}

export interface OrderImportItem {
  code: string;
  status: string;
  note: string;
}

export async function getConversationCod(
  accessToken: string,
  conversationId: number
): Promise<{ cod: CodConfirmation | null } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" + conversationId + "/cod"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).cod;
  if (raw === null || raw === undefined) return { cod: null };
  if (typeof raw !== "object") return { cod: null };
  const p = raw as Record<string, unknown>;
  return {
    cod: {
      id: typeof p.id === "number" ? p.id : 0,
      status: typeof p.status === "string" ? p.status : "pending",
      details: typeof p.details === "string" ? p.details : "",
      attempts: typeof p.attempts === "number" ? p.attempts : 1,
      createdAt: typeof p.created_at === "string" ? p.created_at : null,
      answeredAt: typeof p.answered_at === "string" ? p.answered_at : null,
    },
  };
}

export async function requestCodConfirmation(
  accessToken: string,
  conversationId: number,
  details: string
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" + conversationId + "/cod",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ details }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function listOrders(
  accessToken: string
): Promise<{ items: OrderRow[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/orders");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawItems = (payload as Record<string, unknown>).items;
  if (!Array.isArray(rawItems)) return { items: [] };
  return {
    items: rawItems
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object"
      )
      .map((raw) => ({
        id: typeof raw.id === "number" ? raw.id : 0,
        code: typeof raw.code === "string" ? raw.code : "",
        statusText: typeof raw.status_text === "string" ? raw.status_text : "",
        note: typeof raw.note === "string" ? raw.note : "",
        updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : null,
      })),
  };
}

export async function importOrders(
  accessToken: string,
  items: OrderImportItem[]
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/orders/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function deleteOrder(
  accessToken: string,
  orderId: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/orders/" + orderId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

// ---------------------------------------------------------------------------
// Team (multi-user roles, assignment) + internal conversation notes
// ---------------------------------------------------------------------------

export type TeamRole = "owner" | "admin" | "agent";

export interface TeamMember {
  id: number;
  email: string;
  name: string;
  role: TeamRole;
  status: string;
  createdAt: string | null;
}

export interface TeamOverview {
  members: TeamMember[];
  myRole: TeamRole | null;
}

export interface NoteEntry {
  id: number;
  authorEmail: string;
  authorName: string;
  body: string;
  createdAt: string | null;
}

export type TeamMutationResult =
  | { kind: "ok"; member: TeamMember | null }
  | { kind: "forbidden" }
  | { kind: "exists" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export type AssignConversationResult =
  | { kind: "ok"; assignedTo: string | null; assigneeName: string | null }
  | { kind: "not_found" }
  | { kind: "assignee_not_found" }
  | { kind: "unavailable" };

export type NoteAddResult =
  | { kind: "ok"; note: NoteEntry | null }
  | { kind: "not_found" }
  | { kind: "unavailable" };

function normalizeTeamMember(value: unknown): TeamMember | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  const email = typeof p.email === "string" ? p.email : "";
  if (id === null || !email) return null;
  const role: TeamRole = p.role === "owner" || p.role === "admin" ? p.role : "agent";
  return {
    id,
    email,
    name: typeof p.name === "string" ? p.name : "",
    role,
    status: p.status === "disabled" ? "disabled" : "active",
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
  };
}

function normalizeNoteEntry(value: unknown): NoteEntry | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  if (id === null) return null;
  return {
    id,
    authorEmail: typeof p.author_email === "string" ? p.author_email : "",
    authorName: typeof p.author_name === "string" ? p.author_name : "",
    body: typeof p.body === "string" ? p.body : "",
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
  };
}

export async function listTeam(
  accessToken: string
): Promise<TeamOverview | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/team");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const rawMembers = Array.isArray(p.members) ? p.members : [];
  const members: TeamMember[] = [];
  for (const raw of rawMembers) {
    const member = normalizeTeamMember(raw);
    if (member) members.push(member);
  }
  const myRole =
    p.my_role === "owner" || p.my_role === "admin" || p.my_role === "agent"
      ? p.my_role
      : null;
  return { members, myRole };
}

async function teamMutation(
  accessToken: string,
  path: string,
  init: RequestInit
): Promise<TeamMutationResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, path, init);
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 403) return { kind: "forbidden" };
  if (response.status === 409) return { kind: "exists" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") {
    return { kind: "ok", member: null };
  }
  const member = normalizeTeamMember(
    (payload as Record<string, unknown>).member
  );
  return { kind: "ok", member };
}

export async function addTeamMember(
  accessToken: string,
  email: string,
  name: string,
  role: "admin" | "agent"
): Promise<TeamMutationResult> {
  return teamMutation(accessToken, "api/v1/portal/team", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name, role }),
  });
}

export async function updateTeamMember(
  accessToken: string,
  memberId: number,
  patch: { role?: string; status?: string }
): Promise<TeamMutationResult> {
  return teamMutation(
    accessToken,
    "api/v1/portal/team/" + encodeURIComponent(String(memberId)),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }
  );
}

export async function removeTeamMember(
  accessToken: string,
  memberId: number
): Promise<TeamMutationResult> {
  return teamMutation(
    accessToken,
    "api/v1/portal/team/" + encodeURIComponent(String(memberId)),
    { method: "DELETE" }
  );
}

export async function assignConversation(
  accessToken: string,
  conversationId: number,
  assigneeEmail: string | null
): Promise<AssignConversationResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/assign",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignee_email: assigneeEmail }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) {
    const payload: unknown = await response.json().catch(() => null);
    const code =
      payload !== null && typeof payload === "object"
        ? (payload as Record<string, unknown>).error
        : null;
    const errorCode =
      code !== null && typeof code === "object"
        ? (code as Record<string, unknown>).code
        : null;
    if (errorCode === "assignee_not_found") return { kind: "assignee_not_found" };
    return { kind: "not_found" };
  }
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") {
    return { kind: "unavailable" };
  }
  const p = payload as Record<string, unknown>;
  return {
    kind: "ok",
    assignedTo: typeof p.assigned_to === "string" ? p.assigned_to : null,
    assigneeName: typeof p.assignee_name === "string" ? p.assignee_name : null,
  };
}

export async function listConversationNotes(
  accessToken: string,
  conversationId: number
): Promise<{ notes: NoteEntry[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/notes"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawNotes = (payload as Record<string, unknown>).notes;
  if (!Array.isArray(rawNotes)) return { notes: [] };
  const notes: NoteEntry[] = [];
  for (const raw of rawNotes) {
    const note = normalizeNoteEntry(raw);
    if (note) notes.push(note);
  }
  return { notes };
}

export async function addConversationNote(
  accessToken: string,
  conversationId: number,
  body: string
): Promise<NoteAddResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/notes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") {
    return { kind: "ok", note: null };
  }
  const note = normalizeNoteEntry((payload as Record<string, unknown>).note);
  return { kind: "ok", note };
}

// ---------------------------------------------------------------------------
// Team: agent performance (last N days, deterministic)
// ---------------------------------------------------------------------------

export interface TeamPerformanceMember {
  id: number;
  email: string;
  name: string;
  role: TeamRole;
  status: string;
  repliesSent: number;
  conversationsTouched: number;
  notesAdded: number;
  assignedOpen: number;
}

export interface CsatLowBucket {
  score: number;
  count: number;
}

export interface CsatRecentRating {
  score: number;
  at: string;
}

export interface TeamPerformanceBoard {
  openConversations: number;
  unassignedOpen: number;
  repliesSent: number;
  csatAvg: number | null;
  csatAnswered: number;
  csatDist: number[];
  csatLow: CsatLowBucket[];
  csatRecent: CsatRecentRating[];
}

export interface TeamPerformanceData {
  windowDays: number;
  members: TeamPerformanceMember[];
  board: TeamPerformanceBoard;
}

function normalizePerformanceMember(value: unknown): TeamPerformanceMember | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  const email = typeof p.email === "string" ? p.email : "";
  if (id === null || !email) return null;
  const role: TeamRole = p.role === "owner" || p.role === "admin" ? p.role : "agent";
  return {
    id,
    email,
    name: typeof p.name === "string" ? p.name : "",
    role,
    status: p.status === "disabled" ? "disabled" : "active",
    repliesSent: typeof p.replies_sent === "number" ? p.replies_sent : 0,
    conversationsTouched:
      typeof p.conversations_touched === "number" ? p.conversations_touched : 0,
    notesAdded: typeof p.notes_added === "number" ? p.notes_added : 0,
    assignedOpen: typeof p.assigned_open === "number" ? p.assigned_open : 0,
  };
}

export async function getTeamPerformance(
  accessToken: string
): Promise<TeamPerformanceData | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/team/performance");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const rawMembers = p.members;
  const members: TeamPerformanceMember[] = [];
  if (Array.isArray(rawMembers)) {
    for (const raw of rawMembers) {
      const row = normalizePerformanceMember(raw);
      if (row) members.push(row);
    }
  }
  const boardRaw =
    p.board !== null && typeof p.board === "object"
      ? (p.board as Record<string, unknown>)
      : {};
  return {
    windowDays: typeof p.window_days === "number" ? p.window_days : 7,
    members,
    board: {
      openConversations:
        typeof boardRaw.open_conversations === "number"
          ? boardRaw.open_conversations
          : 0,
      unassignedOpen:
        typeof boardRaw.unassigned_open === "number" ? boardRaw.unassigned_open : 0,
      repliesSent: typeof boardRaw.replies_sent === "number" ? boardRaw.replies_sent : 0,
      csatAvg: typeof boardRaw.csat_avg === "number" ? boardRaw.csat_avg : null,
      csatAnswered:
        typeof boardRaw.csat_answered === "number" ? boardRaw.csat_answered : 0,
      csatDist:
        Array.isArray(boardRaw.csat_dist) && boardRaw.csat_dist.length === 5
          ? boardRaw.csat_dist.map((value) => (typeof value === "number" ? value : 0))
          : [0, 0, 0, 0, 0],
      csatLow: Array.isArray(boardRaw.csat_low)
        ? boardRaw.csat_low
            .map((bucket) => ({
              score: typeof bucket.score === "number" ? bucket.score : 0,
              count: typeof bucket.count === "number" ? bucket.count : 0,
            }))
            .filter((bucket) => bucket.score > 0 && bucket.count > 0)
        : [],
      csatRecent: Array.isArray(boardRaw.csat_recent)
        ? boardRaw.csat_recent
            .map((entry) => ({
              score: typeof entry.score === "number" ? entry.score : 0,
              at: typeof entry.at === "string" ? entry.at : "",
            }))
            .filter((entry) => entry.score > 0 && entry.at)
        : [],
    },
  };
}

// ---------------------------------------------------------------------------
// Overview: live command center (deterministic, 24h window)
// ---------------------------------------------------------------------------

export interface OverviewHotLead {
  id: number;
  contactId: string;
  contactName: string;
  leadScore: number | null;
  preview: string | null;
  lastMessageAt: string | null;
}

export interface OverviewData {
  newChats: number;
  inboundMessages: number;
  teamReplies: number;
  openNow: number;
  unassignedOpen: number;
  needsReplyOpen: number;
  needsReplyOverdue: number;
  hotLeads: OverviewHotLead[];
}

function normalizeOverviewHotLead(value: unknown): OverviewHotLead | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  const contactId = typeof p.contact_id === "string" ? p.contact_id : "";
  if (id === null || !contactId) return null;
  return {
    id,
    contactId,
    contactName: typeof p.contact_name === "string" ? p.contact_name : "",
    leadScore: typeof p.lead_score === "number" ? p.lead_score : null,
    preview: typeof p.preview === "string" ? p.preview : null,
    lastMessageAt:
      typeof p.last_message_at === "string" ? p.last_message_at : null,
  };
}

export async function getOverview(
  accessToken: string
): Promise<OverviewData | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/overview");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const stats =
    p.stats !== null && typeof p.stats === "object"
      ? (p.stats as Record<string, unknown>)
      : {};
  const rawLeads = p.hot_leads;
  const hotLeads: OverviewHotLead[] = [];
  if (Array.isArray(rawLeads)) {
    for (const raw of rawLeads) {
      const lead = normalizeOverviewHotLead(raw);
      if (lead) hotLeads.push(lead);
    }
  }
  return {
    newChats: typeof stats.new_chats === "number" ? stats.new_chats : 0,
    inboundMessages:
      typeof stats.inbound_messages === "number" ? stats.inbound_messages : 0,
    teamReplies: typeof stats.team_replies === "number" ? stats.team_replies : 0,
    openNow: typeof stats.open_now === "number" ? stats.open_now : 0,
    unassignedOpen:
      typeof stats.unassigned_open === "number" ? stats.unassigned_open : 0,
    needsReplyOpen:
      typeof stats.needs_reply_open === "number" ? stats.needs_reply_open : 0,
    needsReplyOverdue:
      typeof stats.needs_reply_overdue === "number" ? stats.needs_reply_overdue : 0,
    hotLeads,
  };
}

// ---------------------------------------------------------------------------
// Automations: welcome message (new-conversation greeting)
// ---------------------------------------------------------------------------

export interface WelcomeAutomationSettings {
  enabled: boolean;
  text: string;
}

export type WelcomeSaveResult =
  | { kind: "ok"; enabled: boolean; text: string }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function getWelcomeAutomation(
  accessToken: string
): Promise<WelcomeAutomationSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/automations/welcome");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  return {
    enabled: p.enabled === true,
    text: typeof p.text === "string" ? p.text : "",
  };
}

export async function saveWelcomeAutomation(
  accessToken: string,
  enabled: boolean,
  text: string
): Promise<WelcomeSaveResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/automations/welcome", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, text }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  return { kind: "ok", enabled: p.enabled === true, text: typeof p.text === "string" ? p.text : "" };
}

// ---------------------------------------------------------------------------
// Automations: auto-close idle chats (deterministic sweep)
// ---------------------------------------------------------------------------

export interface AutoCloseSettings {
  enabled: boolean;
  hours: number;
}

export type AutoCloseSaveResult =
  | { kind: "ok"; enabled: boolean; hours: number }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function getAutoClose(
  accessToken: string
): Promise<AutoCloseSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/automations/autoclose");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  return {
    enabled: p.enabled === true,
    hours: typeof p.hours === "number" && p.hours > 0 ? p.hours : 48,
  };
}

export async function saveAutoClose(
  accessToken: string,
  enabled: boolean,
  hours: number
): Promise<AutoCloseSaveResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/automations/autoclose", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, hours }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  return {
    kind: "ok",
    enabled: p.enabled === true,
    hours: typeof p.hours === "number" && p.hours > 0 ? p.hours : 48,
  };
}

// ---------------------------------------------------------------------------
// Automations: auto-assign new chats (least-loaded teammate)
// ---------------------------------------------------------------------------

export interface AutoAssignSettings {
  enabled: boolean;
}

export type AutoAssignSaveResult =
  | { kind: "ok"; enabled: boolean }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function getAutoAssign(
  accessToken: string
): Promise<AutoAssignSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/automations/autoassign");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  return { enabled: p.enabled === true };
}

export async function saveAutoAssign(
  accessToken: string,
  enabled: boolean
): Promise<AutoAssignSaveResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/automations/autoassign", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  return { kind: "ok", enabled: p.enabled === true };
}

// ---------------------------------------------------------------------------
// Customers: contact-level notes (CRM)
// ---------------------------------------------------------------------------

export interface CustomerNote {
  id: number;
  body: string;
  authorEmail: string;
  authorName: string;
  createdAt: string | null;
}

function normalizeCustomerNote(value: unknown): CustomerNote | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  const body = typeof p.body === "string" ? p.body : "";
  if (id === null || !body) return null;
  return {
    id,
    body,
    authorEmail: typeof p.author_email === "string" ? p.author_email : "",
    authorName: typeof p.author_name === "string" ? p.author_name : "",
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
  };
}

export async function listCustomerNotes(
  accessToken: string,
  contactId: string
): Promise<CustomerNote[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/customers/notes?contact_id=" +
        encodeURIComponent(contactId.slice(0, 120))
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawNotes = (payload as Record<string, unknown>).notes;
  if (!Array.isArray(rawNotes)) return [];
  const notes: CustomerNote[] = [];
  for (const raw of rawNotes) {
    const note = normalizeCustomerNote(raw);
    if (note) notes.push(note);
  }
  return notes;
}

export type CustomerNoteAddResult =
  | { kind: "ok"; note: CustomerNote }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function addCustomerNote(
  accessToken: string,
  contactId: string,
  body: string
): Promise<CustomerNoteAddResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/customers/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_id: contactId.slice(0, 120), body }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const note = normalizeCustomerNote((payload as Record<string, unknown>).note);
  if (!note) return { kind: "unavailable" };
  return { kind: "ok", note };
}

export type CustomerNoteDeleteResult =
  | { kind: "ok" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function deleteCustomerNote(
  accessToken: string,
  noteId: number
): Promise<CustomerNoteDeleteResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/customers/notes/" + encodeURIComponent(String(noteId)),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  return response.ok ? { kind: "ok" } : { kind: "unavailable" };
}

export type CustomerMessageResult =
  | { kind: "ok"; commandId: number | null }
  | { kind: "not_found" }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function sendCustomerMessage(
  accessToken: string,
  contactId: string,
  body: string
): Promise<CustomerMessageResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/customers/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_id: contactId.slice(0, 120), body }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  const p =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  return {
    kind: "ok",
    commandId: typeof p.command_id === "number" ? p.command_id : null,
  };
}

// ---------------------------------------------------------------------------
// Growth: broadcasts, KB gap report, CSAT ratings
// ---------------------------------------------------------------------------

export type BroadcastAudience = "all" | "open" | "hot";

export interface BroadcastPreview {
  audience: BroadcastAudience;
  count: number;
  sample: string[];
}

export interface BroadcastRow {
  id: number;
  audience: BroadcastAudience;
  body: string;
  recipientCount: number;
  createdAt: string | null;
  queued: number | null;
  done: number | null;
  failed: number | null;
}

export interface CsatRequest {
  id: number;
  score: number | null;
  requestedAt: string | null;
  answeredAt: string | null;
}

export interface CsatSummary {
  average: number | null;
  total: number;
  pending: number;
  dist: number[];
}

export interface KbGap {
  id: number;
  conversationId: number;
  question: string;
  intent: string;
  resolved: boolean;
  createdAt: string | null;
}

function normalizeBroadcast(value: unknown): BroadcastRow | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  if (id === null) return null;
  const audience: BroadcastAudience =
    p.audience === "open" || p.audience === "hot" ? p.audience : "all";
  return {
    id,
    audience,
    body: typeof p.body === "string" ? p.body : "",
    recipientCount: typeof p.recipient_count === "number" ? p.recipient_count : 0,
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
    queued: typeof p.queued === "number" ? p.queued : null,
    done: typeof p.done === "number" ? p.done : null,
    failed: typeof p.failed === "number" ? p.failed : null,
  };
}

export async function listBroadcasts(
  accessToken: string
): Promise<{ broadcasts: BroadcastRow[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/broadcasts");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawItems = (payload as Record<string, unknown>).broadcasts;
  if (!Array.isArray(rawItems)) return { broadcasts: [] };
  const broadcasts: BroadcastRow[] = [];
  for (const raw of rawItems) {
    const row = normalizeBroadcast(raw);
    if (row) broadcasts.push(row);
  }
  return { broadcasts };
}

export async function previewBroadcast(
  accessToken: string,
  audience: BroadcastAudience
): Promise<BroadcastPreview | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/broadcasts/preview?audience=" + encodeURIComponent(audience)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  return {
    audience:
      p.audience === "open" || p.audience === "hot"
        ? p.audience
        : "all",
    count: typeof p.count === "number" ? p.count : 0,
    sample: Array.isArray(p.sample)
      ? p.sample.filter((item): item is string => typeof item === "string")
      : [],
  };
}

export type BroadcastSendResult =
  | { kind: "ok"; broadcast: BroadcastRow; recipients: number }
  | { kind: "no_recipients" }
  | { kind: "too_many" }
  | { kind: "unavailable" };

export async function sendBroadcast(
  accessToken: string,
  audience: BroadcastAudience,
  body: string
): Promise<BroadcastSendResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/broadcasts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audience, body }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) {
    const payload: unknown = await response.json().catch(() => null);
    const code =
      payload !== null && typeof payload === "object"
        ? ((payload as Record<string, unknown>).error as Record<string, unknown> | undefined)
            ?.code
        : null;
    if (code === "no_recipients") return { kind: "no_recipients" };
    if (code === "too_many_recipients") return { kind: "too_many" };
    return { kind: "unavailable" };
  }
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  const broadcast = normalizeBroadcast(p.broadcast);
  if (!broadcast) return { kind: "unavailable" };
  return {
    kind: "ok",
    broadcast,
    recipients: typeof p.recipients === "number" ? p.recipients : broadcast.recipientCount,
  };
}

export type CsatRequestResult =
  | { kind: "ok"; csat: CsatRequest }
  | { kind: "not_found" }
  | { kind: "unavailable" };

function normalizeCsat(value: unknown): CsatRequest | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  if (id === null) return null;
  return {
    id,
    score: typeof p.score === "number" ? p.score : null,
    requestedAt: typeof p.requested_at === "string" ? p.requested_at : null,
    answeredAt: typeof p.answered_at === "string" ? p.answered_at : null,
  };
}

export async function requestCsat(
  accessToken: string,
  conversationId: number
): Promise<CsatRequestResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/csat",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const csat = normalizeCsat((payload as Record<string, unknown>).csat);
  if (!csat) return { kind: "unavailable" };
  return { kind: "ok", csat };
}

export async function getConversationCsat(
  accessToken: string,
  conversationId: number
): Promise<{ csat: CsatRequest | null } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/csat"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { csat: null };
  return { csat: normalizeCsat((payload as Record<string, unknown>).csat) };
}

export async function getCsatSummary(
  accessToken: string
): Promise<CsatSummary | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/csat/summary");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const rawDist = Array.isArray(p.dist) ? p.dist : [];
  const dist = [0, 1, 2, 3, 4].map(
    (index) => (typeof rawDist[index] === "number" ? rawDist[index] : 0) as number
  );
  return {
    average: typeof p.average === "number" ? p.average : null,
    total: typeof p.total === "number" ? p.total : 0,
    pending: typeof p.pending === "number" ? p.pending : 0,
    dist,
  };
}

export async function listKbGaps(
  accessToken: string,
  status: "open" | "all" = "open"
): Promise<{ gaps: KbGap[]; openCount: number } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/kb/gaps?status=" + encodeURIComponent(status)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const rawGaps = Array.isArray(p.gaps) ? p.gaps : [];
  const gaps: KbGap[] = [];
  for (const raw of rawGaps) {
    if (raw === null || typeof raw !== "object") continue;
    const g = raw as Record<string, unknown>;
    const id = typeof g.id === "number" ? g.id : null;
    if (id === null) continue;
    gaps.push({
      id,
      conversationId: typeof g.conversation_id === "number" ? g.conversation_id : 0,
      question: typeof g.question === "string" ? g.question : "",
      intent: typeof g.intent === "string" ? g.intent : "general",
      resolved: g.resolved === true || g.resolved === 1,
      createdAt: typeof g.created_at === "string" ? g.created_at : null,
    });
  }
  return {
    gaps,
    openCount: typeof p.open_count === "number" ? p.open_count : 0,
  };
}

export async function resolveKbGap(
  accessToken: string,
  gapId: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/kb/gaps/" + encodeURIComponent(String(gapId)),
      { method: "PATCH" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

// ---------------------------------------------------------------------------
// Website widget settings
// ---------------------------------------------------------------------------

export interface WidgetSettings {
  enabled: boolean;
  businessName: string;
  welcomeText: string;
  accent: string;
  position: "left" | "right";
  launcherLabel: string;
}

function normalizeWidgetSettings(value: unknown): WidgetSettings | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const settings = (p.settings !== undefined ? p.settings : p) as Record<string, unknown>;
  return {
    enabled: settings.enabled === true,
    businessName:
      typeof settings.business_name === "string" ? settings.business_name : "",
    welcomeText:
      typeof settings.welcome_text === "string" ? settings.welcome_text : "",
    accent:
      typeof settings.accent === "string" &&
      /^#[0-9a-fA-F]{6}$/.test(settings.accent)
        ? settings.accent
        : "#22d3ee",
    position: settings.position === "left" ? "left" : "right",
    launcherLabel:
      typeof settings.launcher_label === "string" ? settings.launcher_label : "",
  };
}

export async function getWidgetSettings(
  accessToken: string
): Promise<WidgetSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/widget/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  return normalizeWidgetSettings(payload);
}

export async function saveWidgetSettings(
  accessToken: string,
  settings: {
    enabled: boolean;
    businessName: string;
    welcomeText: string;
    accent: string;
    position: "left" | "right";
    launcherLabel: string;
  }
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/widget/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: settings.enabled,
        business_name: settings.businessName,
        welcome_text: settings.welcomeText,
        accent: settings.accent,
        position: settings.position,
        launcher_label: settings.launcherLabel,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

// ---------------------------------------------------------------------------
// Conversation tags (labels)
// ---------------------------------------------------------------------------

export interface ConversationTagSummary {
  tag: string;
  count: number;
}

export async function getConversationTagSummary(
  accessToken: string
): Promise<ConversationTagSummary[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/tags/summary"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rows = (payload as Record<string, unknown>).tags;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(
      (row): row is Record<string, unknown> =>
        row !== null && typeof row === "object"
    )
    .map((row) => ({
      tag: typeof row.tag === "string" ? row.tag : "",
      count: typeof row.count === "number" ? row.count : 0,
    }))
    .filter((row) => row.tag !== "");
}

export type ConversationTagWriteResult =
  | { kind: "ok"; duplicate: boolean }
  | { kind: "invalid" }
  | { kind: "limit_reached" };

export async function addConversationTag(
  accessToken: string,
  conversationId: number,
  tag: string
): Promise<ConversationTagWriteResult | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" + conversationId + "/tags",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 409) return { kind: "limit_reached" };
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  const duplicate =
    payload !== null &&
    typeof payload === "object" &&
    (payload as Record<string, unknown>).duplicate === true;
  return { kind: "ok", duplicate };
}

export async function removeConversationTag(
  accessToken: string,
  conversationId: number,
  tag: string
): Promise<"ok" | "missing" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        conversationId +
        "/tags?tag=" +
        encodeURIComponent(tag),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return "missing";
  return response.ok ? "ok" : null;
}

// ---------------------------------------------------------------------------
// Saved replies (canned response templates)
// ---------------------------------------------------------------------------

export interface SavedReply {
  id: number;
  shortcut: string;
  body: string;
  createdAt: string | null;
  useCount: number;
  lastUsedAt: string | null;
}

function normalizeSavedReply(value: unknown): SavedReply | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  if (id === null) return null;
  return {
    id,
    shortcut: typeof p.shortcut === "string" ? p.shortcut : "",
    body: typeof p.body === "string" ? p.body : "",
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
    useCount: typeof p.use_count === "number" ? p.use_count : 0,
    lastUsedAt: typeof p.last_used_at === "string" ? p.last_used_at : null,
  };
}

export async function listSavedReplies(
  accessToken: string
): Promise<SavedReply[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/saved-replies");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rows = (payload as Record<string, unknown>).replies;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => normalizeSavedReply(row))
    .filter((row): row is SavedReply => row !== null);
}

export type SavedReplyWriteResult =
  | { kind: "ok"; reply: SavedReply }
  | { kind: "invalid" }
  | { kind: "duplicate" }
  | { kind: "limit_reached" };

export async function createSavedReply(
  accessToken: string,
  shortcut: string,
  body: string
): Promise<SavedReplyWriteResult | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/saved-replies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shortcut, body }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 409) {
    const payload: unknown = await response.json().catch(() => null);
    const code =
      payload !== null &&
      typeof payload === "object" &&
      (payload as Record<string, unknown>).error !== null &&
      typeof (payload as Record<string, unknown>).error === "object" &&
      ((payload as Record<string, unknown>).error as Record<string, unknown>)
        .code === "limit_reached"
        ? "limit_reached"
        : "duplicate";
    return { kind: code };
  }
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const reply = normalizeSavedReply(
    (payload as Record<string, unknown>).reply
  );
  if (reply === null) return null;
  return { kind: "ok", reply };
}

export async function deleteSavedReply(
  accessToken: string,
  replyId: number
): Promise<"ok" | "missing" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/saved-replies/" + replyId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return "missing";
  return response.ok ? "ok" : null;
}

// ---------------------------------------------------------------------------
// Conversation export (CSV download source)
// ---------------------------------------------------------------------------

export interface ConversationExportFilters {
  ids?: number[];
  searchQuery?: string;
  statusFilter?: string;
  intentFilter?: string;
  channelFilter?: string;
  tagFilter?: string;
}

export async function exportConversations(
  accessToken: string,
  filters: ConversationExportFilters = {}
): Promise<ConversationSummary[] | null> {
  const parts: string[] = [];
  if (filters.ids && filters.ids.length) {
    parts.push("ids=" + filters.ids.slice(0, 100).join(","));
  }
  if (filters.searchQuery) {
    parts.push("q=" + encodeURIComponent(filters.searchQuery));
  }
  if (filters.statusFilter && filters.statusFilter !== "all") {
    parts.push("status=" + encodeURIComponent(filters.statusFilter));
  }
  if (filters.intentFilter && filters.intentFilter !== "all") {
    parts.push("intent=" + encodeURIComponent(filters.intentFilter));
  }
  if (filters.channelFilter && filters.channelFilter !== "all") {
    parts.push("channel=" + encodeURIComponent(filters.channelFilter));
  }
  if (filters.tagFilter && filters.tagFilter !== "all") {
    parts.push("tag=" + encodeURIComponent(filters.tagFilter));
  }
  const query = parts.length ? "?" + parts.join("&") : "";

  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/export" + query
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rows = (payload as Record<string, unknown>).conversations;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => normalizeConversation(row))
    .filter((row): row is ConversationSummary => row !== null);
}

// ---------------------------------------------------------------------------
// Customers (contacts aggregated across conversations)
// ---------------------------------------------------------------------------

export interface CustomerSummary {
  contactId: string;
  name: string;
  channels: string[];
  conversationCount: number;
  openCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  leadTemp: string;
  tags: string[];
}

function normalizeCustomer(value: unknown): CustomerSummary | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const contactId =
    typeof p.contact_id === "string" ? p.contact_id : "";
  if (!contactId) return null;
  return {
    contactId,
    name: typeof p.name === "string" ? p.name : "",
    channels: Array.isArray(p.channels)
      ? p.channels.filter((c): c is string => typeof c === "string")
      : [],
    conversationCount:
      typeof p.conversation_count === "number" ? p.conversation_count : 0,
    openCount: typeof p.open_count === "number" ? p.open_count : 0,
    lastMessageAt:
      typeof p.last_message_at === "string" ? p.last_message_at : null,
    lastMessagePreview:
      typeof p.last_message_preview === "string"
        ? p.last_message_preview
        : null,
    leadTemp: typeof p.lead_temp === "string" ? p.lead_temp : "cold",
    tags: Array.isArray(p.tags)
      ? p.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
  };
}

export async function listCustomers(
  accessToken: string,
  searchQuery?: string,
  channelFilter?: string
): Promise<CustomerSummary[] | null> {
  const parts: string[] = [];
  if (searchQuery) parts.push("q=" + encodeURIComponent(searchQuery));
  if (channelFilter && channelFilter !== "all") {
    parts.push("channel=" + encodeURIComponent(channelFilter));
  }
  const query = parts.length ? "?" + parts.join("&") : "";

  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/customers" + query
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rows = (payload as Record<string, unknown>).customers;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => normalizeCustomer(row))
    .filter((row): row is CustomerSummary => row !== null);
}

// ---------------------------------------------------------------------------
// Automations (deterministic keyword rules)
// ---------------------------------------------------------------------------

export interface AutomationRule {
  id: number;
  keyword: string;
  actionType: "add_tag" | "assign";
  actionValue: string;
  isActive: boolean;
  timesTriggered: number;
  createdAt: string | null;
}

function normalizeAutomation(value: unknown): AutomationRule | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  if (id === null) return null;
  return {
    id,
    keyword: typeof p.keyword === "string" ? p.keyword : "",
    actionType: p.action_type === "assign" ? "assign" : "add_tag",
    actionValue: typeof p.action_value === "string" ? p.action_value : "",
    isActive: p.is_active === true,
    timesTriggered: typeof p.times_triggered === "number" ? p.times_triggered : 0,
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
  };
}

export async function listAutomations(
  accessToken: string
): Promise<AutomationRule[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/automations");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rows = (payload as Record<string, unknown>).automations;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => normalizeAutomation(row))
    .filter((row): row is AutomationRule => row !== null);
}

export type AutomationWriteResult =
  | { kind: "ok"; automation: AutomationRule }
  | { kind: "invalid" }
  | { kind: "assignee_not_found" }
  | { kind: "duplicate" }
  | { kind: "limit_reached" };

export async function createAutomation(
  accessToken: string,
  keyword: string,
  actionType: "add_tag" | "assign",
  actionValue: string
): Promise<AutomationWriteResult | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keyword,
        action_type: actionType,
        action_value: actionValue,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) {
    const payload: unknown = await response.json().catch(() => null);
    const code =
      payload !== null && typeof payload === "object"
        ? (payload as Record<string, unknown>).error
        : null;
    const errorCode =
      code !== null && typeof code === "object"
        ? (code as Record<string, unknown>).code
        : null;
    if (errorCode === "assignee_not_found") return { kind: "assignee_not_found" };
    return { kind: "invalid" };
  }
  if (response.status === 409) {
    const payload: unknown = await response.json().catch(() => null);
    const error = payload as {
      error?: { code?: string };
    } | null;
    if (error?.error?.code === "limit_reached") return { kind: "limit_reached" };
    return { kind: "duplicate" };
  }
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const automation = normalizeAutomation(
    (payload as Record<string, unknown>).automation
  );
  if (automation === null) return null;
  return { kind: "ok", automation };
}

export async function setAutomationActive(
  accessToken: string,
  ruleId: number,
  isActive: boolean
): Promise<"ok" | "missing" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/automations/" + ruleId,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: isActive }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return "missing";
  return response.ok ? "ok" : null;
}

export async function deleteAutomation(
  accessToken: string,
  ruleId: number
): Promise<"ok" | "missing" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/automations/" + ruleId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return "missing";
  return response.ok ? "ok" : null;
}

export interface ScheduledBroadcast {
  id: number;
  audience: string;
  body: string;
  recipientCount: number;
  sendAt: string;
  createdAt: string;
}

function normalizeScheduledBroadcast(payload: unknown): ScheduledBroadcast | null {
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const id = typeof row.id === "number" ? row.id : 0;
  if (!id) return null;
  return {
    id,
    audience: typeof row.audience === "string" ? row.audience : "all",
    body: typeof row.body === "string" ? row.body : "",
    recipientCount: typeof row.recipient_count === "number" ? row.recipient_count : 0,
    sendAt: typeof row.send_at === "string" ? row.send_at : "",
    createdAt: typeof row.created_at === "string" ? row.created_at : "",
  };
}

export async function listScheduledBroadcasts(
  accessToken: string
): Promise<ScheduledBroadcast[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/broadcasts/scheduled");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).scheduled;
  if (!Array.isArray(rawList)) return null;
  const scheduled: ScheduledBroadcast[] = [];
  for (const item of rawList) {
    const normalized = normalizeScheduledBroadcast(item);
    if (normalized) scheduled.push(normalized);
  }
  return scheduled;
}

export type ScheduleBroadcastResult =
  | { kind: "ok"; scheduled: ScheduledBroadcast }
  | { kind: "no_recipients" }
  | { kind: "too_many_recipients" }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function scheduleBroadcast(
  accessToken: string,
  audience: string,
  body: string,
  sendAtIso: string
): Promise<ScheduleBroadcastResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/broadcasts/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audience, body, send_at: sendAtIso }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) {
    const payload: unknown = await response.json().catch(() => null);
    const code =
      payload !== null && typeof payload === "object"
        ? ((payload as Record<string, unknown>).error as Record<string, unknown> | undefined)
            ?.code
        : null;
    if (code === "no_recipients") return { kind: "no_recipients" };
    if (code === "too_many_recipients") return { kind: "too_many_recipients" };
    return { kind: "invalid" };
  }
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const scheduled = normalizeScheduledBroadcast(
    (payload as Record<string, unknown>).scheduled
  );
  if (!scheduled) return { kind: "unavailable" };
  return { kind: "ok", scheduled };
}

export async function cancelScheduledBroadcast(
  accessToken: string,
  id: number
): Promise<{ kind: "ok" } | { kind: "not_found" } | { kind: "unavailable" }> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/broadcasts/scheduled/" + String(id),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export interface CodSettings {
  enabled: boolean;
  template: string;
}

export interface CodRequest {
  id: number;
  conversationId: number | null;
  contactId: string;
  contactName: string | null;
  status: "pending" | "confirmed" | "declined";
  createdAt: string;
  answeredAt: string | null;
}

export async function getCodSettings(
  accessToken: string
): Promise<CodSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/cod/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).settings;
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  return {
    enabled: row.enabled === true,
    template: typeof row.template === "string" ? row.template : "",
  };
}

export async function saveCodSettings(
  accessToken: string,
  settings: CodSettings
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/cod/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: settings.enabled, template: settings.template }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

function normalizeCodRequest(payload: unknown): CodRequest | null {
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const id = typeof row.id === "number" ? row.id : 0;
  if (!id) return null;
  const status =
    row.status === "confirmed" || row.status === "declined" ? row.status : "pending";
  return {
    id,
    conversationId: typeof row.conversation_id === "number" ? row.conversation_id : null,
    contactId: typeof row.contact_id === "string" ? row.contact_id : "",
    contactName: typeof row.contact_name === "string" ? row.contact_name : null,
    status,
    createdAt: typeof row.created_at === "string" ? row.created_at : "",
    answeredAt: typeof row.answered_at === "string" ? row.answered_at : null,
  };
}

export async function listCodRequests(
  accessToken: string,
  status: "all" | "pending" | "confirmed" | "declined"
): Promise<{ requests: CodRequest[]; counts: Record<string, number> } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/cod/requests?status=" + encodeURIComponent(status)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const rawList = p.requests;
  if (!Array.isArray(rawList)) return null;
  const requests: CodRequest[] = [];
  for (const item of rawList) {
    const normalized = normalizeCodRequest(item);
    if (normalized) requests.push(normalized);
  }
  const counts =
    p.counts !== null && typeof p.counts === "object"
      ? (p.counts as Record<string, unknown>)
      : {};
  const safeCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === "number") safeCounts[key] = value;
  }
  return { requests, counts: safeCounts };
}

export interface ImportedCustomerRow {
  name?: string;
  phone: string;
}

export interface CustomerImportResult {
  created: number;
  merged: number;
  invalid: { row: number; reason: string }[];
  invalid_count: number;
}

export async function importCustomers(
  accessToken: string,
  customers: ImportedCustomerRow[]
): Promise<CustomerImportResult | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/customers/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customers }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  return {
    created: typeof p.created === "number" ? p.created : 0,
    merged: typeof p.merged === "number" ? p.merged : 0,
    invalid: Array.isArray(p.invalid)
      ? (p.invalid as { row: number; reason: string }[])
      : [],
    invalid_count: typeof p.invalid_count === "number" ? p.invalid_count : 0,
  };
}

export type SavedReplyMutation =
  | { kind: "ok"; reply?: SavedReply }
  | { kind: "invalid" }
  | { kind: "duplicate" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function updateSavedReply(
  accessToken: string,
  id: number,
  shortcut: string,
  body: string
): Promise<SavedReplyMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/saved-replies/" + String(id),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shortcut, body }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 409) return { kind: "duplicate" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  if (payload !== null && typeof payload === "object") {
    const raw = (payload as Record<string, unknown>).reply;
    if (raw !== null && typeof raw === "object") {
      const row = raw as Record<string, unknown>;
      if (typeof row.id === "number") {
        return {
          kind: "ok",
          reply: {
            id: row.id,
            shortcut: typeof row.shortcut === "string" ? row.shortcut : "",
            body: typeof row.body === "string" ? row.body : "",
            createdAt:
              typeof row.created_at === "string" ? row.created_at : null,
            useCount: typeof row.use_count === "number" ? row.use_count : 0,
            lastUsedAt:
              typeof row.last_used_at === "string" ? row.last_used_at : null,
          },
        };
      }
    }
  }
  return { kind: "ok" };
}

export async function markSavedReplyUsed(
  accessToken: string,
  id: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/saved-replies/" + String(id) + "/use",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function exportActivityCsv(
  accessToken: string
): Promise<string | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/activity/export");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return response.text();
}

export async function exportCustomersCsv(accessToken: string): Promise<string | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/customers/export");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return response.text();
}

export async function exportRevenueCsv(
  accessToken: string
): Promise<string | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/revenue/export");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return response.text();
}

export async function exportReturnsCsv(
  accessToken: string
): Promise<string | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/checkout/returns/export"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return response.text();
}

export type EnrollmentExport =
  | { kind: "ok"; csv: string }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function exportEnrollmentsCsv(
  accessToken: string,
  id: number
): Promise<EnrollmentExport> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(id) + "/enrollments/export"
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 404 || response.status === 501) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };
  const csv = await response.text().catch(() => null);
  if (csv === null) return { kind: "unavailable" };
  return { kind: "ok", csv };
}

export interface SetupStatus {
  whatsapp: boolean;
  hours: boolean;
  away: boolean;
  kb: boolean;
  customers: boolean;
  broadcast: boolean;
  cod: boolean;
}

export async function getSetupStatus(
  accessToken: string
): Promise<SetupStatus | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/setup/status");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).setup;
  if (raw === null || typeof raw !== "object") return null;
  const checks = ((raw as Record<string, unknown>).checks ?? {}) as Record<string, unknown>;
  const flag = (key: string) => checks[key] === true;
  return {
    whatsapp: flag("whatsapp"),
    hours: flag("hours"),
    away: flag("away"),
    kb: flag("kb"),
    customers: flag("customers"),
    broadcast: flag("broadcast"),
    cod: flag("cod"),
  };
}

export interface WebhookRow {
  id: number;
  url: string;
  events: string;
  enabled: boolean;
  createdAt: string | null;
  lastDeliveryAt: string | null;
  lastStatusCode: number | null;
}

export interface WebhookDelivery {
  id: number;
  event: string;
  statusCode: number | null;
  error: string | null;
  attempts: number;
  createdAt: string | null;
  deliveredAt: string | null;
}

export async function listWebhooks(
  accessToken: string
): Promise<WebhookRow[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/webhooks");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).webhooks;
  if (!Array.isArray(rawList)) return null;
  const webhooks: WebhookRow[] = [];
  for (const item of rawList) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "number") continue;
    webhooks.push({
      id: row.id,
      url: typeof row.url === "string" ? row.url : "",
      events: typeof row.events === "string" ? row.events : "all",
      enabled: row.enabled === true,
      createdAt: typeof row.created_at === "string" ? row.created_at : null,
      lastDeliveryAt: typeof row.last_delivery_at === "string" ? row.last_delivery_at : null,
      lastStatusCode: typeof row.last_status_code === "number" ? row.last_status_code : null,
    });
  }
  return webhooks;
}

export type WebhookMutation =
  | { kind: "ok"; webhook?: WebhookRow; secret?: string }
  | { kind: "invalid" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function createWebhook(
  accessToken: string,
  url: string,
  events: string
): Promise<WebhookMutation> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, events }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const raw = (payload as Record<string, unknown>).webhook;
  const secret = (payload as Record<string, unknown>).secret;
  const webhook =
    raw !== null && typeof raw === "object"
      ? ({
          id: (raw as Record<string, unknown>).id as number,
          url: (raw as Record<string, unknown>).url as string,
          events: (raw as Record<string, unknown>).events as string,
          enabled: true,
          createdAt: null,
          lastDeliveryAt: null,
          lastStatusCode: null,
        } as WebhookRow)
      : undefined;
  return {
    kind: "ok",
    webhook,
    secret: typeof secret === "string" ? secret : undefined,
  };
}

export async function updateWebhook(
  accessToken: string,
  id: number,
  changes: { url?: string; events?: string; enabled?: boolean }
): Promise<WebhookMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/webhooks/" + String(id),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export async function deleteWebhook(
  accessToken: string,
  id: number
): Promise<{ kind: "ok" } | { kind: "not_found" } | { kind: "unavailable" }> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/webhooks/" + String(id),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export async function listWebhookDeliveries(
  accessToken: string,
  id: number
): Promise<WebhookDelivery[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/webhooks/" + String(id) + "/deliveries"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).deliveries;
  if (!Array.isArray(rawList)) return null;
  const deliveries: WebhookDelivery[] = [];
  for (const item of rawList) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "number") continue;
    deliveries.push({
      id: row.id,
      event: typeof row.event === "string" ? row.event : "",
      statusCode: typeof row.status_code === "number" ? row.status_code : null,
      error: typeof row.error === "string" ? row.error : null,
      attempts: typeof row.attempts === "number" ? row.attempts : 0,
      createdAt: typeof row.created_at === "string" ? row.created_at : null,
      deliveredAt: typeof row.delivered_at === "string" ? row.delivered_at : null,
    });
  }
  return deliveries;
}

export interface SequenceStep {
  step_no: number;
  delay_hours: number;
  body: string;
  onlyIfIdleHours: number | null;
}

export interface SequenceRow {
  id: number;
  name: string;
  enabled: boolean;
  steps: SequenceStep[];
  activeEnrollments: number;
  completedEnrollments: number;
  triggerKeyword: string | null;
  pauseOnReply: boolean;
}

export async function listSequences(
  accessToken: string
): Promise<SequenceRow[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/sequences");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).sequences;
  if (!Array.isArray(rawList)) return null;
  const sequences: SequenceRow[] = [];
  for (const item of rawList) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "number") continue;
    const steps = Array.isArray(row.steps)
      ? (row.steps as Record<string, unknown>[]).map((step) => ({
          step_no: typeof step.step_no === "number" ? step.step_no : 0,
          delay_hours: typeof step.delay_hours === "number" ? step.delay_hours : 0,
          body: typeof step.body === "string" ? step.body : "",
          onlyIfIdleHours:
            typeof step.only_if_idle_hours === "number"
              ? step.only_if_idle_hours
              : null,
        }))
      : [];
    sequences.push({
      id: row.id,
      name: typeof row.name === "string" ? row.name : "",
      enabled: row.enabled === true,
      steps,
      activeEnrollments: typeof row.active_enrollments === "number" ? row.active_enrollments : 0,
      completedEnrollments:
        typeof row.completed_enrollments === "number" ? row.completed_enrollments : 0,
      pauseOnReply: row.pause_on_reply !== false,
      triggerKeyword: typeof row.trigger_keyword === "string" ? row.trigger_keyword : null,
    });
  }
  return sequences;
}

export type SequenceMutation =
  | { kind: "ok" }
  | { kind: "invalid" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function createSequence(
  accessToken: string,
  name: string,
  steps: {
    delay_hours: number;
    body: string;
    only_if_idle_hours?: number | null;
  }[],
  triggerKeyword?: string | null
): Promise<SequenceMutation> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/sequences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        triggerKeyword ? { name, steps, trigger_keyword: triggerKeyword } : { name, steps }
      ),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export async function updateSequence(
  accessToken: string,
  id: number,
  changes: {
    name?: string;
    enabled?: boolean;
    triggerKeyword?: string | null;
    pauseOnReply?: boolean;
  }
): Promise<SequenceMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(id),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify((() => {
          const wire: Record<string, unknown> = {};
          if ("name" in changes) wire.name = changes.name;
          if ("enabled" in changes) wire.enabled = changes.enabled;
          if ("triggerKeyword" in changes) {
            wire.trigger_keyword = changes.triggerKeyword ?? null;
          }
          if ("pauseOnReply" in changes) {
            wire.pause_on_reply = changes.pauseOnReply === true;
          }
          return wire;
        })()),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export async function updateSequenceSteps(
  accessToken: string,
  id: number,
  steps: {
    delay_hours: number;
    body: string;
    only_if_idle_hours?: number | null;
  }[]
): Promise<SequenceMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(id) + "/steps",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ steps }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export interface SequenceSettings {
  quietEnabled: boolean;
  quietStart: number;
  quietEnd: number;
  utcOffset: number;
}

export async function getSequenceSettings(
  accessToken: string
): Promise<SequenceSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/sequences/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  return {
    quietEnabled: row.quiet_enabled === true,
    quietStart: typeof row.quiet_start === "number" ? row.quiet_start : 22,
    quietEnd: typeof row.quiet_end === "number" ? row.quiet_end : 8,
    utcOffset: typeof row.utc_offset === "number" ? row.utc_offset : 5,
  };
}

export async function saveSequenceSettings(
  accessToken: string,
  settings: SequenceSettings
): Promise<SequenceMutation> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/sequences/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quiet_enabled: settings.quietEnabled,
        quiet_start: settings.quietStart,
        quiet_end: settings.quietEnd,
        utc_offset: settings.utcOffset,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export interface SequenceStepStat {
  stepNo: number;
  sent: number;
  skipped: number;
}

export async function getSequenceStats(
  accessToken: string,
  id: number
): Promise<SequenceStepStat[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(id) + "/stats"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const list = (payload as { steps?: unknown }).steps;
  if (!Array.isArray(list)) return null;
  return list
    .map((item) => {
      const row =
        item !== null && typeof item === "object"
          ? (item as Record<string, unknown>)
          : {};
      return {
        stepNo: typeof row.step_no === "number" ? row.step_no : 0,
        sent: typeof row.sent === "number" ? row.sent : 0,
        skipped: typeof row.skipped === "number" ? row.skipped : 0,
      };
    })
    .filter((row) => row.stepNo > 0);
}

export interface SegmentFilters {
  lead_temp?: "hot" | "warm" | "cold";
  status?: "open" | "closed";
  stage?: PipelineStage;
  idle_days?: number;
  tag?: string;
}

export interface SegmentRow {
  id: number;
  name: string;
  filters: SegmentFilters;
  memberCount: number;
  createdAt: string | null;
}

function normalizeSegmentFilters(raw: unknown): SegmentFilters {
  const out: SegmentFilters = {};
  if (raw === null || typeof raw !== "object") return out;
  const input = raw as Record<string, unknown>;
  if (
    input.lead_temp === "hot" ||
    input.lead_temp === "warm" ||
    input.lead_temp === "cold"
  ) {
    out.lead_temp = input.lead_temp;
  }
  if (input.status === "open" || input.status === "closed") {
    out.status = input.status;
  }
  if (
    input.stage === "new" ||
    input.stage === "interested" ||
    input.stage === "negotiating" ||
    input.stage === "won" ||
    input.stage === "lost"
  ) {
    out.stage = input.stage;
  }
  if (typeof input.idle_days === "number" && input.idle_days >= 1) {
    out.idle_days = Math.round(input.idle_days);
  }
  if (typeof input.tag === "string" && input.tag.trim()) {
    out.tag = input.tag.trim();
  }
  return out;
}

export async function listSegments(
  accessToken: string
): Promise<SegmentRow[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/segments");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).segments;
  if (!Array.isArray(rawList)) return null;
  const segments: SegmentRow[] = [];
  for (const item of rawList) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "number") continue;
    segments.push({
      id: row.id,
      name: typeof row.name === "string" ? row.name : "",
      filters: normalizeSegmentFilters(row.filters),
      memberCount: typeof row.member_count === "number" ? row.member_count : 0,
      createdAt:
        typeof row.created_at === "string" ? row.created_at : null,
    });
  }
  return segments;
}

export type SegmentMutation =
  | { kind: "ok"; segment?: SegmentRow }
  | { kind: "invalid" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function createSegment(
  accessToken: string,
  name: string,
  filters: SegmentFilters
): Promise<SegmentMutation> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/segments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, filters }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  const segment =
    payload !== null && typeof payload === "object"
      ? (payload as { segment?: unknown }).segment
      : null;
  if (segment !== null && typeof segment === "object") {
    const row = segment as Record<string, unknown>;
    if (typeof row.id === "number") {
      return {
        kind: "ok",
        segment: {
          id: row.id,
          name: typeof row.name === "string" ? row.name : "",
          filters: normalizeSegmentFilters(row.filters),
          memberCount:
            typeof row.member_count === "number" ? row.member_count : 0,
          createdAt:
            typeof row.created_at === "string" ? row.created_at : null,
        },
      };
    }
  }
  return { kind: "ok" };
}

export async function deleteSegment(
  accessToken: string,
  id: number
): Promise<{ kind: "ok" } | { kind: "not_found" } | { kind: "unavailable" }> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/segments/" + String(id),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export interface SegmentMember {
  contactId: string;
  name: string;
  chats: number;
  lastAt: string | null;
}

export async function listSegmentMembers(
  accessToken: string,
  id: number
): Promise<SegmentMember[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/segments/" + String(id) + "/members?limit=50"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).members;
  if (!Array.isArray(rawList)) return null;
  const members: SegmentMember[] = [];
  for (const item of rawList) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.contact_id !== "string") continue;
    members.push({
      contactId: row.contact_id,
      name: typeof row.name === "string" ? row.name : "",
      chats: typeof row.chats === "number" ? row.chats : 0,
      lastAt: typeof row.last_at === "string" ? row.last_at : null,
    });
  }
  return members;
}

export async function broadcastToSegment(
  accessToken: string,
  id: number,
  body: string
): Promise<{ kind: "ok"; sent: number } | { kind: "invalid" } | { kind: "unavailable" }> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/segments/" + String(id) + "/broadcast",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  const sent =
    payload !== null && typeof payload === "object"
      ? (payload as { sent?: unknown }).sent
      : null;
  return { kind: "ok", sent: typeof sent === "number" ? sent : 0 };
}

export interface CustomerConversationRef {
  id: number;
  status: string;
  channel: string;
  lastMessageAt: string | null;
}

export interface CustomerProfileAction {
  id: number;
  kind: string;
  status: string;
  note: string;
  createdAt: string | null;
}

export interface CustomerProfile {
  contactId: string;
  name: string;
  leadTemp: string;
  language: string | null;
  linkedChannels: string[];
  actions: CustomerProfileAction[];
  chats: number;
  openChats: number;
  firstSeen: string | null;
  lastSeen: string | null;
  tags: string[];
  conversations: CustomerConversationRef[];
  codRequests: {
    id: number;
    status: string;
    createdAt: string | null;
    answeredAt: string | null;
  }[];
  sequences: {
    name: string;
    status: string;
    currentStep: number;
    enrolledAt: string | null;
  }[];
  notes: {
    body: string;
    authorEmail: string;
    createdAt: string | null;
  }[];
}

export async function getCustomerProfile(
  accessToken: string,
  contact: string
): Promise<CustomerProfile | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/customers/profile?contact=" + encodeURIComponent(contact)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const conversations = Array.isArray(row.conversations)
    ? (row.conversations as Record<string, unknown>[]).map((item) => ({
        id: typeof item.id === "number" ? item.id : 0,
        status: typeof item.status === "string" ? item.status : "open",
        channel: typeof item.channel === "string" ? item.channel : "whatsapp",
        lastMessageAt:
          typeof item.last_message_at === "string"
            ? item.last_message_at
            : null,
      }))
    : [];
  const codRequests = Array.isArray(row.cod_requests)
    ? (row.cod_requests as Record<string, unknown>[]).map((item) => ({
        id: typeof item.id === "number" ? item.id : 0,
        status: typeof item.status === "string" ? item.status : "pending",
        createdAt: typeof item.created_at === "string" ? item.created_at : null,
        answeredAt:
          typeof item.answered_at === "string" ? item.answered_at : null,
      }))
    : [];
  const sequences = Array.isArray(row.sequences)
    ? (row.sequences as Record<string, unknown>[]).map((item) => ({
        name: typeof item.name === "string" ? item.name : "",
        status: typeof item.status === "string" ? item.status : "active",
        currentStep: typeof item.current_step === "number" ? item.current_step : 0,
        enrolledAt:
          typeof item.enrolled_at === "string" ? item.enrolled_at : null,
      }))
    : [];
  const notes = Array.isArray(row.notes)
    ? (row.notes as Record<string, unknown>[]).map((item) => ({
        body: typeof item.body === "string" ? item.body : "",
        authorEmail: typeof item.author_email === "string" ? item.author_email : "",
        createdAt: typeof item.created_at === "string" ? item.created_at : null,
      }))
    : [];
  return {
    contactId: typeof row.contact_id === "string" ? row.contact_id : "",
    name: typeof row.name === "string" ? row.name : "",
    leadTemp: typeof row.lead_temp === "string" ? row.lead_temp : "cold",
    chats: typeof row.chats === "number" ? row.chats : 0,
    openChats: typeof row.open_chats === "number" ? row.open_chats : 0,
    firstSeen: typeof row.first_seen === "string" ? row.first_seen : null,
    lastSeen: typeof row.last_seen === "string" ? row.last_seen : null,
    tags: Array.isArray(row.tags)
      ? (row.tags as unknown[]).filter(
          (tag): tag is string => typeof tag === "string"
        )
      : [],
    conversations,
    codRequests,
    sequences,
    notes,
    language: typeof row.language === "string" ? row.language : null,
    linkedChannels: Array.isArray(row.linked_channels)
      ? (row.linked_channels as unknown[]).filter(
          (item): item is string => typeof item === "string"
        )
      : [],
    actions: Array.isArray(row.actions)
      ? (row.actions as Record<string, unknown>[]).map((item) => ({
          id: typeof item.id === "number" ? item.id : 0,
          kind: typeof item.kind === "string" ? item.kind : "",
          status: typeof item.status === "string" ? item.status : "pending",
          note: typeof item.note === "string" ? item.note : "",
          createdAt: typeof item.created_at === "string" ? item.created_at : null,
        }))
      : [],
  };
}

export type PipelineStage =
  | "new"
  | "interested"
  | "negotiating"
  | "won"
  | "lost";

export const PIPELINE_STAGES: PipelineStage[] = [
  "new",
  "interested",
  "negotiating",
  "won",
  "lost",
];

export interface PipelineContact {
  contactId: string;
  name: string;
  leadTemp: string;
  chats: number;
  lastAt: string | null;
}

export interface PipelineColumn {
  stage: PipelineStage;
  count: number;
  contacts: PipelineContact[];
}

export async function getPipelineBoard(
  accessToken: string
): Promise<PipelineColumn[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/pipeline");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawStages = (payload as Record<string, unknown>).stages;
  if (!Array.isArray(rawStages)) return null;
  const columns: PipelineColumn[] = [];
  for (const item of rawStages) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.stage !== "string") continue;
    const rawContacts = Array.isArray(row.contacts) ? row.contacts : [];
    const contacts: PipelineContact[] = [];
    for (const entry of rawContacts) {
      if (entry === null || typeof entry !== "object") continue;
      const contact = entry as Record<string, unknown>;
      if (typeof contact.contact_id !== "string") continue;
      contacts.push({
        contactId: contact.contact_id,
        name: typeof contact.name === "string" ? contact.name : "",
        leadTemp: typeof contact.lead_temp === "string" ? contact.lead_temp : "cold",
        chats: typeof contact.chats === "number" ? contact.chats : 0,
        lastAt: typeof contact.last_at === "string" ? contact.last_at : null,
      });
    }
    columns.push({
      stage: row.stage as PipelineStage,
      count: typeof row.count === "number" ? row.count : contacts.length,
      contacts,
    });
  }
  return columns;
}

export type StageMutation =
  | { kind: "ok" }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function setContactStage(
  accessToken: string,
  contact: string,
  stage: PipelineStage
): Promise<StageMutation> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/pipeline/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact, stage }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export interface WeeklySummary {
  chats: number;
  messagesIn: number;
  messagesOut: number;
  codConfirmed: number;
  codDeclined: number;
  broadcasts: number;
  csatAsked: number;
  csatAvg: number | null;
  days: { day: string; chats: number; inbound: number }[];
}

export async function getWeeklySummary(
  accessToken: string
): Promise<WeeklySummary | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/insights/weekly");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const num = (value: unknown): number =>
    typeof value === "number" ? value : 0;
  const rawDays = Array.isArray(row.days) ? row.days : [];
  const days = rawDays
    .filter(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === "object"
    )
    .map((item) => ({
      day: typeof item.day === "string" ? item.day : "",
      chats: num(item.chats),
      inbound: num(item.inbound),
    }));
  const avg = row.csat_avg;
  return {
    chats: num(row.chats),
    messagesIn: num(row.messages_in),
    messagesOut: num(row.messages_out),
    codConfirmed: num(row.cod_confirmed),
    codDeclined: num(row.cod_declined),
    broadcasts: num(row.broadcasts),
    csatAsked: num(row.csat_asked),
    csatAvg: typeof avg === "number" ? avg : null,
    days,
  };
}

export interface CalendarItem {
  id: number;
  day: string;
  audience: string;
  body: string;
  recipients: number;
  scheduled: boolean;
}

export interface BroadcastCalendar {
  month: string;
  days: { date: string; sent: number; scheduled: number }[];
  items: CalendarItem[];
}

export async function getBroadcastCalendar(
  accessToken: string,
  month: string
): Promise<BroadcastCalendar | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/insights/calendar?month=" + encodeURIComponent(month)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const rawDays = Array.isArray(row.days) ? row.days : [];
  const rawItems = Array.isArray(row.items) ? row.items : [];
  return {
    month: typeof row.month === "string" ? row.month : month,
    days: rawDays
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object"
      )
      .map((item) => ({
        date: typeof item.date === "string" ? item.date : "",
        sent: typeof item.sent === "number" ? item.sent : 0,
        scheduled: typeof item.scheduled === "number" ? item.scheduled : 0,
      })),
    items: rawItems
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object"
      )
      .map((item) => ({
        id: typeof item.id === "number" ? item.id : 0,
        day: typeof item.day === "string" ? item.day : "",
        audience: typeof item.audience === "string" ? item.audience : "all",
        body: typeof item.body === "string" ? item.body : "",
        recipients: typeof item.recipients === "number" ? item.recipients : 0,
        scheduled: item.scheduled === true,
      })),
  };
}

export type MergeMutation =
  | { kind: "ok"; moved: number }
  | { kind: "not_found" }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function mergeCustomers(
  accessToken: string,
  keep: string,
  merge: string
): Promise<MergeMutation> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/customers/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keep, merge }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  const moved =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>).moved
      : null;
  return { kind: "ok", moved: typeof moved === "number" ? moved : 0 };
}

export type ReplyLanguage = "auto" | "en" | "ur" | "roman";

export async function getWorkspaceLanguage(
  accessToken: string
): Promise<ReplyLanguage | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/workspace/language");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const lang =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>).reply_language
      : null;
  return lang === "en" || lang === "ur" || lang === "roman" || lang === "auto"
    ? lang
    : "auto";
}

export type LanguageMutation =
  | { kind: "ok" }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function saveWorkspaceLanguage(
  accessToken: string,
  language: ReplyLanguage
): Promise<LanguageMutation> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/workspace/language", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export async function getContactLanguage(
  accessToken: string,
  contact: string
): Promise<{ lang: string | null; updatedAt: string | null } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/contacts/language?contact=" + encodeURIComponent(contact)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  return {
    lang: typeof row.lang === "string" ? row.lang : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

export async function detectLanguage(
  accessToken: string,
  text: string
): Promise<string | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/contacts/language/detect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const lang =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>).lang
      : null;
  return typeof lang === "string" ? lang : null;
}

export async function linkContacts(
  accessToken: string,
  contactA: string,
  contactB: string
): Promise<LanguageMutation> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/contacts/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_a: contactA, contact_b: contactB }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export type ActionMutation =
  | { kind: "ok"; id: number }
  | { kind: "invalid" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function createConversationAction(
  accessToken: string,
  conversationId: number,
  kind: string,
  note: string
): Promise<ActionMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" + String(conversationId) + "/actions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, note }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  const id =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>).id
      : null;
  return { kind: "ok", id: typeof id === "number" ? id : 0 };
}

export type ResolveMutation =
  | { kind: "ok" }
  | { kind: "invalid" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function resolveContactAction(
  accessToken: string,
  id: number,
  status: "done" | "declined"
): Promise<ResolveMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/contacts/actions/" + String(id),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export interface ContactAction {
  id: number;
  conversationId: number | null;
  contactId: string;
  kind: string;
  note: string;
  status: string;
  requestedBy: string | null;
  createdAt: string | null;
  resolvedAt: string | null;
}

export async function listContactActions(
  accessToken: string,
  contact: string,
  status: string
): Promise<ContactAction[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/contacts/actions?contact=" +
        encodeURIComponent(contact) +
        "&status=" +
        encodeURIComponent(status)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).actions
    : null;
  if (!Array.isArray(raw)) return [];
  const actions: ContactAction[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "number") continue;
    actions.push({
      id: row.id,
      conversationId:
        typeof row.conversation_id === "number" ? row.conversation_id : null,
      contactId: typeof row.contact_id === "string" ? row.contact_id : "",
      kind: typeof row.kind === "string" ? row.kind : "",
      note: typeof row.note === "string" ? row.note : "",
      status: typeof row.status === "string" ? row.status : "pending",
      requestedBy: typeof row.requested_by === "string" ? row.requested_by : null,
      createdAt: typeof row.created_at === "string" ? row.created_at : null,
      resolvedAt: typeof row.resolved_at === "string" ? row.resolved_at : null,
    });
  }
  return actions;
}

export interface IntentResult {
  intent: string;
  entities: { phones: string[]; orderIds: string[]; emails: string[] };
}

export async function classifyIntent(
  accessToken: string,
  text: string
): Promise<IntentResult | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/insights/intent?text=" + encodeURIComponent(text)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const raw = row.entities;
  const entities =
    raw !== null && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : {};
  const list = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  return {
    intent: typeof row.intent === "string" ? row.intent : "other",
    entities: {
      phones: list(entities.phones),
      orderIds: list(entities.order_ids),
      emails: list(entities.emails),
    },
  };
}

export interface FraudScore {
  score: number;
  level: string;
  reasons: string[];
  declined: number;
  refunds: number;
  chats: number;
}

export async function getFraudScore(
  accessToken: string,
  contact: string
): Promise<FraudScore | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/fraud/score?contact=" + encodeURIComponent(contact)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const reasons = Array.isArray(row.reasons)
    ? row.reasons.filter((item): item is string => typeof item === "string")
    : [];
  return {
    score: typeof row.score === "number" ? row.score : 0,
    level: typeof row.level === "string" ? row.level : "clear",
    reasons,
    declined: typeof row.declined === "number" ? row.declined : 0,
    refunds: typeof row.refunds === "number" ? row.refunds : 0,
    chats: typeof row.chats === "number" ? row.chats : 0,
  };
}

export interface FraudFlag {
  contactId: string;
  score: number;
  level: string;
  reasons: string;
  updatedAt: string | null;
}

export async function listFraudFlags(
  accessToken: string
): Promise<FraudFlag[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/fraud/flags");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).flags
    : null;
  if (!Array.isArray(raw)) return [];
  const flags: FraudFlag[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.contact_id !== "string") continue;
    flags.push({
      contactId: row.contact_id,
      score: typeof row.score === "number" ? row.score : 0,
      level: typeof row.level === "string" ? row.level : "clear",
      reasons: typeof row.reasons === "string" ? row.reasons : "",
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
    });
  }
  return flags;
}

export interface OptOutRow {
  contactId: string;
  reason: string;
  createdAt: string | null;
}

export async function listOptOuts(
  accessToken: string,
  query: string
): Promise<OptOutRow[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/compliance/optouts?q=" + encodeURIComponent(query)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).optouts
    : null;
  if (!Array.isArray(raw)) return [];
  const rows: OptOutRow[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.contact_id !== "string") continue;
    rows.push({
      contactId: row.contact_id,
      reason: typeof row.reason === "string" ? row.reason : "customer",
      createdAt: typeof row.created_at === "string" ? row.created_at : null,
    });
  }
  return rows;
}

export interface OptOutMutation {
  ok: boolean;
  contactId: string;
  reason: string;
}

export async function addOptOut(
  accessToken: string,
  contact: string,
  reason: string
): Promise<OptOutMutation | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/compliance/optouts",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact, reason }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  return {
    ok: row.ok === true,
    contactId: typeof row.contact_id === "string" ? row.contact_id : contact,
    reason: typeof row.reason === "string" ? row.reason : reason,
  };
}

export type OptOutRemoval = { ok: true } | "not_found" | null;

export async function removeOptOut(
  accessToken: string,
  contact: string
): Promise<OptOutRemoval> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/compliance/optouts?contact=" + encodeURIComponent(contact),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { ok: true };
}

export interface KbSuggestion {
  id: number;
  question: string;
  snippet: string;
  matched: string[];
}

export interface AssistSentiment {
  label: string;
  score: number;
  positive: string[];
  negative: string[];
}

export interface AssistResult {
  intent: string;
  sentiment: AssistSentiment | null;
  language: string | null;
  linked: string[];
  suggestions: KbSuggestion[];
  basedOn: string;
}

export async function getConversationAssist(
  accessToken: string,
  conversationId: number
): Promise<AssistResult | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" + conversationId + "/assist"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const rawSuggestions = Array.isArray(row.suggestions) ? row.suggestions : [];
  const suggestions: KbSuggestion[] = [];
  for (const item of rawSuggestions) {
    if (item === null || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    suggestions.push({
      id: typeof entry.id === "number" ? entry.id : 0,
      question: typeof entry.question === "string" ? entry.question : "",
      snippet: typeof entry.snippet === "string" ? entry.snippet : "",
      matched: Array.isArray(entry.matched)
        ? entry.matched.filter((m): m is string => typeof m === "string")
        : [],
    });
  }
  let sentiment: AssistSentiment | null = null;
  if (row.sentiment !== null && typeof row.sentiment === "object") {
    const entry = row.sentiment as Record<string, unknown>;
    sentiment = {
      label: typeof entry.label === "string" ? entry.label : "neutral",
      score: typeof entry.score === "number" ? entry.score : 0,
      positive: Array.isArray(entry.positive)
        ? entry.positive.filter((w): w is string => typeof w === "string")
        : [],
      negative: Array.isArray(entry.negative)
        ? entry.negative.filter((w): w is string => typeof w === "string")
        : [],
    };
  }
  return {
    intent: typeof row.intent === "string" ? row.intent : "other",
    sentiment,
    language: typeof row.language === "string" ? row.language : null,
    linked: Array.isArray(row.linked)
      ? row.linked.filter((m): m is string => typeof m === "string")
      : [],
    suggestions,
    basedOn: typeof row.based_on === "string" ? row.based_on : "",
  };
}

async function controlPlanePublicRequest(
  path: string,
  init?: RequestInit
): Promise<Response | null> {
  try {
    const url = new URL(path.replace(/^\\//, ""), controlPlaneBaseUrl());
    return await fetch(url, {
      ...(init ?? {}),
      headers: { Accept: "application/json", ...(init?.headers ?? {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

export type PublicCheckoutPayment = {
  paidAmount: number;
  due: number;
};

export interface PublicCheckoutView {
  title: string;
  items: { name: string; qty: number; price: number }[];
  total: number;
  status: string;
  createdAt: string | null;
  discount: number;
  couponCode: string;
  couponDiscount: number;
  courier: string;
  trackingNumber: string;
  brandName: string | null;
  payment: PublicCheckoutPayment | null;
  phoneVerification?: boolean;
}

export async function getPublicCheckout(
  token: string
): Promise<PublicCheckoutView | null> {
  const response = await controlPlanePublicRequest(
    "api/v1/public/checkout/" + encodeURIComponent(token)
  );
  if (response === null || !response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const rawItems = Array.isArray(row.items) ? row.items : [];
  return {
    title: typeof row.title === "string" ? row.title : "",
    items: rawItems
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === "object")
      .map((item) => ({
        name: typeof item.name === "string" ? item.name : "",
        qty: typeof item.qty === "number" ? item.qty : 1,
        price: typeof item.price === "number" ? item.price : 0,
      })),
    total: typeof row.total === "number" ? row.total : 0,
    status: typeof row.status === "string" ? row.status : "open",
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
    discount: typeof row.discount === "number" ? row.discount : 0,
    couponCode: typeof row.coupon_code === "string" ? row.coupon_code : "",
    couponDiscount:
      typeof row.coupon_discount === "number" ? row.coupon_discount : 0,
    courier: typeof row.courier === "string" ? row.courier : "",
    trackingNumber:
      typeof row.tracking_number === "string" ? row.tracking_number : "",
    brandName: typeof row.brand_name === "string" ? row.brand_name : null,
    payment:
      typeof row.paid_amount === "number" && row.paid_amount > 0
        ? {
            paidAmount: row.paid_amount,
            due: typeof row.due === "number" ? row.due : 0,
          }
        : null,
  };
}

export interface SentimentResult {
  label: string;
  score: number;
  positive: string[];
  negative: string[];
}

export async function getSentiment(
  accessToken: string,
  text: string
): Promise<SentimentResult | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/insights/sentiment?text=" + encodeURIComponent(text)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  return {
    label: typeof row.label === "string" ? row.label : "neutral",
    score: typeof row.score === "number" ? row.score : 0,
    positive: Array.isArray(row.positive)
      ? row.positive.filter((w): w is string => typeof w === "string")
      : [],
    negative: Array.isArray(row.negative)
      ? row.negative.filter((w): w is string => typeof w === "string")
      : [],
  };
}

export interface ChurnContact {
  contactId: string;
  name: string;
  chats: number;
  lastAt: string | null;
}

export async function listChurnRisk(
  accessToken: string,
  days: number
): Promise<ChurnContact[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/insights/churn?days=" + encodeURIComponent(String(days))
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).contacts
    : null;
  if (!Array.isArray(raw)) return [];
  const contacts: ChurnContact[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.contact_id !== "string") continue;
    contacts.push({
      contactId: row.contact_id,
      name: typeof row.name === "string" ? row.name : "",
      chats: typeof row.chats === "number" ? row.chats : 0,
      lastAt: typeof row.last_at === "string" ? row.last_at : null,
    });
  }
  return contacts;
}

export interface StaffingForecast {
  hours: { hour: number; chats: number }[];
  peakHour: number | null;
  peakChats: number;
  suggested: number[];
}

export async function getStaffingForecast(
  accessToken: string
): Promise<StaffingForecast | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/insights/staffing");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const rawHours = Array.isArray(row.hours) ? row.hours : [];
  return {
    hours: rawHours
      .filter((h): h is Record<string, unknown> => h !== null && typeof h === "object")
      .map((h) => ({
        hour: typeof h.hour === "number" ? h.hour : 0,
        chats: typeof h.chats === "number" ? h.chats : 0,
      })),
    peakHour: typeof row.peak_hour === "number" ? row.peak_hour : null,
    peakChats: typeof row.peak_chats === "number" ? row.peak_chats : 0,
    suggested: Array.isArray(row.suggested)
      ? row.suggested.filter((h): h is number => typeof h === "number")
      : [],
  };
}

export interface BroadcastSuggestion {
  audience: string;
  count: number;
  note: string;
}

export async function listBroadcastSuggestions(
  accessToken: string
): Promise<BroadcastSuggestion[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/insights/broadcast-suggestions"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).suggestions
    : null;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === "object")
    .map((item) => ({
      audience: typeof item.audience === "string" ? item.audience : "",
      count: typeof item.count === "number" ? item.count : 0,
      note: typeof item.note === "string" ? item.note : "",
    }));
}

export interface NegotiationSettings {
  enabled: boolean;
  floorPercent: number;
  maxPercent: number;
}

export async function getNegotiationSettings(
  accessToken: string
): Promise<NegotiationSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/negotiation/settings"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).settings
    : null;
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  return {
    enabled: row.enabled === true,
    floorPercent: typeof row.floor_percent === "number" ? row.floor_percent : 0,
    maxPercent: typeof row.max_percent === "number" ? row.max_percent : 25,
  };
}

export async function saveNegotiationSettings(
  accessToken: string,
  enabled: boolean,
  floorPercent: number,
  maxPercent: number
): Promise<NegotiationSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/negotiation/settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          floor_percent: floorPercent,
          max_percent: maxPercent,
        }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).settings
    : null;
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  return {
    enabled: row.enabled === true,
    floorPercent: typeof row.floor_percent === "number" ? row.floor_percent : 0,
    maxPercent: typeof row.max_percent === "number" ? row.max_percent : 25,
  };
}

export interface NegotiationQuote {
  ask: number;
  price: number;
  discountPercent: number;
  verdict: string;
  counter: number;
  maxPercent: number;
  enabled: boolean;
}

export async function getNegotiationQuote(
  accessToken: string,
  ask: number,
  price: number
): Promise<NegotiationQuote | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/negotiation/quote?ask=" +
        encodeURIComponent(String(ask)) +
        "&price=" +
        encodeURIComponent(String(price))
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  return {
    ask: typeof row.ask === "number" ? row.ask : 0,
    price: typeof row.price === "number" ? row.price : 0,
    discountPercent:
      typeof row.discount_percent === "number" ? row.discount_percent : 0,
    verdict: typeof row.verdict === "string" ? row.verdict : "counter",
    counter: typeof row.counter === "number" ? row.counter : 0,
    maxPercent: typeof row.max_percent === "number" ? row.max_percent : 25,
    enabled: row.enabled === true,
  };
}

export interface CheckoutLink {
  id: number;
  token: string;
  contactId: string;
  title: string;
  items: { name: string; qty: number; price: number }[];
  total: number;
  status: string;
  createdAt: string | null;
  expiresAt: string | null;
  viewCount: number;
  paidAmount: number;
  discount: number;
  courier: string;
  trackingNumber: string;
  brandId: number | null;
  brandName: string | null;
}

export async function createCheckoutLink(
  accessToken: string,
  contactId: string,
  title: string,
  items: { name: string; qty: number; price: number }[],
  expiresInDays?: number | null,
  discountAmount?: number | null,
  advancePercent?: number | null,
  brandId?: number | null
): Promise<CheckoutLink | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/checkout/links",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: contactId,
          title,
          items: items.map((item) => ({
            name: item.name,
            qty: item.qty,
            price: item.price,
          })),
          expires_in_days: expiresInDays ?? null,
          discount_amount: discountAmount ?? null,
          advance_percent: advancePercent ?? null,
          brand_id: brandId ?? null,
        }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).link
    : null;
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const rawItems = Array.isArray(row.items) ? row.items : [];
  return {
    id: typeof row.id === "number" ? row.id : 0,
    token: typeof row.token === "string" ? row.token : "",
    contactId: typeof row.contact_id === "string" ? row.contact_id : "",
    title: typeof row.title === "string" ? row.title : "",
    items: rawItems
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === "object")
      .map((item) => ({
        name: typeof item.name === "string" ? item.name : "",
        qty: typeof item.qty === "number" ? item.qty : 1,
        price: typeof item.price === "number" ? item.price : 0,
      })),
    total: typeof row.total === "number" ? row.total : 0,
    status: typeof row.status === "string" ? row.status : "open",
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
    expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
    viewCount: typeof row.view_count === "number" ? row.view_count : 0,
    paidAmount: typeof row.paid_amount === "number" ? row.paid_amount : 0,
    discount: typeof row.discount === "number" ? row.discount : 0,
    courier: typeof row.courier === "string" ? row.courier : "",
    trackingNumber:
      typeof row.tracking_number === "string" ? row.tracking_number : "",
    brandId: typeof row.brand_id === "number" ? row.brand_id : null,
    brandName: typeof row.brand_name === "string" ? row.brand_name : null,
  };
}

export async function listCheckoutLinks(
  accessToken: string
): Promise<CheckoutLink[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/checkout/links");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).links
    : null;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === "object")
    .map((item) => {
      const rawItems = Array.isArray(item.items) ? item.items : [];
      return {
        id: typeof item.id === "number" ? item.id : 0,
        token: typeof item.token === "string" ? item.token : "",
        contactId: typeof item.contact_id === "string" ? item.contact_id : "",
        title: typeof item.title === "string" ? item.title : "",
        items: rawItems
          .filter((entry): entry is Record<string, unknown> =>
            entry !== null && typeof entry === "object")
          .map((entry) => ({
            name: typeof entry.name === "string" ? entry.name : "",
            qty: typeof entry.qty === "number" ? entry.qty : 1,
            price: typeof entry.price === "number" ? entry.price : 0,
          })),
        total: typeof item.total === "number" ? item.total : 0,
        status: typeof item.status === "string" ? item.status : "open",
        createdAt: typeof item.created_at === "string" ? item.created_at : null,
        expiresAt: typeof item.expires_at === "string" ? item.expires_at : null,
        viewCount: typeof item.view_count === "number" ? item.view_count : 0,
        paidAmount: typeof item.paid_amount === "number" ? item.paid_amount : 0,
        discount: typeof item.discount === "number" ? item.discount : 0,
        courier: typeof item.courier === "string" ? item.courier : "",
        trackingNumber:
          typeof item.tracking_number === "string" ? item.tracking_number : "",
        brandId: typeof item.brand_id === "number" ? item.brand_id : null,
        brandName:
          typeof item.brand_name === "string" ? item.brand_name : null,
      };
    });
}

export type CheckoutStatusMutation = { ok: true } | "not_found"
  | "forbidden"
  | null;

export async function setCheckoutLinkStatus(
  accessToken: string,
  linkId: number,
  status: string,
  returnReason?: string
): Promise<CheckoutStatusMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/checkout/links/" + linkId,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, reason: returnReason, note: "" }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 403) return "forbidden";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { ok: true };
}

export interface CheckoutNotifySettings {
  notifyEnabled: boolean;
  tplPaid: string;
  tplShipped: string;
  tplDelivered: string;
  tplReturned: string;
  cartEnabled: boolean;
  cartGap1: number;
  cartGap2: number;
  cartGap3: number;
  cartTpl1: string;
  cartTpl2: string;
  cartTpl3: string;
}

function normalizeCart(raw: Record<string, unknown>): {
  cartEnabled: boolean;
  cartGap1: number;
  cartGap2: number;
  cartGap3: number;
  cartTpl1: string;
  cartTpl2: string;
  cartTpl3: string;
} {
  const gap = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value)
      && value >= 1 && value <= 168
      ? Math.floor(value)
      : fallback;
  return {
    cartEnabled: raw.enabled === true,
    cartGap1: gap(raw.gap_1, 2),
    cartGap2: gap(raw.gap_2, 24),
    cartGap3: gap(raw.gap_3, 48),
    cartTpl1: typeof raw.tpl_1 === "string" ? raw.tpl_1 : "",
    cartTpl2: typeof raw.tpl_2 === "string" ? raw.tpl_2 : "",
    cartTpl3: typeof raw.tpl_3 === "string" ? raw.tpl_3 : "",
  };
}

export async function getCheckoutNotifySettings(
  accessToken: string
): Promise<CheckoutNotifySettings | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/checkout/settings"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).settings
    : null;
  if (raw === null || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const cartRaw = s.cart !== null && typeof s.cart === "object"
    ? (s.cart as Record<string, unknown>)
    : {};
  return {
    notifyEnabled: s.notify_enabled === true,
    tplPaid: typeof s.tpl_paid === "string" ? s.tpl_paid : "",
    tplShipped: typeof s.tpl_shipped === "string" ? s.tpl_shipped : "",
    tplDelivered: typeof s.tpl_delivered === "string" ? s.tpl_delivered : "",
    tplReturned: typeof s.tpl_returned === "string" ? s.tpl_returned : "",
    ...normalizeCart(cartRaw),
  };
}

export async function saveCheckoutNotifySettings(
  accessToken: string,
  settings: CheckoutNotifySettings
): Promise<{ ok: true } | "bad_request" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/checkout/settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            notify_enabled: settings.notifyEnabled === true,
            tpl_paid: String(settings.tplPaid || "").trim().slice(0, 500),
            tpl_shipped: String(settings.tplShipped || "").trim().slice(0, 500),
            tpl_delivered: String(settings.tplDelivered || "").trim().slice(0, 500),
            tpl_returned: String(settings.tplReturned || "").trim().slice(0, 500),
            cart: {
              enabled: settings.cartEnabled === true,
              gap_1: Number(settings.cartGap1) >= 1
                && Number(settings.cartGap1) <= 168
                ? Math.floor(Number(settings.cartGap1)) : 2,
              gap_2: Number(settings.cartGap2) >= 1
                && Number(settings.cartGap2) <= 168
                ? Math.floor(Number(settings.cartGap2)) : 24,
              gap_3: Number(settings.cartGap3) >= 1
                && Number(settings.cartGap3) <= 168
                ? Math.floor(Number(settings.cartGap3)) : 48,
              tpl_1: String(settings.cartTpl1 || "").trim().slice(0, 500),
              tpl_2: String(settings.cartTpl2 || "").trim().slice(0, 500),
              tpl_3: String(settings.cartTpl3 || "").trim().slice(0, 500),
            },
          },
        }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 400) return "bad_request";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { ok: true };
}

export interface CheckoutReturn {
  id: number;
  linkId: number;
  reason: string;
  note: string;
  title: string;
  total: number;
  createdAt: string | null;
}

export async function listCheckoutReturns(
  accessToken: string
): Promise<{ returns: CheckoutReturn[]; total: number } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/checkout/returns"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).returns
    : null;
  if (!Array.isArray(raw)) return { returns: [], total: 0 };
  const returns = raw
    .filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === "object")
    .map((item) => ({
      id: typeof item.id === "number" ? item.id : 0,
      linkId: typeof item.link_id === "number" ? item.link_id : 0,
      reason: typeof item.reason === "string" ? item.reason : "other",
      note: typeof item.note === "string" ? item.note : "",
      title: typeof item.title === "string" ? item.title : "",
      total: typeof item.total === "number" ? item.total : 0,
      createdAt: typeof item.created_at === "string" ? item.created_at : null,
    }));
  const counts = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).counts
    : null;
  const total = counts !== null && typeof counts === "object"
    && typeof (counts as Record<string, unknown>).total === "number"
    ? (counts as Record<string, unknown>).total as number
    : returns.length;
  return { returns, total };
}

export interface DigestSettings {
  enabled: boolean;
  ownerContact: string;
  hour: number;
}

export async function getDigestSettings(
  accessToken: string
): Promise<DigestSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/digest/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).settings
    : null;
  if (raw === null || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  return {
    enabled: s.enabled === true,
    ownerContact: typeof s.owner_contact === "string" ? s.owner_contact : "",
    hour: typeof s.hour === "number" && s.hour >= 6 && s.hour <= 21
      ? Math.floor(s.hour)
      : 9,
  };
}

export async function saveDigestSettings(
  accessToken: string,
  settings: DigestSettings
): Promise<{ ok: true } | "bad_request" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/digest/settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            enabled: settings.enabled === true,
            owner_contact: String(settings.ownerContact || "").trim().slice(0, 100),
            hour: Number(settings.hour) >= 6 && Number(settings.hour) <= 21
              ? Math.floor(Number(settings.hour))
              : 9,
          },
        }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 400) return "bad_request";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { ok: true };
}

export type CheckoutEditMutation =
  | { ok: true; total: number }
  | "not_found"
  | "bad_request"
  | null;

export async function editCheckoutLink(
  accessToken: string,
  linkId: number,
  title: string,
  items: { name: string; qty: number; price: number }[],
  expiresInDays?: number | null,
  discountAmount?: number | null
): Promise<CheckoutEditMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/checkout/links/" + linkId + "/edit",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          items,
          expires_in_days: expiresInDays ?? null,
          discount_amount: discountAmount ?? null,
        }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 400) return "bad_request";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const total = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).total
    : null;
  return {
    ok: true,
    total: typeof total === "number" ? total : 0,
  };
}

export type CheckoutDuplicate =
  | { ok: true; token: string }
  | "not_found"
  | null;

export async function duplicateCheckoutLink(
  accessToken: string,
  linkId: number
): Promise<CheckoutDuplicate> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/checkout/links/" + linkId + "/duplicate",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).link
    : null;
  const token = raw !== null && typeof raw === "object"
    ? (raw as Record<string, unknown>).token
    : null;
  return {
    ok: true,
    token: typeof token === "string" ? token : "",
  };
}

export interface PaymentSettings {
  provider: string;
  enabled: boolean;
  sandbox: boolean;
  configured: boolean;
  merchantIdMask: string;
  storeIdMask: string;
}

export async function fetchPublicPayHtml(
  token: string
): Promise<{ status: number; html: string } | null> {
  const response = await controlPlanePublicRequest(
    "api/v1/public/checkout/" + encodeURIComponent(token) + "/pay"
  );
  if (response === null) return null;
  const html = await response.text().catch(() => "");
  return { status: response.status, html };
}

export async function getPublicPayInfo(
  token: string
): Promise<{ enabled: boolean; due: number } | null> {
  const response = await controlPlanePublicRequest(
    "api/v1/public/checkout/" + encodeURIComponent(token) + "/payinfo"
  );
  if (response === null || !response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  return {
    enabled: row.enabled === true,
    due: typeof row.due === "number" ? row.due : 0,
  };
}

export async function getPaymentSettings(
  accessToken: string
): Promise<PaymentSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/payments/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = (payload as Record<string, unknown>).settings;
  if (row === null || typeof row !== "object") return null;
  const data = row as Record<string, unknown>;
  return {
    provider: typeof data.provider === "string" ? data.provider : "jazzcash",
    enabled: data.enabled === true,
    sandbox: data.sandbox === true,
    configured: data.configured === true,
    merchantIdMask:
      typeof data.merchant_id_masked === "string"
        ? data.merchant_id_masked
        : "****",
    storeIdMask:
      typeof data.store_id_masked === "string" ? data.store_id_masked : "****",
  };
}

export async function savePaymentSettings(
  accessToken: string,
  input: {
    provider: string;
    enabled: boolean;
    sandbox: boolean;
    merchantId: string;
    password: string;
    salt: string;
    storeId: string;
  }
): Promise<{ ok: true } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/payments/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: input.provider,
        enabled: input.enabled,
        sandbox: input.sandbox,
        merchant_id: input.merchantId,
        password: input.password,
        salt: input.salt,
        store_id: input.storeId,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { ok: true };
}

export interface CustomerAnalyticsEntry {
  contactId: string;
  orders: number;
  spend: number;
  avgOrder: number;
  tier: string;
  lastOrder: string | null;
}

export interface ProductAnalyticsEntry {
  name: string;
  qtySold: number;
  revenue: number;
  orders: number;
}

export interface CustomerLanguageCount {
  lang: string;
  count: number;
}

export async function getCustomerAnalytics(
  accessToken: string,
  days: number
): Promise<{
  customers: CustomerAnalyticsEntry[];
  tiers: Record<string, number>;
  repeatShare: number;
  languages: CustomerLanguageCount[];
} | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/insights/customer-analytics?days=" + days
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const rawCustomers = Array.isArray(row.customers) ? row.customers : [];
  const rawTiers =
    row.tiers !== null && typeof row.tiers === "object"
      ? (row.tiers as Record<string, unknown>)
      : {};
  return {
    customers: rawCustomers
      .filter((entry): entry is Record<string, unknown> =>
        entry !== null && typeof entry === "object")
      .map((entry) => ({
        contactId:
          typeof entry.contact_id === "string" ? entry.contact_id : "",
        orders: typeof entry.orders === "number" ? entry.orders : 0,
        spend: typeof entry.spend === "number" ? entry.spend : 0,
        avgOrder: typeof entry.avg_order === "number" ? entry.avg_order : 0,
        tier: typeof entry.tier === "string" ? entry.tier : "new",
        lastOrder:
          typeof entry.last_order === "string" ? entry.last_order : null,
      })),
    tiers: {
      new: typeof rawTiers.new === "number" ? rawTiers.new : 0,
      repeat: typeof rawTiers.repeat === "number" ? rawTiers.repeat : 0,
      vip: typeof rawTiers.vip === "number" ? rawTiers.vip : 0,
    },
    repeatShare: typeof row.repeat_share === "number" ? row.repeat_share : 0,
    languages: (Array.isArray(row.languages) ? row.languages : [])
      .filter((entry): entry is Record<string, unknown> =>
        entry !== null && typeof entry === "object")
      .map((entry) => ({
        lang: typeof entry.lang === "string" ? entry.lang : "",
        count: typeof entry.count === "number" ? entry.count : 0,
      })),
  };
}

export async function getProductAnalytics(
  accessToken: string,
  days: number
): Promise<ProductAnalyticsEntry[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/insights/product-analytics?days=" + days
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = Array.isArray(
    (payload as Record<string, unknown>).products
  )
    ? ((payload as Record<string, unknown>).products as unknown[])
    : [];
  return raw
    .filter((entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === "object")
    .map((entry) => ({
      name: typeof entry.name === "string" ? entry.name : "",
      qtySold: typeof entry.qty_sold === "number" ? entry.qty_sold : 0,
      revenue: typeof entry.revenue === "number" ? entry.revenue : 0,
      orders: typeof entry.orders === "number" ? entry.orders : 0,
    }));
}

export interface RetentionSettings {
  closeIdleDays: number;
  purgeRejectedDays: number;
}

export async function getRetention(
  accessToken: string
): Promise<RetentionSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/data/retention");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = (payload as Record<string, unknown>).retention;
  if (row === null || typeof row !== "object") return null;
  const data = row as Record<string, unknown>;
  return {
    closeIdleDays:
      typeof data.close_idle_days === "number" ? data.close_idle_days : 14,
    purgeRejectedDays:
      typeof data.purge_rejected_days === "number"
        ? data.purge_rejected_days
        : 30,
  };
}

export async function saveRetention(
  accessToken: string,
  closeIdleDays: number,
  purgeRejectedDays: number
): Promise<RetentionSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/data/retention", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        close_idle_days: closeIdleDays,
        purge_rejected_days: purgeRejectedDays,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = (payload as Record<string, unknown>).retention;
  if (row === null || typeof row !== "object") return null;
  const data = row as Record<string, unknown>;
  return {
    closeIdleDays:
      typeof data.close_idle_days === "number" ? data.close_idle_days : 14,
    purgeRejectedDays:
      typeof data.purge_rejected_days === "number"
        ? data.purge_rejected_days
        : 30,
  };
}

export async function runRetention(
  accessToken: string
): Promise<{ closed: number; purged: number } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/data/retention/run",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  return {
    closed: typeof row.closed === "number" ? row.closed : 0,
    purged: typeof row.purged === "number" ? row.purged : 0,
  };
}

export async function fetchDataExport(
  accessToken: string
): Promise<{ status: number; body: string; filename: string | null } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/data/export");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  const body = await response.text().catch(() => "");
  const disposition = response.headers.get("content-disposition");
  const match = disposition
    ? /filename="([^"]+)"/.exec(disposition)
    : null;
  return { status: response.status, body, filename: match ? match[1] : null };
}

export interface InteractiveTemplate {
  id: number | null;
  name: string;
  kind: string;
  header: string;
  body: string;
  footer: string;
  rows: { title: string; description?: string }[];
  listLabel: string;
  createdAt: string | null;
}

export async function listInteractiveTemplates(
  accessToken: string
): Promise<InteractiveTemplate[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/interactive/templates");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = Array.isArray((payload as Record<string, unknown>).templates)
    ? ((payload as Record<string, unknown>).templates as unknown[])
    : [];
  return raw
    .filter((entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === "object")
    .map((entry) => {
      const rawRows = Array.isArray(entry.rows) ? entry.rows : [];
      return {
        id: typeof entry.id === "number" ? entry.id : null,
        name: typeof entry.name === "string" ? entry.name : "",
        kind: typeof entry.kind === "string" ? entry.kind : "buttons",
        header: typeof entry.header === "string" ? entry.header : "",
        body: typeof entry.body === "string" ? entry.body : "",
        footer: typeof entry.footer === "string" ? entry.footer : "",
        rows: rawRows
          .filter((row): row is Record<string, unknown> =>
            row !== null && typeof row === "object")
          .map((row) => ({
            title: typeof row.title === "string" ? row.title : "",
            description:
              typeof row.description === "string" ? row.description : undefined,
          }))
          .filter((row) => row.title !== ""),
        listLabel: typeof entry.list_label === "string" ? entry.list_label : "",
        createdAt:
          typeof entry.created_at === "string" ? entry.created_at : null,
      };
    });
}

export interface InteractiveTemplateInput {
  name: string;
  kind: string;
  header: string;
  body: string;
  footer: string;
  listLabel: string;
  rows: { title: string; description?: string }[];
}

function interactiveTemplateBody(input: InteractiveTemplateInput): string {
  return JSON.stringify({
    name: input.name,
    kind: input.kind,
    header: input.header,
    body: input.body,
    footer: input.footer,
    list_label: input.listLabel,
    rows: input.rows.map((row) => ({
      title: row.title,
      ...(row.description ? { description: row.description } : {}),
    })),
  });
}

export async function createInteractiveTemplate(
  accessToken: string,
  input: InteractiveTemplateInput
): Promise<{ ok: true } | "bad_request" | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/interactive/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: interactiveTemplateBody(input),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 400) return "bad_request";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { ok: true };
}

export async function updateInteractiveTemplate(
  accessToken: string,
  templateId: number,
  input: InteractiveTemplateInput
): Promise<{ ok: true } | "not_found" | "bad_request" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/interactive/templates/" + templateId,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: interactiveTemplateBody(input),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 400) return "bad_request";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { ok: true };
}

export async function deleteInteractiveTemplate(
  accessToken: string,
  templateId: number
): Promise<{ ok: true } | "not_found" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/interactive/templates/" + templateId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { ok: true };
}

export type InteractiveSendResult =
  | { ok: true; kind: string }
  | "not_found"
  | "bad_request"
  | null;

export async function sendInteractiveTemplate(
  accessToken: string,
  conversationId: number,
  templateId: number
): Promise<InteractiveSendResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/interactive/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: conversationId,
        template_id: templateId,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 400) return "bad_request";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  if (row.ok !== true) return null;
  return { ok: true, kind: typeof row.kind === "string" ? row.kind : "buttons" };
}

export interface WatiSettings {
  enabled: boolean;
  baseUrl: string;
  tokenMasked: string;
  configured: boolean;
}

export async function getWatiSettings(
  accessToken: string
): Promise<WatiSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/wati/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = ((payload as Record<string, unknown>).settings || {}) as Record<string, unknown>;
  return {
    enabled: row.enabled === true,
    baseUrl: typeof row.baseUrl === "string" ? row.baseUrl : "",
    tokenMasked: typeof row.tokenMasked === "string" ? row.tokenMasked : "",
    configured: row.configured === true,
  };
}

export async function saveWatiSettings(
  accessToken: string,
  input: { enabled: boolean; baseUrl: string; apiToken: string }
): Promise<{ ok: true } | "bad_request" | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/wati/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: input.enabled,
        base_url: input.baseUrl,
        api_token: input.apiToken,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 400) return "bad_request";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { ok: true };
}

export async function syncWatiTemplates(
  accessToken: string
): Promise<{ ok: true; count: number } | "bad_request" | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/wati/sync", {
      method: "POST",
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 400) return "bad_request";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  if (row.ok !== true) return null;
  return { ok: true, count: typeof row.count === "number" ? row.count : 0 };
}

export async function listWatiTemplates(
  accessToken: string
): Promise<{ name: string; data: Record<string, unknown> }[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/wati/templates");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = Array.isArray((payload as Record<string, unknown>).templates)
    ? ((payload as Record<string, unknown>).templates as unknown[])
    : [];
  return raw
    .filter((entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === "object")
    .map((entry) => ({
      name: typeof entry.name === "string" ? entry.name : "",
      data:
        entry.data !== null && typeof entry.data === "object"
          ? (entry.data as Record<string, unknown>)
          : {},
    }))
    .filter((entry) => entry.name !== "");
}

export async function sendWatiTemplate(
  accessToken: string,
  conversationId: number,
  templateName: string,
  parameters: string[]
): Promise<{ ok: true } | "not_found" | "bad_request" | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/wati/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: conversationId,
        template_name: templateName,
        parameters: parameters.map((value, index) => ({
          name: String(index + 1),
          value,
        })),
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 400) return "bad_request";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  if ((payload as Record<string, unknown>).ok !== true) return null;
  return { ok: true };
}

export interface ChangeRequest {
  id: number;
  linkId: number;
  kind: "address" | "cancel";
  message: string;
  addressText: string;
  status: "pending" | "approved" | "declined";
  createdAt: string | null;
  decidedAt: string | null;
  title: string;
}

function mapChangeRequest(raw: Record<string, unknown>): ChangeRequest {
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    linkId: typeof raw.linkId === "number" ? raw.linkId : 0,
    kind: raw.kind === "cancel" ? "cancel" : "address",
    message: typeof raw.message === "string" ? raw.message : "",
    addressText: typeof raw.addressText === "string" ? raw.addressText : "",
    status:
      raw.status === "approved"
        ? "approved"
        : raw.status === "declined"
          ? "declined"
          : "pending",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    decidedAt: typeof raw.decidedAt === "string" ? raw.decidedAt : null,
    title: typeof raw.title === "string" ? raw.title : "",
  };
}

export async function listChangeRequests(
  accessToken: string,
  statusFilter: "pending" | "approved" | "declined" | "all"
): Promise<{ requests: ChangeRequest[]; counts: Record<string, number> } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/changes/requests?status=" + statusFilter
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    requests?: unknown;
    counts?: unknown;
  } | null;
  if (!payload || !Array.isArray(payload.requests)) return null;
  const counts: Record<string, number> = {};
  if (payload.counts && typeof payload.counts === "object") {
    for (const [key, value] of Object.entries(
      payload.counts as Record<string, unknown>
    )) {
      if (typeof value === "number") counts[key] = value;
    }
  }
  return {
    requests: payload.requests
      .filter((row): row is Record<string, unknown> =>
        row !== null && typeof row === "object")
      .map(mapChangeRequest),
    counts,
  };
}

export async function decideChangeRequest(
  accessToken: string,
  requestId: number,
  action: "approve" | "decline"
): Promise<{ ok: true; request: ChangeRequest } | "bad_request" | "conflict" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/changes/requests/" + requestId + "/decide",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return "bad_request";
  if (response.status === 409) return "conflict";
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    request?: unknown;
  } | null;
  if (!payload || !payload.request || typeof payload.request !== "object") {
    return null;
  }
  return {
    ok: true,
    request: mapChangeRequest(payload.request as Record<string, unknown>),
  };
}

export async function submitChangeRequest(
  token: string,
  input: { kind: "address" | "cancel"; message: string; addressText: string }
): Promise<{ ok: true } | { error: { message: string } } | null> {
  const response = await controlPlanePublicRequest(
    "api/v1/public/checkout/" + encodeURIComponent(token) + "/change-request",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: input.kind,
        message: input.message,
        address_text: input.addressText,
      }),
    }
  );
  if (response === null) return null;
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (payload === null) return null;
  if (!response.ok) {
    const error =
      payload.error !== null && typeof payload.error === "object"
        ? (payload.error as Record<string, unknown>)
        : {};
    return {
      error: { message: typeof error.message === "string" ? error.message : "" },
    };
  }
  return { ok: true };
}

export interface Coupon {
  id: number;
  code: string;
  kind: "percent" | "fixed";
  value: number;
  minTotal: number;
  usageLimit: number | null;
  usedCount: number;
  expiresAt: string | null;
  isActive: boolean;
}

function mapCoupon(raw: Record<string, unknown>): Coupon {
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    code: typeof raw.code === "string" ? raw.code : "",
    kind: raw.kind === "percent" ? "percent" : "fixed",
    value: typeof raw.value === "number" ? raw.value : 0,
    minTotal: typeof raw.minTotal === "number" ? raw.minTotal : 0,
    usageLimit: typeof raw.usageLimit === "number" ? raw.usageLimit : null,
    usedCount: typeof raw.usedCount === "number" ? raw.usedCount : 0,
    expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : null,
    isActive: raw.isActive === true,
  };
}

export async function listCoupons(
  accessToken: string
): Promise<{ coupons: Coupon[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/coupons");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    coupons?: unknown;
  } | null;
  if (!payload || !Array.isArray(payload.coupons)) return null;
  return {
    coupons: payload.coupons
      .filter((row): row is Record<string, unknown> =>
        row !== null && typeof row === "object")
      .map(mapCoupon),
  };
}

export type CouponInput = {
  code: string;
  kind: "percent" | "fixed";
  value: number;
  min_total?: number;
  usage_limit?: number | null;
  expires_in_days?: number | null;
};

export async function createCoupon(
  accessToken: string,
  input: CouponInput
): Promise<{ ok: true; coupon: Coupon } | { error: string } | "conflict" | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/coupons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 409) return "conflict";
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return { error: payload?.error?.message || "Check the coupon details." };
  }
  const payload = (await response.json().catch(() => null)) as {
    coupon?: unknown;
  } | null;
  if (!payload || !payload.coupon || typeof payload.coupon !== "object") {
    return null;
  }
  return {
    ok: true,
    coupon: mapCoupon(payload.coupon as Record<string, unknown>),
  };
}

export async function setCouponActive(
  accessToken: string,
  couponId: number,
  isActive: boolean
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/coupons/" + couponId,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: isActive }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function deleteCoupon(
  accessToken: string,
  couponId: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/coupons/" + couponId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export type PublicPhoneOtpResult =
  | { ok: true; sent: true }
  | "not_found"
  | "feature_off"
  | "rate_limited"
  | null;

export async function requestPublicPhoneOtp(
  token: string
): Promise<PublicPhoneOtpResult> {
  const response = await controlPlanePublicRequest(
    "api/v1/public/checkout/" + encodeURIComponent(token) + "/otp",
    { method: "POST" }
  );
  if (response === null) return null;
  if (response.status === 404) return "not_found";
  if (response.status === 409) return "feature_off";
  if (response.status === 429) return "rate_limited";
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (payload === null || payload.ok !== true) return null;
  return { ok: true, sent: true };
}

export type PublicPhoneOtpVerifyResult =
  | { ok: true; verified: true }
  | "not_found"
  | "feature_off"
  | "rate_limited"
  | "bad_code"
  | null;

export async function verifyPublicPhoneOtp(
  token: string,
  code: string
): Promise<PublicPhoneOtpVerifyResult> {
  const response = await controlPlanePublicRequest(
    "api/v1/public/checkout/" + encodeURIComponent(token) + "/otp/verify",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    }
  );
  if (response === null) return null;
  if (response.status === 404) return "not_found";
  if (response.status === 409) return "feature_off";
  if (response.status === 429) return "rate_limited";
  if (response.status === 400) return "bad_code";
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (payload === null || payload.verified !== true) return null;
  return { ok: true, verified: true };
}

export async function applyPublicCoupon(
  token: string,
  code: string
): Promise<
  | { ok: true; total: number; discount: number; code: string }
  | { error: string }
  | null
> {
  const response = await controlPlanePublicRequest(
    "api/v1/public/checkout/" + encodeURIComponent(token) + "/coupon",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    }
  );
  if (response === null) return null;
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (payload === null) return null;
  if (!response.ok) {
    const error =
      payload.error !== null && typeof payload.error === "object"
        ? (payload.error as Record<string, unknown>)
        : {};
    return {
      error: typeof error.message === "string" ? error.message : "",
    };
  }
  return {
    ok: true,
    total: typeof payload.total === "number" ? payload.total : 0,
    discount: typeof payload.discount === "number" ? payload.discount : 0,
    code: typeof payload.code === "string" ? payload.code : "",
  };
}

export async function removePublicCoupon(
  token: string
): Promise<{ ok: true; total: number } | { error: string } | null> {
  const response = await controlPlanePublicRequest(
    "api/v1/public/checkout/" + encodeURIComponent(token) + "/coupon",
    { method: "DELETE" }
  );
  if (response === null) return null;
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (payload === null) return null;
  if (!response.ok) {
    const error =
      payload.error !== null && typeof payload.error === "object"
        ? (payload.error as Record<string, unknown>)
        : {};
    return {
      error: typeof error.message === "string" ? error.message : "",
    };
  }
  return { ok: true, total: typeof payload.total === "number" ? payload.total : 0 };
}

export interface CloudTemplate {
  id: number;
  name: string;
  language: string;
  status: string;
  category: string;
}

export async function getCloudTemplates(
  accessToken: string
): Promise<{ templates: CloudTemplate[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/cloud/templates");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    templates?: unknown;
  } | null;
  if (!payload || !Array.isArray(payload.templates)) return null;
  return {
    templates: payload.templates
      .filter((row): row is Record<string, unknown> =>
        row !== null && typeof row === "object")
      .map((row) => ({
        id: typeof row.id === "number" ? row.id : 0,
        name: typeof row.name === "string" ? row.name : "",
        language: typeof row.language === "string" ? row.language : "",
        status: typeof row.status === "string" ? row.status : "",
        category: typeof row.category === "string" ? row.category : "",
      })),
  };
}

export async function sendCloudTemplate(
  accessToken: string,
  input: {
    conversationId: number;
    templateName: string;
    languageCode: string;
    parameters: string[];
  }
): Promise<{ ok: true; template: string } | "bad_request" | "not_found" | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/cloud/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: input.conversationId,
        template_name: input.templateName,
        language_code: input.languageCode,
        parameters: input.parameters,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return "bad_request";
  if (response.status === 404) return "not_found";
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    template?: unknown;
  } | null;
  return {
    ok: true,
    template: typeof payload?.template === "string" ? payload.template : "",
  };
}

// ---------------------------------------------------------------------------
// Deliveries (event core: failed command queue + dead letters)
// ---------------------------------------------------------------------------

export type DeliveryStatus = "pending" | "failed" | "dead" | "done";

export interface DeliveryRow {
  id: number;
  kind: string;
  label: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  providerMessageId: string | null;
  channel: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DeliveriesPayload {
  deliveries: DeliveryRow[];
  counts: Record<DeliveryStatus, number>;
}

function mapDeliveryRow(row: Record<string, unknown>): DeliveryRow {
  return {
    id: typeof row.id === "number" ? row.id : 0,
    kind: typeof row.kind === "string" ? row.kind : "command",
    label: typeof row.label === "string" ? row.label : "",
    status: typeof row.status === "string" ? row.status : "",
    attempts: typeof row.attempts === "number" ? row.attempts : 0,
    nextAttemptAt: typeof row.nextAttemptAt === "string" ? row.nextAttemptAt : null,
    errorCode: typeof row.errorCode === "string" ? row.errorCode : null,
    errorMessage: typeof row.errorMessage === "string" ? row.errorMessage : null,
    providerMessageId:
      typeof row.providerMessageId === "string" ? row.providerMessageId : null,
    channel: typeof row.channel === "string" ? row.channel : null,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : null,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
  };
}

export async function listDeliveries(
  accessToken: string,
  status?: DeliveryStatus
): Promise<DeliveriesPayload | null> {
  let response: Response;
  try {
    const query = status ? "?status=" + encodeURIComponent(status) : "";
    response = await portalRequest(
      accessToken,
      "api/v1/portal/deliveries" + query
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    deliveries?: unknown;
    counts?: unknown;
  } | null;
  if (!payload || !Array.isArray(payload.deliveries)) return null;
  const counts = (payload.counts ?? {}) as Record<string, unknown>;
  return {
    deliveries: payload.deliveries
      .filter((row): row is Record<string, unknown> =>
        row !== null && typeof row === "object")
      .map(mapDeliveryRow),
    counts: {
      pending: typeof counts.pending === "number" ? counts.pending : 0,
      failed: typeof counts.failed === "number" ? counts.failed : 0,
      dead: typeof counts.dead === "number" ? counts.dead : 0,
      done: typeof counts.done === "number" ? counts.done : 0,
    },
  };
}

export interface GrowthBundlePayload {
  segments?: Record<string, unknown> | null;
  trends?:
    | Record<string, { day: string | null; value: number }[]>
    | null;
  days?: number;
  generated_at?: string;
}

export async function getGrowthBundle(
  accessToken: string,
  days: number
): Promise<GrowthBundlePayload | "bundle_disabled" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/growth-bundle?days=" +
        encodeURIComponent(String(days))
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 503) return "bundle_disabled";
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as
    | GrowthBundlePayload
    | null;
  return payload;
}

export interface PortalAlert {
  id: number;
  kind: string;
  severity: string;
  title: string;
  detail: string;
  is_read: boolean;
  created_at: string | null;
}

export interface AlertsPayload {
  alerts: PortalAlert[];
  unread: number;
}

export async function listAlerts(
  accessToken: string
): Promise<AlertsPayload | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/alerts");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as AlertsPayload | null;
}

export async function markAlertsRead(
  accessToken: string,
  id?: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/alerts/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(id ? { id } : { all: true }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function putAlertSettings(
  accessToken: string,
  enabled: boolean
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/alerts/settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export interface BrainSettings {
  autonomy: "off" | "suggest" | "auto";
  tone: string;
}

export interface BrainDraftResult {
  decision: string;
  draft: string;
  grounding: Record<string, unknown> | null;
  autonomy?: string;
  kbEntry?: { title: string; content: string } | null;
}

export async function getBrainSettings(
  accessToken: string
): Promise<BrainSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/brain/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    settings?: BrainSettings;
  } | null;
  return payload?.settings ?? null;
}

export async function putBrainSettings(
  accessToken: string,
  settings: BrainSettings
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/brain/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function draftBrainReply(
  accessToken: string,
  conversationId: number
): Promise<BrainDraftResult | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/brain/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: conversationId }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const result = payload as BrainDraftResult & {
    kb_entry?: unknown;
  };
  const rawEntry = result.kb_entry;
  const kbEntry =
    rawEntry !== null && typeof rawEntry === "object"
      ? {
          title: String(
            (rawEntry as Record<string, unknown>).title || "Saved answer"
          ),
          content: String((rawEntry as Record<string, unknown>).content || ""),
        }
      : null;
  return { ...result, kbEntry };
}

export async function listBrainTraces(
  accessToken: string,
  conversationId?: number
): Promise<{ traces: Record<string, unknown>[] } | null> {
  let response: Response;
  try {
    const query = conversationId
      ? "?conversation_id=" + encodeURIComponent(String(conversationId))
      : "";
    response = await portalRequest(accessToken, "api/v1/portal/brain/trace" + query);
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    traces: Record<string, unknown>[];
  } | null;
}

export interface MemoryEntry {
  id: number;
  kind: "preference" | "note" | "fact";
  content: string;
  created_by: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface JourneyStage {
  id: number;
  name: string;
  position: number;
  is_active: boolean;
}

export interface JourneyEvent {
  stage_name: string;
  source: string;
  created_at: string | null;
}

export interface JourneySnapshot {
  stages: JourneyStage[];
  current: { stage_id: number; name: string; updated_at: string } | null;
  events: JourneyEvent[];
}

export interface ExplainActivity {
  action: string;
  actor_kind: string;
  note: string;
  created_at: string | null;
}

export async function listCustomerMemory(
  accessToken: string,
  contact: string
): Promise<{ memory: MemoryEntry[]; cap: number } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/memory?contact=" + encodeURIComponent(contact)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    memory: MemoryEntry[];
    cap: number;
  } | null;
}

export async function addCustomerMemory(
  accessToken: string,
  contact: string,
  kind: MemoryEntry["kind"],
  content: string
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact, kind, content }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function updateCustomerMemory(
  accessToken: string,
  id: number,
  content: string
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/memory/" + id, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function deleteCustomerMemory(
  accessToken: string,
  id: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/memory/" + id, {
      method: "DELETE",
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function purgeCustomerMemory(
  accessToken: string,
  contact: string
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/memory?contact=" + encodeURIComponent(contact),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function getJourney(
  accessToken: string,
  contact: string
): Promise<JourneySnapshot | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/journey?contact=" + encodeURIComponent(contact)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as JourneySnapshot | null;
}

export async function moveJourneyStage(
  accessToken: string,
  contact: string,
  stageId: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/journey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact, stage_id: stageId }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function addJourneyStage(
  accessToken: string,
  name: string
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/journey/stages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function deleteJourneyStage(
  accessToken: string,
  stageId: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/journey/stages/" + stageId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function getExplain(
  accessToken: string,
  contact: string
): Promise<{ activity: ExplainActivity[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/explain?contact=" + encodeURIComponent(contact)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    activity: ExplainActivity[];
  } | null;
}

export interface RecoveryItem {
  id: number;
  kind: string;
  contact_id: string;
  conversation_id: number | null;
  priority: number;
  status: string;
  note: string;
  created_at: string | null;
}

export interface RecoverySettings {
  auto_enabled: boolean;
  checkout_hours: number;
  cod_hours: number;
  inactive_days: number;
  min_value: number;
}

export interface PriceBounds {
  enabled: boolean;
  min_price: number;
  max_discount_pct: number;
}

export interface NegotiationDecision {
  decision: "accept" | "counter" | "reject";
  counter_price: number;
  floor: number;
  message: string;
}

export async function listRecoveries(
  accessToken: string
): Promise<{ items: RecoveryItem[]; settings: RecoverySettings } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/recovery");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    items: RecoveryItem[];
    settings: RecoverySettings;
  } | null;
}

export async function sendRecoveryFollowup(
  accessToken: string,
  id: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/recovery/followup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function dismissRecovery(
  accessToken: string,
  id: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/recovery/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function putRecoverySettings(
  accessToken: string,
  settings: RecoverySettings
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/recovery/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function getPriceBounds(
  accessToken: string
): Promise<PriceBounds | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/negotiation/bounds"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    settings?: PriceBounds;
  } | null;
  return payload?.settings ?? null;
}

export async function putPriceBounds(
  accessToken: string,
  settings: PriceBounds
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/negotiation/bounds",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function decideNegotiation(
  accessToken: string,
  input: { price: number; offer: number; conversation_id?: number }
): Promise<NegotiationDecision | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/negotiation/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as NegotiationDecision | null;
}

export async function generateBroadcastCopy(
  accessToken: string,
  topic: string,
  lang: "ur" | "roman" | "en"
): Promise<{ variants: string[]; source: string } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/copygen/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, lang }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    variants: string[];
    source: string;
  } | null;
}

export interface RiskFactor {
  key: string;
  points: number;
  note: string;
}

export interface RiskScore {
  score: number;
  factors: RiskFactor[];
  recommendation: "proceed" | "collect_advance" | "hold";
  threshold: number;
  task_created: boolean;
}

export interface RiskSettings {
  score_threshold: number;
  staff_tasks: boolean;
  city_default_pct: number;
}

export interface RiskTask {
  id: number;
  contact_id: string;
  conversation_id: number | null;
  score: number;
  factors: RiskFactor[];
  created_at: string | null;
}

export interface AddressIntel {
  normalized: string;
  city: string | null;
  phone: string | null;
  issues: string[];
  ask_prompts: string[];
}

export async function getRiskScore(
  accessToken: string,
  contact: string,
  options?: { total?: number; address?: string }
): Promise<RiskScore | null> {
  let query = "?contact=" + encodeURIComponent(contact);
  if (options?.total) query += "&total=" + encodeURIComponent(String(options.total));
  if (options?.address)
    query += "&address=" + encodeURIComponent(options.address);
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/risk/score" + query);
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as RiskScore | null;
}

export async function getRiskSettings(
  accessToken: string
): Promise<{ settings: RiskSettings; city_rates: { city: string; return_pct: number }[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/risk/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    settings: RiskSettings;
    city_rates: { city: string; return_pct: number }[];
  } | null;
}

export async function putRiskSettings(
  accessToken: string,
  settings: RiskSettings
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/risk/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function listRiskTasks(
  accessToken: string
): Promise<{ tasks: RiskTask[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/risk/tasks");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    tasks: RiskTask[];
  } | null;
}

export async function completeRiskTask(
  accessToken: string,
  id: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/risk/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function normalizeAddress(
  accessToken: string,
  address: string
): Promise<AddressIntel | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/address/normalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as AddressIntel | null;
}

export interface CourierSettings {
  configured: boolean;
  enabled: boolean;
  provider: string;
  base_url: string;
  api_key_masked: string;
  api_password_masked: string;
  secret_label: string;
  providers: { id: string; label: string; default_base: string }[];
}

export interface CourierBooking {
  id: number;
  contact_id: string;
  tracking_number: string;
  provider: string;
  status: string;
  raw_status: string;
  cod_amount: number;
  city: string;
  created_at: string | null;
  tracked_at: string | null;
}

export interface CourierBookInput {
  contact_id?: string;
  customer_name?: string;
  phone?: string;
  city: string;
  address: string;
  cod_amount?: number;
  pieces?: number;
  weight?: number;
  description?: string;
}

export async function getCourierSettings(
  accessToken: string
): Promise<CourierSettings | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/courier/settings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as CourierSettings | null;
}

export async function putCourierSettings(
  accessToken: string,
  settings: {
    provider: string;
    api_key?: string;
    api_password?: string;
    base_url?: string;
    enabled?: boolean;
  }
): Promise<{ ok: boolean; configured: boolean } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/courier/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    ok: boolean;
    configured: boolean;
  } | null;
}

export async function testCourierConnection(
  accessToken: string
): Promise<{ ok: boolean; message: string } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/courier/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    message?: string;
  } | null;
  if (payload === null) return null;
  return { ok: Boolean(payload.ok), message: payload.message ?? "" };
}

export async function bookCourierParcel(
  accessToken: string,
  input: CourierBookInput
): Promise<{
  ok: boolean;
  id: number | null;
  tracking_number: string;
  address_issues: string[];
  ask_prompts: string[];
} | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/courier/book", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    ok: boolean;
    id: number | null;
    tracking_number: string;
    address_issues: string[];
    ask_prompts: string[];
  } | null;
}

export async function listCourierBookings(
  accessToken: string
): Promise<{
  bookings: CourierBooking[];
  summary: Record<string, number>;
} | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/courier/bookings");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    bookings: CourierBooking[];
    summary: Record<string, number>;
  } | null;
}

export async function trackCourierParcel(
  accessToken: string,
  id: number
): Promise<{
  ok: boolean;
  id: number;
  status: string;
  raw_status: string;
  events: { when: string; status: string; detail: string }[];
} | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/courier/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    ok: boolean;
    id: number;
    status: string;
    raw_status: string;
    events: { when: string; status: string; detail: string }[];
  } | null;
}

export interface CourierProvider {
  id: number;
  name: string;
  adapter: string;
  base_url: string;
  api_key_masked: string;
  api_secret_masked: string;
  booking_mode: string;
  enabled: boolean;
  test_status: string;
  test_message: string;
  created_at: string;
}

export interface CourierProviderAdapter {
  key: string;
  label: string;
  default_base: string;
  secret_label: string;
}

export interface CourierProviderInput {
  name: string;
  adapter: string;
  base_url?: string;
  api_key?: string;
  api_secret?: string;
  booking_mode?: string;
  enabled?: boolean;
}

export async function listCourierProviders(
  accessToken: string
): Promise<{
  providers: CourierProvider[];
  adapters: CourierProviderAdapter[];
  booking_modes: string[];
} | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/courier/providers");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    providers: CourierProvider[];
    adapters: CourierProviderAdapter[];
    booking_modes: string[];
  } | null;
}

export async function createCourierProvider(
  accessToken: string,
  input: CourierProviderInput
): Promise<{ ok: boolean; id: number } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/courier/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    ok: boolean;
    id: number;
  } | null;
}

export async function updateCourierProvider(
  accessToken: string,
  id: number,
  patch: Partial<CourierProviderInput>
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/courier/providers/" + id,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function deleteCourierProvider(
  accessToken: string,
  id: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/courier/providers/" + id,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function testCourierProvider(
  accessToken: string,
  id: number
): Promise<{ ok: boolean; message: string } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/courier/providers/" + id + "/test",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    ok: boolean;
    message: string;
  } | null;
}

export async function confirmCourierBooking(
  accessToken: string,
  id: number
): Promise<{ ok: boolean; id: number; tracking_number: string } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/courier/bookings/" + id + "/confirm",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    ok: boolean;
    id: number;
    tracking_number: string;
  } | null;
}

export interface OperationsSnapshot {
  chats: { new: number; open: number; total: number };
  messages: { received: number; sent: number };
  orders: { paid: number; revenue: number };
  deliveries: {
    bookings: number;
    by_status: Record<string, number>;
  };
  recovery: { open: number; resolved: number };
  csat: { answers: number; avg_score: number | null };
}

export async function getOperations(
  accessToken: string,
  days?: number
): Promise<{ days: number; operations: OperationsSnapshot } | null> {
  let response: Response;
  try {
    const query = days ? "?days=" + String(days) : "";
    response = await portalRequest(
      accessToken,
      "api/v1/portal/insights/operations" + query
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    days: number;
    operations: OperationsSnapshot;
  } | null;
}

export interface TemplatePack {
  key: string;
  label: string;
  description: string;
  persona: {
    agent_name: string;
    tone: string;
    greeting: string;
    fallback: string;
  };
  kb: { title: string; category: string; keywords: string;
        content: string; lang: string }[];
  keywords: { keyword: string; note: string }[];
  saved_replies: { shortcut: string; body: string }[];
  journey: string[];
}

export interface TemplatesPayload {
  packs: TemplatePack[];
  applied: string;
  applied_at: string;
}

export async function listTemplates(
  accessToken: string
): Promise<TemplatesPayload | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/templates");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as TemplatesPayload | null;
}

export async function applyTemplate(
  accessToken: string,
  vertical: string,
  overwritePersona = false
): Promise<{
  ok: boolean;
  vertical: string;
  created: Record<string, number>;
} | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken,
      "api/v1/portal/templates/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vertical, overwrite_persona: overwritePersona }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    ok: boolean;
    vertical: string;
    created: Record<string, number>;
  } | null;
}

export interface Brand {
  id: number;
  name: string;
  isActive: boolean;
  createdAt: string | null;
}

function mapBrand(raw: Record<string, unknown>): Brand {
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    name: typeof raw.name === "string" ? raw.name : "",
    isActive: raw.is_active === true,
    createdAt: typeof raw.created_at === "string" ? raw.created_at : null,
  };
}

export interface VoiceCall {
  id: number;
  contactId: string;
  phone: string;
  sid: string;
  status: string;
  message: string;
  createdAt: string | null;
}

export async function listVoiceCalls(
  accessToken: string
): Promise<VoiceCall[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/voice/calls", {
      method: "GET",
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).calls
    : null;
  if (!Array.isArray(raw)) return null;
  return raw.map((row: Record<string, unknown>) => ({
    id: Number(row.id || 0),
    contactId: String(row.contact_id || ""),
    phone: String(row.phone || ""),
    sid: String(row.sid || ""),
    status: String(row.status || ""),
    message: String(row.message || ""),
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
  }));
}

export type VoiceCallMutation =
  | { ok: true; call: VoiceCall }
  | "not_configured"
  | "bad_request"
  | null;

export async function callContact(
  accessToken: string,
  contactId: string,
  phone: string,
  message: string
): Promise<VoiceCallMutation> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/voice/calls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_id: contactId, phone, message }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 409) return "not_configured";
  if (response.status === 400) return "bad_request";
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).call;
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  return {
    ok: true,
    call: {
      id: Number(row.id || 0),
      contactId: String(row.contact_id || ""),
      phone: String(row.phone || ""),
      sid: String(row.sid || ""),
      status: String(row.status || ""),
      message: String(row.message || ""),
      createdAt: typeof row.created_at === "string" ? row.created_at : null,
    },
  };
}

export interface VideoRoom {
  id: number;
  conversationId: number;
  contactId: string;
  provider: string;
  url: string;
  createdAt: string | null;
}

export async function listVideoRooms(
  accessToken: string,
  conversationId?: number
): Promise<VideoRoom[] | null> {
  let response: Response;
  try {
    const query = conversationId && conversationId > 0
      ? "?conversation_id=" + conversationId
      : "";
    response = await portalRequest(
      accessToken,
      "api/v1/portal/video/rooms" + query,
      { method: "GET" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).rooms
    : null;
  if (!Array.isArray(raw)) return null;
  return raw.map((row: Record<string, unknown>) => ({
    id: Number(row.id || 0),
    conversationId: Number(row.conversation_id || 0),
    contactId: String(row.contact_id || ""),
    provider: String(row.provider || ""),
    url: String(row.url || ""),
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
  }));
}

export type VideoRoomMutation =
  | { ok: true; room: VideoRoom }
  | "not_configured"
  | "bad_request"
  | null;

export async function sendVideoInvite(
  accessToken: string,
  conversationId: number,
  provider?: string,
  title?: string
): Promise<VideoRoomMutation> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/video/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: conversationId,
        provider: provider || undefined,
        title: title || undefined,
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 409) return "not_configured";
  if (response.status === 400) return "bad_request";
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).room;
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  return {
    ok: true,
    room: {
      id: Number(row.id || 0),
      conversationId: Number(row.conversation_id || 0),
      contactId: String(row.contact_id || ""),
      provider: String(row.provider || ""),
      url: String(row.url || ""),
      createdAt: typeof row.created_at === "string" ? row.created_at : null,
    },
  };
}

export async function listBrands(
  accessToken: string
): Promise<Brand[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/brands");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).brands;
  if (!Array.isArray(rawList)) return null;
  return rawList
    .filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === "object")
    .map(mapBrand);
}

export async function createBrand(
  accessToken: string,
  name: string
): Promise<{ ok: boolean; status: number }> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/brands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { ok: false, status: 0 };
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return { ok: response.ok, status: response.status };
}

export async function updateBrand(
  accessToken: string,
  brandId: number,
  changes: { name?: string; isActive?: boolean }
): Promise<{ ok: boolean; status: number }> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/brands/" + String(brandId),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(changes.name !== undefined ? { name: changes.name } : {}),
          ...(changes.isActive !== undefined
            ? { is_active: changes.isActive }
            : {}),
        }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { ok: false, status: 0 };
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return { ok: response.ok, status: response.status };
}

export async function deleteBrand(
  accessToken: string,
  brandId: number
): Promise<{ ok: boolean; status: number }> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/brands/" + String(brandId),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { ok: false, status: 0 };
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return { ok: response.ok, status: response.status };
}

export interface PlansPayload {
  plan: string;
  limits: Record<string, number | null>;
  usage: Record<string, number>;
  catalog: {
    key: string;
    label: string;
    description: string;
    limits: Record<string, number | null>;
  }[];
}

export async function getPlans(
  accessToken: string
): Promise<PlansPayload | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/plans");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as PlansPayload | null;
}

export async function putPlan(
  accessToken: string,
  plan: string
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/plans", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export interface MediaAsset {
  id: number;
  kind: string;
  filename: string;
  mime: string;
  size_bytes: number;
  caption: string;
  created_at: string | null;
}

export async function listMediaAssets(
  accessToken: string
): Promise<{ assets: MediaAsset[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/media");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    assets: MediaAsset[];
  } | null;
}

export async function uploadMediaAsset(
  accessToken: string,
  form: FormData
): Promise<{ asset: MediaAsset | null } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/media", {
      method: "POST",
      body: form,
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    asset: MediaAsset | null;
  } | null;
}

export async function deleteMediaAsset(
  accessToken: string,
  id: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/media/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function sendMediaAsset(
  accessToken: string,
  input: { id: number; contact_id: string; conversation_id?: number;
    caption?: string }
): Promise<{ ok: boolean; queued: boolean } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/media/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    ok: boolean;
    queued: boolean;
  } | null;
}

export async function transcribeMediaAsset(
  accessToken: string,
  id: number
): Promise<{ ok: boolean; text: string; model: string } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/media/transcribe",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as {
    ok: boolean;
    text: string;
    model: string;
  } | null;
}

export interface PerfReport {
  counts: {
    conversations: number;
    messages: number;
    actions: number;
    checkout_links: number;
  };
  timings_ms: {
    recent_conversations: number;
    recent_messages: number;
    open_links: number;
  };
  indexes: string[];
  hot_indexes_present: string[];
  missing_hot_indexes: string[];
  ok: boolean;
}

export async function getPerfReport(
  accessToken: string
): Promise<PerfReport | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/perf");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401)
    throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as PerfReport | null;
}

export async function replayDelivery(
  accessToken: string,
  deliveryId: number
): Promise<{ ok: true } | "bad_request" | "not_found" | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/deliveries/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: deliveryId }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return "bad_request";
  if (response.status === 404) return "not_found";
  if (!response.ok) return null;
  return { ok: true };
}

export type CheckoutShareMutation =
  | { ok: true }
  | "not_found"
  | "bad_request"
  | null;

export async function shareCheckoutLink(
  accessToken: string,
  linkId: number,
  message: string
): Promise<CheckoutShareMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/checkout/links/" + linkId + "/share",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 400) return "bad_request";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  if (row.ok !== true) return null;
  return { ok: true };
}

export async function setLinkTracking(
  accessToken: string,
  linkId: number,
  courier: string,
  trackingNumber: string
): Promise<{ ok: true } | "not_found" | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/checkout/links/" + linkId + "/tracking",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courier,
          tracking_number: trackingNumber,
        }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  if (row.ok !== true) return null;
  return { ok: true };
}

export type CheckoutAdvanceMutation =
  | { ok: true; paidAmount: number; due: number; status: string }
  | "not_found"
  | "bad_request"
  | "forbidden"
  | null;

export async function addCheckoutAdvance(
  accessToken: string,
  linkId: number,
  amount: number
): Promise<CheckoutAdvanceMutation> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/checkout/links/" + linkId + "/advance",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 400) return "bad_request";
  if (response.status === 403) return "forbidden";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  if (row.ok !== true) return null;
  return {
    ok: true,
    paidAmount: typeof row.paid_amount === "number" ? row.paid_amount : 0,
    due: typeof row.due === "number" ? row.due : 0,
    status: typeof row.status === "string" ? row.status : "open",
  };
}

export interface ListenRule {
  id: number;
  keyword: string;
  note: string;
}

export async function listListenRules(
  accessToken: string
): Promise<ListenRule[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/listen/rules");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).rules
    : null;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === "object")
    .map((item) => ({
      id: typeof item.id === "number" ? item.id : 0,
      keyword: typeof item.keyword === "string" ? item.keyword : "",
      note: typeof item.note === "string" ? item.note : "",
    }));
}

export async function addListenRule(
  accessToken: string,
  keyword: string,
  note: string
): Promise<ListenRule | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/listen/rules",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword, note }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).rule
    : null;
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  return {
    id: typeof row.id === "number" ? row.id : 0,
    keyword: typeof row.keyword === "string" ? row.keyword : keyword,
    note: typeof row.note === "string" ? row.note : note,
  };
}

export type ListenRuleRemoval = { ok: true } | "not_found" | null;

export async function deleteListenRule(
  accessToken: string,
  ruleId: number
): Promise<ListenRuleRemoval> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/listen/rules/" + ruleId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { ok: true };
}

export interface ListenHit {
  id: number;
  keyword: string;
  conversationId: number | null;
  contactId: string;
  snippet: string;
  createdAt: string | null;
}

export async function listListenHits(
  accessToken: string
): Promise<ListenHit[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/listen/hits");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).hits
    : null;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === "object")
    .map((item) => ({
      id: typeof item.id === "number" ? item.id : 0,
      keyword: typeof item.keyword === "string" ? item.keyword : "",
      conversationId:
        typeof item.conversation_id === "number" ? item.conversation_id : null,
      contactId: typeof item.contact_id === "string" ? item.contact_id : "",
      snippet: typeof item.snippet === "string" ? item.snippet : "",
      createdAt: typeof item.created_at === "string" ? item.created_at : null,
    }));
}

export interface RoutingRule {
  id: number;
  match: string;
  userId: number;
  priority: number;
}

export async function listRoutingRules(
  accessToken: string
): Promise<RoutingRule[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/routing/rules");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  const raw = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).rules
    : null;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === "object")
    .map((item) => ({
      id: typeof item.id === "number" ? item.id : 0,
      match: typeof item.match === "string" ? item.match : "",
      userId: typeof item.user_id === "number" ? item.user_id : 0,
      priority: typeof item.priority === "number" ? item.priority : 100,
    }));
}

export async function addRoutingRule(
  accessToken: string,
  match: string,
  userId: number,
  priority: number
): Promise<RoutingRule | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/routing/rules",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ match, user_id: userId, priority }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  return {
    id: typeof row.id === "number" ? row.id : 0,
    match,
    userId,
    priority,
  };
}

export type RoutingRuleRemoval = { ok: true } | "not_found" | null;

export async function deleteRoutingRule(
  accessToken: string,
  ruleId: number
): Promise<RoutingRuleRemoval> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/routing/rules/" + ruleId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404) return "not_found";
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  return { ok: true };
}

export interface RecoSuggestion {
  name: string;
  priceText: string;
  notes: string;
  kind: string;
  score: number;
  reasons: string[];
}

export interface RecoSignals {
  paidItems: number;
  mentions: number;
  bestsellers: number;
  catalogItems: number;
}

export interface RecoResult {
  contactId: string;
  contactName: string | null;
  conversationId: number | null;
  suggestions: RecoSuggestion[];
  signals: RecoSignals;
}

export async function getRecoSuggestions(
  accessToken: string,
  contact: string
): Promise<RecoResult | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/reco/suggest?contact=" + encodeURIComponent(contact)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const rawSuggestions = Array.isArray(row.suggestions) ? row.suggestions : [];
  const signalsRaw =
    row.signals !== null && typeof row.signals === "object"
      ? (row.signals as Record<string, unknown>)
      : {};
  return {
    contactId: typeof row.contact_id === "string" ? row.contact_id : contact,
    contactName: null,
    conversationId: null,
    suggestions: rawSuggestions
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === "object")
      .map((item) => ({
        name: typeof item.name === "string" ? item.name : "",
        priceText: typeof item.price_text === "string" ? item.price_text : "",
        notes: typeof item.notes === "string" ? item.notes : "",
        kind: typeof item.kind === "string" ? item.kind : "product",
        score: typeof item.score === "number" ? item.score : 0,
        reasons: Array.isArray(item.reasons)
          ? item.reasons.filter((r): r is string => typeof r === "string")
          : [],
      })),
    signals: {
      paidItems:
        typeof signalsRaw.paid_items === "number" ? signalsRaw.paid_items : 0,
      mentions:
        typeof signalsRaw.mentions === "number" ? signalsRaw.mentions : 0,
      bestsellers:
        typeof signalsRaw.bestsellers === "number" ? signalsRaw.bestsellers : 0,
      catalogItems:
        typeof signalsRaw.catalog_items === "number"
          ? signalsRaw.catalog_items
          : 0,
    },
  };
}

export async function getConversationRecos(
  accessToken: string,
  conversationId: number
): Promise<RecoResult | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/reco/surface?conversation_id=" + conversationId
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const rawSuggestions = Array.isArray(row.suggestions) ? row.suggestions : [];
  return {
    contactId: typeof row.contact_id === "string" ? row.contact_id : "",
    contactName:
      typeof row.contact_name === "string" ? row.contact_name : null,
    conversationId:
      typeof row.conversation_id === "number" ? row.conversation_id : null,
    suggestions: rawSuggestions
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === "object")
      .map((item) => ({
        name: typeof item.name === "string" ? item.name : "",
        priceText: typeof item.price_text === "string" ? item.price_text : "",
        notes: typeof item.notes === "string" ? item.notes : "",
        kind: typeof item.kind === "string" ? item.kind : "product",
        score: typeof item.score === "number" ? item.score : 0,
        reasons: Array.isArray(item.reasons)
          ? item.reasons.filter((r): r is string => typeof r === "string")
          : [],
      })),
    signals: {
      paidItems: 0,
      mentions: 0,
      bestsellers: 0,
      catalogItems: 0,
    },
  };
}

export interface RecoBestseller {
  name: string;
  orders: number;
  priceText: string;
}

export interface RecoReport {
  bestsellers: RecoBestseller[];
  paidLinks: number;
  buyers: number;
  catalogItems: number;
}

export async function getRecoReport(
  accessToken: string
): Promise<RecoReport | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/reco/report");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const rawBest = Array.isArray(row.bestsellers) ? row.bestsellers : [];
  return {
    bestsellers: rawBest
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === "object")
      .map((item) => ({
        name: typeof item.name === "string" ? item.name : "",
        orders: typeof item.orders === "number" ? item.orders : 0,
        priceText: typeof item.price_text === "string" ? item.price_text : "",
      })),
    paidLinks: typeof row.paid_links === "number" ? row.paid_links : 0,
    buyers: typeof row.buyers === "number" ? row.buyers : 0,
    catalogItems: typeof row.catalog_items === "number" ? row.catalog_items : 0,
  };
}

export interface ChurnSignals {
  lastInboundDays: number | null;
  unansweredDays: number | null;
  openCartDays: number | null;
  ordersLast30d: number;
  ordersPrior30d: number;
  paidOrders: number;
  lastOrderDays: number | null;
}

export interface ChurnScore {
  contactId: string;
  score: number;
  tier: string;
  reasons: string[];
  signals: ChurnSignals;
}

export interface ChurnRadarEntry {
  contactId: string;
  name: string;
  score: number;
  tier: string;
  reasons: string[];
}

export interface ChurnRadar {
  contacts: ChurnRadarEntry[];
  scored: number;
  counts: Record<string, number>;
}

export interface ChurnTopReason {
  reason: string;
  count: number;
}

export interface ChurnReport {
  scored: number;
  avgScore: number | null;
  tiers: Record<string, number>;
  topReasons: ChurnTopReason[];
}

function churnSignalsOf(row: Record<string, unknown>): ChurnSignals {
  const raw =
    row.signals !== null && typeof row.signals === "object"
      ? (row.signals as Record<string, unknown>)
      : {};
  const num = (key: string): number =>
    typeof raw[key] === "number" ? (raw[key] as number) : 0;
  const opt = (key: string): number | null =>
    typeof raw[key] === "number" ? (raw[key] as number) : null;
  return {
    lastInboundDays: opt("last_inbound_days"),
    unansweredDays: opt("unanswered_days"),
    openCartDays: opt("open_cart_days"),
    ordersLast30d: num("orders_last_30d"),
    ordersPrior30d: num("orders_prior_30d"),
    paidOrders: num("paid_orders"),
    lastOrderDays: opt("last_order_days"),
  };
}

function churnReasonsOf(row: Record<string, unknown>): string[] {
  const raw = row.reasons;
  return Array.isArray(raw)
    ? raw.filter((reason): reason is string => typeof reason === "string")
    : [];
}

export async function getChurnScore(
  accessToken: string,
  contact: string
): Promise<ChurnScore | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/churn/score?contact=" + encodeURIComponent(contact)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  return {
    contactId: typeof row.contact_id === "string" ? row.contact_id : contact,
    score: typeof row.score === "number" ? row.score : 0,
    tier: typeof row.tier === "string" ? row.tier : "healthy",
    reasons: churnReasonsOf(row),
    signals: churnSignalsOf(row),
  };
}

export async function getChurnRadar(
  accessToken: string,
  limit = 10
): Promise<ChurnRadar | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/churn/radar?limit=" + encodeURIComponent(String(limit))
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const rawContacts = Array.isArray(row.contacts) ? row.contacts : [];
  const counts =
    row.counts !== null && typeof row.counts === "object"
      ? (row.counts as Record<string, unknown>)
      : {};
  const tierCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === "number") tierCounts[key] = value;
  }
  return {
    contacts: rawContacts
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === "object")
      .map((item) => ({
        contactId: typeof item.contact_id === "string" ? item.contact_id : "",
        name: typeof item.name === "string" ? item.name : "",
        score: typeof item.score === "number" ? item.score : 0,
        tier: typeof item.tier === "string" ? item.tier : "healthy",
        reasons: churnReasonsOf(item),
      })),
    scored: typeof row.scored === "number" ? row.scored : 0,
    counts: tierCounts,
  };
}

export async function getChurnReport(
  accessToken: string
): Promise<ChurnReport | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/churn/report");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const rawReasons = Array.isArray(row.top_reasons) ? row.top_reasons : [];
  const tiers =
    row.tiers !== null && typeof row.tiers === "object"
      ? (row.tiers as Record<string, unknown>)
      : {};
  const tierCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(tiers)) {
    if (typeof value === "number") tierCounts[key] = value;
  }
  return {
    scored: typeof row.scored === "number" ? row.scored : 0,
    avgScore: typeof row.avg_score === "number" ? row.avg_score : null,
    tiers: tierCounts,
    topReasons: rawReasons
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === "object")
      .map((item) => ({
        reason: typeof item.reason === "string" ? item.reason : "",
        count: typeof item.count === "number" ? item.count : 0,
      })),
  };
}

export interface WinbackEntry {
  contactId: string;
  name: string;
  kind: string;
  days: number | null;
  item: string;
  priceText: string;
  total: number | null;
  message: string;
  waLink: string | null;
}

export interface WinbackQueue {
  cart: WinbackEntry[];
  reorder: WinbackEntry[];
  winback: WinbackEntry[];
  counts: Record<string, number>;
  scored: number;
}

export async function getWinbackQueue(
  accessToken: string
): Promise<WinbackQueue | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/winback/queue");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const entryOf = (raw: unknown): WinbackEntry | null => {
    if (raw === null || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    return {
      contactId: typeof item.contact_id === "string" ? item.contact_id : "",
      name: typeof item.name === "string" ? item.name : "",
      kind: typeof item.kind === "string" ? item.kind : "",
      days: typeof item.days === "number" ? item.days : null,
      item: typeof item.item === "string" ? item.item : "",
      priceText: typeof item.price_text === "string" ? item.price_text : "",
      total: typeof item.total === "number" ? item.total : null,
      message: typeof item.message === "string" ? item.message : "",
      waLink: typeof item.wa_link === "string" ? item.wa_link : null,
    };
  };
  const segmentOf = (raw: unknown): WinbackEntry[] =>
    Array.isArray(raw)
      ? raw
          .map(entryOf)
          .filter((entry): entry is WinbackEntry => entry !== null)
      : [];
  const segments =
    row.segments !== null && typeof row.segments === "object"
      ? (row.segments as Record<string, unknown>)
      : {};
  const counts =
    row.counts !== null && typeof row.counts === "object"
      ? (row.counts as Record<string, unknown>)
      : {};
  const tierCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === "number") tierCounts[key] = value;
  }
  return {
    cart: segmentOf(segments.cart),
    reorder: segmentOf(segments.reorder),
    winback: segmentOf(segments.winback),
    counts: tierCounts,
    scored: typeof row.scored === "number" ? row.scored : 0,
  };
}

export type WinbackSendResult =
  | { kind: "ok"; commandId: number }
  | { kind: "stale" }
  | { kind: "cooldown" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function sendWinbackEntry(
  accessToken: string,
  contactId: string,
  entryKind: string
): Promise<WinbackSendResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/winback/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_id: contactId, kind: entryKind }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 409) {
    const payload: unknown = await response.json().catch(() => null);
    const errorRaw =
      payload !== null && typeof payload === "object"
        ? (payload as Record<string, unknown>).error
        : null;
    const errorCode =
      errorRaw !== null && typeof errorRaw === "object"
        ? (errorRaw as Record<string, unknown>).code
        : "";
    return errorCode === "cooldown"
      ? { kind: "cooldown" }
      : { kind: "stale" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  const row =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const commandId = typeof row.command_id === "number" ? row.command_id : 0;
  return { kind: "ok", commandId };
}

export interface RevenueSummary {
  days: number;
  revenue: number;
  revenuePrior: number;
  deltaPercent: number | null;
  orders: number;
  ordersPrior: number;
  aov: number | null;
  newBuyers: number;
  repeatBuyers: number;
  cancelled: number;
  cancelledRate: number | null;
  openCarts: number;
  pipelineValue: number;
  winbackSent: number;
}

export interface RevenueItem {
  name: string;
  units: number;
  revenue: number;
  buyers: number;
  unitsPrior: number;
  trend: string;
}

export async function getRevenueSummary(
  accessToken: string,
  days: number
): Promise<RevenueSummary | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/revenue/summary?days=" + encodeURIComponent(String(days))
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const num = (key: string): number =>
    typeof row[key] === "number" ? (row[key] as number) : 0;
  const opt = (key: string): number | null =>
    typeof row[key] === "number" ? (row[key] as number) : null;
  return {
    days: num("days"),
    revenue: num("revenue"),
    revenuePrior: num("revenue_prior"),
    deltaPercent: opt("delta_percent"),
    orders: num("orders"),
    ordersPrior: num("orders_prior"),
    aov: opt("aov"),
    newBuyers: num("new_buyers"),
    repeatBuyers: num("repeat_buyers"),
    cancelled: num("cancelled"),
    cancelledRate: opt("cancelled_rate"),
    openCarts: num("open_carts"),
    pipelineValue: num("pipeline_value"),
    winbackSent: num("winback_sent"),
  };
}

export async function getRevenueItems(
  accessToken: string,
  days: number
): Promise<RevenueItem[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/revenue/items?days=" + encodeURIComponent(String(days))
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).items;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === "object")
    .map((item) => ({
      name: typeof item.name === "string" ? item.name : "",
      units: typeof item.units === "number" ? item.units : 0,
      revenue: typeof item.revenue === "number" ? item.revenue : 0,
      buyers: typeof item.buyers === "number" ? item.buyers : 0,
      unitsPrior: typeof item.units_prior === "number" ? item.units_prior : 0,
      trend: typeof item.trend === "string" ? item.trend : "steady",
    }))
    .filter((item) => item.name);
}

export interface RestockItem {
  name: string;
  weeklyRate: number;
  revenue: number;
  buyers: number;
  lastSoldDays: number | null;
  recentUnits: number;
  priorUnits: number;
  sharePercent: number | null;
  trend: string;
}

export interface RestockRadar {
  stockUp: RestockItem[];
  watch: RestockItem[];
  slow: RestockItem[];
  counts: Record<string, number>;
  itemsSold: number;
  days: number;
}

function restockItemOf(raw: unknown): RestockItem | null {
  if (raw === null || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const name = typeof item.name === "string" ? item.name : "";
  if (!name) return null;
  return {
    name,
    weeklyRate: typeof item.weekly_rate === "number" ? item.weekly_rate : 0,
    revenue: typeof item.revenue === "number" ? item.revenue : 0,
    buyers: typeof item.buyers === "number" ? item.buyers : 0,
    lastSoldDays:
      typeof item.last_sold_days === "number" ? item.last_sold_days : null,
    recentUnits: typeof item.recent_units === "number" ? item.recent_units : 0,
    priorUnits: typeof item.prior_units === "number" ? item.prior_units : 0,
    sharePercent:
      typeof item.share_percent === "number" ? item.share_percent : null,
    trend: typeof item.trend === "string" ? item.trend : "steady",
  };
}

export async function getRestockRadar(
  accessToken: string,
  days: number
): Promise<RestockRadar | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/restock/radar?days=" + encodeURIComponent(String(days))
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const listOf = (raw: unknown): RestockItem[] =>
    Array.isArray(raw)
      ? raw
          .map(restockItemOf)
          .filter((item): item is RestockItem => item !== null)
      : [];
  const counts =
    row.counts !== null && typeof row.counts === "object"
      ? (row.counts as Record<string, unknown>)
      : {};
  const tierCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === "number") tierCounts[key] = value;
  }
  return {
    stockUp: listOf(row.stock_up),
    watch: listOf(row.watch),
    slow: listOf(row.slow),
    counts: tierCounts,
    itemsSold: typeof row.items_sold === "number" ? row.items_sold : 0,
    days: typeof row.days === "number" ? row.days : 0,
  };
}

export interface CustomerValue {
  contactId: string;
  totalSpent: number;
  orders: number;
  units: number;
  avgOrder: number | null;
  topItem: string;
  topItemUnits: number;
  medianGapDays: number | null;
  firstOrderDays: number | null;
  lastOrderDays: number | null;
  tier: string;
}

export interface ValueCustomer {
  contactId: string;
  name: string;
  totalSpent: number;
  orders: number;
  lastOrderDays: number | null;
  tier: string;
}

function valueBlockOf(row: Record<string, unknown>, contact: string): CustomerValue {
  const num = (key: string): number =>
    typeof row[key] === "number" ? (row[key] as number) : 0;
  const opt = (key: string): number | null =>
    typeof row[key] === "number" ? (row[key] as number) : null;
  return {
    contactId: typeof row.contact_id === "string" ? row.contact_id : contact,
    totalSpent: num("total_spent"),
    orders: num("orders"),
    units: num("units"),
    avgOrder: opt("avg_order"),
    topItem: typeof row.top_item === "string" ? row.top_item : "",
    topItemUnits: num("top_item_units"),
    medianGapDays: opt("median_gap_days"),
    firstOrderDays: opt("first_order_days"),
    lastOrderDays: opt("last_order_days"),
    tier: typeof row.tier === "string" ? row.tier : "new",
  };
}

export async function getCustomerValue(
  accessToken: string,
  contact: string
): Promise<CustomerValue | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/value/summary?contact=" + encodeURIComponent(contact)
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  return valueBlockOf(payload as Record<string, unknown>, contact);
}

export async function getTopCustomers(
  accessToken: string,
  limit = 10
): Promise<{ customers: ValueCustomer[]; scored: number } | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/value/top?limit=" + encodeURIComponent(String(limit))
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const raw = Array.isArray(row.customers) ? row.customers : [];
  return {
    customers: raw
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === "object")
      .map((item) => {
        const num = (key: string): number =>
          typeof item[key] === "number" ? (item[key] as number) : 0;
        const opt = (key: string): number | null =>
          typeof item[key] === "number" ? (item[key] as number) : null;
        return {
          contactId:
            typeof item.contact_id === "string" ? item.contact_id : "",
          name: typeof item.name === "string" ? item.name : "",
          totalSpent: num("total_spent"),
          orders: num("orders"),
          lastOrderDays: opt("last_order_days"),
          tier: typeof item.tier === "string" ? item.tier : "new",
        };
      })
      .filter((item) => item.contactId),
    scored: typeof row.scored === "number" ? row.scored : 0,
  };
}

export async function deleteSequence(
  accessToken: string,
  id: number
): Promise<{ kind: "ok" } | { kind: "not_found" } | { kind: "unavailable" }> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(id),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export interface SequenceEnrollmentRow {
  id: number;
  contact_name: string | null;
  contact_id: string;
  current_step: number;
  status: string;
  next_at: string | null;
  enrolled_at: string | null;
}

export async function listSequenceEnrollments(
  accessToken: string,
  sequenceId: number
): Promise<SequenceEnrollmentRow[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(sequenceId) + "/enrollments"
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }
  if (response.status === 404 || response.status === 501) return null;
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawList = (payload as Record<string, unknown>).enrollments;
  if (!Array.isArray(rawList)) return null;
  const enrollments: SequenceEnrollmentRow[] = [];
  for (const item of rawList) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "number") continue;
    enrollments.push({
      id: row.id,
      contact_name: typeof row.contact_name === "string" ? row.contact_name : null,
      contact_id: typeof row.contact_id === "string" ? row.contact_id : "",
      current_step: typeof row.current_step === "number" ? row.current_step : 0,
      status: typeof row.status === "string" ? row.status : "active",
      next_at: typeof row.next_at === "string" ? row.next_at : null,
      enrolled_at: typeof row.enrolled_at === "string" ? row.enrolled_at : null,
    });
  }
  return enrollments;
}

export type EnrollmentPauseResult =
  | { kind: "ok" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function pauseSequenceEnrollment(
  accessToken: string,
  sequenceId: number,
  enrollmentId: number
): Promise<EnrollmentPauseResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(sequenceId) +
        "/enrollments/" + String(enrollmentId) + "/pause",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export async function resumeSequenceEnrollment(
  accessToken: string,
  sequenceId: number,
  enrollmentId: number
): Promise<EnrollmentPauseResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(sequenceId) +
        "/enrollments/" + String(enrollmentId) + "/resume",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export type EnrollmentBulkResult =
  | { kind: "ok"; count: number }
  | { kind: "unavailable" };

export async function pauseAllEnrollments(
  accessToken: string,
  sequenceId: number
): Promise<EnrollmentBulkResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(sequenceId) + "/enrollments/pause-all",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  const count =
    payload !== null && typeof payload === "object"
      ? (payload as { paused?: unknown }).paused
      : null;
  return {
    kind: "ok",
    count: typeof count === "number" ? count : 0,
  };
}

export async function resumeAllEnrollments(
  accessToken: string,
  sequenceId: number
): Promise<EnrollmentBulkResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(sequenceId) + "/enrollments/resume-all",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  const count =
    payload !== null && typeof payload === "object"
      ? (payload as { resumed?: unknown }).resumed
      : null;
  return {
    kind: "ok",
    count: typeof count === "number" ? count : 0,
  };
}

export type WebhookTestResult =
  | { kind: "ok"; delivered: boolean; statusCode: number | null; error: string | null }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function testWebhook(
  accessToken: string,
  id: number
): Promise<WebhookTestResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/webhooks/" + String(id) + "/test",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  if (typeof p.delivered !== "boolean") return { kind: "unavailable" };
  return {
    kind: "ok",
    delivered: p.delivered,
    statusCode: typeof p.status_code === "number" ? p.status_code : null,
    error: typeof p.error === "string" ? p.error : null,
  };
}

export type WebhookRetryResult =
  | { kind: "ok"; delivered: boolean; statusCode: number | null }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function retryWebhookDelivery(
  accessToken: string,
  id: number,
  deliveryId: number
): Promise<WebhookRetryResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/webhooks/" + String(id) +
        "/deliveries/" + String(deliveryId) + "/retry",
      { method: "POST" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  if (typeof p.delivered !== "boolean") return { kind: "unavailable" };
  return {
    kind: "ok",
    delivered: p.delivered,
    statusCode: typeof p.status_code === "number" ? p.status_code : null,
  };
}

export type SequenceEnrollResult =
  | { kind: "ok"; enrolled: number; skipped: string[] }
  | { kind: "not_found" }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function enrollSequenceContacts(
  accessToken: string,
  sequenceId: number,
  contacts: string[]
): Promise<SequenceEnrollResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(sequenceId) + "/enrollments",
      { method: "POST", body: JSON.stringify({ contacts }) }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  if (typeof p.enrolled !== "number") return { kind: "unavailable" };
  return {
    kind: "ok",
    enrolled: p.enrolled,
    skipped: Array.isArray(p.skipped)
      ? p.skipped.filter((item): item is string => typeof item === "string")
      : [],
  };
}

export type SequenceCancelResult =
  | { kind: "ok" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function cancelSequenceEnrollment(
  accessToken: string,
  sequenceId: number,
  enrollmentId: number
): Promise<SequenceCancelResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(sequenceId) +
        "/enrollments/" + String(enrollmentId),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

export type ConversationStatusResult =
  | { kind: "ok"; conversation: ConversationSummary }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function updateConversationStatus(
  accessToken: string,
  conversationId: number,
  status: "open" | "closed"
): Promise<ConversationStatusResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" + encodeURIComponent(String(conversationId)),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const conversation = normalizeConversation(
    (payload as Record<string, unknown>).conversation
  );
  if (!conversation) return { kind: "unavailable" };
  return { kind: "ok", conversation };
}

export type ConversationSendResult =
  | { kind: "ok"; queued: boolean; commandId: number | null }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function sendConversationMessage(
  accessToken: string,
  conversationId: number,
  body: string
): Promise<ConversationSendResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  return {
    kind: "ok",
    queued: p.queued === true,
    commandId: typeof p.command_id === "number" ? p.command_id : null,
  };
}

// ---------------------------------------------------------------------------
// Session helper for BFF routes
// ---------------------------------------------------------------------------

export async function requirePortalAccessToken(): Promise<string | null> {
  const { accessToken } = await readSessionCookies();
  return accessToken ?? null;
}
`);
writeNewRepair("app/api/omniflow/portal/voice/calls/route.ts", "export async function POST(request: Request) {", false,
    `import {
  callContact,
  listVoiceCalls,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  safeJson,
  sameOrigin,
} from "../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  try {
    const calls = await listVoiceCalls(accessToken);
    if (calls === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ calls }, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const payload: unknown = await request.json().catch(() => null);
  const body =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const contactId = String(body.contact_id || "").trim().slice(0, 100);
  const phone = String(body.phone || "").trim();
  const message = String(body.message || "").trim().slice(0, 300);
  if (!contactId) {
    return safeJson(
      { error: { code: "bad_request", message: "contact_id is required." } },
      400
    );
  }
  if (!phone.startsWith("+") || !phone.slice(1).replace(/\\d/g, "")) {
    return safeJson(
      {
        error: {
          code: "bad_request",
          message: "Enter the number in +92300... format.",
        },
      },
      400
    );
  }
  if (!message) {
    return safeJson(
      { error: { code: "bad_request", message: "Write a short message." } },
      400
    );
  }
  try {
    const result = await callContact(accessToken, contactId, phone, message);
    if (result === "not_configured") {
      return safeJson(
        {
          error: {
            code: "not_configured",
            message:
              "Voice is not configured — add the Twilio keys in the admin panel Integrations page.",
          },
        },
        409
      );
    }
    if (result === "bad_request") {
      return safeJson(
        { error: { code: "bad_request", message: "Check the number and message." } },
        400
      );
    }
    if (result === null) {
      return safeJson(
        {
          error: {
            code: "call_failed",
            message: "Twilio rejected the call — check the saved keys.",
          },
        },
        502
      );
    }
    return safeJson(result, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
`);
writeNewRepair("app/api/omniflow/portal/video/rooms/route.ts", "sendVideoInvite", false,
    `import {
  listVideoRooms,
  sendVideoInvite,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import {
  safeJson,
  sameOrigin,
} from "../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  try {
    const rooms = await listVideoRooms(accessToken);
    if (rooms === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ rooms }, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const payload: unknown = await request.json().catch(() => null);
  const body =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const conversationId = Number(body.conversation_id || 0);
  const provider = String(body.provider || "").trim().toLowerCase();
  const title = String(body.title || "").trim().slice(0, 120);
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return safeJson(
      {
        error: { code: "bad_request", message: "conversation_id is required." },
      },
      400
    );
  }
  try {
    const result = await sendVideoInvite(
      accessToken,
      conversationId,
      provider || undefined,
      title || undefined
    );
    if (result === "not_configured") {
      return safeJson(
        {
          error: {
            code: "not_configured",
            message:
              "Video is not configured — add the provider key in the admin panel Integrations page.",
          },
        },
        409
      );
    }
    if (result === "bad_request") {
      return safeJson(
        { error: { code: "bad_request", message: "Check the request." } },
        400
      );
    }
    if (result === null) {
      return safeJson(
        {
          error: {
            code: "room_failed",
            message: "The video provider rejected the room — check the saved keys.",
          },
        },
        502
      );
    }
    return safeJson(result, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
`);
writeNewRepair("app/api/omniflow/portal/conversations/[id]/draft/route.ts", "draftBrainReply", false,
    `import {
  draftBrainReply,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import {
  safeJson,
  sameOrigin,
} from "../../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";


export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }
  const { id } = await context.params;
  const conversationId = Number(id);
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return safeJson(
      {
        error: { code: "bad_request", message: "Invalid conversation id." },
      },
      400
    );
  }
  const payload: unknown = await request.json().catch(() => null);
  const body =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const message = String(body.message || "").trim().slice(0, 2000);
  try {
    const result = await draftBrainReply(accessToken, conversationId);
    if (result === null) {
      return safeJson(
        {
          error: {
            code: "draft_unavailable",
            message: "Could not draft right now — try again shortly.",
          },
        },
        503
      );
    }
    return safeJson({ ok: true, draft: result, message }, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
`);
writeNewRepair("app/api/omniflow/public/checkout/[token]/otp/route.ts", "requestPublicPhoneOtp", false,
    `import {
  requestPublicPhoneOtp,
} from "../../../../../../../lib/omniflow/portal";
import {
  safeJson,
  sameOrigin,
} from "../../../../../../../lib/omniflow/request-security";


export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }
  const { token } = await context.params;
  const clean = token.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (!clean) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid order link." } },
      400
    );
  }
  const result = await requestPublicPhoneOtp(clean);
  if (result === "not_found") {
    return safeJson(
      { error: { code: "not_found", message: "This order link is not valid." } },
      404
    );
  }
  if (result === "feature_off") {
    return safeJson(
      {
        error: {
          code: "feature_off",
          message: "Phone verification is not enabled for this order.",
        },
      },
      409
    );
  }
  if (result === "rate_limited") {
    return safeJson(
      {
        error: {
          code: "rate_limited",
          message: "Too many codes — wait a few minutes.",
        },
      },
      429
    );
  }
  if (result === null) {
    return safeJson(
      {
        error: {
          code: "otp_unavailable",
          message: "Could not send the code — try again shortly.",
        },
      },
      503
    );
  }
  return safeJson(result, 200);
}


`);
writeNewRepair("app/api/omniflow/public/checkout/[token]/otp/verify/route.ts", "verifyPublicPhoneOtp", false,
    `import {
  verifyPublicPhoneOtp,
} from "../../../../../../../../lib/omniflow/portal";
import {
  safeJson,
  sameOrigin,
} from "../../../../../../../../lib/omniflow/request-security";


export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }
  const { token } = await context.params;
  const clean = token.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (!clean) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid order link." } },
      400
    );
  }
  const payload: unknown = await request.json().catch(() => null);
  const raw =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>).code
      : null;
  const code = typeof raw === "string" ? raw.trim().slice(0, 6) : "";
  if (!/^\\d{6}$/.test(code)) {
    return safeJson(
      {
        error: { code: "bad_request", message: "Enter the 6-digit code." },
      },
      400
    );
  }
  const result = await verifyPublicPhoneOtp(clean, code);
  if (result === "not_found") {
    return safeJson(
      {
        error: { code: "not_found", message: "Request a code first." },
      },
      404
    );
  }
  if (result === "feature_off") {
    return safeJson(
      {
        error: {
          code: "feature_off",
          message: "Phone verification is not enabled for this order.",
        },
      },
      409
    );
  }
  if (result === "rate_limited") {
    return safeJson(
      {
        error: {
          code: "rate_limited",
          message: "Too many tries — request a new code.",
        },
      },
      429
    );
  }
  if (result === "bad_code") {
    return safeJson(
      {
        error: {
          code: "bad_code",
          message: "That code is not right — check the WhatsApp message.",
        },
      },
      400
    );
  }
  if (result === null) {
    return safeJson(
      {
        error: {
          code: "otp_unavailable",
          message: "Could not verify right now — try again shortly.",
        },
      },
      503
    );
  }
  return safeJson(result, 200);
}
`);
writeNewRepair("app/dashboard/(portal)/conversations/[id]/VoiceCard.tsx", "Place call", false,
    `"use client";

import { useCallback, useEffect, useState } from "react";

interface VoiceCall {
  id: number;
  contactId: string;
  phone: string;
  sid: string;
  status: string;
  message: string;
  createdAt: string | null;
}

export default function VoiceCard({ conversationId }: { conversationId: number }) {
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [calls, setCalls] = useState<VoiceCall[]>([]);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/voice/calls", {
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        calls?: VoiceCall[];
      } | null;
      if (payload && Array.isArray(payload.calls)) {
        setCalls(payload.calls.slice(0, 5));
      }
    } catch {
      return;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function call() {
    if (busy) return;
    if (!phone.startsWith("+")) {
      setNote({ text: "Enter the number in +92300... format.", ok: false });
      return;
    }
    if (!message.trim()) {
      setNote({ text: "Write the short message the call should read.", ok: false });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/omniflow/portal/voice/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: String(conversationId),
          phone: phone.trim(),
          message: message.trim(),
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload && payload.ok) {
        setNote({ text: "Call placed — Twilio is dialling.", ok: true });
        setMessage("");
        await load();
      } else {
        setNote({
          text:
            payload && payload.error
              ? (payload.error.message || "Please try again.")
              : "Could not place the call — try again.",
          ok: false,
        });
      }
    } catch {
      setNote({ text: "Could not place the call — try again.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="of-fade-up rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-white">Call the customer</p>
        <span className="text-[10px] text-slate-500">Twilio voice</span>
      </div>
      <div className="mt-3 space-y-2">
        <input
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          placeholder="+923001234567"
          autoComplete="off"
          className="w-full rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-cyan-400/40 focus:outline-none"
        />
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="What should the call say? (reads aloud, max 300 chars)"
          rows={2}
          maxLength={300}
          className="w-full resize-none rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-cyan-400/40 focus:outline-none"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={() => void call()}
            disabled={busy}
            className="rounded-xl border border-cyan-400/30 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors hover:bg-cyan-400/[0.14] disabled:opacity-50"
          >
            {busy ? "Dialling…" : "Place call"}
          </button>
          {note ? (
            <span
              className={
                "text-[11px] " + (note.ok ? "text-emerald-300" : "text-rose-300")
              }
            >
              {note.text}
            </span>
          ) : null}
        </div>
      </div>
      {calls.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {calls.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.05] bg-white/[0.015] px-2.5 py-1.5 text-[11px]"
            >
              <span className="truncate text-slate-300">{entry.phone}</span>
              <span className="shrink-0 rounded-md border border-white/[0.08] bg-white/[0.02] px-1.5 py-0.5 text-[10px] text-slate-400">
                {entry.status}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
`);
writeNewRepair("app/dashboard/(portal)/conversations/[id]/VideoCard.tsx", "Create & send invite", false,
    `"use client";

import { useCallback, useEffect, useState } from "react";

interface VideoRoom {
  id: number;
  conversationId: number;
  contactId: string;
  provider: string;
  url: string;
  createdAt: string | null;
}

export default function VideoCard({ conversationId }: { conversationId: number }) {
  const [provider, setProvider] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [rooms, setRooms] = useState<VideoRoom[]>([]);

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        "/api/omniflow/portal/video/rooms?conversation_id=" + conversationId,
        { cache: "no-store" }
      );
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        rooms?: VideoRoom[];
      } | null;
      if (payload && Array.isArray(payload.rooms)) {
        setRooms(payload.rooms.slice(0, 3));
      }
    } catch {
      return;
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function invite() {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/omniflow/portal/video/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversationId,
          provider: provider || undefined,
          title: title.trim() || undefined,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        room?: VideoRoom;
        error?: { message?: string };
      } | null;
      if (response.ok && payload && payload.ok) {
        setNote({
          text: "Invite sent to the customer on WhatsApp.",
          ok: true,
        });
        setTitle("");
        await load();
      } else {
        setNote({
          text:
            payload && payload.error
              ? (payload.error.message || "Please try again.")
              : "Could not create the room — try again.",
          ok: false,
        });
      }
    } catch {
      setNote({ text: "Could not create the room — try again.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="of-fade-up rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-white">Video invite</p>
        <span className="text-[10px] text-slate-500">Whereby / Daily / Zoom</span>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        Creates a room and drops the link into this chat.
      </p>
      <div className="mt-3 space-y-2">
        <div className="flex gap-2">
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            className="w-32 rounded-xl border border-white/[0.08] bg-white/[0.02] px-2 py-2 text-xs text-slate-200 focus:border-cyan-400/40 focus:outline-none"
          >
            <option value="">Default</option>
            <option value="whereby">Whereby</option>
            <option value="daily">Daily</option>
            <option value="zoom">Zoom</option>
          </select>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Topic (optional)"
            className="flex-1 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-cyan-400/40 focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void invite()}
            disabled={busy}
            className="rounded-xl border border-cyan-400/30 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors hover:bg-cyan-400/[0.14] disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create & send invite"}
          </button>
          {note ? (
            <span
              className={
                "text-[11px] " + (note.ok ? "text-emerald-300" : "text-rose-300")
              }
            >
              {note.text}
            </span>
          ) : null}
        </div>
      </div>
      {rooms.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {rooms.map((room) => (
            <li key={room.id}>
              <a
                href={room.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.05] bg-white/[0.015] px-2.5 py-1.5 text-[11px] text-slate-300 hover:bg-white/[0.04]"
              >
                <span className="truncate">{room.url}</span>
                <span className="shrink-0 rounded-md border border-white/[0.08] bg-white/[0.02] px-1.5 py-0.5 text-[10px] text-slate-400">
                  {room.provider}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
`);
writeNewRepair("app/dashboard/(portal)/conversations/[id]/AssistCard.tsx", "Draft with AI", false,
    `"use client";

import { useCallback, useEffect, useState } from "react";

interface AssistSentiment {
  label: string;
  score: number;
  positive: string[];
  negative: string[];
}

interface KbSuggestion {
  id: number;
  question: string;
  snippet: string;
  matched: string[];
}

interface AssistResult {
  intent: string;
  sentiment: AssistSentiment | null;
  language: string | null;
  linked: string[];
  suggestions: KbSuggestion[];
  basedOn: string;
}


interface BrainDraft {
  decision: string;
  draft: string;
  kbEntry?: { title: string; content: string } | null;
}

export default function AssistCard({ conversationId }: { conversationId: number }) {
  const [assist, setAssist] = useState<AssistResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<BrainDraft | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftNote, setDraftNote] = useState<{ text: string; ok: boolean } | null>(
    null
  );

  const load = useCallback(async () => {
    if (!Number.isFinite(conversationId) || conversationId <= 0) return;
    setBusy(true);
    try {
      const response = await fetch(
        \`/api/omniflow/portal/conversations/\${conversationId}/assist\`,
        { cache: "no-store" }
      );
      if (!response.ok) return;
      const payload: unknown = await response.json().catch(() => null);
      if (payload !== null && typeof payload === "object") {
        setAssist(payload as unknown as AssistResult);
      }
    } catch {
      return;
    } finally {
      setBusy(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function makeDraft() {
    if (draftBusy) return;
    setDraftBusy(true);
    setDraftNote(null);
    try {
      const response = await fetch(
        \`/api/omniflow/portal/conversations/\${conversationId}/draft\`,
        { method: "POST", headers: { "Content-Type": "application/json" } }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        draft?: BrainDraft;
        error?: { message?: string };
      } | null;
      if (response.ok && payload && payload.ok && payload.draft) {
        setDraft(payload.draft);
        setDraftNote(null);
      } else {
        setDraftNote({
          text:
            payload && payload.error
              ? (payload.error.message || "Please try again.")
              : "Could not draft right now.",
          ok: false,
        });
      }
    } catch {
      setDraftNote({ text: "Could not draft right now.", ok: false });
    } finally {
      setDraftBusy(false);
    }
  }

  async function saveDraftToKb() {
    if (!draft?.kbEntry) return;
    setDraftBusy(true);
    setDraftNote(null);
    try {
      const response = await fetch("/api/omniflow/portal/kb", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entry: {
            title: draft.kbEntry.title,
            content: draft.kbEntry.content,
            isActive: true,
            lang: "auto",
          },
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload && payload.ok) {
        setDraftNote({ text: "Saved to the knowledge base.", ok: true });
        setDraft((prev) => (prev ? { ...prev, kbEntry: null } : prev));
      } else {
        setDraftNote({
          text:
            payload && payload.error
              ? (payload.error.message || "Please try again.")
              : "Could not save — try again.",
          ok: false,
        });
      }
    } catch {
      setDraftNote({ text: "Could not save — try again.", ok: false });
    } finally {
      setDraftBusy(false);
    }
  }

  if (!assist) return null;
  const sentiment = assist.sentiment?.label ?? null;
  const empty =
    assist.suggestions.length === 0 &&
    assist.intent === "other" &&
    assist.linked.length === 0 &&
    !assist.language;
  if (empty) return null;

  return (
    <section className="of-fade-up rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-white">Agent assist</p>
        <button
          onClick={() => void load()}
          disabled={busy}
          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] text-slate-300 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Checking…" : "Refresh"}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className="rounded-md border border-cyan-400/25 bg-cyan-400/[0.08] px-1.5 py-0.5 text-cyan-300">
          Intent: {assist.intent}
        </span>
        {sentiment && sentiment !== "neutral" ? (
          <span
            className={\`rounded-md border px-1.5 py-0.5 \${
              sentiment === "negative"
                ? "border-rose-400/25 bg-rose-400/[0.08] text-rose-300"
                : sentiment === "mixed"
                  ? "border-amber-400/25 bg-amber-400/[0.08] text-amber-300"
                  : "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300"
            }\`}
          >
            Sentiment: {sentiment}
          </span>
        ) : null}
        {assist.language ? (
          <span className="rounded-md border border-violet-400/25 bg-violet-400/[0.08] px-1.5 py-0.5 text-violet-300">
            Language: {assist.language}
          </span>
        ) : null}
        {assist.linked.map((linked) => (
          <span
            key={linked}
            className="rounded-md border border-white/[0.08] bg-white/[0.02] px-1.5 py-0.5 text-slate-400"
          >
            Linked: {linked}
          </span>
        ))}
      </div>

      {assist.sentiment && assist.sentiment.negative.length > 0 ? (
        <p className="mt-2 text-[11px] text-amber-300/80">
          Flagged: {assist.sentiment.negative.join(", ")}
        </p>
      ) : null}

      {assist.suggestions.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {assist.suggestions.map((suggestion) => (
            <li
              key={suggestion.id}
              className="rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2"
            >
              <p className="text-xs font-medium text-slate-200">
                {suggestion.question}
              </p>
              <p className="mt-1 text-xs text-slate-400">{suggestion.snippet}</p>
              {suggestion.matched.length > 0 ? (
                <p className="mt-1 text-[10px] text-slate-600">
                  Matched: {suggestion.matched.join(", ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-slate-500">
          No knowledge-base matches for the latest messages.
        </p>
      )}

      <div className="mt-4 border-t border-white/[0.06] pt-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => void makeDraft()}
            disabled={draftBusy}
            className="rounded-xl border border-violet-400/30 bg-violet-400/[0.08] px-3 py-1.5 text-[11px] font-medium text-violet-200 transition-colors hover:bg-violet-400/[0.14] disabled:opacity-50"
          >
            {draftBusy ? "Working…" : "Draft with AI"}
          </button>
          {draftNote ? (
            <span
              className={
                "text-[11px] " +
                (draftNote.ok ? "text-emerald-300" : "text-rose-300")
              }
            >
              {draftNote.text}
            </span>
          ) : null}
        </div>
        {draft ? (
          <div className="mt-2 rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">
              {draft.decision} draft
            </p>
            <p className="mt-1 whitespace-pre-wrap text-xs text-slate-200">
              {draft.draft}
            </p>
            {draft.kbEntry ? (
              <button
                onClick={() => void saveDraftToKb()}
                disabled={draftBusy}
                className="mt-2 rounded-lg border border-emerald-400/30 bg-emerald-400/[0.08] px-2.5 py-1 text-[11px] text-emerald-200 transition-colors hover:bg-emerald-400/[0.14] disabled:opacity-50"
              >
                Save as KB answer
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
`);
writeNewRepair("app/dashboard/(portal)/conversations/[id]/ThreadClient.tsx", "VoiceCard", false,
    `"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";

const CodCard = dynamic(() => import("./CodCard"));
const VoiceCard = dynamic(() => import("./VoiceCard"));
const VideoCard = dynamic(() => import("./VideoCard"));
const InteractiveCard = dynamic(() => import("./InteractiveCard"));
const TeamCard = dynamic(() => import("./TeamCard"));
const TagsCard = dynamic(() => import("./TagsCard"));
const NotesCard = dynamic(() => import("./NotesCard"));
const RatingCard = dynamic(() => import("./RatingCard"));
const CustomerCard = dynamic(() => import("./CustomerCard"));
const AddToSequenceCard = dynamic(() => import("./AddToSequenceCard"));
const AssistCard = dynamic(() => import("./AssistCard"));
const RecoCard = dynamic(() => import("./RecoCard"));
const SavedRepliesPicker = dynamic(() => import("./SavedRepliesPicker"));
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
const MESSAGE_URL_PATTERN = /(https?:\\/\\/[^\\s]+)/g;

function linkifyText(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(MESSAGE_URL_PATTERN);
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <a
        key={keyPrefix + "-url-" + index}
        href={part}
        target="_blank"
        rel="noreferrer"
        className="underline decoration-slate-500 underline-offset-2 transition-colors hover:text-cyan-200"
      >
        {part}
      </a>
    ) : (
      part
    )
  );
}

function renderMessageBody(body: string, query: string): ReactNode {
  const needle = query.trim().toLowerCase();
  if (!needle) return linkifyText(body, "msg");
  const lower = body.toLowerCase();
  const pieces: ReactNode[] = [];
  let cursor = 0;
  let found = lower.indexOf(needle);
  while (found !== -1) {
    if (found > cursor) {
      pieces.push(
        <span key={"seg-" + cursor}>
          {linkifyText(body.slice(cursor, found), "seg-" + cursor)}
        </span>
      );
    }
    pieces.push(
      <mark
        key={"hit-" + found}
        className="rounded bg-amber-300/25 px-0.5 text-amber-100"
      >
        {body.slice(found, found + needle.length)}
      </mark>
    );
    cursor = found + needle.length;
    found = lower.indexOf(needle, cursor);
  }
  if (cursor < body.length) {
    pieces.push(
      <span key={"tail"}>{linkifyText(body.slice(cursor), "tail")}</span>
    );
  }
  return pieces;
}

interface ConversationSummary {
  id: number;
  channel: string;
  contactId: string | null;
  contactName: string | null;
  status: string;
  assignedTo: string | null;
  tags: string[];
}

interface ConversationMessage {
  id: number;
  direction: "in" | "out";
  body: string;
  status: string;
  intent: string | null;
  createdAt: string | null;
}

const POLL_MS = 10_000;

function formatTime(value: string | null): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function ThreadClient({
  conversationId,
  initialConversation,
  initialMessages,
}: {
  conversationId: string;
  initialConversation?: ConversationSummary | null;
  initialMessages?: ConversationMessage[] | null;
}) {
  const id = conversationId;

  const [conversation, setConversation] = useState<ConversationSummary | null>(
    initialConversation ?? null
  );
  const [messages, setMessages] = useState<ConversationMessage[] | null>(
    initialMessages ?? null
  );
  const [notFound, setNotFound] = useState(false);
  const [expired, setExpired] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const response = await fetch(
        \`/api/omniflow/portal/conversations/\${encodeURIComponent(id)}\`,
        { credentials: "same-origin", cache: "no-store" }
      );
      if (response.status === 401) {
        if (mounted.current) setExpired(true);
        return;
      }
      if (response.status === 404) {
        if (mounted.current) setNotFound(true);
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        conversation?: ConversationSummary;
        messages?: ConversationMessage[];
        has_more?: boolean;
      } | null;
      if (mounted.current && payload?.conversation && Array.isArray(payload.messages)) {
        setConversation(payload.conversation);
        setMessages(payload.messages);
        setHasMore(payload.has_more === true);
      }
    } catch {
      // Transient network issue — next poll retries.
    }
  }, [id]);

  function copyNumber() {
    const value = conversation?.contactId || "";
    if (value) void navigator.clipboard.writeText(value);
  }

  function downloadTranscript() {
    if (!messages || !conversation) return;
    const agentLabel = "Agent";
    const customerLabel = conversation.contactName || conversation.contactId || "Customer";
    const lines = messages.map((message) =>
      "[" + (message.createdAt || "unknown") + "] " +
      (message.direction === "out" ? agentLabel : customerLabel) +
      ": " + message.body
    );
    const blob = new Blob(
      ["Conversation with " + customerLabel + "\\n\\n" + lines.join("\\n")],
      { type: "text/plain;charset=utf-8" }
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "conversation-" + conversation.id + ".txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function loadOlder() {
    if (loadingOlder || !messages || messages.length === 0) return;
    const oldestId = messages[0].id;
    if (!oldestId) return;
    setLoadingOlder(true);
    try {
      const response = await fetch(
        \`/api/omniflow/portal/conversations/\${encodeURIComponent(id)}/messages?before_id=\${oldestId}\`,
        { credentials: "same-origin", cache: "no-store" }
      );
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        messages?: ConversationMessage[];
        has_more?: boolean;
      } | null;
      if (!mounted.current || !payload || !Array.isArray(payload.messages)) return;
      const older = payload.messages;
      setMessages((current) => (current ? [...older, ...current] : current));
      setHasMore(payload.has_more === true);
    } catch {
      // Transient network issue, the next click retries.
    } finally {
      setLoadingOlder(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const [statusBusy, setStatusBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem("ofl_draft_" + id);
    } catch {
      // Storage can be unavailable in private modes.
    }
    setDraft(stored ?? "");
  }, [id]);

  useEffect(() => {
    if (!id) return;
    try {
      if (draft) {
        window.localStorage.setItem("ofl_draft_" + id, draft);
      } else {
        window.localStorage.removeItem("ofl_draft_" + id);
      }
    } catch {
      // Storage can be unavailable in private modes.
    }
  }, [draft, id]);

  const threadBottomRef = useRef<HTMLDivElement | null>(null);
  const [nearBottom, setNearBottom] = useState(true);

  useEffect(() => {
    function onScroll() {
      const fromBottom =
        document.documentElement.scrollHeight -
        window.innerHeight -
        window.scrollY;
      setNearBottom(fromBottom < 160);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!nearBottom) return;
    threadBottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, nearBottom]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [threadQuery, setThreadQuery] = useState("");
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      void router.push("/dashboard/conversations");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  const [awayActive, setAwayActive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/omniflow/portal/business-hours", {
          credentials: "same-origin",
        });
        const payload = (await response.json()) as {
          business_hours?: {
            enabled?: boolean;
            timezone?: string;
            days?: { enabled: boolean; start: string; end: string }[];
          };
        };
        const config = payload.business_hours;
        if (!config || !config.enabled || cancelled) return;
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: config.timezone,
          hour12: false,
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
        }).formatToParts(new Date());
        const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
        const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
        const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
        const day = (config.days ?? [])[dayNames.indexOf(weekday)];
        const now = hour.padStart(2, "0") + ":" + minute;
        const openNow =
          day && day.enabled && now >= day.start && now <= day.end;
        if (!openNow && !cancelled) setAwayActive(true);
      } catch {
        // Transient network issue, the banner stays hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleMessages =
    threadQuery.trim() && messages
      ? messages.filter((message) =>
          message.body.toLowerCase().includes(threadQuery.trim().toLowerCase())
        )
      : messages;

  const threadMessages: ConversationMessage[] = visibleMessages ?? messages ?? [];

  const threadDayLabel = (index: number): string | null => {
    const current = threadMessages[index];
    if (!current || !current.createdAt) return null;
    const key = new Date(current.createdAt).toDateString();
    const previous = index > 0 ? threadMessages[index - 1] : null;
    if (previous && previous.createdAt &&
      new Date(previous.createdAt).toDateString() === key
    ) {
      return null;
    }
    const date = new Date(current.createdAt);
    if (date.toDateString() === new Date().toDateString()) return "Today";
    if (date.toDateString() === new Date(Date.now() - 86400000).toDateString()) {
      return "Yesterday";
    }
    return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  };
  const [sending, setSending] = useState(false);

  async function toggleStatus() {
    if (!conversation || statusBusy) return;
    const next = conversation.status === "open" ? "closed" : "open";
    setStatusBusy(true);
    try {
      const response = await fetch(
        \`/api/omniflow/portal/conversations/\${encodeURIComponent(id)}/status\`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ status: next }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        conversation?: ConversationSummary;
      } | null;
      if (mounted.current && payload?.conversation) {
        setConversation(payload.conversation);
      }
    } catch {
      // Transient network issue — the badge updates on the next poll.
    } finally {
      if (mounted.current) setStatusBusy(false);
    }
  }

  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "auto";
    composer.style.height = Math.min(composer.scrollHeight, 160) + "px";
  }, [draft]);

  useEffect(() => {
    if (!draft) return;
    function warnOnLeave(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warnOnLeave);
    return () => window.removeEventListener("beforeunload", warnOnLeave);
  }, [draft]);

  function exportThreadCsv() {
    if (!messages || messages.length === 0) return;
    const csvCell = (value: unknown): string => {
      const text = value === null || value === undefined ? "" : String(value);
      return /[",\\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    };
    const lines = ["created_at,direction,intent,body"];
    for (const message of messages) {
      lines.push(
        [
          message.createdAt,
          message.direction,
          message.intent ?? "",
          message.body,
        ]
          .map(csvCell)
          .join(",")
      );
    }
    const blob = new Blob(["\\ufeff" + lines.join("\\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "omniflow-conversation-" + id + ".csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function sendReply() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const response = await fetch(
        \`/api/omniflow/portal/conversations/\${encodeURIComponent(id)}/messages\`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ body }),
        }
      );
      if (response.ok) {
        setDraft("");
        setSendError(null);
        void refresh();
      } else {
        setSendError(
          "The reply did not go through. Check the connection and try again."
        );
      }
    } catch {
      // Transient network issue — the reply can be retried.
    } finally {
      if (mounted.current) setSending(false);
    }
  }

  const title = conversation?.contactName || conversation?.contactId || "Conversation";

  useEffect(() => {
    document.title = title + " \\u00b7 OmniFlow";
    return () => {
      document.title = "OmniFlow";
    };
  }, [title]);

  return (
    <div className="mx-auto max-w-3xl 2xl:max-w-5xl">
      <div className="mb-6">
        <Link
          href="/dashboard/conversations"
          className="-ml-2 inline-block rounded-lg px-2 py-1.5 text-sm text-slate-500 transition-colors hover:bg-white/[0.03] hover:text-cyan-300"
        >
          ← Conversations
        </Link>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-white">
              {title}
            </h1>
            <p className="mt-0.5 truncate text-xs text-slate-500">
              {conversation?.contactId ?? (id ? \`#\${id}\` : "")}
            </p>
            <p className="mt-0.5 text-[10px] text-slate-600">
              Press Esc to return to the inbox
            </p>
            {awayActive && (
              <p className="mt-0.5 text-[10px] font-medium text-amber-300">
                Away message is active. Customers get an automatic reply until
                business hours.
              </p>
            )}
          </div>
          {conversation && (
            <div className="flex shrink-0 items-center gap-2">
              <span
                className={\`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider \${
                  conversation.status === "open"
                    ? "border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-300"
                    : "border-white/[0.06] bg-white/[0.02] text-slate-500"
                }\`}
              >
                {conversation.status}
              </span>
              <button
                onClick={() => void toggleStatus()}
                disabled={statusBusy}
                className={\`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 \${
                  conversation.status === "open"
                    ? "border-red-400/25 bg-red-400/[0.06] text-red-300 hover:bg-red-400/[0.12]"
                    : "border-cyan-400/25 bg-cyan-400/[0.06] text-cyan-300 hover:bg-cyan-400/[0.12]"
                }\`}
              >
                {statusBusy
                  ? "Working…"
                  : conversation.status === "open"
                    ? "Close"
                    : "Reopen"}
              </button>
              {conversation.contactId && (
                <>
                  <a
                    href={\`https://wa.me/\${conversation.contactId.replace(/[^0-9]/g, "")}\`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border border-emerald-400/25 bg-emerald-400/[0.06] px-2.5 py-1 text-[11px] font-medium text-emerald-300 transition-colors hover:bg-emerald-400/[0.12]"
                  >
                    WhatsApp
                  </a>
                  <button
                    type="button"
                    onClick={() => copyNumber()}
                    title="Copy number"
                    className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:text-white"
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void navigator.clipboard.writeText(window.location.href)
                    }
                    title="Copy a link to this conversation"
                    className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:text-white"
                  >
                    Link
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadTranscript()}
                    title="Download the loaded messages as a text file"
                    className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:text-white"
                  >
                    Transcript
                  </button>
                  <button
                    type="button"
                    onClick={() => exportThreadCsv()}
                    title="Download the loaded messages as a CSV file"
                    className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:text-white"
                  >
                    CSV
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {!expired && !notFound && conversation?.channel !== "website" && (
        <CodCard conversationId={Number(id)} />
      )}
      {!expired && !notFound && (
        <VoiceCard conversationId={Number(id)} />
      )}
      {!expired && !notFound && conversation?.channel !== "website" && (
        <VideoCard conversationId={Number(id)} />
      )}
      {!expired && !notFound && conversation?.channel !== "website" && (
        <InteractiveCard conversationId={Number(id)} />
      )}
      {!expired && !notFound && (
        <TeamCard
          conversationId={Number(id)}
          initialAssignedTo={conversation?.assignedTo ?? null}
        />
      )}
      {!expired && !notFound && <NotesCard conversationId={Number(id)} />}
      {!expired && !notFound && (
        <TagsCard conversationId={Number(id)} initialTags={conversation?.tags ?? []} />
      )}
      {!expired && !notFound && (
        <CustomerCard contactId={conversation?.contactId ?? null} />
      )}
      {!expired && !notFound && (
        <AddToSequenceCard contactId={conversation?.contactId ?? null} />
      )}
      {!expired && !notFound && conversation?.channel !== "website" && (
        <RatingCard conversationId={Number(id)} />
      )}
      {!expired && !notFound && (
        <AssistCard conversationId={Number(id)} />
      )}
      {!expired && !notFound && (
        <RecoCard conversationId={Number(id)} />
      )}

      {expired ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-sm text-slate-300">Your session expired.</p>
          <a
            href="/dashboard/reauth"
            className="mt-3 inline-block text-xs text-cyan-300 transition-colors hover:text-cyan-200"
          >
            Re-authenticate →
          </a>
        </div>
      ) : notFound ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-sm text-slate-300">Conversation not found.</p>
        </div>
      ) : !messages ? (
        <div className="animate-pulse space-y-3">
          {[0, 1, 2, 3].map((index) => (
            <div
              key={index}
              className="h-10 w-2/3 rounded-2xl border border-white/[0.06] bg-white/[0.015]"
            />
          ))}
        </div>
      ) : messages.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-sm text-slate-300">No messages in this conversation yet.</p>
        </div>
      ) : visibleMessages && visibleMessages.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-sm text-slate-300">No messages match your search.</p>
        </div>
      ) : (
        <div className="of-fade-up space-y-3">
          {messages.length > 3 && (
            <div className="sticky top-0 z-10 -mx-1 bg-[#06101d]/90 px-1 py-2 backdrop-blur">
              <input
                type="search"
                value={threadQuery}
                onChange={(event) => setThreadQuery(event.target.value)}
                placeholder="Search in this conversation"
                className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2 text-xs text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
              />
              {threadQuery.trim() && (
                <p className="mt-1 text-right text-[10px] text-slate-600">
                  {threadMessages.length}{" "}
                  {threadMessages.length === 1 ? "match" : "matches"}
                </p>
              )}
            </div>
          )}
          {hasMore && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => void loadOlder()}
                disabled={loadingOlder}
                className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-1.5 text-xs font-medium text-slate-300 transition-colors duration-300 hover:text-white disabled:opacity-40"
              >
                {loadingOlder ? "Loading..." : "Load older messages"}
              </button>
            </div>
          )}
          {threadMessages.map((message, index) => (
            <Fragment key={message.id}>
            {threadDayLabel(index) && (
              <div className="sticky top-[4.25rem] z-10 flex justify-center">
                <span className="rounded-full border border-white/[0.06] bg-[#06101d] px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-slate-500 shadow-sm">
                  {threadDayLabel(index)}
                </span>
              </div>
            )}
            <div
              className={\`flex \${message.direction === "out" ? "justify-end" : "justify-start"}\`}
            >
              <div
                onDoubleClick={() =>
                  setDraft(
                    (current) =>
                      current +
                      (current && !current.endsWith("\\n") ? "\\n" : "") +
                      "> " +
                      message.body.replace(/\\n/g, "\\n> ") +
                      "\\n\\n"
                  )
                }
                title="Double-click to quote this message in your reply"
                className={\`max-w-[85%] rounded-2xl border px-4 py-2.5 sm:max-w-[70%] \${
                  message.direction === "out"
                    ? "border-cyan-400/20 bg-cyan-400/[0.08]"
                    : "border-white/[0.06] bg-white/[0.03]"
                }\`}
              >
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-100">
                  {renderMessageBody(message.body, threadQuery)}
                </p>
                <p className="mt-1 text-[10px] text-slate-500">
                  {message.direction === "out" ? "Bot / you" : "Customer"}
                  {formatTime(message.createdAt) ? \` · \${formatTime(message.createdAt)}\` : ""}
                  {message.direction === "in" &&
                  message.intent &&
                  message.intent !== "general"
                    ? \` · \${message.intent.replace(/_/g, " ")}\`
                    : ""}
                </p>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(message.body)}
                  title="Copy this message"
                  className="text-[10px] font-medium uppercase tracking-wider text-slate-500 transition-colors hover:text-slate-300"
                >
                  Copy
                </button>
              </div>
            </div>
            </Fragment>
          ))}
          <div ref={threadBottomRef} className="h-px" />
        </div>
      )}

      {!expired && !notFound && (
        <SavedRepliesPicker onPick={(text) => setDraft(text)} />
      )}
        {!nearBottom && (
          <button
            type="button"
            onClick={() =>
              threadBottomRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "end",
              })
            }
            className="fixed bottom-28 right-6 z-20 rounded-full border border-white/[0.1] bg-[#0b1829] px-4 py-2 text-xs font-medium text-slate-200 shadow-lg transition-colors hover:text-white"
          >
            Jump to latest
          </button>
        )}
        {sendError && (
          <p className="mb-2 text-[11px] font-medium text-amber-300">
            {sendError}
          </p>
        )}
      {!expired && !notFound && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void sendReply();
          }}
          className="sticky bottom-0 z-10 -mx-2 mt-6 flex items-end gap-3 border-t border-white/[0.06] bg-[#06101d]/95 px-2 py-3 backdrop-blur"
        >
          <div className="hidden max-w-[176px] flex-wrap items-end gap-0.5 sm:flex">
            {["\\u{1F44D}", "\\u{1F64F}", "\\u{1F600}", "\\u{1F622}", "\\u{1F621}", "\\u{1F44C}", "\\u{1F91D}", "\\u{1F4B0}", "\\u{1F4E6}", "\\u{1F69A}", "\\u2705", "\\u274C", "\\u23F0", "\\u{1F4DE}", "\\u{1F60A}", "\\u{1F44B}"].map(
              (emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => setDraft((current) => current + emoji)}
                  className="rounded px-1 text-base leading-6 transition-colors hover:bg-white/[0.06]"
                >
                  {emoji}
                </button>
              )
            )}
          </div>
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            title="Enter sends the reply, Shift+Enter inserts a new line"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void sendReply();
              }
            }}
            rows={2}
            maxLength={4096}
            placeholder="Reply as a human agent"
            className="flex-1 resize-none rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
          />
          <div className="hidden shrink-0 flex-col items-end text-[10px] text-slate-600 sm:flex">
            {draft.length} / 4096
          </div>
          <button
            type="submit"
            disabled={sending || !draft.trim()}
            className="shrink-0 rounded-xl bg-cyan-400 px-5 py-3 text-sm font-semibold text-[#07111f] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </form>
      )}
    </div>
  );
}
`);
writeNewRepair("app/c/[token]/PayGate.tsx", "Send my code", false,
    `"use client";

import { useState } from "react";

export default function PayGate({
  token,
  due,
  phoneVerification,
  status,
}: {
  token: string;
  due: number | string;
  phoneVerification: boolean;
  status: string;
}) {
  const [verified, setVerified] = useState(false);
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);

  if (status !== "open") return null;

  async function sendCode() {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(
        "/api/omniflow/public/checkout/" + encodeURIComponent(token) + "/otp",
        { method: "POST" }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload && payload.ok) {
        setSent(true);
        setNote({ text: "Code sent to you on WhatsApp.", ok: true });
      } else {
        setNote({
          text:
            payload && payload.error
              ? (payload.error.message || "Please try again.")
              : "Could not send the code — try again.",
          ok: false,
        });
      }
    } catch {
      setNote({ text: "Could not send the code — try again.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (busy) return;
    if (!/^\\d{6}$/.test(code.trim())) {
      setNote({ text: "Enter the 6-digit code.", ok: false });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(
        "/api/omniflow/public/checkout/"
          + encodeURIComponent(token)
          + "/otp/verify",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: code.trim() }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        verified?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload && payload.verified) {
        setVerified(true);
        setNote({ text: "Verified — you can pay now.", ok: true });
      } else {
        setNote({
          text:
            payload && payload.error
              ? (payload.error.message || "Please try again.")
              : "Could not verify — try again.",
          ok: false,
        });
      }
    } catch {
      setNote({ text: "Could not verify — try again.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  if (phoneVerification && !verified) {
    return (
      <div className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3">
        <p className="text-xs font-medium text-slate-200">
          Verify it&apos;s you before paying
        </p>
        <p className="mt-1 text-[11px] text-slate-500">
          We send a 6-digit code to your WhatsApp.
        </p>
        {sent ? (
          <div className="mt-2 flex items-center gap-2">
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode="numeric"
              maxLength={6}
              placeholder="123456"
              className="w-28 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm tracking-[0.3em] text-white placeholder:text-slate-600 focus:border-cyan-400/40 focus:outline-none"
            />
            <button
              onClick={() => void verify()}
              disabled={busy}
              className="rounded-xl border border-cyan-400/30 bg-cyan-400/[0.08] px-3 py-2 text-xs font-medium text-cyan-200 hover:bg-cyan-400/[0.14] disabled:opacity-50"
            >
              {busy ? "Checking…" : "Verify"}
            </button>
          </div>
        ) : (
          <button
            onClick={() => void sendCode()}
            disabled={busy}
            className="mt-2 rounded-xl border border-cyan-400/30 bg-cyan-400/[0.08] px-3 py-2 text-xs font-medium text-cyan-200 hover:bg-cyan-400/[0.14] disabled:opacity-50"
          >
            {busy ? "Sending…" : "Send my code"}
          </button>
        )}
        {note ? (
          <p
            className={
              "mt-2 text-[11px] " + (note.ok ? "text-emerald-300" : "text-rose-300")
            }
          >
            {note.text}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <a
      href={"/api/omniflow/public/checkout/" + encodeURIComponent(token) + "/pay"}
      className="mt-3 block rounded-xl border border-emerald-400/30 bg-emerald-400/[0.1] px-4 py-3 text-center text-sm font-semibold text-emerald-200 hover:bg-emerald-400/[0.18]"
    >
      Pay {due} online
    </a>
  );
}
`);
writeNewRepair("app/c/[token]/page.tsx", "<PayGate", false,
    `import Link from "next/link";
import {
  getPublicCheckout,
  getPublicPayInfo,
} from "../../../lib/omniflow/portal";
import SelfServe from "./SelfServe";
import PayGate from "./PayGate";


export default async function PublicCheckoutPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const view = await getPublicCheckout(token);
  const payInfo = view ? await getPublicPayInfo(token) : null;

  if (!view) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
        <h1 className="text-xl font-semibold text-white">Link not found</h1>
        <p className="mt-2 text-sm text-slate-500">
          This order link is not valid. Please ask the business for a fresh
          link.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-6 py-12">
      <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-400/70">
        {view.brandName ? view.brandName + " · order summary" : "Order summary"}
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white">
        {view.title || "Your order"}
      </h1>
      <div className="mt-4 flex items-center gap-1.5">
        {["ordered", "paid", "shipped", "delivered"].map((step, index) => {
          const order = ["open", "paid", "shipped", "delivered"];
          const at = order.indexOf(view.status);
          const done = view.status === "returned"
            ? false
            : at >= index && at !== 0
              ? true
              : index === 0;
          return (
            <span
              key={step}
              className={\`rounded-full border px-2 py-0.5 text-[10px] capitalize \${
                done
                  ? "border-emerald-400/30 bg-emerald-400/[0.1] text-emerald-300"
                  : "border-white/[0.08] bg-white/[0.02] text-slate-500"
              }\`}
            >
              {step}
            </span>
          );
        })}
      </div>

      <ul className="mt-6 space-y-2">
        {view.items.map((item, index) => (
          <li
            key={index}
            className="flex items-center justify-between rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3"
          >
            <div>
              <p className="text-sm text-slate-200">{item.name}</p>
              <p className="text-[11px] text-slate-500">Qty {item.qty}</p>
            </div>
            <p className="text-sm font-medium text-white">
              {item.price * item.qty}
            </p>
          </li>
        ))}
      </ul>

      {view.discount > 0 ? (
        <div className="mt-2 flex items-center justify-between rounded-xl border border-rose-400/20 bg-rose-400/[0.05] px-4 py-2.5">
          <p className="text-sm text-rose-200">Discount</p>
          <p className="text-sm font-medium text-rose-200">
            -{view.discount}
          </p>
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-between rounded-xl border border-cyan-400/20 bg-cyan-400/[0.06] px-4 py-3">
        <p className="text-sm font-medium text-cyan-200">Total</p>
        <p className="text-lg font-semibold text-white">{view.total}</p>
      </div>

      {view.couponCode ? (
        <div className="mt-2 flex items-center justify-between rounded-xl border border-cyan-400/15 bg-cyan-400/[0.04] px-4 py-2">
          <p className="text-xs text-cyan-200">
            Coupon <span className="font-semibold">{view.couponCode}</span>{" "}
            applied
          </p>
          <p className="text-xs font-medium text-cyan-200">
            −{view.couponDiscount}
          </p>
        </div>
      ) : null}

      {view.payment ? (
        <div className="mt-2 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] px-4 py-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-emerald-200">
              Advance received: {view.payment.paidAmount}
            </p>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <p className="text-sm font-medium text-emerald-100">
              Due on delivery
            </p>
            <p className="text-base font-semibold text-white">
              {view.payment.due}
            </p>
          </div>
        </div>
      ) : null}

      {view.trackingNumber ? (
        <div className="mt-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3">
          <p className="text-xs text-slate-400">
            Courier: {view.courier || "-"}
          </p>
          <p className="mt-1 text-sm font-medium text-slate-200">
            Tracking #: {view.trackingNumber}
          </p>
        </div>
      ) : null}

      {payInfo && payInfo.enabled && view.payment
        && view.payment.due > 0 ? (
        <PayGate
          token={token}
          due={view.payment.due}
          phoneVerification={view.phoneVerification === true}
          status={view.status}
        />
      ) : null}

      <SelfServe
        token={token}
        status={view.status}
        hasCoupon={Boolean(view.couponCode)}
      />

      {view.status === "paid" ? (
        <p className="mt-3 rounded-xl border border-emerald-400/25 bg-emerald-400/[0.08] px-4 py-2.5 text-center text-sm font-medium text-emerald-300">
          Paid in full — thank you!
        </p>
      ) : null}

      <p className="mt-6 text-xs text-slate-500">
        Confirm or ask questions by replying to the business on WhatsApp —
        this link always shows the latest status of your order. If the link
        has expired, ask the business for a fresh one.
      </p>

      <Link
        href="/"
        className="mt-8 inline-block text-xs text-slate-600 transition-colors hover:text-slate-400"
      >
        Powered by OmniFlow
      </Link>
    </main>
  );
}
`);
writeNewRepair("app/dashboard/(portal)/settings/CatalogCard.tsx", "id=\"catalogBrandFilter\"", false,
    `"use client";

import { useCallback, useEffect, useState } from "react";

interface CatalogRow {
  id: number;
  kind: "product" | "service";
  name: string;
  priceText: string;
  notes: string;
  isActive: boolean;
  price?: number;
  stock?: number;
  source?: string;
  brand_id?: number | null;
  brand_name?: string | null;
}

interface CatalogBrand {
  id: number;
  name: string;
}

interface SyncSettings {
  source: string;
  base_url: string;
  api_key_masked: string;
  api_secret_masked: string;
  last_sync_at: string | null;
  last_sync_count: number;
}

interface FormState {
  kind: "product" | "service";
  name: string;
  priceText: string;
  notes: string;
  brandId: string;
}

const EMPTY_FORM: FormState = {
  kind: "product",
  name: "",
  priceText: "",
  notes: "",
  brandId: "",
};

export default function CatalogCard() {
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [brands, setBrands] = useState<CatalogBrand[]>([]);
  const [brandFilter, setBrandFilter] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState(0);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [sync, setSync] = useState<SyncSettings | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncForm, setSyncForm] = useState({
    source: "woo", base_url: "", api_key: "", api_secret: "",
  });
  const [syncNote, setSyncNote] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);

  const load = useCallback(async (brandFilter?: string) => {
    try {
      const [response, brandsRes] = await Promise.all([
        fetch(
          brandFilter
            ? "/api/omniflow/portal/catalog?brand_id=" + brandFilter
            : "/api/omniflow/portal/catalog",
          { cache: "no-store" }
        ),
        fetch("/api/omniflow/portal/brands", { cache: "no-store" }),
      ]);
      const payload = (await response.json().catch(() => null)) as {
        items?: CatalogRow[];
      } | null;
      if (payload && Array.isArray(payload.items)) setRows(payload.items);
      const brandsPayload = (await brandsRes.json().catch(() => null)) as {
        brands?: CatalogBrand[];
      } | null;
      if (brandsPayload && Array.isArray(brandsPayload.brands)) {
        setBrands(brandsPayload.brands);
      }
    } catch {
      // transient - the list can be reloaded
    } finally {
      setLoaded(true);
    }
  }, []);

  const loadSync = useCallback(async () => {
    try {
      const response = await fetch(
        "/api/omniflow/portal/catalog/sync/settings",
        { cache: "no-store" }
      );
      if (response.ok) {
        setSync((await response.json()) as SyncSettings);
      }
    } catch {
      /* the import panel simply stays closed */
    }
  }, []);

  async function saveSyncSettings() {
    if (!syncForm.base_url.trim()) return;
    setSyncBusy(true);
    setSyncNote("");
    try {
      const response = await fetch(
        "/api/omniflow/portal/catalog/sync/settings",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: syncForm.source,
            base_url: syncForm.base_url.trim(),
            api_key: syncForm.api_key.trim() || undefined,
            api_secret: syncForm.api_secret.trim() || undefined,
          }),
        }
      );
      if (response.ok) {
        setSyncNote("Import source saved.");
        setSyncForm({ ...syncForm, api_key: "", api_secret: "" });
        await loadSync();
      } else {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setSyncNote(payload?.error?.message ?? "Could not save.");
      }
    } catch {
      setSyncNote("Could not save - try again.");
    } finally {
      setSyncBusy(false);
    }
  }

  async function runSync() {
    setSyncBusy(true);
    setSyncNote("");
    try {
      const response = await fetch("/api/omniflow/portal/catalog/sync",
        { method: "POST" });
      const payload = (await response.json().catch(() => null)) as
        | { imported?: number; updated?: number;
            error?: { message?: string } }
        | null;
      if (response.ok && payload?.imported !== undefined) {
        setSyncNote("Imported " + payload.imported + " new, updated "
          + (payload.updated ?? 0) + " existing.");
        await load();
        await loadSync();
      } else {
        setSyncNote(payload?.error?.message ?? "Import failed.");
      }
    } catch {
      setSyncNote("Import failed - try again.");
    } finally {
      setSyncBusy(false);
    }
  }

  useEffect(() => {
    void load();
    void loadSync();
  }, [load, loadSync]);

  useEffect(() => {
    void load(brandFilter || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandFilter]);

  async function create() {
    if (busy) return;
    if (!form.name.trim()) {
      setNote("Item name is required.");
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item: {
            kind: form.kind,
            name: form.name.trim(),
            price_text: form.priceText.trim(),
            notes: form.notes.trim(),
            is_active: true,
            brand_id: form.brandId === "" ? null : Number(form.brandId),
          },
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        setNote(payload?.error?.message || "Could not save the item.");
        return;
      }
      setForm(EMPTY_FORM);
      setNote("Item saved.");
      await load();
    } catch {
      setNote("Could not save the item - try again.");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: number) {
    if (busy) return;
    if (!editForm.name.trim()) {
      setNote("Item name is required.");
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const response = await fetch(
        "/api/omniflow/portal/catalog/" + String(id),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            item: {
              kind: editForm.kind,
              name: editForm.name.trim(),
              price_text: editForm.priceText.trim(),
              notes: editForm.notes.trim(),
              is_active: true,
              brand_id: editForm.brandId === "" ? null : Number(editForm.brandId),
            },
          }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        setNote(payload?.error?.message || "Could not update the item.");
        return;
      }
      setEditingId(0);
      setNote("Item updated.");
      await load();
    } catch {
      setNote("Could not update the item - try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch(
        "/api/omniflow/portal/catalog/" + String(id),
        { method: "DELETE" }
      );
      if (!response.ok) {
        setNote("Could not remove the item.");
        return;
      }
      setNote("Item removed.");
      await load();
    } catch {
      setNote("Could not remove the item - try again.");
    } finally {
      setBusy(false);
    }
  }

  const active = rows.filter((row) => row.isActive);

  return (
    <section className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5">
      <h2 className="text-sm font-semibold text-white">Saved catalog</h2>
      <p className="mt-1 text-xs text-slate-500">
        Products and services you sell again and again. The checkout link
        builder picks items from here with one tap, and recommendations read
        the same list.
      <button
        onClick={() => setSyncOpen(!syncOpen)}
        className="mt-2 text-[11px] text-cyan-300 hover:underline"
      >
        Import from store {sync?.source
          ? "(" + sync.source + ")"
          : ""}
      </button>
      {syncOpen ? (
        <div className="mt-2 rounded-xl border border-cyan-400/15 bg-cyan-400/[0.03] p-3">
          <p className="text-[11px] text-slate-400">
            One-way import from WooCommerce or Shopify - names, prices,
            stock and images. Your manual items are never touched, and
            re-importing updates the same products in place.
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <select
              value={syncForm.source}
              onChange={(e) => setSyncForm({ ...syncForm,
                source: e.target.value })}
              className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1.5 text-[11px] text-white outline-none"
              aria-label="Store platform"
            >
              <option value="woo">WooCommerce</option>
              <option value="shopify">Shopify</option>
            </select>
            <input
              value={syncForm.base_url}
              onChange={(e) => setSyncForm({ ...syncForm,
                base_url: e.target.value })}
              placeholder={sync?.base_url
                || "Store URL (e.g. https://mystore.com)"}
              className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1.5 text-[11px] text-white outline-none"
            />
            <input
              value={syncForm.api_key}
              onChange={(e) => setSyncForm({ ...syncForm,
                api_key: e.target.value })}
              placeholder={sync?.api_key_masked
                || (syncForm.source === "woo"
                  ? "Consumer key"
                  : "Admin API access token")}
              className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1.5 text-[11px] text-white outline-none"
            />
            {syncForm.source === "woo" ? (
              <input
                value={syncForm.api_secret}
                onChange={(e) => setSyncForm({ ...syncForm,
                  api_secret: e.target.value })}
                placeholder={sync?.api_secret_masked || "Consumer secret"}
                className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1.5 text-[11px] text-white outline-none"
              />
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              onClick={() => void saveSyncSettings()}
              disabled={syncBusy || !syncForm.base_url.trim()}
              className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-[11px] text-slate-300 hover:bg-white/[0.05] disabled:opacity-40"
            >
              Save source
            </button>
            <button
              onClick={() => void runSync()}
              disabled={syncBusy}
              className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-3 py-1.5 text-[11px] text-emerald-200 hover:bg-emerald-400/[0.15] disabled:opacity-40"
            >
              Import now
            </button>
            {sync?.last_sync_at ? (
              <span className="text-[10px] text-slate-600">
                Last import: {sync.last_sync_count} products
              </span>
            ) : null}
          </div>
          {syncNote ? (
            <p className="mt-1.5 text-[11px] text-slate-300">{syncNote}</p>
          ) : null}
        </div>
      ) : null}
      </p>

      <div className="mt-4 grid gap-2 sm:grid-cols-[7rem_1fr_9rem]">
        <select
          value={form.kind}
          onChange={(event) =>
            setForm({ ...form, kind: event.target.value === "service" ? "service" : "product" })
          }
          className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs text-white outline-none focus:border-cyan-400/40"
        >
          <option value="product">Product</option>
          <option value="service">Service</option>
        </select>
        <input
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          placeholder="Item name (e.g. Lawn 3-piece)"
          maxLength={120}
          className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs text-white outline-none focus:border-cyan-400/40"
        />
        <input
          value={form.priceText}
          onChange={(event) => setForm({ ...form, priceText: event.target.value })}
          placeholder="Price (e.g. Rs 2,500)"
          maxLength={40}
          className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs text-white outline-none focus:border-cyan-400/40"
        />
        {brands.length > 0 && (
          <select
            value={form.brandId}
            onChange={(event) => setForm({ ...form, brandId: event.target.value })}
            className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs text-white outline-none focus:border-cyan-400/40"
          >
            <option value="">No brand</option>
            {brands.map((brand) => (
              <option key={brand.id} value={String(brand.id)}>
                {brand.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          value={form.notes}
          onChange={(event) => setForm({ ...form, notes: event.target.value })}
          placeholder="Short note (optional)"
          maxLength={160}
          className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs text-white outline-none focus:border-cyan-400/40"
        />
        <button
          type="button"
          onClick={() => void create()}
          disabled={busy}
          className="shrink-0 rounded-xl bg-cyan-400 px-4 py-2 text-xs font-semibold text-[#07111f] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Add item
        </button>
      </div>

      {note ? <p className="mt-2 text-[11px] text-amber-300">{note}</p> : null}


      {brands.length > 0 ? (
        <div className="mt-3">
          <select
            id="catalogBrandFilter"
            value={brandFilter}
            onChange={(event) => setBrandFilter(event.target.value)}
            className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-1.5 text-xs text-white outline-none focus:border-cyan-400/40"
          >
            <option value="">All brands</option>
            {brands.map((brand) => (
              <option key={brand.id} value={String(brand.id)}>
                {brand.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="mt-4">
        {loaded && rows.length === 0 ? (
          <p className="text-xs text-slate-500">
            No catalog items yet — add your first product above.
          </p>
        ) : null}
        {active.length > 0 ? (

          <ul className="space-y-1.5">
            {active.map((row) => (
              <li
                key={row.id}
                className="rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2"
              >
                <span className="float-right flex items-center gap-1.5">
                  {row.brand_name ? (
                    <span className="rounded-full border border-sky-400/25 bg-sky-400/[0.08] px-2 py-0.5 text-[9px] uppercase tracking-wide text-sky-300">
                      {row.brand_name}
                    </span>
                  ) : null}
                  {row.source && row.source !== "manual" ? (
                    <span className="rounded-full border border-white/[0.1] bg-white/[0.03] px-2 py-0.5 text-[9px] uppercase tracking-wide text-slate-400">
                      {row.source}
                      {(row.stock ?? 0) > 0 ? " · stock " + row.stock : ""}
                    </span>
                  ) : null}
                </span>
                {editingId === row.id ? (
                  <div className="grid gap-2 sm:grid-cols-[7rem_1fr_9rem]">
                    <select
                      value={editForm.kind}
                      onChange={(event) =>
                        setEditForm({
                          ...editForm,
                          kind: event.target.value === "service" ? "service" : "product",
                        })
                      }
                      className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1.5 text-[11px] text-white outline-none"
                    >
                      <option value="product">Product</option>
                      <option value="service">Service</option>
                    </select>
                    <input
                      value={editForm.name}
                      onChange={(event) =>
                        setEditForm({ ...editForm, name: event.target.value })
                      }
                      maxLength={120}
                      className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1.5 text-[11px] text-white outline-none"
                    />
                    <input
                      value={editForm.priceText}
                      onChange={(event) =>
                        setEditForm({ ...editForm, priceText: event.target.value })
                      }
                      maxLength={40}
                      className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1.5 text-[11px] text-white outline-none"
                    />
                    {brands.length > 0 && (
                      <select
                        value={editForm.brandId}
                        onChange={(event) =>
                          setEditForm({
                            ...editForm,
                            brandId: event.target.value,
                          })
                        }
                        className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1.5 text-[11px] text-white outline-none sm:col-span-3"
                      >
                        <option value="">No brand</option>
                        {brands.map((brand) => (
                          <option key={brand.id} value={String(brand.id)}>
                            {brand.name}
                          </option>
                        ))}
                      </select>
                    )}
                    <div className="flex items-center gap-1.5 sm:col-span-3">
                      <button
                        type="button"
                        onClick={() => void saveEdit(row.id)}
                        disabled={busy}
                        className="rounded-lg border border-cyan-400/30 bg-cyan-400/[0.1] px-2.5 py-1 text-[10px] font-medium text-cyan-200 disabled:opacity-50"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(0)}
                        className="rounded-lg border border-white/[0.08] px-2.5 py-1 text-[10px] text-slate-400"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs text-slate-200">
                        <span className="mr-1.5 rounded border border-white/[0.08] px-1 py-0.5 text-[9px] uppercase tracking-wider text-slate-400">
                          {row.kind}
                        </span>
                        {row.name}
                        {row.priceText ? (
                          <span className="text-slate-400"> · {row.priceText}</span>
                        ) : null}
                      </p>
                      {row.notes ? (
                        <p className="truncate text-[10px] text-slate-500">{row.notes}</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(row.id);
                          setEditForm({
                            kind: row.kind,
                            name: row.name,
                            priceText: row.priceText,
                            notes: row.notes,
                            brandId: row.brand_id ? String(row.brand_id) : "",
                          });
                        }}
                        className="rounded-lg border border-white/[0.08] px-2 py-1 text-[10px] text-slate-300 hover:bg-white/[0.06]"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(row.id)}
                        disabled={busy}
                        className="rounded-lg border border-white/[0.08] px-2 py-1 text-[10px] text-slate-400 hover:border-rose-400/40 hover:text-rose-300 disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
`);
writeNewRepair("app/dashboard/(portal)/knowledge-base/KnowledgeBaseClient.tsx", "id=\"kbBrandFilter\"", false,
    `"use client";

import { useCallback, useMemo, useState } from "react";
import type { KnowledgeBaseData } from "../../../../lib/omniflow/portal";

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const labelClass = "mb-1.5 block text-xs font-medium text-slate-400";

const primaryBtn =
  "rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50";

const ghostBtn =
  "rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-xs font-medium text-slate-300 transition-colors duration-300 hover:bg-white/[0.05] disabled:opacity-50";

const chipClass =
  "rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-slate-500";

type KbLang = "auto" | "en" | "ur" | "roman";

const LANG_LABELS: Record<KbLang, string> = {
  auto: "Auto",
  en: "English",
  ur: "Urdu",
  roman: "Roman Urdu",
};

interface KbFormState {
  id: number | null;
  title: string;
  category: string;
  keywords: string;
  content: string;
  isActive: boolean;
  lang: KbLang;
  brandId: number | null;
}

export interface KbBrandOption {
  id: number;
  name: string;
}

const EMPTY_FORM: KbFormState = {
  id: null,
  title: "",
  category: "general",
  keywords: "",
  content: "",
  isActive: true,
  lang: "auto",
  brandId: null,
};

export default function KnowledgeBaseClient({
  initial,
  brands = [],
}: {
  initial: KnowledgeBaseData;
  brands?: KbBrandOption[];
}) {
  const [autoReply, setAutoReply] = useState(initial.settings.autoReply);
  const [entries, setEntries] = useState(initial.entries);
  const [search, setSearch] = useState("");
  const [langFilter, setLangFilter] = useState<KbLang | "all">("all");
  const [brandFilter, setBrandFilter] = useState<string>("all");
  const [form, setForm] = useState<KbFormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/kb", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as
        | (KnowledgeBaseData & { error?: unknown })
        | null;
      if (payload && Array.isArray(payload.entries)) {
        setEntries(payload.entries);
        setAutoReply(payload.settings?.autoReply === true);
      }
    } catch {
      // Transient network issue — the next action retries.
    }
  }, []);

  async function toggleAutoReply(next: boolean) {
    if (busy) return;
    setAutoReply(next);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/kb", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ settings: { autoReply: next } }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({
          kind: "ok",
          text: next
            ? "Automatic replies are on."
            : "Automatic replies are off.",
        });
      } else {
        setAutoReply(!next);
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not save. Try again shortly.",
        });
      }
    } catch {
      setAutoReply(!next);
      setMessage({ kind: "error", text: "Network error — try again." });
    }
  }

  async function saveForm() {
    if (busy || !form) return;
    const title = form.title.trim();
    const content = form.content.trim();
    if (!title || !content) {
      setMessage({ kind: "error", text: "Title and answer are required." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        form.id === null
          ? "/api/omniflow/portal/kb"
          : "/api/omniflow/portal/kb/" + String(form.id),
        {
          method: form.id === null ? "POST" : "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            entry: {
              title,
              category: form.category.trim() || "general",
              keywords: form.keywords.trim(),
              content,
              isActive: form.isActive,
              lang: form.lang,
              brand_id: form.brandId,
            },
          }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({
          kind: "ok",
          text: form.id === null ? "Entry added." : "Entry updated.",
        });
        setForm(null);
        await refresh();
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not save. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  async function removeEntry(entryId: number) {
    if (busy) return;
    if (
      !window.confirm(
        "Delete this entry? Customers will no longer receive this answer."
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/kb/" + String(entryId),
        {
          method: "DELETE",
          credentials: "same-origin",
        }
      );
      if (response.ok) {
        setMessage({ kind: "ok", text: "Entry deleted." });
        await refresh();
      } else {
        setMessage({
          kind: "error",
          text: "Could not delete. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  const visibleEntries = useMemo(() => {
    const query = search.trim().toLowerCase();
    let result = entries;
    if (langFilter !== "all") {
      result = result.filter((entry) => (entry.lang || "auto") === langFilter);
    }
    if (brandFilter !== "all") {
      const brandId = Number(brandFilter);
      result = result.filter((entry) => entry.brandId === brandId);
    }
    if (!query) return result;
    return result.filter(
      (entry) =>
        entry.title.toLowerCase().includes(query) ||
        entry.category.toLowerCase().includes(query) ||
        entry.keywords.toLowerCase().includes(query) ||
        entry.content.toLowerCase().includes(query)
    );
  }, [entries, search, langFilter, brandFilter]);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-white">
              Automatic replies
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              When a customer message matches an entry keyword, the assistant
              sends that answer instantly on WhatsApp. Fires for general,
              shipping, order-tracking and appointment questions. Complaints,
              refund requests and requests for a human are never
              auto-answered.
            </p>
          </div>
          <button
            type="button"
            onClick={() => toggleAutoReply(!autoReply)}
            aria-pressed={autoReply}
            className={"relative h-6 w-11 shrink-0 rounded-full transition-colors " +
              (autoReply ? "bg-cyan-400" : "bg-white/[0.1]")}
          >
            <span
              className={"absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all " +
                (autoReply ? "left-[22px]" : "left-0.5")}
            />
          </button>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          {autoReply
            ? "Automatic replies are ON — matching entries are sent instantly."
            : "Automatic replies are OFF — entries are a reference library only until you switch them on."}
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search entries..."
          className={inputClass + " sm:flex-1"}
        />
        {brands.length > 0 ? (
          <select
            id="kbBrandFilter"
            value={brandFilter}
            onChange={(e) => setBrandFilter(e.target.value)}
            className={inputClass + " sm:w-40"}
          >
            <option value="all">All brands</option>
            {brands.map((brand) => (
              <option key={brand.id} value={String(brand.id)}>
                {brand.name}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          onClick={() => {
            setForm({ ...EMPTY_FORM });
            setMessage(null);
          }}
          className={primaryBtn}
        >
          Add entry
        </button>
      </div>

      {message && (
        <div
          className={
            "rounded-xl border px-4 py-3 text-xs leading-relaxed " +
            (message.kind === "ok"
              ? "border-emerald-400/20 bg-emerald-400/[0.05] text-emerald-200/90"
              : "border-red-400/20 bg-red-400/[0.05] text-red-200/90")
          }
        >
          {message.text}
        </div>
      )}

      {form && (
        <div className="rounded-2xl border border-cyan-400/15 bg-white/[0.02] p-6">
          <h3 className="text-sm font-semibold text-white">
            {form.id === null ? "New entry" : "Edit entry"}
          </h3>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="kbTitle" className={labelClass}>
                Question title
              </label>
              <input
                id="kbTitle"
                type="text"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Delivery time"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="kbCategory" className={labelClass}>
                Category
              </label>
              <input
                id="kbCategory"
                type="text"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                placeholder="general"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="kbLang" className={labelClass}>
                Language
              </label>
              <select
                id="kbLang"
                value={form.lang}
                onChange={(e) =>
                  setForm({ ...form, lang: e.target.value as KbLang })
                }
                className={inputClass}
              >
                {(Object.keys(LANG_LABELS) as KbLang[]).map((value) => (
                  <option key={value} value={value}>
                    {LANG_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {brands.length > 0 && (
            <div className="mt-4">
              <label htmlFor="kbBrand" className={labelClass}>
                Brand (optional)
              </label>
              <select
                id="kbBrand"
                value={form.brandId === null ? "" : String(form.brandId)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    brandId: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
                className={inputClass}
              >
                <option value="">No brand</option>
                {brands.map((brand) => (
                  <option key={brand.id} value={String(brand.id)}>
                    {brand.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="mt-4">
            <label htmlFor="kbKeywords" className={labelClass}>
              Trigger keywords
            </label>
            <input
              id="kbKeywords"
              type="text"
              value={form.keywords}
              onChange={(e) => setForm({ ...form, keywords: e.target.value })}
              placeholder="delivery, delivery time, kitne din"
              className={inputClass}
            />
            <p className="mt-1.5 text-[11px] text-slate-600">
              Comma separated. A customer message containing any keyword can
              receive this answer automatically.
            </p>
          </div>
          <div className="mt-4">
            <label htmlFor="kbContent" className={labelClass}>
              Answer
            </label>
            <textarea
              id="kbContent"
              rows={5}
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              placeholder="Hi {name}! We deliver in 2-3 working days across Karachi..."
              className={inputClass}
            />
            <p className="mt-1.5 text-[11px] text-slate-600">
              {"{name}"} becomes the customer&apos;s first name.
            </p>
          </div>
          <div className="mt-4 flex items-center justify-between gap-4">
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) =>
                  setForm({ ...form, isActive: e.target.checked })
                }
                className="h-4 w-4 rounded border-white/20 bg-white/[0.03]"
              />
              Active
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setForm(null)}
                className={ghostBtn}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => saveForm()}
                disabled={busy}
                className={primaryBtn}
              >
                {busy ? "Saving..." : "Save entry"}
              </button>
            </div>
          </div>
        </div>
      )}

      {entries.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-8 text-center">
          <p className="text-sm text-slate-400">No entries yet</p>
          <p className="mt-1 text-xs text-slate-600">
            Add your first answer — delivery times, prices, policies, hours.
          </p>
        </div>
      ) : visibleEntries.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-8 text-center">
          <p className="text-xs text-slate-500">No entries match your search.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {visibleEntries.map((entry) => (
            <div
              key={entry.id}
              className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-white">
                      {entry.title}
                    </h3>
                    <span className={chipClass}>{entry.category}</span>
                    {entry.brandId !== null &&
                      brands.some((b) => b.id === entry.brandId) && (
                        <span className="rounded-md border border-sky-400/25 bg-sky-400/[0.08] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-sky-300">
                          {brands.find((b) => b.id === entry.brandId)?.name}
                        </span>
                      )}
                    {(entry.lang || "auto") !== "auto" && (
                      <span className={chipClass}>
                        {LANG_LABELS[entry.lang || "auto"]}
                      </span>
                    )}
                    {!entry.isActive && (
                      <span className="rounded-md border border-amber-400/20 bg-amber-400/[0.05] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-amber-300/80">
                        Hidden
                      </span>
                    )}
                  </div>
                  {entry.keywords && (
                    <p className="mt-1 text-[11px] text-slate-500">
                      Keywords: {entry.keywords}
                    </p>
                  )}
                  <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-slate-400">
                    {entry.content}
                  </p>
                  <p className="mt-2 text-[10px] uppercase tracking-wider text-slate-600">
                    Sent {entry.usageCount}{" "}
                    {entry.usageCount === 1 ? "time" : "times"}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setForm({
                        id: entry.id,
                        title: entry.title,
                        category: entry.category,
                        keywords: entry.keywords,
                        content: entry.content,
                        isActive: entry.isActive,
                        lang: entry.lang || "auto",
                        brandId: entry.brandId ?? null,
                      });
                      setMessage(null);
                    }}
                    className={ghostBtn}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => removeEntry(entry.id)}
                    disabled={busy}
                    className="rounded-xl border border-red-400/15 bg-red-400/[0.04] px-4 py-2 text-xs font-medium text-red-300/80 transition-colors duration-300 hover:bg-red-400/[0.09] disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
`);
writeNewRepair("app/dashboard/(portal)/settings/PaymentsCard.tsx", "value=\"stripe\"", false,
    `"use client";

import { useEffect, useState } from "react";

type PaymentSettings = {
  provider: string;
  enabled: boolean;
  sandbox: boolean;
  configured: boolean;
  merchantIdMask: string;
  storeIdMask: string;
};

export default function PaymentsCard() {
  const [settings, setSettings] = useState<PaymentSettings | null>(null);
  const [provider, setProvider] = useState("jazzcash");
  const [enabled, setEnabled] = useState(false);
  const [sandbox, setSandbox] = useState(true);
  const [merchantId, setMerchantId] = useState("");
  const [password, setPassword] = useState("");
  const [salt, setSalt] = useState("");
  const [storeId, setStoreId] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/omniflow/portal/payments/settings", {
      cache: "no-store",
    })
      .then((response) => response.json().catch(() => null))
      .then((payload) => {
        if (!active || payload === null || payload.settings === undefined) {
          return;
        }
        const data = payload.settings as PaymentSettings;
        setSettings(data);
        setProvider(data.provider || "jazzcash");
        setEnabled(data.enabled);
        setSandbox(data.sandbox);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  async function save() {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch(
        "/api/omniflow/portal/payments/settings",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider,
            enabled,
            sandbox,
            merchant_id: merchantId,
            password,
            salt,
            store_id: storeId,
          }),
        }
      );
      const payload = await response.json().catch(() => null);
      if (payload && payload.error) {
        setNote(payload.error.message || "Could not save.");
        return;
      }
      if (!response.ok) {
        setNote("Could not save - try again.");
        return;
      }
      setMerchantId("");
      setPassword("");
      setSalt("");
      setStoreId("");
      setNote("Saved.");
      const fresh = await fetch("/api/omniflow/portal/payments/settings", {
        cache: "no-store",
      })
        .then((response) => response.json().catch(() => null))
        .catch(() => null);
      if (fresh && fresh.settings) setSettings(fresh.settings);
    } catch {
      setNote("Could not save - try again.");
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "mt-1 w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-xs text-slate-200 focus:border-white/20 focus:outline-none";

  return (
    <section className="mt-6 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-slate-200">
            Online payments
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            JazzCash / Easypaisa hosted checkout on your order links. The
            customer pays from the link; the payment lands on the order
            automatically.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enabled
        </label>
      </div>

      {settings ? (
        <p className="mt-2 text-[11px] text-slate-500">
          {settings.configured
            ? "Configured" + (settings.sandbox ? " (sandbox)" : "") +
              " - merchant " + settings.merchantIdMask +
              ", store " + settings.storeIdMask
            : "Not configured yet."}
        </p>
      ) : null}

      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-[11px] text-slate-400">Provider</span>
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            className={inputClass}
          >
            <option value="jazzcash">JazzCash</option>
            <option value="easypaisa">Easypaisa</option>
            <option value="stripe">Stripe (platform keys)</option>
          </select>
        </label>
        <label className="flex items-end gap-2 pb-1 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={sandbox}
            onChange={(event) => setSandbox(event.target.checked)}
          />
          Sandbox (test mode)
        </label>
        {provider === "stripe" ? (
          <p className="col-span-2 rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2 text-[11px] text-slate-400">
            Stripe runs on the platform keys saved in the admin panel
            (Admin &gt; Integrations &gt; Payments). No per-workspace keys
            needed — just enable it here.
          </p>
        ) : null}
        {provider === "jazzcash" ? (
          <>
            <label className="block">
              <span className="text-[11px] text-slate-400">Merchant ID</span>
              <input
                type="text"
                value={merchantId}
                onChange={(event) => setMerchantId(event.target.value)}
                placeholder={settings?.merchantIdMask || "MC-12345"}
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-slate-400">
                Integration password
              </span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className={inputClass}
              />
            </label>
            <label className="block col-span-2">
              <span className="text-[11px] text-slate-400">
                Integrity salt
              </span>
              <input
                type="password"
                value={salt}
                onChange={(event) => setSalt(event.target.value)}
                className={inputClass}
              />
            </label>
          </>
        ) : (
          <label className="block col-span-2">
            <span className="text-[11px] text-slate-400">Store ID</span>
            <input
              type="text"
              value={storeId}
              onChange={(event) => setStoreId(event.target.value)}
              placeholder={settings?.storeIdMask || "STORE-1"}
              className={inputClass}
            />
          </label>
        )}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-lg border border-cyan-400/30 bg-cyan-400/[0.08] px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-400/[0.15] disabled:opacity-50"
        >
          {busy ? "Saving..." : "Save payment settings"}
        </button>
        {note ? (
          <span className="text-[11px] text-slate-400">{note}</span>
        ) : null}
      </div>
    </section>
  );
}
`);
writeNewRepair("app/admin/(panel)/integrations/IntegrationsClient.tsx", "zoom_account_id", false,
    `"use client";

import { useCallback, useEffect, useState } from "react";

type GroupKey =
  | "email"
  | "llm"
  | "flags"
  | "voice"
  | "video"
  | "payments"
  | "whatsapp_e2e";

type Field = {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  hint?: string;
};

type GroupDef = {
  id: GroupKey;
  title: string;
  description: string;
  fields?: Field[];
  toggles?: { key: string; label: string; hint: string }[];
  note?: string;
  actions?: ("test" | "weekly")[];
};

const GROUPS: GroupDef[] = [
  {
    id: "email",
    title: "Email (SMTP / Brevo)",
    description:
      "Password-reset codes and the weekly report are parked on these keys.",
    fields: [
      {
        key: "provider",
        label: "Provider",
        placeholder: "smtp",
        hint: "smtp or brevo",
      },
      { key: "smtp_host", label: "SMTP host", placeholder: "smtp-relay.brevo.com" },
      { key: "smtp_port", label: "SMTP port", placeholder: "587" },
      { key: "smtp_user", label: "SMTP user" },
      { key: "smtp_password", label: "SMTP password", secret: true },
      {
        key: "smtp_from",
        label: "From address",
        placeholder: "OmniFlow <no-reply@yourdomain.com>",
      },
      { key: "brevo_api_key", label: "Brevo API key", secret: true },
      {
        key: "reports_to",
        label: "Reports to",
        placeholder: "owner@yourdomain.com",
        hint: "Where the weekly report lands",
      },
    ],
    actions: ["test", "weekly"],
  },
  {
    id: "llm",
    title: "AI engine",
    description:
      "Any OpenAI-compatible endpoint. Powers drafts, intents and the AI switches below.",
    fields: [
      { key: "base_url", label: "Base URL", placeholder: "https://api.openai.com/v1" },
      { key: "api_key", label: "API key", secret: true },
      { key: "model", label: "Model", placeholder: "gpt-4o-mini" },
    ],
  },
  {
    id: "flags",
    title: "AI switches",
    description:
      "Your earlier decision locked these OFF — flip them once the AI key above is saved.",
    toggles: [
      {
        key: "true_sentiment",
        label: "True sentiment (LLM)",
        hint: "The sentiment endpoint classifies with the AI engine instead of the word list.",
      },
      {
        key: "kb_autodraft",
        label: "KB auto-draft",
        hint: "Answer drafts also ship a saveable knowledge-base entry.",
      },
      {
        key: "phone_verification",
        label: "Phone verification (Ph9)",
        hint: "The switch the phone-verification feature will read when it ships.",
      },
    ],
  },
  {
    id: "voice",
    title: "Voice channel",
    description: "Twilio credentials for the voice channel (keys ready before launch).",
    fields: [
      { key: "provider", label: "Provider", placeholder: "twilio" },
      { key: "account_sid", label: "Account SID" },
      { key: "auth_token", label: "Auth token", secret: true },
      { key: "from_number", label: "From number", placeholder: "+92300..." },
    ],
    note:
      "The conversation Call button dials through Twilio with these keys.",
  },
  {
    id: "video",
    title: "Video channel",
    description: "Meeting-link provider for the video channel.",
    fields: [
      { key: "provider", label: "Provider", placeholder: "whereby / daily / zoom" },
      { key: "api_key", label: "Whereby / Daily API key", secret: true },
      { key: "zoom_account_id", label: "Zoom account id" },
      { key: "zoom_client_id", label: "Zoom client id" },
      { key: "zoom_client_secret", label: "Zoom client secret", secret: true },
    ],
    note:
      "Whereby/Daily need the API key; Zoom needs the three OAuth fields. The conversation Video invite button uses these.",
  },
  {
    id: "payments",
    title: "Payments channel",
    description:
      "Platform payment-processor keys. (Per-workspace JazzCash/Easypaisa live in the portal settings.)",
    fields: [
      { key: "provider", label: "Provider", placeholder: "stripe" },
      { key: "publishable_key", label: "Publishable key" },
      { key: "secret_key", label: "Secret key", secret: true },
      { key: "webhook_secret", label: "Webhook secret", secret: true },
    ],
    note:
      "Stripe Checkout runs on the secret key here — a workspace that picks Stripe (platform keys) uses it directly.",
  },
  {
    id: "whatsapp_e2e",
    title: "WhatsApp E2E test",
    description:
      "The live number the laptop end-to-end run should message. Save it here so the runbook picks it up.",
    fields: [
      { key: "live_number", label: "Live test number", placeholder: "+92300..." },
    ],
  },
];

type Values = Record<string, Record<string, string>>;
type Configured = Record<string, boolean>;

function fieldInputType(field: Field, value: string): string {
  if (field.secret && !value.startsWith("\\u2022")) return "password";
  return "text";
}

export default function IntegrationsClient() {
  const [values, setValues] = useState<Values>({});
  const [configured, setConfigured] = useState<Configured>({});
  const [loading, setLoading] = useState(true);
  const [busyGroup, setBusyGroup] = useState<string>("");
  const [notice, setNotice] = useState<{ group: string; text: string; ok: boolean } | null>(
    null
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/omniflow/admin/providers", {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload && payload.groups) {
        const next: Values = {};
        const nextConfigured: Configured = {};
        for (const def of GROUPS) {
          const group = payload.groups[def.id] || {};
          const row: Record<string, string> = {};
          for (const field of def.fields || []) {
            row[field.key] = String(group[field.key] ?? "");
          }
          next[def.id] = row;
          nextConfigured[def.id] = Boolean(group.configured);
        }
        setValues(next);
        setConfigured(nextConfigured);
      }
    } catch {
      // keep whatever is on screen
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function update(group: GroupKey, key: string, value: string) {
    setValues((prev) => ({
      ...prev,
      [group]: { ...(prev[group] || {}), [key]: value },
    }));
  }

  async function save(def: GroupDef) {
    setBusyGroup(def.id);
    setNotice(null);
    try {
      const response = await fetch("/api/omniflow/admin/providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group: def.id, values: values[def.id] || {} }),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload && payload.ok) {
        const kept = Array.isArray(payload.kept_blank) ? payload.kept_blank : [];
        setNotice({
          group: def.id,
          ok: true,
          text:
            "Saved." +
            (kept.length ? " Left " + kept.join(", ") + " unchanged (blank)." : ""),
        });
        await load();
      } else {
        setNotice({
          group: def.id,
          ok: false,
          text: payload && payload.error ? payload.error.message : "Could not save — try again.",
        });
      }
    } catch {
      setNotice({ group: def.id, ok: false, text: "Could not save — try again." });
    } finally {
      setBusyGroup("");
    }
  }

  async function action(def: GroupDef, kind: "test" | "weekly") {
    setBusyGroup(def.id + ":" + kind);
    setNotice(null);
    try {
      const to = (values[def.id] || {}).reports_to || "";
      const response = await fetch(
        kind === "test"
          ? "/api/omniflow/admin/providers/email-test"
          : "/api/omniflow/admin/providers/weekly-report",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to }),
        }
      );
      const payload = await response.json().catch(() => null);
      if (response.ok && payload && payload.ok) {
        setNotice({
          group: def.id,
          ok: true,
          text:
            kind === "test"
              ? "Test email sent — check the inbox."
              : "Weekly report sent" +
                (payload.clients ? " for " + payload.clients + " workspace(s)." : "."),
        });
      } else {
        setNotice({
          group: def.id,
          ok: false,
          text: payload && payload.error ? payload.error.message : "Could not send — try again.",
        });
      }
    } catch {
      setNotice({ group: def.id, ok: false, text: "Could not send — try again." });
    } finally {
      setBusyGroup("");
    }
  }

  return (
    <div className="space-y-6">
      {loading ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6 text-sm text-slate-400">
          Loading integration settings…
        </div>
      ) : null}
      {GROUPS.map((def) => {
        const groupValues = values[def.id] || {};
        const isOn = configured[def.id];
        return (
          <div
            key={def.id}
            className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6"
          >
            <div className="mb-1 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-white">{def.title}</h2>
              <span
                className={
                  "rounded-md border px-2 py-0.5 text-[10px] " +
                  (isOn
                    ? "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300"
                    : "border-white/[0.08] bg-white/[0.02] text-slate-400")
                }
              >
                {isOn ? "Saved" : "Not set"}
              </span>
            </div>
            <p className="mb-5 text-xs text-slate-500">{def.description}</p>

            {(def.fields || []).length > 0 ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {(def.fields || []).map((field) => (
                  <label key={field.key} className="block">
                    <span className="mb-1 block text-[11px] font-medium text-slate-300">
                      {field.label}
                    </span>
                    <input
                      type={fieldInputType(field, groupValues[field.key] || "")}
                      value={groupValues[field.key] || ""}
                      onChange={(event) =>
                        update(def.id, field.key, event.target.value)
                      }
                      placeholder={field.placeholder}
                      autoComplete="off"
                      className="w-full rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-cyan-400/40 focus:outline-none"
                    />
                    {field.hint ? (
                      <span className="mt-1 block text-[10px] text-slate-500">
                        {field.hint}
                      </span>
                    ) : null}
                  </label>
                ))}
              </div>
            ) : null}

            {def.toggles ? (
              <div className="space-y-3">
                {def.toggles.map((toggle) => (
                  <label
                    key={toggle.key}
                    className="flex items-start gap-3 rounded-xl border border-white/[0.05] bg-white/[0.015] px-4 py-3"
                  >
                    <input
                      type="checkbox"
                      checked={(groupValues[toggle.key] || "") === "on"}
                      onChange={(event) =>
                        update(
                          def.id,
                          toggle.key,
                          event.target.checked ? "on" : "off"
                        )
                      }
                      className="mt-0.5 h-4 w-4 accent-cyan-400"
                    />
                    <span>
                      <span className="block text-sm text-slate-200">
                        {toggle.label}
                      </span>
                      <span className="block text-[11px] text-slate-500">
                        {toggle.hint}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            ) : null}

            {def.note ? (
              <p className="mt-4 text-[11px] text-slate-500">{def.note}</p>
            ) : null}

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <button
                onClick={() => void save(def)}
                disabled={busyGroup === def.id}
                className="rounded-xl border border-cyan-400/30 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors hover:bg-cyan-400/[0.14] disabled:opacity-50"
              >
                {busyGroup === def.id ? "Saving…" : "Save"}
              </button>
              {def.actions?.includes("test") ? (
                <button
                  onClick={() => void action(def, "test")}
                  disabled={busyGroup === def.id + ":test"}
                  className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-xs text-slate-300 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
                >
                  {busyGroup === def.id + ":test" ? "Sending…" : "Send test email"}
                </button>
              ) : null}
              {def.actions?.includes("weekly") ? (
                <button
                  onClick={() => void action(def, "weekly")}
                  disabled={busyGroup === def.id + ":weekly"}
                  className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-xs text-slate-300 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
                >
                  {busyGroup === def.id + ":weekly"
                    ? "Sending…"
                    : "Send weekly report now"}
                </button>
              ) : null}
              {notice && notice.group === def.id ? (
                <span
                  className={
                    "text-[11px] " + (notice.ok ? "text-emerald-300" : "text-rose-300")
                  }
                >
                  {notice.text}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
`);

console.log("");
console.log("applied: " + applied + "  already: " + already + "  warnings: " + warnings);
if (warnings > 0) process.exit(1);