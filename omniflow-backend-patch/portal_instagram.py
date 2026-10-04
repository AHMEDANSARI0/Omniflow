"""Instagram Messaging API adapter for the shared OmniFlow message engine.

This module is intentionally an adapter, not a second inbox. Meta's signed
webhook events are verified and normalized, then handed to
``connector_api.ingest_messages_for_tenant`` so the existing idempotency,
conversation, one-reply, approval, compliance, workflow, sequence,
intelligence and audit hooks run unchanged.

The account token and app secret are tenant-scoped database values. The
optional environment app secret is only a migration/operations fallback; no
provider credential is embedded in source. Outbound messages use the existing
connector command queue and a service-key dispatch endpoint that calls the
Instagram Graph API.

§228 (Meta social): the same adapter also carries Facebook Messenger (Page
inbox, contact ``fb:<psid>``, channel ``messenger``) and comments on
Instagram posts (``igc:<user>``) and Facebook Page posts (``fbc:<user>``).
A comment conversation is answered with a PUBLIC reply to the commenter's
latest comment, so only an inbox reply ("manual"), an owner-approved reply
("approval") or - when the workspace turned it on - an AI answer may post
there; any other automation is refused and never retried. One webhook URL
(/api/v1/public/meta/webhook; the old /instagram/webhook keeps working)
takes both Meta objects ("instagram" and "page").
"""

import hashlib
import hmac
import json
import logging
import os
import secrets
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

from flask import Blueprint, Response, jsonify, request

import portal_db
import portal_vault
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)


logger = logging.getLogger("omniflow.instagram")

bp = Blueprint("portal_instagram", __name__, url_prefix="/api/v1/portal")
public_bp = Blueprint("instagram_public", __name__, url_prefix="/api/v1/public")
connector_bp = Blueprint("instagram_connector", __name__,
                         url_prefix="/api/v1/connector/instagram")

SETTINGS_TABLE = os.environ.get(
    "OF_INSTAGRAM_TABLE", "portal_instagram_accounts"
)
# §223: sealed at rest (verify_token stays plain - the webhook looks it up).
VAULT_FIELDS = ("app_secret", "access_token", "page_access_token")
COMMENTS_TABLE = os.environ.get("OF_META_COMMENTS_TABLE", "portal_meta_comments")
META_CHANNELS = ("instagram", "messenger")
COMMENT_PREFIXES = ("igc:", "fbc:")
#: command sources allowed to post a public comment reply (ai_brain only
#: when the workspace enabled comment auto-reply)
COMMENT_SOURCES = ("manual", "approval")
_COLUMNS = ("client_id, instagram_account_id, page_id, app_secret, access_token,"
            " verify_token, enabled, last_check_at, last_error, page_access_token,"
            " messenger_enabled, comments_enabled, comment_auto_reply")
_NEW_COLUMNS = (
    ("page_access_token", "TEXT NOT NULL DEFAULT ''"),
    ("messenger_enabled", "BOOLEAN NOT NULL DEFAULT FALSE"),
    ("comments_enabled", "BOOLEAN NOT NULL DEFAULT FALSE"),
    ("comment_auto_reply", "BOOLEAN NOT NULL DEFAULT FALSE"),
)
GRAPH_BASE_URL = os.environ.get(
    "OF_META_GRAPH_BASE_URL", "https://graph.facebook.com"
).rstrip("/")
GRAPH_VERSION = os.environ.get("OF_META_GRAPH_VERSION", "v21.0").strip()
MAX_BODY = 1000
MAX_WEBHOOK_BYTES = 2_000_000
_DDL_READY = False


class MetaGraphError(RuntimeError):
    """A provider request failed without exposing credentials in the message."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = int(status or 502)
        self.message = str(message)[:500]


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _mask_secret(value: Any) -> str:
    text = str(value or "")
    return "****" + text[-4:] if text else ""


def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {
            "code": "portal_unavailable", "message": str(error)}}), 503)
    if principal is None:
        return None, (jsonify({"error": {
            "code": "unauthorized", "message": "Sign in required."}}), 401)
    return principal, None


def _ensure_instagram_tables(conn) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(SETTINGS_TABLE) +
            " (client_id BIGINT PRIMARY KEY,"
            " instagram_account_id TEXT NOT NULL DEFAULT '',"
            " page_id TEXT NOT NULL DEFAULT '',"
            " app_secret TEXT NOT NULL DEFAULT '',"
            " access_token TEXT NOT NULL DEFAULT '',"
            " verify_token TEXT NOT NULL DEFAULT '',"
            " enabled BOOLEAN NOT NULL DEFAULT FALSE,"
            " last_check_at TIMESTAMPTZ,"
            " last_error TEXT,"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        cur.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_account_id"
            " ON " + portal_db._q(SETTINGS_TABLE) +
            " (instagram_account_id) WHERE instagram_account_id <> ''"
        )
        # §228: Messenger / comments columns. Guarded by information_schema
        # so a warm table never takes an ALTER lock; existing rows keep
        # their values (new switches default off).
        for column, ddl in _NEW_COLUMNS:
            cur.execute(
                "SELECT 1 FROM information_schema.columns"
                " WHERE table_schema = current_schema() AND table_name = %s"
                " AND column_name = %s", (SETTINGS_TABLE, column))
            if not portal_db.rows(cur):
                cur.execute("ALTER TABLE " + portal_db._q(SETTINGS_TABLE) +
                            " ADD COLUMN IF NOT EXISTS " + column + " " + ddl)
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_instagram_page_id ON "
            + portal_db._q(SETTINGS_TABLE) + " (page_id) WHERE page_id <> ''"
        )
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(COMMENTS_TABLE) +
            " (id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL,"
            " contact_id TEXT NOT NULL, comment_id TEXT NOT NULL,"
            " platform TEXT NOT NULL, post_id TEXT NOT NULL DEFAULT '',"
            " body TEXT NOT NULL DEFAULT '',"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " UNIQUE (client_id, comment_id))"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_meta_comments_contact ON "
            + portal_db._q(COMMENTS_TABLE) + " (client_id, contact_id, id DESC)"
        )
    conn.commit()
    _DDL_READY = True


def _load_settings(cur, client_id: Any) -> Optional[Dict[str, Any]]:
    cur.execute(
        "SELECT " + _COLUMNS +
        " FROM " + portal_db._q(SETTINGS_TABLE) +
        " WHERE client_id = %s LIMIT 1",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    return portal_vault.unseal_fields(rows[0], VAULT_FIELDS) if rows else None


def _load_by_account(cur, account_id: str) -> Optional[Dict[str, Any]]:
    cur.execute(
        "SELECT " + _COLUMNS +
        " FROM " + portal_db._q(SETTINGS_TABLE) +
        " WHERE instagram_account_id = %s LIMIT 1",
        (account_id,),
    )
    rows = portal_db.rows(cur)
    return portal_vault.unseal_fields(rows[0], VAULT_FIELDS) if rows else None


def _load_by_verify_token(cur, verify_token: str) -> Optional[Dict[str, Any]]:
    cur.execute(
        "SELECT " + _COLUMNS +
        " FROM " + portal_db._q(SETTINGS_TABLE) +
        " WHERE verify_token = %s"
        " AND (instagram_account_id <> '' OR page_id <> '')"
        " LIMIT 1",
        (verify_token,),
    )
    rows = portal_db.rows(cur)
    return portal_vault.unseal_fields(rows[0], VAULT_FIELDS) if rows else None


def _load_by_page(cur, page_id: str) -> Optional[Dict[str, Any]]:
    cur.execute(
        "SELECT " + _COLUMNS +
        " FROM " + portal_db._q(SETTINGS_TABLE) +
        " WHERE page_id = %s LIMIT 1",
        (page_id,),
    )
    rows = portal_db.rows(cur)
    return portal_vault.unseal_fields(rows[0], VAULT_FIELDS) if rows else None


def page_token(row: Dict[str, Any]) -> str:
    """Messenger / Page comments use the Page token; a single Page token
    saved as the access token works for both."""
    return str(row.get("page_access_token") or "").strip() or str(
        row.get("access_token") or "").strip()


def _settings_public(row: Dict[str, Any]) -> Dict[str, Any]:
    account_id = str(row.get("instagram_account_id") or "")
    access_token = str(row.get("access_token") or "")
    app_secret = str(row.get("app_secret") or "")
    verify_token = str(row.get("verify_token") or "")
    checked = row.get("last_check_at")
    if isinstance(checked, datetime) and checked.tzinfo is None:
        checked = checked.replace(tzinfo=timezone.utc)
    page_id = str(row.get("page_id") or "")
    return {
        "accountId": account_id,
        "pageId": page_id,
        "enabled": row.get("enabled") is True,
        "configured": bool(verify_token and (
            (account_id and access_token) or (page_id and page_token(row)))),
        "messengerEnabled": row.get("messenger_enabled") is True,
        "commentsEnabled": row.get("comments_enabled") is True,
        "commentAutoReply": row.get("comment_auto_reply") is True,
        "pageAccessTokenMasked": _mask_secret(row.get("page_access_token")),
        "webhookPath": "/api/v1/public/meta/webhook",
        "accessTokenMasked": _mask_secret(access_token),
        "appSecretMasked": _mask_secret(app_secret),
        "verifyTokenMasked": _mask_secret(verify_token),
        "lastCheckAt": checked.isoformat() if isinstance(checked, datetime) else None,
        "lastError": str(row.get("last_error") or "")[:300] or None,
    }


def _clean_settings(payload: Any, existing: Optional[Dict[str, Any]] = None):
    if not isinstance(payload, dict):
        return None, "Send a JSON object."
    existing = existing or {}
    account_id = str(payload.get("account_id") or "").strip()
    page_id = str(payload.get("page_id") or "").strip()
    access_token = str(payload.get("access_token") or "").strip()
    app_secret = str(payload.get("app_secret") or "").strip()
    verify_token = str(payload.get("verify_token") or "").strip()
    page_access_token = str(payload.get("page_access_token") or "").strip()
    if not page_access_token:
        page_access_token = str(existing.get("page_access_token") or "")
    if not access_token:
        access_token = str(existing.get("access_token") or "")
    if not app_secret:
        app_secret = str(existing.get("app_secret") or "")
    if not verify_token:
        verify_token = str(existing.get("verify_token") or "")
    if len(account_id) > 150 or len(page_id) > 150:
        return None, "Instagram account IDs are too long."
    if (len(access_token) > 2000 or len(page_access_token) > 2000
            or len(app_secret) > 500 or len(verify_token) > 500):
        return None, "One of the credentials is too long."
    if account_id and not access_token:
        return None, "Access token is required for an Instagram account."
    messenger_enabled = payload.get("messenger_enabled") is True
    comments_enabled = payload.get("comments_enabled") is True
    comment_auto_reply = payload.get("comment_auto_reply") is True and comments_enabled
    if messenger_enabled and not page_id:
        return None, "Messenger needs the Facebook Page ID."
    if messenger_enabled and not (page_access_token or access_token):
        return None, "Messenger needs a Page access token."
    if (account_id or page_id) and not verify_token:
        return None, "A webhook verify token is required."
    # The Meta app secret may be intentionally supplied by the environment
    # during a controlled migration. Do not pretend an account is connected
    # without one of those two real sources.
    if (account_id or page_id) and not app_secret \
            and not os.environ.get("OF_INSTAGRAM_APP_SECRET", "").strip():
        return None, "App secret is required for signed Meta webhooks."
    return {
        "account_id": account_id,
        "page_id": page_id,
        "access_token": access_token,
        "app_secret": app_secret,
        "verify_token": verify_token,
        "page_access_token": page_access_token,
        "messenger_enabled": messenger_enabled,
        "comments_enabled": comments_enabled,
        "comment_auto_reply": comment_auto_reply,
        "requested_enabled": payload.get("enabled") is True,
    }, None


def _graph_path(path: str) -> str:
    clean = "/" + str(path or "").lstrip("/")
    version = GRAPH_VERSION.strip("/")
    return "/" + version + clean if version else clean


def _meta_request(method: str, path: str, access_token: str,
                  payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Call Meta Graph API; kept module-level so deterministic tests can stub it."""
    if not access_token:
        raise MetaGraphError(401, "Instagram access token is missing.")
    body = None
    headers = {
        "Authorization": "Bearer " + access_token,
        "Accept": "application/json",
    }
    if payload is not None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        GRAPH_BASE_URL + _graph_path(path),
        data=body,
        headers=headers,
        method=method.upper(),
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            raw = response.read().decode("utf-8")
            parsed = json.loads(raw or "{}")
            return parsed if isinstance(parsed, dict) else {}
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(raw or "{}")
        except Exception:
            parsed = {}
        detail = parsed.get("error") if isinstance(parsed, dict) else None
        if isinstance(detail, dict):
            message = str(detail.get("message") or "Meta Graph API rejected the request.")
        else:
            message = "Meta Graph API rejected the request."
        raise MetaGraphError(error.code, message) from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise MetaGraphError(502, "Meta Graph API is unreachable.") from error
    except json.JSONDecodeError as error:
        raise MetaGraphError(502, "Meta Graph API returned invalid JSON.") from error


def _app_secret(row: Dict[str, Any]) -> str:
    return str(row.get("app_secret") or "").strip() or os.environ.get(
        "OF_INSTAGRAM_APP_SECRET", ""
    ).strip()


def verify_meta_signature(raw_body: bytes, signature: str,
                          app_secret: str) -> bool:
    """Verify Meta's X-Hub-Signature-256 header without accepting weak forms."""
    if not raw_body or not app_secret or not isinstance(signature, str):
        return False
    prefix, separator, digest = signature.partition("=")
    if prefix.lower() != "sha256" or separator != "=" or len(digest) != 64:
        return False
    if any(char not in "0123456789abcdefABCDEF" for char in digest):
        return False
    expected = hmac.new(
        app_secret.encode("utf-8"), raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, digest)


def _account_id_from_event(entry: Dict[str, Any], event: Dict[str, Any]) -> str:
    recipient = event.get("recipient")
    if isinstance(recipient, dict):
        value = recipient.get("id")
        if isinstance(value, (str, int)) and str(value).strip():
            return str(value).strip()
    value = entry.get("id")
    return str(value).strip() if isinstance(value, (str, int)) else ""


def _attachment_public(attachment: Dict[str, Any]) -> Dict[str, Any]:
    payload = attachment.get("payload")
    payload = payload if isinstance(payload, dict) else {}
    result: Dict[str, Any] = {
        "type": str(attachment.get("type") or "file").strip().lower()[:40],
    }
    url = payload.get("url")
    if isinstance(url, str) and url.strip():
        result["url"] = url.strip()[:2000]
    if payload.get("sticker_id") is not None:
        result["sticker_id"] = str(payload.get("sticker_id"))[:100]
    return result


def normalize_instagram_events(payload: Any,
                               account_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Normalize text, media and postback events from Meta's webhook shape."""
    return _normalize_messaging(payload, account_id, "ig:", "instagram",
                                "meta_instagram", "[Instagram attachment]")


def normalize_messenger_events(payload: Any,
                               page_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Facebook Page inbox (object "page"): same event shape, PSID contacts."""
    return _normalize_messaging(payload, page_id, "fb:", "messenger",
                                "meta_messenger", "[Messenger attachment]")


def _normalize_messaging(payload: Any, account_id: Optional[str], prefix: str,
                         channel: str, provider: str,
                         attachment_label: str) -> List[Dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    normalized: List[Dict[str, Any]] = []
    for entry in payload.get("entry") or []:
        if not isinstance(entry, dict):
            continue
        entry_account = str(entry.get("id") or "").strip()
        if account_id and entry_account and entry_account != str(account_id):
            continue
        events = entry.get("messaging")
        if not isinstance(events, list):
            continue
        for index, event in enumerate(events):
            if not isinstance(event, dict):
                continue
            sender = event.get("sender")
            sender_id = sender.get("id") if isinstance(sender, dict) else None
            if not isinstance(sender_id, (str, int)) or not str(sender_id).strip():
                continue
            message = event.get("message")
            message = message if isinstance(message, dict) else {}
            if message.get("is_echo") is True:
                continue
            postback = event.get("postback")
            postback = postback if isinstance(postback, dict) else None
            quick_reply = message.get("quick_reply")
            quick_reply = quick_reply if isinstance(quick_reply, dict) else None
            if quick_reply and postback is None:
                postback = {
                    "payload": quick_reply.get("payload"),
                    "title": quick_reply.get("title"),
                    "source": "quick_reply",
                }
            attachments: List[Dict[str, Any]] = []
            raw_attachments = message.get("attachments")
            if isinstance(raw_attachments, list):
                attachments = [
                    _attachment_public(item)
                    for item in raw_attachments if isinstance(item, dict)
                ]
            text = message.get("text")
            text = text.strip() if isinstance(text, str) else ""
            if not text and postback:
                title = postback.get("title")
                payload_value = postback.get("payload")
                text = str(title or payload_value or "").strip()
            if not text and attachments:
                text = attachment_label
            if not text and not attachments:
                # Delivery/read events do not represent customer messages.
                continue
            provider_id = message.get("mid")
            if not isinstance(provider_id, (str, int)) or not str(provider_id).strip():
                provider_id = event.get("id")
            if not isinstance(provider_id, (str, int)) or not str(provider_id).strip():
                provider_id = "event:" + entry_account + ":" + str(event.get("timestamp") or index)
            record: Dict[str, Any] = {
                "from": prefix + str(sender_id).strip(),
                "body": text[:MAX_BODY],
                "name": str(sender.get("name") or "").strip() or None
                if isinstance(sender, dict) else None,
                "direction": "in",
                "channel": channel,
                "id": str(provider_id).strip(),
                "provider": provider,
            }
            timestamp = event.get("timestamp")
            if isinstance(timestamp, (int, float, str)):
                record["timestamp"] = timestamp
            if attachments:
                record["media"] = attachments
            if postback:
                record["postback"] = {
                    "title": str(postback.get("title") or "")[:200],
                    "payload": str(postback.get("payload") or "")[:500],
                    "source": str(postback.get("source") or "postback")[:40],
                }
            normalized.append(record)
    return normalized


def normalize_comment_events(payload: Any, own_id: str,
                             platform: str) -> List[Dict[str, Any]]:
    """New comments on the account's posts -> inbound messages.

    platform "instagram": object "instagram", field "comments".
    platform "facebook": object "page", field "feed", item comment, verb add.
    The account's own comments (our replies) are skipped. Each record keeps
    a ``comment`` block (id, post, platform) so the reply can target it.
    """
    if not isinstance(payload, dict):
        return []
    out: List[Dict[str, Any]] = []
    for entry in payload.get("entry") or []:
        if not isinstance(entry, dict):
            continue
        entry_id = str(entry.get("id") or "").strip()
        if own_id and entry_id and entry_id != str(own_id):
            continue
        for change in entry.get("changes") or []:
            if not isinstance(change, dict):
                continue
            value = change.get("value")
            value = value if isinstance(value, dict) else {}
            author = value.get("from")
            author = author if isinstance(author, dict) else {}
            if platform == "instagram":
                if change.get("field") != "comments":
                    continue
                comment_id, text = value.get("id"), value.get("text")
                media = value.get("media")
                post_id = media.get("id") if isinstance(media, dict) else ""
                name, prefix, channel = author.get("username"), "igc:", "instagram"
            else:
                if (change.get("field") != "feed" or value.get("item") != "comment"
                        or value.get("verb") != "add"):
                    continue
                comment_id, text = value.get("comment_id"), value.get("message")
                post_id = value.get("post_id")
                name, prefix, channel = author.get("name"), "fbc:", "messenger"
            author_id = str(author.get("id") or "").strip()
            comment_id = str(comment_id or "").strip()
            text = text.strip() if isinstance(text, str) else ""
            if not comment_id or not author_id or not text or len(author_id) > 100:
                continue
            if author_id in (str(own_id or ""), entry_id):
                continue
            out.append({
                "from": prefix + author_id,
                "body": text[:MAX_BODY],
                "name": str(name or "").strip()[:200] or None,
                "direction": "in",
                "channel": channel,
                "id": "comment:" + comment_id[:200],
                "provider": "meta_comments",
                "comment": {"id": comment_id[:200], "platform": platform,
                            "post_id": str(post_id or "")[:200]},
            })
    return out


def _record_comments(client_id: int, comments: List[Dict[str, Any]]) -> None:
    """Remember each comment so a reply can target the latest one."""
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            for item in comments:
                info = item["comment"]
                cur.execute(
                    "INSERT INTO " + portal_db._q(COMMENTS_TABLE) +
                    " (client_id, contact_id, comment_id, platform, post_id, body)"
                    " VALUES (%s, %s, %s, %s, %s, %s)"
                    " ON CONFLICT (client_id, comment_id) DO NOTHING",
                    (client_id, item["from"], info["id"], info["platform"],
                     info["post_id"], item["body"][:500]))
        conn.commit()
    finally:
        conn.close()


def latest_comment(cur, client_id: int, contact_id: str) -> Optional[Dict[str, Any]]:
    cur.execute(
        "SELECT comment_id, platform, post_id FROM " + portal_db._q(COMMENTS_TABLE) +
        " WHERE client_id = %s AND contact_id = %s ORDER BY id DESC LIMIT 1",
        (client_id, contact_id))
    rows = portal_db.rows(cur)
    return rows[0] if rows else None


def comment_auto_reply(cur, client_id: int) -> bool:
    """True only when the workspace turned on AI answers for comments."""
    cur.execute(
        "SELECT comments_enabled, comment_auto_reply FROM " + portal_db._q(SETTINGS_TABLE) +
        " WHERE client_id = %s LIMIT 1", (client_id,))
    rows = portal_db.rows(cur)
    return bool(rows and rows[0].get("comments_enabled") is True
                and rows[0].get("comment_auto_reply") is True)


def _events_for(obj: str, payload: Dict[str, Any], row: Dict[str, Any]):
    """(all inbound records, the comment records) for one workspace."""
    comments_on = row.get("comments_enabled") is True
    if obj == "instagram":
        own = str(row.get("instagram_account_id") or "")
        events = normalize_instagram_events(payload, account_id=own)
        comments = normalize_comment_events(payload, own, "instagram") if comments_on else []
    else:
        own = str(row.get("page_id") or "")
        events = (normalize_messenger_events(payload, page_id=own)
                  if row.get("messenger_enabled") is True else [])
        comments = normalize_comment_events(payload, own, "facebook") if comments_on else []
    return events + comments, comments


def _json_payload(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _target_id(value: Any) -> str:
    target = str(value or "").strip()
    for prefix in ("ig:", "fb:"):
        if target.startswith(prefix):
            return target[len(prefix):]
    return target


def _outbound_graph_payload(action: str, command: Dict[str, Any],
                            account_id: str) -> Dict[str, Any]:
    payload = _json_payload(command.get("payload"))
    target = _target_id(payload.get("external_user_id"))
    if not target or len(target) > 200:
        raise MetaGraphError(400, "Meta recipient is missing.")
    recipient: Dict[str, Any] = {"id": target}
    body = str(payload.get("body") or "").strip()[:MAX_BODY]
    if action == "send_message":
        if not body:
            raise MetaGraphError(400, "Instagram text message is empty.")
        message: Dict[str, Any] = {"text": body}
    elif action == "send_interactive":
        if not body:
            raise MetaGraphError(400, "Instagram interactive message is empty.")
        message = {"text": body}
        interactive = payload.get("interactive")
        interactive = interactive if isinstance(interactive, dict) else {}
        raw_replies = interactive.get("quick_replies") or interactive.get("buttons")
        if isinstance(raw_replies, list):
            replies = []
            for item in raw_replies[:13]:
                if not isinstance(item, dict):
                    continue
                title = str(item.get("title") or item.get("label") or "").strip()
                if not title:
                    continue
                replies.append({
                    "content_type": "text",
                    "title": title[:20],
                    "payload": str(item.get("payload") or item.get("id") or title)[:1000],
                })
            if replies:
                message["quick_replies"] = replies
    elif action == "send_media":
        media_url = str(
            payload.get("media_url") or payload.get("url") or ""
        ).strip()
        if not media_url.lower().startswith(("http://", "https://")):
            raise MetaGraphError(400, "Instagram media URL is required.")
        kind = str(payload.get("kind") or "image").lower()
        kind = {"document": "file", "photo": "image"}.get(kind, kind)
        if kind not in ("image", "video", "audio", "file"):
            kind = "file"
        message = {
            "attachment": {
                "type": kind,
                "payload": {"url": media_url, "is_reusable": False},
            }
        }
    else:
        raise MetaGraphError(400, "Unsupported Instagram command.")
    return {"recipient": recipient, "message": message}


# ---------------------------------------------------------------------------
# Workspace configuration and provider check
# ---------------------------------------------------------------------------


@bp.get("/instagram/settings")
def get_instagram_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_instagram_tables(conn)
            with conn.cursor() as cur:
                row = _load_settings(cur, principal["client_id"])
        finally:
            conn.close()
    except Exception as error:
        logger.warning("instagram settings read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "instagram settings read")[0]), 503
    return jsonify({"settings": _settings_public(row or {})}), 200


@bp.put("/instagram/settings")
def save_instagram_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    raw = request.get_json(silent=True) or {}
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_instagram_tables(conn)
            with conn.cursor() as cur:
                existing = _load_settings(cur, principal["client_id"])
                clean, validation_error = _clean_settings(raw, existing)
                if validation_error:
                    return jsonify({"error": {"code": "bad_request",
                                              "message": validation_error}}), 400
                if clean["page_id"]:
                    owner = _load_by_page(cur, clean["page_id"])
                    if owner and int(owner.get("client_id") or 0) != int(principal["client_id"]):
                        return jsonify({"error": {"code": "page_taken", "message":
                                        "This Facebook Page is already connected to another workspace."}}), 409
                changed = any(
                    clean[key] != str((existing or {}).get(db_key) or "")
                    for key, db_key in (
                        ("account_id", "instagram_account_id"),
                        ("page_id", "page_id"),
                        ("access_token", "access_token"),
                        ("app_secret", "app_secret"),
                        ("verify_token", "verify_token"),
                        ("page_access_token", "page_access_token"),
                    )
                )
                keep_connected = (
                    clean["requested_enabled"] and not changed
                    and existing is not None and existing.get("enabled") is True
                )
                cur.execute(
                    "INSERT INTO " + portal_db._q(SETTINGS_TABLE) +
                    " (client_id, instagram_account_id, page_id, app_secret,"
                    " access_token, verify_token, enabled, last_error,"
                    " page_access_token, messenger_enabled, comments_enabled,"
                    " comment_auto_reply)"
                    " VALUES (%s, %s, %s, %s, %s, %s, %s, NULL, %s, %s, %s, %s)"
                    " ON CONFLICT (client_id) DO UPDATE SET"
                    " instagram_account_id = EXCLUDED.instagram_account_id,"
                    " page_id = EXCLUDED.page_id,"
                    " app_secret = EXCLUDED.app_secret,"
                    " access_token = EXCLUDED.access_token,"
                    " verify_token = EXCLUDED.verify_token,"
                    " enabled = EXCLUDED.enabled,"
                    " page_access_token = EXCLUDED.page_access_token,"
                    " messenger_enabled = EXCLUDED.messenger_enabled,"
                    " comments_enabled = EXCLUDED.comments_enabled,"
                    " comment_auto_reply = EXCLUDED.comment_auto_reply,"
                    " last_error = NULL, updated_at = NOW()",
                    (principal["client_id"], clean["account_id"],
                     clean["page_id"], portal_vault.seal(clean["app_secret"]),
                     portal_vault.seal(clean["access_token"]),
                     clean["verify_token"], keep_connected,
                     portal_vault.seal(clean["page_access_token"]),
                     clean["messenger_enabled"], clean["comments_enabled"],
                     clean["comment_auto_reply"]),
                )
                portal_db.log_action(
                    cur, principal["client_id"], "instagram.settings",
                    "customer_user", principal.get("user_id"), None,
                    "Meta settings saved (Instagram / Messenger / comments); provider"
                    " check required after credential changes.",
                )
                cur.execute(
                    "SELECT " + _COLUMNS +
                    " FROM " + portal_db._q(SETTINGS_TABLE) +
                    " WHERE client_id = %s",
                    (principal["client_id"],),
                )
                saved = [portal_vault.unseal_fields(r, VAULT_FIELDS)
                         for r in portal_db.rows(cur)]
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("instagram settings save failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "instagram settings save")[0]), 503
    return jsonify({"ok": True, "settings": _settings_public(saved[0] if saved else clean),
                    "requires_check": not bool(keep_connected)}), 200


@bp.post("/instagram/test")
def test_instagram_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    row = None
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_instagram_tables(conn)
            with conn.cursor() as cur:
                row = _load_settings(cur, principal["client_id"])
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "instagram test read")[0]), 503
    has_ig = bool(row and row.get("instagram_account_id") and row.get("access_token"))
    has_page = bool(row and row.get("page_id") and page_token(row))
    if not has_ig and not has_page:
        return jsonify({"error": {"code": "not_configured",
                                  "message": "Save the Instagram account or the Facebook Page and its token first."}}), 409
    profile: Dict[str, Any] = {}
    page: Dict[str, Any] = {}
    try:
        if has_ig:
            profile = _meta_request(
                "GET", "/" + urllib.parse.quote(
                    str(row["instagram_account_id"]), safe=""
                ) + "?fields=id,username",
                str(row["access_token"]),
            )
            returned_id = str(profile.get("id") or "").strip()
            if returned_id and returned_id != str(row["instagram_account_id"]):
                raise MetaGraphError(502, "Meta returned a different Instagram account.")
        if has_page and (row.get("messenger_enabled") is True or not has_ig):
            page = _meta_request(
                "GET", "/" + urllib.parse.quote(str(row["page_id"]), safe="")
                + "?fields=id,name", page_token(row))
            if str(page.get("id") or "").strip() not in ("", str(row["page_id"])):
                raise MetaGraphError(502, "Meta returned a different Facebook Page.")
    except MetaGraphError as provider_error:
        try:
            conn = portal_db._conn()
            try:
                _ensure_instagram_tables(conn)
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE " + portal_db._q(SETTINGS_TABLE) +
                        " SET enabled = FALSE, last_error = %s, updated_at = NOW()"
                        " WHERE client_id = %s",
                        (provider_error.message, principal["client_id"]),
                    )
                conn.commit()
            finally:
                conn.close()
        except Exception:
            pass
        return jsonify({"error": {"code": "provider_error",
                                  "message": provider_error.message}}), 502
    try:
        conn = portal_db._conn()
        try:
            _ensure_instagram_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(SETTINGS_TABLE) +
                    " SET enabled = TRUE, last_check_at = NOW(), last_error = NULL,"
                    " updated_at = NOW() WHERE client_id = %s",
                    (principal["client_id"],),
                )
                portal_db.log_action(
                    cur, principal["client_id"], "instagram.provider_checked",
                    "customer_user", principal.get("user_id"), None,
                    "Meta Graph API account check passed.",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "instagram test save")[0]), 503
    return jsonify({"ok": True, "profile": {
        "id": profile.get("id"), "username": profile.get("username")
    }, "page": {"id": page.get("id"), "name": page.get("name")} if page else None}), 200


# ---------------------------------------------------------------------------
# Meta webhook: GET verification + signed POST ingestion
# ---------------------------------------------------------------------------


@public_bp.get("/instagram/webhook")
@public_bp.get("/meta/webhook")
def verify_instagram_webhook():
    mode = request.args.get("hub.mode", "")
    verify_token = request.args.get("hub.verify_token", "")
    challenge = request.args.get("hub.challenge", "")
    if mode != "subscribe" or not verify_token or not challenge:
        return Response("Bad webhook verification request.", status=400,
                        content_type="text/plain")
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_instagram_tables(conn)
            with conn.cursor() as cur:
                row = _load_by_verify_token(cur, verify_token)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "instagram webhook verify")[0]), 503
    if not row or not secrets.compare_digest(
            str(row.get("verify_token") or ""), verify_token):
        return Response("Forbidden.", status=403, content_type="text/plain")
    return Response(challenge, status=200, content_type="text/plain")


@public_bp.post("/instagram/webhook")
@public_bp.post("/meta/webhook")
def instagram_webhook():
    raw_body = request.get_data(cache=True)
    if len(raw_body) > MAX_WEBHOOK_BYTES:
        return jsonify({"error": {"code": "payload_too_large",
                                  "message": "Webhook payload is too large."}}), 413
    signature = request.headers.get("X-Hub-Signature-256", "")
    payload = request.get_json(silent=True)
    obj = payload.get("object") if isinstance(payload, dict) else None
    if obj not in ("instagram", "page"):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Expected an Instagram or Facebook Page webhook payload."}}), 400
    loader = _load_by_account if obj == "instagram" else _load_by_page
    entries = payload.get("entry")
    if not isinstance(entries, list):
        return jsonify({"ok": True, "inserted": 0}), 200
    account_ids = {
        str(entry.get("id") or "").strip()
        for entry in entries if isinstance(entry, dict) and str(entry.get("id") or "").strip()
    }
    if not account_ids:
        return jsonify({"ok": True, "inserted": 0}), 200
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_instagram_tables(conn)
            with conn.cursor() as cur:
                rows = [loader(cur, account_id) for account_id in sorted(account_ids)]
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "instagram webhook account resolve")[0]), 503
    rows = [row for row in rows if row]
    if len(rows) != len(account_ids):
        return jsonify({"error": {"code": "unknown_account",
                                  "message": "This Meta account is not configured."}}), 404
    # Meta signs the complete raw body with the app secret. A shared app
    # normally means one secret; requiring every tenant match prevents an
    # account from being accepted under another tenant's secret.
    if not all(verify_meta_signature(raw_body, signature, _app_secret(row))
               for row in rows):
        return jsonify({"error": {"code": "invalid_signature",
                                  "message": "Webhook signature rejected."}}), 403
    if not any(row.get("enabled") is True for row in rows):
        return jsonify({"ok": True, "inserted": 0}), 200

    import connector_api

    total_inserted = 0
    for row in rows:
        events, comments = _events_for(obj, payload, row)
        if not events:
            continue
        if comments:
            try:
                _record_comments(int(row["client_id"]), comments)
            except Exception as error:
                logger.warning("meta comment record failed: %s", error)
        try:
            normalized = connector_api.normalize_messages(
                events, default_channel=events[0]["channel"]
            )
            total_inserted += connector_api.ingest_messages_for_tenant(
                {"client_id": row["client_id"], "user_id": None,
                 "source": "instagram_webhook"}, normalized
            )
        except connector_api.IngestRateLimited:
            return jsonify({"error": {"code": "rate_limited",
                                      "message": "Too many messages; slow down."}}), 429
        except connector_api.MessageValidationError as validation_error:
            return jsonify({"error": {"code": "bad_request",
                                      "message": str(validation_error)}}), 400
        except connector_api.IngestFailure as failure:
            logger.warning("instagram ingest failed: %s", failure.original)
            return jsonify(portal_db.portal_unavailable(
                failure.original, "instagram messages ingest")[0]), 503
    return jsonify({"ok": True, "inserted": total_inserted}), 200


# ---------------------------------------------------------------------------
# Connector command dispatch: queue -> real Meta Graph API -> event ack
# ---------------------------------------------------------------------------


@connector_bp.before_request
def _connector_guard():
    if request.method == "OPTIONS":
        return None
    import connector_api

    if not connector_api._authorized():
        return jsonify({"error": {"code": "forbidden",
                                  "message": "Service key missing or invalid."}}), 403
    return None


@connector_bp.post("/commands/dispatch")
def dispatch_instagram_command():
    payload = request.get_json(silent=True)
    payload = payload if isinstance(payload, dict) else {}
    command_id = payload.get("command_id")
    client_id = payload.get("client_id")
    if isinstance(command_id, str) and command_id.strip().isdigit():
        command_id = int(command_id.strip())
    if isinstance(client_id, str) and client_id.strip().isdigit():
        client_id = int(client_id.strip())
    if (isinstance(command_id, bool) or not isinstance(command_id, int)
            or command_id <= 0 or isinstance(client_id, bool)
            or not isinstance(client_id, int) or client_id <= 0):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "client_id and command_id are required."}}), 400

    comment = None
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_instagram_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, action, payload, status FROM "
                    + portal_db._q(portal_db.CMD_TABLE) +
                    " WHERE id = %s AND client_id = %s"
                    " AND channel IN ('instagram', 'messenger') LIMIT 1",
                    (command_id, client_id),
                )
                commands = portal_db.rows(cur)
                account = _load_settings(cur, client_id)
                contact = str(_json_payload(
                    commands[0].get("payload")).get("external_user_id") or ""
                ).strip() if commands else ""
                if contact.startswith(COMMENT_PREFIXES):
                    comment = latest_comment(cur, client_id, contact)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "meta command read")[0]), 503
    if not commands:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Meta command not found."}}), 404
    command = commands[0]
    if command.get("status") not in ("pending", "failed"):
        return jsonify({"ok": True, "status": command.get("status"),
                        "command_id": command_id}), 200
    if not account or account.get("enabled") is not True:
        return jsonify({"error": {"code": "not_configured",
                                  "message": "Meta provider check has not passed."}}), 409
    action = str(command.get("action") or "")
    payload_in = _json_payload(command.get("payload"))
    refusal = _route_refusal(contact, action, payload_in, account, comment)
    if refusal:
        _refuse(client_id, command_id, refusal)
        return jsonify({"error": {"code": "refused", "message": refusal},
                        "command_id": command_id}), 409
    try:
        if contact.startswith(COMMENT_PREFIXES):
            body = str(payload_in.get("body") or "").strip()[:MAX_BODY]
            if comment["platform"] == "instagram":
                path, token = "/" + urllib.parse.quote(
                    str(comment["comment_id"]), safe="") + "/replies", str(
                    account.get("access_token") or "")
            else:
                path, token = "/" + urllib.parse.quote(
                    str(comment["comment_id"]), safe="") + "/comments", page_token(account)
            graph_payload: Dict[str, Any] = {"message": body}
        elif contact.startswith("fb:"):
            page_id = str(account.get("page_id") or "")
            graph_payload = _outbound_graph_payload(action, command, page_id)
            graph_payload["messaging_type"] = "RESPONSE"
            path = "/" + urllib.parse.quote(page_id, safe="") + "/messages"
            token = page_token(account)
        else:
            graph_payload = _outbound_graph_payload(
                action, command, str(account.get("instagram_account_id") or ""))
            path = "/" + urllib.parse.quote(
                str(account.get("instagram_account_id") or ""), safe="") + "/messages"
            token = str(account.get("access_token") or "")
        result = _meta_request("POST", path, token, graph_payload)
        provider_message_id = str(
            result.get("message_id") or result.get("id") or ""
        ).strip() or None
        _ack_dispatch(client_id, command_id, True, "Meta accepted the message.",
                      provider_message_id)
    except MetaGraphError as provider_error:
        _ack_dispatch(client_id, command_id, False, provider_error.message, None)
        return jsonify({"error": {"code": "provider_error",
                                  "message": provider_error.message},
                        "command_id": command_id}), 502
    except Exception as error:
        _ack_dispatch(client_id, command_id, False, "Meta dispatch failed.", None)
        logger.warning("meta command dispatch failed: %s", error)
        return jsonify({"error": {"code": "dispatch_failed",
                                  "message": "Meta dispatch failed."},
                        "command_id": command_id}), 502
    return jsonify({"ok": True, "command_id": command_id,
                    "provider_message_id": provider_message_id}), 200


def _route_refusal(contact: str, action: str, payload: Dict[str, Any],
                   account: Dict[str, Any], comment: Optional[Dict[str, Any]]) -> str:
    """Why this command must never be sent (empty = send). Refusals are
    final: a retry cannot fix a policy or a switched-off channel."""
    if contact.startswith(COMMENT_PREFIXES):
        if account.get("comments_enabled") is not True:
            return "Comment replies are turned off for this workspace."
        source = str(payload.get("source") or "")
        if not (source in COMMENT_SOURCES or (
                source == "ai_brain" and account.get("comment_auto_reply") is True)):
            return "Automated messages are not posted as public comment replies."
        if action not in ("send_message", "send_interactive"):
            return "Comments take text replies only."
        if not str(payload.get("body") or "").strip():
            return "The comment reply is empty."
        if not comment:
            return "No comment from this person to reply to."
        if comment.get("platform") == "facebook" and not account.get("page_id"):
            return "The Facebook Page is not set."
        return ""
    if contact.startswith("fb:"):
        if account.get("messenger_enabled") is not True or not account.get("page_id"):
            return "Messenger is not turned on for this workspace."
        return ""
    if not account.get("instagram_account_id"):
        return "No Instagram account is connected."
    return ""


def _refuse(client_id: int, command_id: int, note: str) -> None:
    """Mark a command dead (no retry) with the reason the owner sees."""
    import portal_events

    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE " + portal_db._q(portal_db.CMD_TABLE) +
                " SET status = %s, result_note = %s, updated_at = NOW()"
                " WHERE id = %s AND client_id = %s"
                " AND channel IN ('instagram', 'messenger')",
                (portal_events._DEAD, note[:500], command_id, client_id))
            # optional outbox columns: a savepoint keeps the status update
            # above even when they are missing
            cur.execute("SAVEPOINT of_meta_refuse")
            try:
                portal_events._ensure_ddl(cur)
                cur.execute(
                    "UPDATE " + portal_db._q(portal_db.CMD_TABLE) +
                    " SET error_code = 'refused', error_message = %s,"
                    " next_attempt_at = NULL WHERE id = %s AND client_id = %s",
                    (note[:500], command_id, client_id))
                cur.execute("RELEASE SAVEPOINT of_meta_refuse")
            except Exception as error:
                cur.execute("ROLLBACK TO SAVEPOINT of_meta_refuse")
                logger.info("meta refusal bookkeeping skipped: %s", error)
        conn.commit()
    finally:
        conn.close()


def _ack_dispatch(client_id: int, command_id: int, ok: bool,
                  note: str, provider_message_id: Optional[str]) -> None:
    """Use the existing command/event retry bookkeeping for Graph delivery."""
    import portal_events

    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE " + portal_db._q(portal_db.CMD_TABLE) +
                " SET status = %s, result_note = %s, updated_at = NOW()"
                " WHERE id = %s AND client_id = %s"
                " AND channel IN ('instagram', 'messenger')",
                ("done" if ok else "pending", str(note or "")[:500],
                 command_id, client_id),
            )
            portal_events.on_command_ack(
                cur, client_id, command_id, ok, str(note or "")[:500],
                provider_message_id,
            )
        conn.commit()
    finally:
        conn.close()
