"""Social channels (§255): TikTok, X, LinkedIn, YouTube and a personal
Telegram account in the same inbox, AI, approvals and audit.

Every channel is hybrid where the platform allows it:

* API mode - the merchant's OWN developer app (app id + secret, sealed in
  the vault) and a one-click OAuth connect. The Control Plane talks to the
  official API itself: webhooks (X, TikTok) or a throttled poll (comments)
  bring messages in, and replies / posts queued in the shared command queue
  are sent through ``portal_cp_outbox`` (same ack / retry / refuse rules as
  email and SMS).
* Login mode - the account's own session on the merchant's laptop
  (``connector-node/social_login_bridge.py``). The bridge polls the shared
  command queue for its channel; every command is checked here first
  (``filter_bridge_commands``) so the same policy applies in both modes.
  Unofficial: the platforms may limit or ban accounts that automate a
  personal login - the settings card says so.

Nothing new answers customers: inbound messages go through the one ingest
core (``connector_api.ingest_messages_for_tenant``), so the brain, away
replies, workflows, opt-outs and audit work unchanged. Public comment
replies follow §228 (manual / approval, AI only when the workspace turned on
comment auto-reply). Publishing a post is HIGH risk: owners and admins
publish directly, everything else (agents, AI drafts) goes through an
approval (kind ``social_post``).

Contact ids: ``tt:`` TikTok DM conversation, ``x:`` X user (DM), ``li:``
LinkedIn conversation (login), ``tgu:`` Telegram user (login); comments
``ttc:`` / ``xc:`` / ``lic:`` / ``ytc:`` + the author id.
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_cp_outbox
import portal_db
import portal_txn
import portal_vault
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)

logger = logging.getLogger("omniflow.social")

bp = Blueprint("portal_social", __name__, url_prefix="/api/v1/portal")
public_bp = Blueprint("portal_social_public", __name__, url_prefix="/api/v1/public")
connector_bp = Blueprint("portal_social_connector", __name__,
                         url_prefix="/api/v1/connector/social")


def _env_int(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(str(os.environ.get(name, "")).strip() or default)
    except ValueError:
        value = default
    return max(low, min(high, value))


ENABLED = os.environ.get("OF_SOCIAL_CHANNELS", "1").strip() != "0"
TABLE = os.environ.get("OF_SOCIAL_TABLE", "portal_social_accounts")
OAUTH_TABLE = os.environ.get("OF_SOCIAL_OAUTH_TABLE", "portal_social_oauth")
COMMENTS_TABLE = os.environ.get("OF_SOCIAL_COMMENTS_TABLE", "portal_social_comments")
POSTS_TABLE = os.environ.get("OF_SOCIAL_POSTS_TABLE", "portal_social_posts")
POLL_SECONDS = _env_int("OF_SOCIAL_POLL_SECONDS", 120, 30, 3600)
MAX_SEND_PER_RUN = _env_int("OF_SOCIAL_MAX_SEND", 10, 1, 50)
DISPATCH_LIMIT = 3
TIMEOUT = _env_int("OF_SOCIAL_TIMEOUT_SECONDS", 10, 3, 30)
OAUTH_TTL_MINUTES = 10
BRIDGE_FRESH_SECONDS = _env_int("OF_SOCIAL_BRIDGE_FRESH_SECONDS", 300, 60, 3600)
TIKTOK_SIG_TOLERANCE = _env_int("OF_TIKTOK_SIG_TOLERANCE", 300, 30, 3600)
RECENT_VIDEOS = _env_int("OF_SOCIAL_RECENT_POSTS", 3, 1, 10)
MAX_WEBHOOK_BYTES = 1_000_000
LOCK_CLASS = 24402
RECENT_POSTS = 10
CALLBACK_SUFFIX = "/channels/social/callback"

TIKTOK_API = os.environ.get("OF_TIKTOK_API_BASE",
                            "https://business-api.tiktok.com/open_api/v1.3").rstrip("/")
X_API = os.environ.get("OF_X_API_BASE", "https://api.x.com").rstrip("/")
LINKEDIN_API = os.environ.get("OF_LINKEDIN_API_BASE", "https://api.linkedin.com").rstrip("/")
YOUTUBE_API = os.environ.get("OF_YOUTUBE_API_BASE",
                             "https://www.googleapis.com/youtube/v3").rstrip("/")


def _linkedin_version() -> str:
    """LinkedIn wants a dated API version (each is supported ~1 year):
    OF_LINKEDIN_VERSION, else last month's."""
    value = os.environ.get("OF_LINKEDIN_VERSION", "").strip()
    if re.fullmatch(r"\d{6}", value):
        return value
    first = datetime.now(timezone.utc).replace(day=1) - timedelta(days=1)
    return first.strftime("%Y%m")


SCOPES = {
    "tiktok": os.environ.get("OF_TIKTOK_SCOPES", "user.info.basic,user.info.username,"
                             "message.list.read,message.list.send,message.list.manage,"
                             "video.list,comment.list,comment.list.manage,video.publish"),
    "x": os.environ.get("OF_X_SCOPES", "tweet.read tweet.write users.read dm.read"
                        " dm.write offline.access"),
    "linkedin": os.environ.get("OF_LINKEDIN_SCOPES", "openid profile w_member_social"),
    "linkedin_org": os.environ.get("OF_LINKEDIN_ORG_SCOPES", "openid profile w_member_social"
                                   " r_organization_social w_organization_social"),
    "youtube": os.environ.get("OF_YOUTUBE_SCOPES",
                              "https://www.googleapis.com/auth/youtube.force-ssl"),
}

#: what each channel can do in each mode (anything else is refused)
SPECS: Dict[str, Dict[str, Any]] = {
    "tiktok": {"label": "TikTok", "dm": "tt:", "comment": "ttc:",
               "api": ("dm", "comments", "publish"), "login": (),
               "comment_max": 150, "dm_max": 6000, "post_max": 2200},
    "x": {"label": "X", "dm": "x:", "comment": "xc:",
          "api": ("dm", "comments", "publish"), "login": ("dm", "comments", "publish"),
          "comment_max": 280, "dm_max": 10000, "post_max": 280},
    "linkedin": {"label": "LinkedIn", "dm": "li:", "comment": "lic:",
                 "api": ("comments", "publish"), "login": ("dm",),
                 "comment_max": 1250, "dm_max": 8000, "post_max": 3000},
    "youtube": {"label": "YouTube", "dm": "", "comment": "ytc:",
                "api": ("comments",), "login": (),
                "comment_max": 10000, "dm_max": 0, "post_max": 0},
    "telegram_user": {"label": "Telegram (personal)", "dm": "tgu:", "comment": "",
                      "api": (), "login": ("dm",),
                      "comment_max": 0, "dm_max": 4096, "post_max": 0},
}
CHANNELS = tuple(SPECS)
FEATURES = ("dm", "comments", "publish")
DM_PREFIXES = tuple(s["dm"] for s in SPECS.values() if s["dm"])
COMMENT_PREFIXES = tuple(s["comment"] for s in SPECS.values() if s["comment"])
PREFIXES = DM_PREFIXES + COMMENT_PREFIXES
COMMENT_SOURCES = ("manual", "approval")

#: honest platform limits, shown on the settings card
# Honest platform limits shown on the card: (mode, line); mode "" = both modes.
LIMITS = {
    "tiktok": [
        ("", "Business accounts only, and your TikTok app needs Business Messaging and"
             " comment access approved."),
        ("", "TikTok messaging is not available in the EEA, Switzerland or the UK."),
        ("", "Replies only within 48 hours of the customer's last message, at most 10 in"
             " a row."),
        ("", "Publishing needs a public video URL; TikTok processes it before it appears."),
    ],
    "x": [
        ("api", "The X API is paid per use (each message read or sent and each post costs"
                " credits on your developer account)."),
        ("api", "Direct messages and mentions arrive through a webhook: the Control Plane"
                " needs a public HTTPS address (no port number)."),
        ("login", "Login mode is unofficial and can get the account limited or suspended."),
        ("login", "The laptop bridge checks messages and mentions about once a minute while"
                  " it runs."),
        ("", "Posts are text only (280 characters)."),
    ],
    "linkedin": [
        ("api", "The API cannot read or send LinkedIn messages - use login mode for direct"
                " messages."),
        ("api", "Comment replies need a Company Page (organization id) and Community"
                " Management API access on your LinkedIn app."),
        ("api", "Posts are text only (3000 characters)."),
        ("login", "Login mode handles personal messages only; it is unofficial and may break"
                  " or get the account restricted."),
        ("login", "Comment replies and posts need API mode."),
    ],
    "youtube": [
        ("", "YouTube has no direct messages - only comments on your videos."),
        ("", "Replies cost API quota (50 units each, 10,000 units a day by default)."),
        ("", "Only top-level comments are imported."),
    ],
    "telegram_user": [
        ("", "Uses your personal Telegram account through the laptop bridge (api id and"
             " hash from my.telegram.org). Unofficial use can get the account limited."),
        ("", "Private chats only - groups and channels are ignored."),
        ("", "The Telegram bot (Settings > Telegram) keeps working separately."),
    ],
}


def limits_for(channel: str, mode: str) -> List[str]:
    return [line for when, line in LIMITS[channel] if when in ("", mode)]


VAULT_FIELDS = ("app_secret", "consumer_secret", "bearer_token", "access_token",
                "refresh_token")
_COLUMNS = ("client_id, channel, mode, enabled, app_id, app_secret, consumer_secret,"
            " bearer_token, access_token, refresh_token, token_expires_at, account_id,"
            " account_name, flags, config, cursor, hook_key, webhook_id, last_check_at,"
            " last_in_at, last_sent_at, last_error, bridge_seen_at, bridge_state")
_DDL_READY = False
_LOCK = threading.Lock()
_RUNNING: set = set()
_LAST: Dict[int, float] = {}


class SocialApiError(RuntimeError):
    """A provider call failed. ``kind``: auth (reconnect / refresh), retry
    (temporary) or final (this request can never work). The message never
    contains credentials."""

    def __init__(self, status: int, message: str, kind: str = "final"):
        super().__init__(message)
        self.status = int(status or 0)
        self.message = str(message or "request failed")[:300]
        self.kind = kind


# ---------------------------------------------------------------------------
# storage
# ---------------------------------------------------------------------------

def _ensure_ddl(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(
        "CREATE TABLE IF NOT EXISTS " + portal_db._q(TABLE) +
        " (client_id BIGINT NOT NULL, channel TEXT NOT NULL,"
        " mode TEXT NOT NULL DEFAULT 'api', enabled BOOLEAN NOT NULL DEFAULT FALSE,"
        " app_id TEXT NOT NULL DEFAULT '', app_secret TEXT NOT NULL DEFAULT '',"
        " consumer_secret TEXT NOT NULL DEFAULT '', bearer_token TEXT NOT NULL DEFAULT '',"
        " access_token TEXT NOT NULL DEFAULT '', refresh_token TEXT NOT NULL DEFAULT '',"
        " token_expires_at TIMESTAMPTZ, account_id TEXT NOT NULL DEFAULT '',"
        " account_name TEXT NOT NULL DEFAULT '',"
        " flags JSONB NOT NULL DEFAULT '{}'::jsonb, config JSONB NOT NULL DEFAULT '{}'::jsonb,"
        " cursor JSONB NOT NULL DEFAULT '{}'::jsonb, hook_key TEXT NOT NULL,"
        " webhook_id TEXT NOT NULL DEFAULT '', last_check_at TIMESTAMPTZ,"
        " last_in_at TIMESTAMPTZ, last_sent_at TIMESTAMPTZ, last_error TEXT NOT NULL DEFAULT '',"
        " bridge_seen_at TIMESTAMPTZ, bridge_state TEXT NOT NULL DEFAULT '',"
        " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (client_id, channel))")
    cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_social_hook_key ON "
                + portal_db._q(TABLE) + " (hook_key)")
    cur.execute(
        "CREATE TABLE IF NOT EXISTS " + portal_db._q(OAUTH_TABLE) +
        " (state TEXT PRIMARY KEY, client_id BIGINT NOT NULL, channel TEXT NOT NULL,"
        " verifier TEXT NOT NULL DEFAULT '', redirect_uri TEXT NOT NULL,"
        " expires_at TIMESTAMPTZ NOT NULL)")
    cur.execute(
        "CREATE TABLE IF NOT EXISTS " + portal_db._q(COMMENTS_TABLE) +
        " (id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL, channel TEXT NOT NULL,"
        " contact_id TEXT NOT NULL, comment_id TEXT NOT NULL,"
        " post_id TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',"
        " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
        " UNIQUE (client_id, channel, comment_id))")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_social_comments_contact ON "
                + portal_db._q(COMMENTS_TABLE) + " (client_id, contact_id, id DESC)")
    cur.execute(
        "CREATE TABLE IF NOT EXISTS " + portal_db._q(POSTS_TABLE) +
        " (id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL, channel TEXT NOT NULL,"
        " body TEXT NOT NULL, media_url TEXT NOT NULL DEFAULT '',"
        " status TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual',"
        " requested_by BIGINT, approval_id BIGINT, command_id BIGINT,"
        " provider_post_id TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',"
        " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
        " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_social_posts_client ON "
                + portal_db._q(POSTS_TABLE) + " (client_id, id DESC)")
    _DDL_READY = True


def _json(value: Any) -> Dict[str, Any]:
    if isinstance(value, str):
        try:
            value = json.loads(value or "{}")
        except ValueError:
            value = {}
    return value if isinstance(value, dict) else {}


def _row(raw: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if raw is None:
        return None
    row = portal_vault.unseal_fields(raw, VAULT_FIELDS) or {}
    for key in ("flags", "config", "cursor"):
        row[key] = _json(row.get(key))
    return row


def load_account(cur, client_id: int, channel: str) -> Optional[Dict[str, Any]]:
    cur.execute("SELECT " + _COLUMNS + " FROM " + portal_db._q(TABLE) +
                " WHERE client_id = %s AND channel = %s LIMIT 1", (client_id, channel))
    found = portal_db.rows(cur)
    return _row(found[0]) if found else None


def _load_by_hook(cur, channel: str, hook_key: str) -> Optional[Dict[str, Any]]:
    if not hook_key or len(hook_key) > 80:
        return None
    cur.execute("SELECT " + _COLUMNS + " FROM " + portal_db._q(TABLE) +
                " WHERE hook_key = %s AND channel = %s LIMIT 1", (hook_key, channel))
    found = portal_db.rows(cur)
    return _row(found[0]) if found else None


def _blank(client_id: int, channel: str) -> Dict[str, Any]:
    return {"client_id": client_id, "channel": channel, "mode": "api" if SPECS[channel]["api"]
            else "login", "enabled": False, "app_id": "", "app_secret": "",
            "consumer_secret": "", "bearer_token": "", "access_token": "",
            "refresh_token": "", "token_expires_at": None, "account_id": "",
            "account_name": "", "flags": {}, "config": {}, "cursor": {}, "hook_key": "",
            "webhook_id": "", "last_check_at": None, "last_in_at": None,
            "last_sent_at": None, "last_error": "", "bridge_seen_at": None,
            "bridge_state": ""}


_JSON_COLUMNS = ("flags", "config", "cursor")
_TIME_COLUMNS = ("token_expires_at", "last_check_at", "last_in_at", "last_sent_at",
                 "bridge_seen_at")
_SAVE_COLUMNS = ("mode", "enabled", "app_id", "account_id", "account_name", "webhook_id",
                 "last_error", "bridge_state") + VAULT_FIELDS + _JSON_COLUMNS + _TIME_COLUMNS


def save_account(cur, client_id: int, channel: str, changes: Dict[str, Any]) -> None:
    """Upsert the given columns (secrets sealed, JSON columns replaced)."""
    values: Dict[str, Any] = {}
    for key, value in changes.items():
        if key not in _SAVE_COLUMNS:
            raise ValueError("unknown column " + key)
        if key in VAULT_FIELDS:
            value = portal_vault.seal(value or "")
        elif key in _JSON_COLUMNS:
            value = json.dumps(value or {}, default=str)
        values[key] = value
    if "mode" not in values:
        # A new row starts in the channel's own mode (Telegram personal is
        # login only); an existing row keeps its mode (not in the UPDATE).
        values["mode"] = _blank(client_id, channel)["mode"]
        keep_mode = True
    else:
        keep_mode = False
    cols = list(values)
    holders = ["CAST(%s AS JSONB)" if c in _JSON_COLUMNS else "%s" for c in cols]
    sets = ", ".join(c + " = EXCLUDED." + c for c in cols if not (keep_mode and c == "mode"))
    cur.execute(
        "INSERT INTO " + portal_db._q(TABLE) + " (client_id, channel, hook_key"
        + "".join(", " + c for c in cols) + ") VALUES (%s, %s, %s"
        + "".join(", " + h for h in holders) + ") ON CONFLICT (client_id, channel) DO UPDATE"
        " SET " + (sets + ", " if sets else "") + "updated_at = NOW()",
        tuple([client_id, channel, secrets.token_urlsafe(24)] + [values[c] for c in cols]))


def _now(cur) -> datetime:
    cur.execute("SELECT NOW() AS now")
    found = portal_db.rows(cur)
    value = found[0]["now"] if found else datetime.now(timezone.utc)
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _iso(value: Any) -> Optional[str]:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return None


def _mask(secret: Any) -> str:
    text = str(secret or "")
    return ("****" + text[-4:]) if len(text) > 8 else ("****" if text else "")


def has(account: Optional[Dict[str, Any]], feature: str) -> bool:
    """The feature is supported in the account's mode AND switched on."""
    if not account:
        return False
    spec = SPECS[account["channel"]]
    mode = account.get("mode") if account.get("mode") in ("api", "login") else "api"
    return feature in spec[mode] and account["flags"].get(feature) is True


def channel_of_contact(contact_id: Any) -> str:
    """The social channel a contact id belongs to ("" = not social)."""
    value = str(contact_id or "").strip().lower()
    for channel, spec in SPECS.items():
        if (spec["dm"] and value.startswith(spec["dm"])) or (
                spec["comment"] and value.startswith(spec["comment"])):
            return channel
    return ""


def is_comment(contact_id: Any) -> bool:
    return str(contact_id or "").strip().lower().startswith(COMMENT_PREFIXES)


def comment_auto_reply(cur, client_id: int, contact_id: str) -> bool:
    """§228 for the brain: AI may answer a public comment only when the
    workspace switched comments AND comment auto-reply on for the channel."""
    channel = channel_of_contact(contact_id)
    if not channel or not is_comment(contact_id):
        return False
    try:
        with portal_txn.savepoint(cur, None, "of_social_gate"):
            cur.execute("SELECT to_regclass(%s) AS t", (TABLE,))
            found = portal_db.rows(cur)
            account = load_account(cur, client_id, channel) \
                if found and found[0].get("t") else None
    except Exception:
        return False
    return bool(account and account.get("enabled") is True and has(account, "comments")
                and account["flags"].get("comment_auto_reply") is True)


def latest_comment(cur, client_id: int, contact_id: str) -> Optional[Dict[str, Any]]:
    cur.execute("SELECT comment_id, post_id FROM " + portal_db._q(COMMENTS_TABLE) +
                " WHERE client_id = %s AND contact_id = %s ORDER BY id DESC LIMIT 1",
                (client_id, contact_id))
    found = portal_db.rows(cur)
    return found[0] if found else None


def _record_comment(cur, client_id: int, channel: str, contact: str, comment_id: str,
                    post_id: str, body: str) -> bool:
    cur.execute("INSERT INTO " + portal_db._q(COMMENTS_TABLE) +
                " (client_id, channel, contact_id, comment_id, post_id, body)"
                " VALUES (%s, %s, %s, %s, %s, %s)"
                " ON CONFLICT (client_id, channel, comment_id) DO NOTHING",
                (client_id, channel, contact[:120], comment_id[:200], post_id[:200],
                 body[:2000]))
    return (getattr(cur, "rowcount", 0) or 0) > 0


# ---------------------------------------------------------------------------
# HTTP (module-level so tests stub it)
# ---------------------------------------------------------------------------

def _transport(method: str, url: str, headers: Dict[str, str], body: Optional[bytes]):
    """One HTTP call -> (status, response headers, parsed JSON or {})."""
    req = urllib.request.Request(url, data=body, method=method.upper(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read(2_000_000)
            status, got = resp.status, dict(resp.headers.items())
    except urllib.error.HTTPError as error:
        raw = error.read(200_000) if error.fp else b""
        status, got = error.code, dict(error.headers.items()) if error.headers else {}
    try:
        data = json.loads(raw.decode("utf8") or "{}") if raw else {}
    except ValueError:
        data = {}
    return status, {k.lower(): v for k, v in got.items()}, data


def _call(method: str, url: str, token: str = "", json_body: Any = None,
          form: Optional[Dict[str, str]] = None, basic: Optional[Tuple[str, str]] = None,
          extra: Optional[Dict[str, str]] = None, token_header: str = "") -> Tuple[Dict[str, Any], Dict[str, str]]:
    headers = {"Accept": "application/json", "User-Agent": "OmniFlow-Social/1"}
    body = None
    if json_body is not None:
        body = json.dumps(json_body).encode("utf8")
        headers["Content-Type"] = "application/json"
    elif form is not None:
        body = urllib.parse.urlencode(form).encode("utf8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    if basic:
        headers["Authorization"] = "Basic " + base64.b64encode(
            (basic[0] + ":" + basic[1]).encode("utf8")).decode("ascii")
    elif token and token_header:
        headers[token_header] = token
    elif token:
        headers["Authorization"] = "Bearer " + token
    headers.update(extra or {})
    try:
        status, got, data = _transport(method, url, headers, body)
    except Exception as error:  # network / DNS / timeout
        raise SocialApiError(0, "Could not reach the platform (" + type(error).__name__ + ").",
                             "retry")
    if 200 <= status < 300:
        return (data if isinstance(data, dict) else {"data": data}), got
    raise SocialApiError(status, _provider_message(data, status), _classify_status(status))


def _classify_status(status: int) -> str:
    if status == 401:
        return "auth"
    if status == 429 or status >= 500 or status == 0:
        return "retry"
    return "final"


def _provider_message(data: Any, status: int) -> str:
    if isinstance(data, dict):
        for key in ("error_description", "detail", "message", "title"):
            if isinstance(data.get(key), str) and data[key].strip():
                return data[key].strip()[:300]
        error = data.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            return error["message"][:300]
        if isinstance(error, str):
            return error[:300]
        errors = data.get("errors")
        if isinstance(errors, list) and errors and isinstance(errors[0], dict):
            return str(errors[0].get("message") or errors[0].get("detail") or "")[:300] \
                or "HTTP " + str(status)
    return "HTTP " + str(status)


def _tiktok(method: str, path: str, token: str, params: Optional[Dict[str, Any]] = None,
            body: Any = None) -> Dict[str, Any]:
    url = TIKTOK_API + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data, _ = _call(method, url, token, json_body=body, token_header="Access-Token")
    code = data.get("code", 0)
    if code not in (0, "0", None):
        message = str(data.get("message") or "TikTok error " + str(code))[:300]
        lowered = message.lower()
        if "token" in lowered or "access" in lowered or "auth" in lowered:
            kind = "auth"
        elif str(code) == "40064" or (str(code).isdigit() and int(code) >= 50000):
            kind = "retry"
        else:
            kind = "final"
        raise SocialApiError(200, "TikTok: " + message, kind)
    return data.get("data") if isinstance(data.get("data"), dict) else {}


def _linkedin_headers() -> Dict[str, str]:
    return {"Linkedin-Version": _linkedin_version(), "X-Restli-Protocol-Version": "2.0.0"}


# ---------------------------------------------------------------------------
# OAuth
# ---------------------------------------------------------------------------

def _pkce() -> Tuple[str, str]:
    verifier = secrets.token_urlsafe(48)[:96]
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode("ascii")).digest()).decode("ascii").rstrip("=")
    return verifier, challenge


def authorize_url(account: Dict[str, Any], redirect_uri: str, state: str,
                  challenge: str) -> str:
    channel = account["channel"]
    app_id = account["app_id"]
    if channel == "tiktok":
        return "https://www.tiktok.com/v2/auth/authorize/?" + urllib.parse.urlencode({
            "client_key": app_id, "response_type": "code", "scope": SCOPES["tiktok"],
            "redirect_uri": redirect_uri, "state": state})
    if channel == "x":
        return "https://x.com/i/oauth2/authorize?" + urllib.parse.urlencode({
            "response_type": "code", "client_id": app_id, "redirect_uri": redirect_uri,
            "scope": SCOPES["x"], "state": state, "code_challenge": challenge,
            "code_challenge_method": "S256"})
    if channel == "linkedin":
        scope = SCOPES["linkedin_org"] if account["config"].get("organization_id") \
            else SCOPES["linkedin"]
        return "https://www.linkedin.com/oauth/v2/authorization?" + urllib.parse.urlencode({
            "response_type": "code", "client_id": app_id, "redirect_uri": redirect_uri,
            "state": state, "scope": scope})
    return "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": app_id, "redirect_uri": redirect_uri, "response_type": "code",
        "scope": SCOPES["youtube"], "access_type": "offline", "prompt": "consent",
        "state": state, "code_challenge": challenge, "code_challenge_method": "S256"})


def _token_from(data: Dict[str, Any]) -> Dict[str, Any]:
    access = str(data.get("access_token") or "")
    if not access:
        raise SocialApiError(400, "The platform did not return an access token.", "final")
    out: Dict[str, Any] = {"access_token": access}
    if data.get("refresh_token"):
        out["refresh_token"] = str(data["refresh_token"])
    try:
        seconds = int(data.get("expires_in") or 0)
    except (TypeError, ValueError):
        seconds = 0
    out["token_expires_at"] = (datetime.now(timezone.utc) + timedelta(seconds=seconds)
                               if seconds > 0 else None)
    if data.get("open_id"):
        out["account_id"] = str(data["open_id"])
    return out


def exchange_code(account: Dict[str, Any], code: str, redirect_uri: str,
                  verifier: str) -> Dict[str, Any]:
    channel, app_id, secret = account["channel"], account["app_id"], account["app_secret"]
    if channel == "tiktok":
        data = _tiktok("POST", "/tt_user/oauth2/token/", "", body={
            "client_id": app_id, "client_secret": secret, "grant_type": "authorization_code",
            "auth_code": code, "redirect_uri": redirect_uri})
        return _token_from(data)
    if channel == "x":
        data, _ = _call("POST", X_API + "/2/oauth2/token", basic=(app_id, secret), form={
            "grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri,
            "code_verifier": verifier, "client_id": app_id})
        return _token_from(data)
    if channel == "linkedin":
        data, _ = _call("POST", "https://www.linkedin.com/oauth/v2/accessToken", form={
            "grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri,
            "client_id": app_id, "client_secret": secret})
        return _token_from(data)
    data, _ = _call("POST", "https://oauth2.googleapis.com/token", form={
        "grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri,
        "client_id": app_id, "client_secret": secret, "code_verifier": verifier})
    return _token_from(data)


def refresh_token(account: Dict[str, Any]) -> Dict[str, Any]:
    channel, app_id, secret = account["channel"], account["app_id"], account["app_secret"]
    token = account.get("refresh_token") or ""
    if not token:
        raise SocialApiError(401, "The connection expired - connect the account again.", "auth")
    try:
        if channel == "tiktok":
            return _token_from(_tiktok("POST", "/tt_user/oauth2/refresh_token/", "", body={
                "client_id": app_id, "client_secret": secret,
                "grant_type": "refresh_token", "refresh_token": token}))
        if channel == "x":
            data, _ = _call("POST", X_API + "/2/oauth2/token", basic=(app_id, secret), form={
                "grant_type": "refresh_token", "refresh_token": token, "client_id": app_id})
        elif channel == "linkedin":
            data, _ = _call("POST", "https://www.linkedin.com/oauth/v2/accessToken", form={
                "grant_type": "refresh_token", "refresh_token": token,
                "client_id": app_id, "client_secret": secret})
        else:
            data, _ = _call("POST", "https://oauth2.googleapis.com/token", form={
                "grant_type": "refresh_token", "refresh_token": token,
                "client_id": app_id, "client_secret": secret})
    except SocialApiError as error:
        if error.kind == "retry":
            raise
        raise SocialApiError(401, "The connection expired - connect the account again.", "auth")
    return _token_from(data)


def whoami(account: Dict[str, Any]) -> Dict[str, str]:
    """(account id, display name) of the connected account."""
    channel, token = account["channel"], account["access_token"]
    if channel == "tiktok":
        data = _tiktok("GET", "/business/get/", token, params={
            "business_id": account["account_id"],
            "fields": json.dumps(["username", "display_name"])})
        return {"account_id": account["account_id"],
                "account_name": str(data.get("display_name") or data.get("username") or "")}
    if channel == "x":
        data, _ = _call("GET", X_API + "/2/users/me", token)
        user = data.get("data") or {}
        return {"account_id": str(user.get("id") or ""),
                "account_name": "@" + str(user.get("username") or "")}
    if channel == "linkedin":
        data, _ = _call("GET", LINKEDIN_API + "/v2/userinfo", token)
        return {"account_id": str(data.get("sub") or ""),
                "account_name": str(data.get("name") or "")}
    data, _ = _call("GET", YOUTUBE_API + "/channels?part=id,snippet&mine=true", token)
    items = data.get("items") or []
    if not items:
        raise SocialApiError(404, "This Google account has no YouTube channel.", "final")
    return {"account_id": str(items[0].get("id") or ""),
            "account_name": str((items[0].get("snippet") or {}).get("title") or "")}


def _fresh_token(cur, account: Dict[str, Any], force: bool = False) -> None:
    """Refresh the access token when it expires within 5 minutes (or now)."""
    expires = account.get("token_expires_at")
    soon = isinstance(expires, datetime) and expires - timedelta(minutes=5) <= _now(cur)
    if not (force or soon):
        return
    fresh = refresh_token(account)
    account.update(fresh)
    save_account(cur, account["client_id"], account["channel"], fresh)


# ---------------------------------------------------------------------------
# provider actions
# ---------------------------------------------------------------------------

def _org_urn(account: Dict[str, Any]) -> str:
    org = str(account["config"].get("organization_id") or "")
    return "urn:li:organization:" + org if org else ""


def send_dm(account: Dict[str, Any], contact: str, text: str) -> str:
    channel, token = account["channel"], account["access_token"]
    target = contact.split(":", 1)[1]
    if channel == "tiktok":
        data = _tiktok("POST", "/business/message/send/", token, body={
            "business_id": account["account_id"], "recipient_type": "CONVERSATION",
            "recipient": target, "message_type": "TEXT", "text": {"body": text}})
        return str(data.get("message_id") or "")
    if channel == "x":
        data, _ = _call("POST", X_API + "/2/dm_conversations/with/"
                        + urllib.parse.quote(target, safe="") + "/messages", token,
                        json_body={"text": text})
        return str((data.get("data") or {}).get("dm_event_id") or "")
    raise SocialApiError(400, SPECS[channel]["label"] + " direct messages are not"
                         " available through the API.", "final")


def reply_comment(account: Dict[str, Any], comment: Dict[str, Any], text: str) -> str:
    channel, token = account["channel"], account["access_token"]
    comment_id, post_id = str(comment["comment_id"]), str(comment.get("post_id") or "")
    if channel == "tiktok":
        data = _tiktok("POST", "/business/comment/reply/create/", token, body={
            "business_id": account["account_id"], "video_id": post_id,
            "comment_id": comment_id, "text": text})
        return str(data.get("comment_id") or "")
    if channel == "x":
        data, _ = _call("POST", X_API + "/2/tweets", token, json_body={
            "text": text, "reply": {"in_reply_to_tweet_id": comment_id}})
        return str((data.get("data") or {}).get("id") or "")
    if channel == "linkedin":
        org = _org_urn(account)
        if not org:
            raise SocialApiError(400, "Add your LinkedIn Company Page id to reply to comments.",
                                 "final")
        _, got = _call("POST", LINKEDIN_API + "/rest/socialActions/"
                       + urllib.parse.quote(post_id, safe="") + "/comments", token,
                       json_body={"actor": org, "object": post_id, "parentComment": comment_id,
                                  "message": {"text": text}}, extra=_linkedin_headers())
        return str(got.get("x-restli-id") or "")
    data, _ = _call("POST", YOUTUBE_API + "/comments?part=snippet", token, json_body={
        "snippet": {"parentId": comment_id, "textOriginal": text}})
    return str(data.get("id") or "")


def publish(account: Dict[str, Any], text: str, media_url: str) -> str:
    channel, token = account["channel"], account["access_token"]
    if channel == "tiktok":
        if not media_url:
            raise SocialApiError(400, "TikTok posts need a public video URL.", "final")
        data = _tiktok("POST", "/business/video/publish/", token, body={
            "business_id": account["account_id"], "video_url": media_url,
            "post_info": {"caption": text}})
        return str(data.get("share_id") or "")
    if media_url:
        raise SocialApiError(400, "Only text posts are supported on "
                             + SPECS[channel]["label"] + ".", "final")
    if channel == "x":
        data, _ = _call("POST", X_API + "/2/tweets", token, json_body={"text": text})
        return str((data.get("data") or {}).get("id") or "")
    if channel == "linkedin":
        author = _org_urn(account) or "urn:li:person:" + account["account_id"]
        _, got = _call("POST", LINKEDIN_API + "/rest/posts", token, json_body={
            "author": author, "commentary": text, "visibility": "PUBLIC",
            "distribution": {"feedDistribution": "MAIN_FEED", "targetEntities": [],
                             "thirdPartyDistributionChannels": []},
            "lifecycleState": "PUBLISHED", "isReshareDisabledByAuthor": False},
            extra=_linkedin_headers())
        return str(got.get("x-restli-id") or "")
    raise SocialApiError(400, "Publishing is not available on "
                         + SPECS[channel]["label"] + ".", "final")


def _since(account: Dict[str, Any], now: datetime) -> Optional[float]:
    """Comment cursor (epoch seconds). None on the first run: start from
    now, old comments are never imported."""
    value = account["cursor"].get("since")
    try:
        return float(value)
    except (TypeError, ValueError):
        account["cursor"]["since"] = now.timestamp()
        return None


def _epoch(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value) / (1000.0 if value > 1e11 else 1.0)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def poll_comments(account: Dict[str, Any], now: datetime) -> List[Dict[str, Any]]:
    """New comments since the cursor: [{contact, name, comment_id, post_id,
    body, at}]. The account's own comments are skipped."""
    since = _since(account, now)
    if since is None:
        return []
    channel, token, own = account["channel"], account["access_token"], account["account_id"]
    found: List[Dict[str, Any]] = []
    if channel == "tiktok":
        videos = _tiktok("GET", "/business/video/list/", token, params={
            "business_id": own, "fields": json.dumps(["item_id", "create_time"]),
            "max_count": RECENT_VIDEOS}).get("videos") or []
        for video in videos[:RECENT_VIDEOS]:
            video_id = str(video.get("item_id") or "")
            if not video_id:
                continue
            data = _tiktok("GET", "/business/comment/list/", token, params={
                "business_id": own, "video_id": video_id, "max_count": 30,
                "sort_field": "create_time", "sort_order": "desc"})
            for item in data.get("comments") or []:
                author = str(item.get("unique_identifier") or item.get("user_id") or "")
                if not author or str(item.get("user_id") or "") == own or item.get("owner"):
                    continue
                found.append({"contact": "ttc:" + author, "name": item.get("display_name"),
                              "comment_id": str(item.get("comment_id") or ""),
                              "post_id": video_id, "body": str(item.get("text") or ""),
                              "at": _epoch(item.get("create_time"))})
    elif channel == "youtube":
        data, _ = _call("GET", YOUTUBE_API + "/commentThreads?" + urllib.parse.urlencode({
            "part": "snippet", "allThreadsRelatedToChannelId": own, "order": "time",
            "maxResults": 50}), token)
        for thread in data.get("items") or []:
            top = (thread.get("snippet") or {}).get("topLevelComment") or {}
            snippet = top.get("snippet") or {}
            author = str((snippet.get("authorChannelId") or {}).get("value") or "")
            if not author or author == own:
                continue
            found.append({"contact": "ytc:" + author, "name": snippet.get("authorDisplayName"),
                          "comment_id": str(top.get("id") or ""),
                          "post_id": str(snippet.get("videoId") or ""),
                          "body": str(snippet.get("textOriginal") or snippet.get("textDisplay")
                                      or ""), "at": _epoch(snippet.get("publishedAt"))})
    elif channel == "linkedin":
        org = _org_urn(account)
        if not org:
            return []
        posts, _ = _call("GET", LINKEDIN_API + "/rest/posts?" + urllib.parse.urlencode({
            "author": org, "q": "author", "count": RECENT_VIDEOS}), token,
            extra=_linkedin_headers())
        for post in (posts.get("elements") or [])[:RECENT_VIDEOS]:
            urn = str(post.get("id") or "")
            if not urn:
                continue
            data, _ = _call("GET", LINKEDIN_API + "/rest/socialActions/"
                            + urllib.parse.quote(urn, safe="") + "/comments", token,
                            extra=_linkedin_headers())
            for item in data.get("elements") or []:
                actor = str(item.get("actor") or "")
                if not actor or actor == org:
                    continue
                found.append({"contact": "lic:" + actor.rsplit(":", 1)[-1], "name": None,
                              "comment_id": str(item.get("$URN") or item.get("commentUrn")
                                                or item.get("id") or ""),
                              "post_id": urn,
                              "body": str((item.get("message") or {}).get("text") or ""),
                              "at": _epoch((item.get("created") or {}).get("time"))})
    fresh = [c for c in found if c["comment_id"] and c["body"].strip() and c["at"] > since]
    if fresh:
        account["cursor"]["since"] = max(c["at"] for c in fresh)
    return sorted(fresh, key=lambda c: c["at"])


def poll_x(account: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """X "Check now" only (each read is billed): new mentions and DMs since
    the cursor. First run stores the newest ids and imports nothing."""
    token, own = account["access_token"], account["account_id"]
    cursor = account["cursor"]
    dms: List[Dict[str, Any]] = []
    mentions: List[Dict[str, Any]] = []
    if has(account, "comments"):
        params = {"max_results": 20, "tweet.fields": "author_id,created_at",
                  "expansions": "author_id", "user.fields": "username,name"}
        if cursor.get("mention_id"):
            params["since_id"] = cursor["mention_id"]
        data, _ = _call("GET", X_API + "/2/users/" + urllib.parse.quote(own, safe="")
                        + "/mentions?" + urllib.parse.urlencode(params), token)
        names = {str(u.get("id")): u.get("name") for u in
                 (data.get("includes") or {}).get("users") or []}
        tweets = data.get("data") or []
        if tweets:
            newest = max(tweets, key=lambda t: int(t.get("id") or 0))
            if cursor.get("mention_id"):
                for tweet in tweets:
                    author = str(tweet.get("author_id") or "")
                    if author and author != own:
                        mentions.append({"contact": "xc:" + author, "name": names.get(author),
                                         "comment_id": str(tweet["id"]), "post_id": str(tweet["id"]),
                                         "body": str(tweet.get("text") or "")})
            cursor["mention_id"] = str(newest["id"])
    if has(account, "dm"):
        data, _ = _call("GET", X_API + "/2/dm_events?" + urllib.parse.urlencode({
            "event_types": "MessageCreate", "max_results": 20,
            "dm_event.fields": "sender_id,text,created_at"}), token)
        events = data.get("data") or []
        last = int(cursor.get("dm_id") or 0)
        newest = last
        for event in events:
            event_id = int(event.get("id") or 0)
            newest = max(newest, event_id)
            sender = str(event.get("sender_id") or "")
            if last and event_id > last and sender and sender != own:
                dms.append({"from": "x:" + sender, "body": str(event.get("text") or ""),
                            "id": "x-dm:" + str(event_id)})
        cursor["dm_id"] = str(newest) if newest else cursor.get("dm_id", "")
    return dms, sorted(mentions, key=lambda m: int(m["comment_id"]))


def register_webhook(account: Dict[str, Any], url: str) -> str:
    """X: register the webhook (app bearer) and subscribe the account (user
    token). TikTok: point the app's message webhook here. -> webhook id."""
    if account["channel"] == "x":
        bearer = account.get("bearer_token") or ""
        if not bearer:
            raise SocialApiError(400, "Add the X app bearer token first.", "final")
        webhook_id = ""
        try:
            data, _ = _call("POST", X_API + "/2/webhooks", bearer, json_body={"url": url})
            webhook_id = str((data.get("data") or {}).get("id") or "")
        except SocialApiError as error:
            if error.kind != "final":
                raise
            listed, _ = _call("GET", X_API + "/2/webhooks", bearer)
            for hook in listed.get("data") or []:
                if str(hook.get("url") or "") == url:
                    webhook_id = str(hook.get("id") or "")
            if not webhook_id:
                raise
        _call("POST", X_API + "/2/account_activity/webhooks/" + webhook_id
              + "/subscriptions/all", account["access_token"], json_body={})
        return webhook_id
    _tiktok("POST", "/business/webhook/update/", "", body={
        "app_id": account["app_id"], "secret": account["app_secret"],
        "event_type": "DIRECT_MESSAGE", "callback_url": url})
    return "tiktok"


# ---------------------------------------------------------------------------
# outbox (API mode)
# ---------------------------------------------------------------------------

def _fit(text: str, limit: int) -> str:
    text = str(text or "").strip()
    return text if len(text) <= limit else text[:max(1, limit - 1)].rstrip() + "\u2026"


def refusal(cur, client_id: int, account: Optional[Dict[str, Any]], item: Dict[str, Any],
            mode: str) -> str:
    """Why this queued item must never be sent (empty = send). Final."""
    channel = item.get("_channel") or ""
    if not account or account.get("mode") != mode:
        return "This channel is not connected in " + mode + " mode."
    if account.get("enabled") is not True:
        return SPECS[account["channel"]]["label"] + " is switched off for this workspace."
    payload = item["payload"]
    if item["action"] == "publish_post":
        return "" if has(account, "publish") else "Publishing is turned off for this channel."
    contact = str(payload.get("external_user_id") or "").strip()
    if channel_of_contact(contact) != account["channel"]:
        return "This contact does not belong to " + SPECS[account["channel"]]["label"] + "."
    if item["action"] not in ("send_message", "send_interactive"):
        return "Only text replies can be sent on " + SPECS[account["channel"]]["label"] + "."
    if not str(payload.get("body") or "").strip():
        return "The reply is empty."
    try:
        import portal_compliance

        with portal_txn.savepoint(cur, None, "of_social_optout"):
            if portal_compliance.is_opted_out(cur, client_id, contact):
                return "This customer opted out of messages."
    except Exception:
        pass
    if is_comment(contact):
        if not has(account, "comments"):
            return "Comment replies are turned off for this channel."
        source = str(payload.get("source") or "")
        if item["kind"] == "away" or not (source in COMMENT_SOURCES or (
                source == "ai_brain" and account["flags"].get("comment_auto_reply") is True)):
            return "Automated messages are not posted as public comment replies."
        if not latest_comment(cur, client_id, contact):
            return "No comment from this person to reply to."
        return ""
    if not has(account, "dm"):
        return "Direct messages are turned off for this channel."
    return ""


def _set_post(cur, client_id: int, post_id: Any, status: str, provider_id: str = "",
              error: str = "") -> None:
    try:
        post_id = int(post_id or 0)
    except (TypeError, ValueError):
        return
    cur.execute("UPDATE " + portal_db._q(POSTS_TABLE) + " SET status = %s,"
                " provider_post_id = %s, error = %s, updated_at = NOW()"
                " WHERE id = %s AND client_id = %s", (status, provider_id[:200], error[:300],
                                                       post_id, client_id))


def _finish(cur, client_id: int, channel: str, item: Dict[str, Any], how: str,
            note: str) -> None:
    """Refuse (final) or retry one queued item; a refused post is failed."""
    if how == "refuse":
        portal_cp_outbox.refuse(cur, client_id, channel, item, note)
        if item["action"] == "publish_post":
            _set_post(cur, client_id, item["payload"].get("post_id"), "failed", "", note)
    else:
        portal_cp_outbox.retry(cur, client_id, channel, item, note)


def _deliver(cur, client_id: int, account: Dict[str, Any], item: Dict[str, Any],
             contact: str) -> Tuple[str, str]:
    """Send one item -> (the text sent, provider id)."""
    spec = SPECS[account["channel"]]
    payload = item["payload"]
    if item["action"] == "publish_post":
        text = _fit(payload.get("body"), spec["post_max"])
        return text, publish(account, text, str(payload.get("media_url") or ""))
    if is_comment(contact):
        text = _fit(payload.get("body"), spec["comment_max"])
        return text, reply_comment(account, latest_comment(cur, client_id, contact) or {}, text)
    text = _fit(payload.get("body"), spec["dm_max"])
    return text, send_dm(account, contact, text)


def _send_channel(conn, cur, client_id: int, account: Dict[str, Any], result: Dict[str, Any],
                  limit: int) -> str:
    """Send the channel's due queue. -> the problem to show ("" = fine)."""
    channel = account["channel"]
    spec = SPECS[channel]
    if spec["comment"]:
        cur.execute("UPDATE " + portal_db._q(portal_cp_outbox.AWAY_TABLE) +
                    " SET status = 'failed', result_note = %s, sent_at = NOW()"
                    " WHERE client_id = %s AND status = 'pending' AND contact_id LIKE %s",
                    ("Away replies are never posted as public comments.", client_id,
                     spec["comment"] + "%"))
        conn.commit()
    pending = portal_cp_outbox.pending(cur, client_id, channel, spec["dm"] or spec["comment"],
                                       limit)
    conn.commit()
    records: List[Dict[str, Any]] = []
    refreshed = False
    problem = ""
    try:
        for item in pending:
            item["_channel"] = channel
            payload = item["payload"]
            reason = refusal(cur, client_id, account, item, "api")
            if reason:
                _finish(cur, client_id, channel, item, "refuse", reason)
                conn.commit()
                result["refused"] += 1
                continue
            contact = str(payload.get("external_user_id") or "")
            try:
                while True:
                    try:
                        text, provider_id = _deliver(cur, client_id, account, item, contact)
                        break
                    except SocialApiError as error:
                        if error.kind != "auth" or refreshed:
                            raise
                        refreshed = True
                        _fresh_token(cur, account, force=True)
                        conn.commit()
            except SocialApiError as error:
                if error.kind == "auth":
                    # nothing was sent and no attempt is spent - the replies wait
                    conn.rollback()
                    problem = spec["label"] + " refused the connection - connect the account again."
                    break
                note = spec["label"] + ": " + error.message
                if error.kind == "final":
                    _finish(cur, client_id, channel, item, "refuse", note)
                    result["refused"] += 1
                else:
                    _finish(cur, client_id, channel, item, "retry", note)
                    result["failed"] += 1
                    problem = note
                conn.commit()
                continue
            note = spec["label"] + (" post published." if item["action"] == "publish_post"
                                    else " reply sent.")
            portal_cp_outbox.sent(cur, client_id, channel, item, note, provider_id or None)
            if item["action"] == "publish_post":
                _set_post(cur, client_id, payload.get("post_id"), "published", provider_id)
            else:
                records.append({"from": contact, "body": text, "direction": "out",
                                "channel": channel, "provider": "social_api",
                                "id": channel + "-out:" + (provider_id or str(item["id"]))})
            conn.commit()
            result["sent"] += 1
    finally:
        portal_cp_outbox.record_sent(client_id, channel, "social_api", records)
    return problem


def _ingest_comments(cur, conn, client_id: int, channel: str,
                     comments: List[Dict[str, Any]]) -> int:
    """Store comments (reply targets) and run them through the ingest core."""
    records = []
    for item in comments:
        if _record_comment(cur, client_id, channel, item["contact"], item["comment_id"],
                           item.get("post_id") or "", item["body"]):
            records.append({"from": item["contact"], "body": item["body"],
                            "name": item.get("name") if isinstance(item.get("name"), str) else None,
                            "direction": "in", "channel": channel, "provider": "social",
                            "id": channel + "-c:" + item["comment_id"]})
    conn.commit()
    _ingest(client_id, channel, records)
    return len(records)


def _ingest(client_id: int, channel: str, records: List[Dict[str, Any]]) -> None:
    for start in range(0, len(records), 50):
        portal_cp_outbox.ingest(client_id, channel, "social_" + channel, records[start:start + 50])


def _run_channel(conn, cur, client_id: int, account: Dict[str, Any], result: Dict[str, Any],
                 limit: int, poll: bool, paid: bool) -> None:
    channel = account["channel"]
    problem = ""
    changes: Dict[str, Any] = {}
    try:
        _fresh_token(cur, account)
        conn.commit()
        if poll and channel in ("tiktok", "youtube", "linkedin") and has(account, "comments"):
            before = dict(account["cursor"])
            comments = poll_comments(account, _now(cur))
            if account["cursor"] != before:
                save_account(cur, client_id, channel, {"cursor": account["cursor"]})
                conn.commit()
            if comments:
                result["received"] += _ingest_comments(cur, conn, client_id, channel, comments)
                changes["last_in_at"] = _now(cur)
        if paid and channel == "x":
            dms, mentions = poll_x(account)
            save_account(cur, client_id, channel, {"cursor": account["cursor"]})
            conn.commit()
            if dms:
                _ingest(client_id, channel, [dict(d, name=None, direction="in", channel="x",
                                                  provider="social") for d in dms])
            got = len(dms) + (_ingest_comments(cur, conn, client_id, channel, mentions)
                              if mentions else 0)
            result["received"] += got
            if got:
                changes["last_in_at"] = _now(cur)
        sent_before = result["sent"]
        problem = _send_channel(conn, cur, client_id, account, result, limit)
        if result["sent"] > sent_before:
            changes["last_sent_at"] = _now(cur)
    except SocialApiError as error:
        conn.rollback()
        problem = (SPECS[channel]["label"] + " refused the connection - connect the account"
                   " again.") if error.kind == "auth" else SPECS[channel]["label"] + ": " + error.message
    changes["last_check_at"] = _now(cur)
    if problem != account.get("last_error"):
        changes["last_error"] = problem
    save_account(cur, client_id, channel, changes)
    conn.commit()
    if problem:
        result["errors"][channel] = problem


def run(client_id: int, channels: Optional[Tuple[str, ...]] = None, limit: int = 0,
        poll: bool = True, paid: bool = False) -> Dict[str, Any]:
    """Poll comments and send the queue for the workspace's API-mode
    accounts (one run per workspace at a time). Never raises."""
    result: Dict[str, Any] = {"ran": False, "reason": "", "sent": 0, "failed": 0,
                              "refused": 0, "received": 0, "errors": {}}
    if not ENABLED:
        result["reason"] = "off"
        return result
    conn = None
    locked = False
    try:
        conn = portal_db._conn()
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            conn.commit()
            cur.execute("SELECT pg_try_advisory_lock(%s, %s) AS ok",
                        (LOCK_CLASS, client_id % 2147483647))
            found = portal_db.rows(cur)
            locked = bool(found and found[0].get("ok"))
            conn.commit()
            if not locked:
                result["reason"] = "busy"
                return result
            result["ran"] = True
            cur.execute("SELECT " + _COLUMNS + " FROM " + portal_db._q(TABLE) +
                        " WHERE client_id = %s AND mode = 'api' AND enabled = TRUE"
                        " AND access_token <> '' ORDER BY channel", (client_id,))
            accounts = [_row(r) for r in portal_db.rows(cur)]
            conn.commit()
            for account in accounts:
                if channels and account["channel"] not in channels:
                    continue
                try:
                    _run_channel(conn, cur, client_id, account, result,
                                 limit or MAX_SEND_PER_RUN, poll, paid)
                except Exception as error:
                    conn.rollback()
                    logger.warning("social %s run failed: %s", account["channel"], error)
                    result["errors"][account["channel"]] = "Temporarily unavailable - try again shortly."
    except Exception as error:
        logger.warning("social channels run failed: %s", error)
        result["reason"] = result["reason"] or "unavailable"
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


def dispatch(client_id: Any, channel: str) -> None:
    """A reply was just queued (portal_channels.dispatch_now): send it now
    when the channel runs in API mode. Fail-soft."""
    if channel in SPECS and SPECS[channel]["api"]:
        try:
            run(int(client_id), (channel,), DISPATCH_LIMIT, poll=False)
        except Exception:
            pass


def _job(client_id: int) -> None:
    try:
        run(client_id)
    finally:
        with _LOCK:
            _RUNNING.discard(client_id)


def kick(client_id: Any) -> bool:
    """Tick hook (connector poll, inbox list, settings card): poll comments and
    send queued replies in the background, at most every
    OF_SOCIAL_POLL_SECONDS per workspace per process."""
    if not ENABLED:
        return False
    try:
        client_id = int(client_id or 0)
    except (TypeError, ValueError):
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
        threading.Thread(target=_job, args=(client_id,), name="social-" + str(client_id),
                         daemon=True).start()
    except Exception:
        with _LOCK:
            _RUNNING.discard(client_id)
        return False
    return True


# ---------------------------------------------------------------------------
# login mode (laptop bridge) - called from connector_api
# ---------------------------------------------------------------------------

def bridge_channel(channel: str) -> bool:
    return channel in SPECS and bool(SPECS[channel]["login"])


def filter_bridge_commands(cur, conn, client_id: int, channel: str,
                           rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The commands the login bridge may run. API-mode channels return []
    (the Control Plane sends those); refused commands are marked dead here,
    comment replies get the comment to answer (``reply_to``)."""
    _ensure_ddl(cur)
    account = load_account(cur, client_id, channel)
    if not account or account.get("mode") != "login":
        return []
    cur.execute("UPDATE " + portal_db._q(TABLE) + " SET bridge_seen_at = NOW()"
                " WHERE client_id = %s AND channel = %s", (client_id, channel))
    allowed = []
    for row in rows:
        payload = _json(row.get("payload"))
        item = {"kind": "command", "id": int(row["id"]), "action": str(row.get("action") or ""),
                "payload": payload, "_channel": channel}
        reason = refusal(cur, client_id, account, item, "login")
        if reason:
            portal_cp_outbox.refuse(cur, client_id, channel, item, reason)
            if item["action"] == "publish_post":
                _set_post(cur, client_id, payload.get("post_id"), "failed", "", reason)
            continue
        spec = SPECS[channel]
        contact = str(payload.get("external_user_id") or "")
        if item["action"] == "publish_post":
            payload["body"] = _fit(payload.get("body"), spec["post_max"])
        elif is_comment(contact):
            payload["body"] = _fit(payload.get("body"), spec["comment_max"])
            payload["reply_to"] = str((latest_comment(cur, client_id, contact) or {})
                                      .get("comment_id") or "")
        else:
            payload["body"] = _fit(payload.get("body"), spec["dm_max"])
        allowed.append(dict(row, payload=payload))
    conn.commit()
    return allowed


def away_prefix(cur, client_id: int, channel: str) -> str:
    """The DM prefix whose away replies the login bridge may send ("" = none)."""
    if not bridge_channel(channel) or not SPECS[channel]["dm"]:
        return ""
    _ensure_ddl(cur)
    account = load_account(cur, client_id, channel)
    if not account or account.get("mode") != "login" or account.get("enabled") is not True \
            or not has(account, "dm"):
        return ""
    return SPECS[channel]["dm"]


@connector_bp.before_request
def _connector_guard():
    """The login bridge authenticates with the service key, like every
    connector route."""
    if request.method == "OPTIONS":
        return None
    import connector_api

    if not connector_api._authorized():
        return _err("forbidden", "Service key missing or invalid.", 403)
    return None


@connector_bp.post("/messages")
def bridge_messages():
    """Login bridge -> ingest: {client_id?, channel, messages:[{from, body,
    name?, id, comment_id?, post_id?}]}. Comments are stored as reply
    targets; everything goes through the one ingest core."""
    import connector_api

    payload = request.get_json(silent=True)
    payload = payload if isinstance(payload, dict) else {}
    tenant, error = connector_api._tenant_or_error(payload.get("client_id"))
    if error:
        return error
    channel = str(payload.get("channel") or "")
    messages = payload.get("messages")
    if not bridge_channel(channel) or not isinstance(messages, list) or not messages \
            or len(messages) > 50:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "channel and 1-50 messages are required."}}), 400
    client_id = int(tenant["client_id"])
    spec = SPECS[channel]
    records, comments = [], []
    for item in messages:
        if not isinstance(item, dict):
            continue
        sender = str(item.get("from") or "").strip()
        body = str(item.get("body") or "")[:4000]
        if not body.strip() or channel_of_contact(sender) != channel:
            continue
        if is_comment(sender):
            comment_id = str(item.get("comment_id") or "").strip()
            if comment_id:
                comments.append({"contact": sender, "name": item.get("name"),
                                 "comment_id": comment_id,
                                 "post_id": str(item.get("post_id") or ""), "body": body})
            continue
        records.append({"from": sender, "body": body, "direction": "in", "channel": channel,
                        "name": item.get("name") if isinstance(item.get("name"), str) else None,
                        "id": str(item.get("id") or "")[:120] or None, "provider": "social_login"})
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                account = load_account(cur, client_id, channel)
                if not account or account.get("mode") != "login" \
                        or account.get("enabled") is not True:
                    conn.rollback()
                    return jsonify({"ok": True, "ingested": 0, "ignored": "switched_off"}), 200
                records = records if has(account, "dm") else []
                comments = comments if has(account, "comments") else []
                count = _ingest_comments(cur, conn, client_id, channel, comments) \
                    if comments else 0
                _ingest(client_id, channel, [r for r in records if r["id"]])
                count += len([r for r in records if r["id"]])
                if count:
                    save_account(cur, client_id, channel, {"last_in_at": _now(cur)})
                conn.commit()
        finally:
            conn.close()
    except connector_api.IngestRateLimited:
        return jsonify({"error": {"code": "rate_limited", "message": "Slow down."}}), 429
    except Exception as failure:
        return jsonify(portal_db.portal_unavailable(failure, spec["label"] + " ingest")[0]), 503
    return jsonify({"ok": True, "ingested": count}), 200


@connector_bp.post("/status")
def bridge_status():
    """Login bridge heartbeat: {client_id?, channel, state, account_name?, error?}."""
    import connector_api

    payload = request.get_json(silent=True)
    payload = payload if isinstance(payload, dict) else {}
    tenant, error = connector_api._tenant_or_error(payload.get("client_id"))
    if error:
        return error
    channel = str(payload.get("channel") or "")
    state = str(payload.get("state") or "")
    if not bridge_channel(channel) or state not in ("connected", "connecting", "error"):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "channel and state are required."}}), 400
    changes: Dict[str, Any] = {"bridge_state": state,
                               "last_error": str(payload.get("error") or "")[:300]
                               if state == "error" else ""}
    name = str(payload.get("account_name") or "").strip()[:120]
    if name:
        changes["account_name"] = name
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                account = load_account(cur, int(tenant["client_id"]), channel)
                if not account or account.get("mode") != "login":
                    conn.rollback()
                    return jsonify({"ok": True, "active": False}), 200
                changes["bridge_seen_at"] = _now(cur)
                save_account(cur, int(tenant["client_id"]), channel, changes)
                conn.commit()
        finally:
            conn.close()
    except Exception as failure:
        return jsonify(portal_db.portal_unavailable(failure, "social bridge status")[0]), 503
    return jsonify({"ok": True, "active": account.get("enabled") is True,
                    "features": [f for f in FEATURES if has(account, f)]}), 200


# ---------------------------------------------------------------------------
# public webhooks
# ---------------------------------------------------------------------------

def _signature_ok(secret: str, raw: bytes, header: str) -> bool:
    if not secret or not header:
        return False
    digest = base64.b64encode(hmac.new(secret.encode("utf8"), raw, hashlib.sha256).digest())
    expected = "sha256=" + digest.decode("ascii")
    return hmac.compare_digest(expected, header.strip())


def _x_secret(account: Dict[str, Any]) -> str:
    return account.get("consumer_secret") or account.get("app_secret") or ""


@public_bp.get("/social/x/webhook/<hook_key>")
def x_crc(hook_key: str):
    token = request.args.get("crc_token", "")
    if not token or len(token) > 300:
        return jsonify({"error": {"code": "bad_request", "message": "crc_token missing."}}), 400
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                account = _load_by_hook(cur, "x", hook_key)
                conn.commit()
        finally:
            conn.close()
    except Exception as failure:
        return jsonify(portal_db.portal_unavailable(failure, "x crc")[0]), 503
    if not account or not _x_secret(account):
        return jsonify({"error": {"code": "not_found", "message": "Unknown webhook."}}), 404
    digest = hmac.new(_x_secret(account).encode("utf8"), token.encode("utf8"),
                      hashlib.sha256).digest()
    return jsonify({"response_token": "sha256=" + base64.b64encode(digest).decode("ascii")}), 200


def x_events(payload: Dict[str, Any], account: Dict[str, Any]):
    """(DM records, comment items) from an Account Activity payload."""
    own = account["account_id"]
    if str(payload.get("for_user_id") or "") != own:
        return [], []
    users = payload.get("users") if isinstance(payload.get("users"), dict) else {}
    dms, comments = [], []
    if has(account, "dm"):
        for event in payload.get("direct_message_events") or []:
            create = event.get("message_create") if isinstance(event, dict) else None
            if event.get("type") != "message_create" or not isinstance(create, dict):
                continue
            sender = str(create.get("sender_id") or "")
            text = str((create.get("message_data") or {}).get("text") or "")
            if not sender or sender == own or not text.strip():
                continue
            name = (users.get(sender) or {}).get("name") if isinstance(users.get(sender), dict) else None
            dms.append({"from": "x:" + sender, "body": text, "direction": "in", "channel": "x",
                        "name": name if isinstance(name, str) else None, "provider": "social",
                        "id": "x-dm:" + str(event.get("id") or "")})
    if has(account, "comments"):
        for tweet in payload.get("tweet_create_events") or []:
            if not isinstance(tweet, dict):
                continue
            user = tweet.get("user") if isinstance(tweet.get("user"), dict) else {}
            author = str(user.get("id_str") or "")
            tweet_id = str(tweet.get("id_str") or "")
            text = str(tweet.get("text") or "")
            if not author or author == own or not tweet_id or not text.strip() \
                    or "retweeted_status" in tweet:
                continue
            comments.append({"contact": "xc:" + author, "name": user.get("name"),
                             "comment_id": tweet_id, "post_id": tweet_id, "body": text})
    return dms, comments


def tiktok_events(payload: Dict[str, Any], account: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Inbound TikTok DMs (im_receive_msg to this business account)."""
    if not has(account, "dm") or payload.get("event") != "im_receive_msg":
        return []
    content = payload.get("content")
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except ValueError:
            return []
    if not isinstance(content, dict):
        return []
    own = account["account_id"]
    to_user = str((content.get("to_user") or {}).get("id") or "")
    sender = str((content.get("from_user") or {}).get("id") or "")
    conversation = str(content.get("conversation_id") or "")
    text = str((content.get("text") or {}).get("body") or "")
    if to_user != own or not sender or sender == own or not conversation or not text.strip():
        return []
    return [{"from": "tt:" + conversation, "body": text, "direction": "in", "channel": "tiktok",
             "name": None, "provider": "social",
             "id": "tt-dm:" + str(content.get("message_id") or "")}]


def _tiktok_signature_ok(secret: str, raw: bytes, header: str, now: float) -> bool:
    parts = dict(p.split("=", 1) for p in str(header or "").split(",") if "=" in p)
    stamp, signature = parts.get("t", ""), parts.get("s", "")
    if not secret or not stamp.isdigit() or not signature:
        return False
    if abs(now - int(stamp)) > TIKTOK_SIG_TOLERANCE:
        return False
    expected = hmac.new(secret.encode("utf8"), stamp.encode("ascii") + b"." + raw,
                        hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature.strip())


def _webhook(channel: str, hook_key: str):
    raw = request.get_data(cache=False) or b""
    if len(raw) > MAX_WEBHOOK_BYTES:
        return jsonify({"error": {"code": "too_large", "message": "Payload too large."}}), 413
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                account = _load_by_hook(cur, channel, hook_key)
                conn.commit()
                if not account:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Unknown webhook."}}), 404
                if channel == "x":
                    headers = (request.headers.get("X-Twitter-Webhooks-Signature-OAuth2", ""),
                               request.headers.get("X-Twitter-Webhooks-Signature", ""))
                    secrets_ = (account.get("app_secret") or "", account.get("consumer_secret") or "")
                    valid = any(_signature_ok(s, raw, h) for s in secrets_ for h in headers if s and h)
                else:
                    valid = _tiktok_signature_ok(account.get("app_secret") or "", raw,
                                                 request.headers.get("Tiktok-Signature", ""),
                                                 time.time())
                if not valid:
                    return jsonify({"error": {"code": "forbidden",
                                              "message": "Bad signature."}}), 403
                if account.get("mode") != "api" or account.get("enabled") is not True:
                    return jsonify({"ok": True, "ignored": "switched_off"}), 200
                try:
                    payload = json.loads(raw.decode("utf8") or "{}")
                except ValueError:
                    return jsonify({"error": {"code": "bad_request", "message": "Bad JSON."}}), 400
                payload = payload if isinstance(payload, dict) else {}
                client_id = int(account["client_id"])
                if channel == "x":
                    dms, comments = x_events(payload, account)
                else:
                    dms, comments = tiktok_events(payload, account), []
                count = _ingest_comments(cur, conn, client_id, channel, comments) \
                    if comments else 0
                _ingest(client_id, channel, dms)
                count += len(dms)
                if count:
                    save_account(cur, client_id, channel, {"last_in_at": _now(cur)})
                    conn.commit()
        finally:
            conn.close()
    except Exception as failure:
        logger.warning("%s webhook failed: %s", channel, failure)
        return jsonify(portal_db.portal_unavailable(failure, channel + " webhook")[0]), 503
    if count:
        # the brain may have queued an answer - send it while the customer waits
        run(client_id, (channel,), DISPATCH_LIMIT, poll=False)
    return jsonify({"ok": True, "ingested": count}), 200


@public_bp.post("/social/x/webhook/<hook_key>")
def x_webhook(hook_key: str):
    return _webhook("x", hook_key)


@public_bp.post("/social/tiktok/webhook/<hook_key>")
def tiktok_webhook(hook_key: str):
    return _webhook("tiktok", hook_key)


# ---------------------------------------------------------------------------
# posts + approvals
# ---------------------------------------------------------------------------

def _queue_post(cur, client_id: int, post_id: int, channel: str, body: str, media_url: str,
                source: str, requested_by: Any) -> int:
    cur.execute("INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
                " (client_id, channel, action, payload, status, requested_by,"
                " created_at, updated_at) VALUES (%s, %s, 'publish_post', CAST(%s AS JSONB),"
                " 'pending', %s, NOW(), NOW()) RETURNING id",
                (client_id, channel, json.dumps({
                    "post_id": post_id, "body": body, "media_url": media_url,
                    "external_user_id": "post:" + channel + ":" + str(post_id),
                    "source": source}), requested_by))
    command_id = int(portal_db.rows(cur)[0]["id"])
    cur.execute("UPDATE " + portal_db._q(POSTS_TABLE) + " SET status = 'queued',"
                " command_id = %s, updated_at = NOW() WHERE id = %s AND client_id = %s",
                (command_id, post_id, client_id))
    return command_id


def _post_problem(account: Optional[Dict[str, Any]], channel: str, body: str,
                  media_url: str) -> str:
    spec = SPECS[channel]
    if not account or account.get("enabled") is not True or not has(account, "publish"):
        return "Turn on publishing for " + spec["label"] + " first."
    if not body.strip() and channel != "tiktok":
        return "Write the post text."
    if len(body) > spec["post_max"]:
        return spec["label"] + " posts can be at most " + str(spec["post_max"]) + " characters."
    if media_url and not re.match(r"^https://[^\s]{4,1500}$", media_url):
        return "The media link must be a public https:// URL."
    if channel == "tiktok" and not media_url:
        return "TikTok posts need a public video URL."
    if channel != "tiktok" and media_url:
        return "Only text posts are supported on " + spec["label"] + "."
    return ""


def create_post(cur, client_id: int, channel: str, body: str, media_url: str, source: str,
                requested_by: Any, direct: bool) -> Dict[str, Any]:
    """One post: ``direct`` (owner / admin) queues it now, otherwise it waits
    for an approval (HIGH risk). Raises ValueError with the reason."""
    _ensure_ddl(cur)
    if channel not in SPECS or not SPECS[channel]["post_max"]:
        raise ValueError("Publishing is not available on this channel.")
    body, media_url = str(body or "").strip(), str(media_url or "").strip()
    problem = _post_problem(load_account(cur, client_id, channel), channel, body, media_url)
    if problem:
        raise ValueError(problem)
    cur.execute("INSERT INTO " + portal_db._q(POSTS_TABLE) +
                " (client_id, channel, body, media_url, status, source, requested_by)"
                " VALUES (%s, %s, %s, %s, 'pending_approval', %s, %s) RETURNING id",
                (client_id, channel, body, media_url, source[:20], requested_by))
    post_id = int(portal_db.rows(cur)[0]["id"])
    if direct:
        _queue_post(cur, client_id, post_id, channel, body, media_url, source, requested_by)
        return {"id": post_id, "status": "queued"}
    import portal_approvals

    label = SPECS[channel]["label"]
    approval = None
    with portal_txn.savepoint(cur, None, "of_social_approval"):
        approval = portal_approvals.create_approval(
            cur, client_id, None, "post:" + channel + ":" + str(post_id), label + " post",
            "social_post", ("Publish on " + label + ": " + body)[:300],
            body[:500], context={"post_id": post_id, "channel": channel, "text": body,
                                 "media_url": media_url},
            source=source, kind="social_post", risk="high")
    if not approval:
        raise ValueError("The approval could not be created - try again shortly.")
    cur.execute("UPDATE " + portal_db._q(POSTS_TABLE) + " SET approval_id = %s"
                " WHERE id = %s AND client_id = %s", (approval.get("id"), post_id, client_id))
    return {"id": post_id, "status": "pending_approval"}


def request_post(cur, client_id: int, channel: str, body: str, media_url: str = "",
                 source: str = "ai", requested_by: Any = None) -> Optional[Dict[str, Any]]:
    """For AI / automations: always through an approval. Fail-soft."""
    try:
        return create_post(cur, client_id, channel, body, media_url, source, requested_by,
                           direct=False)
    except Exception as error:
        logger.info("social post request skipped: %s", error)
        return None


def resolve_post_approval(cur, client_id: int, row: Dict[str, Any], approved: bool,
                          args_override: Any = None, customer_reply: Any = None) -> Dict[str, Any]:
    """portal_approvals resolver for kind ``social_post``."""
    context = _json(row.get("context_json"))
    post_id = int(context.get("post_id") or 0)
    cur.execute("SELECT id, channel, body, media_url, status, source, requested_by FROM "
                + portal_db._q(POSTS_TABLE) + " WHERE id = %s AND client_id = %s",
                (post_id, client_id))
    found = portal_db.rows(cur)
    if not found:
        return {"outcome": "failed", "detail": "The post no longer exists."}
    post = found[0]
    if post["status"] != "pending_approval":
        return {"outcome": "recorded", "detail": "The post was already " + post["status"] + "."}
    if not approved:
        _set_post(cur, client_id, post_id, "rejected")
        return {"outcome": "recorded", "detail": "The post was not published."}
    problem = _post_problem(load_account(cur, client_id, post["channel"]), post["channel"],
                            post["body"], post["media_url"])
    if problem:
        _set_post(cur, client_id, post_id, "failed", "", problem)
        return {"outcome": "failed", "detail": problem}
    _queue_post(cur, client_id, post_id, post["channel"], post["body"], post["media_url"],
                "approval", post.get("requested_by"))
    return {"outcome": "executed", "detail": SPECS[post["channel"]]["label"]
            + " post queued for publishing."}


try:
    import portal_approvals as _approvals

    _approvals.register_resolver("social_post", resolve_post_approval)
except Exception as _error:  # pragma: no cover - approvals module missing
    logger.warning("social post approvals unavailable: %s", _error)


def _sync_posts(cur, client_id: int) -> None:
    """Login-mode posts are acked by the bridge: mirror the command result."""
    cur.execute("UPDATE " + portal_db._q(POSTS_TABLE) + " p SET status = CASE"
                " WHEN c.status = 'done' THEN 'published' ELSE 'failed' END,"
                " provider_post_id = CASE WHEN c.status = 'done' THEN"
                " LEFT(COALESCE(c.result_note, ''), 200) ELSE '' END,"
                " error = CASE WHEN c.status = 'done' THEN '' ELSE"
                " LEFT(COALESCE(c.result_note, ''), 300) END, updated_at = NOW()"
                " FROM " + portal_db._q(portal_db.CMD_TABLE) + " c"
                " WHERE p.client_id = %s AND p.status = 'queued' AND c.id = p.command_id"
                " AND c.client_id = p.client_id AND c.status IN ('done', 'dead')",
                (client_id,))


# ---------------------------------------------------------------------------
# portal API
# ---------------------------------------------------------------------------

URL = "/channels/social"
DOWN = {"error": {"code": "portal_unavailable",
                  "message": "Social channels are unavailable right now."}}


def _err(code: str, message: str, status: int):
    return jsonify({"error": {"code": code, "message": message}}), status


def _human_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, _err("portal_unavailable", str(error), 503)
    if principal is None:
        return None, _err("unauthorized", "Sign in required.", 401)
    forbidden = ensure_human_principal(principal)
    if forbidden:
        return None, forbidden
    return principal, None


def _can_edit(principal: Dict[str, Any]) -> bool:
    import portal_notify

    return portal_notify.can_edit(principal)


def _editor_or_error():
    principal, error = _human_or_error()
    if error:
        return None, error
    if not _can_edit(principal):
        return None, _err("forbidden", "Only owners and admins can change social channels.", 403)
    return principal, None


def _audit(cur, conn, client_id: int, principal: Dict[str, Any], note: str) -> None:
    try:
        with portal_txn.savepoint(cur, conn, "of_social_log"):
            portal_db.log_action(cur, client_id, "settings.social_channel", "user",
                                 principal.get("user_id"), None, note[:200])
    except Exception as error:
        logger.info("social channel audit skipped: %s", error)


def _webhook_url(channel: str, hook_key: str) -> str:
    if channel not in ("x", "tiktok") or not hook_key:
        return ""
    import portal_voice

    base, _ = portal_voice.webhook_base()
    return (base.rstrip("/") + "/api/v1/public/social/" + channel + "/webhook/" + hook_key) \
        if base else ""


def _account_public(account: Dict[str, Any], now: datetime) -> Dict[str, Any]:
    channel = account["channel"]
    spec = SPECS[channel]
    mode = account["mode"]
    seen = account.get("bridge_seen_at")
    if isinstance(seen, datetime) and seen.tzinfo is None:
        seen = seen.replace(tzinfo=timezone.utc)
    bridge_live = isinstance(seen, datetime) and (now - seen).total_seconds() <= BRIDGE_FRESH_SECONDS
    return {
        "channel": channel, "label": spec["label"], "mode": mode,
        "modes": [m for m in ("api", "login") if spec[m]],
        "capabilities": {"api": list(spec["api"]), "login": list(spec["login"])},
        "enabled": account.get("enabled") is True,
        "flags": {f: account["flags"].get(f) is True for f in FEATURES + ("comment_auto_reply",)},
        "app_id": account.get("app_id") or "",
        "app_secret_masked": _mask(account.get("app_secret")),
        "consumer_secret_masked": _mask(account.get("consumer_secret")),
        "bearer_token_masked": _mask(account.get("bearer_token")),
        "organization_id": str(account["config"].get("organization_id") or ""),
        "connected": bool(account.get("access_token")) if mode == "api" else bridge_live,
        "bridge_live": bridge_live, "bridge_state": account.get("bridge_state") or "",
        "account_name": account.get("account_name") or "",
        "webhook_url": _webhook_url(channel, account.get("hook_key") or "")
        if mode == "api" else "",
        "webhook_registered": bool(account.get("webhook_id")),
        "token_expires_at": _iso(account.get("token_expires_at")),
        "last_check_at": _iso(account.get("last_check_at")),
        "last_in_at": _iso(account.get("last_in_at")),
        "last_sent_at": _iso(account.get("last_sent_at")),
        "last_error": str(account.get("last_error") or "")[:300],
        "limits": limits_for(channel, mode), "post_max": spec["post_max"],
    }


def _state(cur, client_id: int, principal: Dict[str, Any]) -> Dict[str, Any]:
    _sync_posts(cur, client_id)
    now = _now(cur)
    cur.execute("SELECT " + _COLUMNS + " FROM " + portal_db._q(TABLE) +
                " WHERE client_id = %s", (client_id,))
    saved = {r["channel"]: _row(r) for r in portal_db.rows(cur)}
    cur.execute("SELECT id, channel, body, media_url, status, source, provider_post_id, error,"
                " created_at FROM " + portal_db._q(POSTS_TABLE) +
                " WHERE client_id = %s ORDER BY id DESC LIMIT %s", (client_id, RECENT_POSTS))
    posts = [{"id": int(r["id"]), "channel": r["channel"], "body": r["body"][:300],
              "media_url": r["media_url"], "status": r["status"], "source": r["source"],
              "provider_post_id": r["provider_post_id"], "error": r["error"],
              "created_at": _iso(r["created_at"])} for r in portal_db.rows(cur)]
    return {"available": ENABLED, "can_edit": _can_edit(principal),
            "channels": [_account_public(saved.get(c) or _blank(client_id, c), now)
                         for c in CHANNELS],
            "posts": posts}


def _with_cur(fn):
    """Run fn(cur, conn) in one transaction; storage failures -> 503."""
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                conn.commit()
                return fn(cur, conn)
        finally:
            conn.close()
    except Exception as failure:
        logger.warning("social channels request failed: %s", failure)
        return jsonify(DOWN), 503


@bp.get(URL)
def get_social_channels():
    principal, error = _human_or_error()
    if error:
        return error
    client_id = int(principal["client_id"])

    def read(cur, conn):
        state = _state(cur, client_id, principal)
        conn.commit()
        return jsonify(state), 200

    response = _with_cur(read)
    kick(client_id)
    return response


_SECRET_KEYS = ("app_secret", "consumer_secret", "bearer_token")


def _clean(channel: str, payload: Dict[str, Any], account: Dict[str, Any]):
    """(changes, error) for a settings save."""
    spec = SPECS[channel]
    changes: Dict[str, Any] = {}
    mode = payload.get("mode", account["mode"])
    if mode not in ("api", "login") or not spec[mode]:
        return None, spec["label"] + " supports " + " and ".join(
            m for m in ("api", "login") if spec[m]) + " mode only."
    if mode != account["mode"]:
        changes.update(mode=mode, enabled=False, access_token="", refresh_token="",
                       token_expires_at=None, webhook_id="", last_error="", bridge_state="")
    if "app_id" in payload:
        app_id = str(payload.get("app_id") or "").strip()
        if len(app_id) > 200 or not re.fullmatch(r"[A-Za-z0-9._\-]*", app_id):
            return None, "The app id / client id looks wrong."
        if app_id != account["app_id"]:
            changes.update(app_id=app_id, access_token="", refresh_token="", enabled=False,
                           token_expires_at=None, webhook_id="")
    for key in _SECRET_KEYS:
        value = str(payload.get(key) or "").strip()
        if value:  # write-only: blank keeps the saved value
            if len(value) > 500:
                return None, "A secret is too long."
            changes[key] = value
            if key == "app_secret":
                changes.update(access_token="", refresh_token="", enabled=False)
    config = dict(account["config"])
    if "organization_id" in payload and channel == "linkedin":
        org = str(payload.get("organization_id") or "").strip()
        if org and not org.isdigit():
            return None, "The LinkedIn Company Page id is a number (from the page admin URL)."
        config["organization_id"] = org
        changes["config"] = config
    flags = dict(account["flags"])
    if "flags" in payload:
        given = payload["flags"]
        if not isinstance(given, dict):
            return None, "flags must be an object."
        for key, value in given.items():
            if key not in FEATURES + ("comment_auto_reply",) or not isinstance(value, bool):
                return None, "Unknown or invalid switch: " + str(key)[:40]
            feature = "comments" if key == "comment_auto_reply" else key
            if value and feature not in spec[mode]:
                return None, spec["label"] + " cannot do " + feature + " in " + mode + " mode."
            flags[key] = value
        changes["flags"] = flags
    if "enabled" in payload:
        if not isinstance(payload["enabled"], bool):
            return None, "enabled must be true or false."
        changes["enabled"] = payload["enabled"]
    return changes, ""


@bp.put(URL + "/<channel>")
def save_social_channel(channel: str):
    principal, error = _editor_or_error()
    if error:
        return error
    if channel not in SPECS:
        return _err("not_found", "Unknown channel.", 404)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return _err("bad_request", "Send a JSON object.", 400)
    client_id = int(principal["client_id"])

    def save(cur, conn):
        account = load_account(cur, client_id, channel) or _blank(client_id, channel)
        changes, problem = _clean(channel, payload, account)
        if problem:
            conn.rollback()
            return _err("bad_request", problem, 400)
        if not changes:
            conn.rollback()
            return _err("bad_request", "Nothing to save.", 400)
        merged = dict(account, **changes)
        if merged.get("enabled") is True:
            if not ENABLED:
                conn.rollback()
                return _err("disabled", "Social channels are switched off on this platform.", 409)
            if merged["mode"] == "api" and not merged.get("access_token"):
                conn.rollback()
                return _err("not_ready", "Connect the account first.", 409)
        save_account(cur, client_id, channel, changes)
        _audit(cur, conn, client_id, principal, SPECS[channel]["label"] + " settings saved ("
               + merged["mode"] + " mode, " + ("on" if merged.get("enabled") else "off") + ")")
        state = _state(cur, client_id, principal)
        conn.commit()
        state["ok"] = True
        return jsonify(state), 200

    return _with_cur(save)


def _redirect_ok(uri: str) -> bool:
    parsed = urllib.parse.urlparse(uri)
    local = parsed.hostname in ("localhost", "127.0.0.1")
    return (parsed.scheme == "https" or (parsed.scheme == "http" and local)) and bool(
        parsed.hostname) and parsed.path.endswith(CALLBACK_SUFFIX) and not parsed.query \
        and len(uri) <= 500


@bp.post(URL + "/<channel>/oauth/start")
def oauth_start(channel: str):
    principal, error = _editor_or_error()
    if error:
        return error
    if channel not in SPECS or not SPECS[channel]["api"]:
        return _err("not_found", "This channel has no API connection.", 404)
    payload = request.get_json(silent=True)
    redirect_uri = str((payload or {}).get("redirect_uri") or "").strip() \
        if isinstance(payload, dict) else ""
    if not _redirect_ok(redirect_uri):
        return _err("bad_request", "Invalid redirect address.", 400)
    client_id = int(principal["client_id"])

    def start(cur, conn):
        account = load_account(cur, client_id, channel)
        if not account or account["mode"] != "api" or not account["app_id"] \
                or not account["app_secret"]:
            conn.rollback()
            return _err("not_ready", "Save your app id and secret first.", 409)
        verifier, challenge = _pkce()
        state = secrets.token_urlsafe(24)
        cur.execute("DELETE FROM " + portal_db._q(OAUTH_TABLE) + " WHERE expires_at < NOW()")
        cur.execute("INSERT INTO " + portal_db._q(OAUTH_TABLE) +
                    " (state, client_id, channel, verifier, redirect_uri, expires_at)"
                    " VALUES (%s, %s, %s, %s, %s, NOW() + (%s * INTERVAL '1 minute'))",
                    (state, client_id, channel, verifier, redirect_uri, OAUTH_TTL_MINUTES))
        conn.commit()
        return jsonify({"url": authorize_url(account, redirect_uri, state, challenge)}), 200

    return _with_cur(start)


@bp.post(URL + "/oauth/finish")
def oauth_finish():
    principal, error = _editor_or_error()
    if error:
        return error
    payload = request.get_json(silent=True)
    payload = payload if isinstance(payload, dict) else {}
    state, code = str(payload.get("state") or ""), str(payload.get("code") or "")
    if not state or not code or len(state) > 100 or len(code) > 2000:
        return _err("bad_request", "The sign-in answer is incomplete.", 400)
    client_id = int(principal["client_id"])

    def finish(cur, conn):
        cur.execute("DELETE FROM " + portal_db._q(OAUTH_TABLE) +
                    " WHERE state = %s RETURNING client_id, channel, verifier, redirect_uri,"
                    " expires_at > NOW() AS live", (state,))
        found = portal_db.rows(cur)
        conn.commit()  # one-time: the state is gone even when the exchange fails
        if not found or int(found[0]["client_id"]) != client_id or not found[0]["live"]:
            return _err("bad_request", "This sign-in link expired - start again.", 400)
        channel = found[0]["channel"]
        account = load_account(cur, client_id, channel)
        if not account or account["mode"] != "api":
            return _err("not_ready", "Switch the channel to API mode first.", 409)
        try:
            tokens = exchange_code(account, code, found[0]["redirect_uri"], found[0]["verifier"])
            account.update(tokens)
            who = whoami(account)
        except SocialApiError as failure:
            save_account(cur, client_id, channel, {"last_error": failure.message})
            conn.commit()
            return _err("provider_error", SPECS[channel]["label"] + ": " + failure.message,
                        503 if failure.kind == "retry" else 409)
        changes = dict(tokens, **who)
        changes.update(enabled=True, last_error="", cursor={}, webhook_id="")
        flags = dict(account["flags"])
        for feature in SPECS[channel]["api"]:
            flags.setdefault(feature, feature != "publish")
        changes["flags"] = flags
        save_account(cur, client_id, channel, changes)
        _audit(cur, conn, client_id, principal, SPECS[channel]["label"] + " connected ("
               + who.get("account_name", "") + ")")
        conn.commit()
        return jsonify({"ok": True, "channel": channel}), 200

    return _with_cur(finish)


@bp.post(URL + "/<channel>/<action>")
def channel_action(channel: str, action: str):
    principal, error = _editor_or_error()
    if error:
        return error
    if channel not in SPECS or action not in ("test", "webhook", "sync", "disconnect"):
        return _err("not_found", "Unknown action.", 404)
    client_id = int(principal["client_id"])

    def act(cur, conn):
        account = load_account(cur, client_id, channel)
        if not account:
            conn.rollback()
            return _err("not_ready", "Set the channel up first.", 409)
        label = SPECS[channel]["label"]
        if action == "disconnect":
            save_account(cur, client_id, channel, {
                "enabled": False, "access_token": "", "refresh_token": "",
                "token_expires_at": None, "webhook_id": "", "last_error": "",
                "bridge_state": ""})
            _audit(cur, conn, client_id, principal, label + " disconnected")
            conn.commit()
            return jsonify(dict(_state(cur, client_id, principal), ok=True)), 200
        if account["mode"] == "login":
            if action != "test":
                conn.rollback()
                return _err("bad_request", "Login mode runs on the laptop bridge.", 400)
            public = _account_public(account, _now(cur))
            conn.rollback()
            if not public["bridge_live"]:
                return _err("not_ready", "The laptop bridge has not checked in for "
                            + label + " in the last few minutes.", 409)
            return jsonify({"ok": True, "account_name": public["account_name"]}), 200
        if not account.get("access_token"):
            conn.rollback()
            return _err("not_ready", "Connect the account first.", 409)
        if action == "sync":
            conn.rollback()
            outcome = run(client_id, (channel,), MAX_SEND_PER_RUN, poll=True, paid=True)
            if outcome.get("reason") == "busy":
                return _err("busy", "A check is already running - try again in a minute.", 409)
            return jsonify({"ok": not outcome["errors"], "received": outcome["received"],
                            "sent": outcome["sent"], "error": outcome["errors"].get(channel, "")}), 200
        try:
            _fresh_token(cur, account)
            if action == "test":
                who = whoami(account)
                save_account(cur, client_id, channel, dict(who, last_error="",
                                                           last_check_at=_now(cur)))
                conn.commit()
                return jsonify({"ok": True, "account_name": who["account_name"]}), 200
            if channel not in ("x", "tiktok"):
                conn.rollback()
                return _err("bad_request", label + " has no webhook - comments are checked"
                            " every few minutes.", 400)
            url = _webhook_url(channel, account["hook_key"])
            if not url:
                conn.rollback()
                return _err("not_ready", "The Control Plane has no public address yet - set the"
                            " webhook base in the admin panel (Voice channel).", 409)
            conn.commit()  # X calls the CRC check while we wait
            webhook_id = register_webhook(account, url)
            save_account(cur, client_id, channel, {"webhook_id": webhook_id, "last_error": ""})
            _audit(cur, conn, client_id, principal, label + " webhook registered")
            conn.commit()
            return jsonify({"ok": True, "webhook_url": url}), 200
        except SocialApiError as failure:
            conn.rollback()
            save_account(cur, client_id, channel, {"last_error": label + ": " + failure.message})
            conn.commit()
            return _err("provider_error", label + ": " + failure.message,
                        503 if failure.kind == "retry" else 409)

    return _with_cur(act)


@bp.post(URL + "/posts")
def create_social_post():
    principal, error = _human_or_error()
    if error:
        return error
    payload = request.get_json(silent=True)
    payload = payload if isinstance(payload, dict) else {}
    channel = str(payload.get("channel") or "")
    if channel not in SPECS:
        return _err("bad_request", "Pick a channel.", 400)
    client_id = int(principal["client_id"])
    direct = _can_edit(principal)

    def post(cur, conn):
        try:
            created = create_post(cur, client_id, channel, str(payload.get("text") or ""),
                                  str(payload.get("media_url") or ""), "manual",
                                  principal.get("user_id"), direct)
        except ValueError as problem:
            conn.rollback()
            return _err("bad_request", str(problem), 400)
        _audit(cur, conn, client_id, principal, SPECS[channel]["label"] + " post "
               + ("queued" if direct else "sent for approval") + " (#" + str(created["id"]) + ")")
        conn.commit()
        return jsonify(dict(created, ok=True)), 200

    response = _with_cur(post)
    if direct and isinstance(response, tuple) and response[1] == 200:
        dispatch(client_id, channel)
    return response
