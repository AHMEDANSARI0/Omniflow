"""Customer media store (§214): keep what customers send, even after the
provider link expires.

Instagram (Meta) delivers images and voice notes as short-lived CDN links;
Telegram and the WhatsApp laptop bridge deliver the bytes inline. Before
this module the inbox could not show any of it afterwards, and a Meta link
that had expired could never be fetched again.

What happens now, on the one ingest path (connector_api), right after the
message row is written:

  * a small reference row is recorded for EVERY inbound attachment
    (channel, provider message id, index, kind, latest link);
  * for images and voice notes a COPY of the bytes is kept (owner switch,
    default on) - bytes already downloaded by media understanding are
    reused, so nothing is fetched twice;
  * copies are bounded: per-file cap (fits the Vercel response limit), a
    per-workspace quota (oldest copies are released first) and a
    retention window (days) - all owner-editable within platform ceilings
    set by env;
  * when there is no copy (switch off, too large, expired) and the channel
    is Instagram, opening the file asks the Graph API for a fresh link
    (GET /<message-id>?fields=attachments). Meta only answers this for the
    20 most recent messages of a conversation - which is exactly why the
    copy exists.

Laws kept:
  * customer media is untrusted: bytes are served only when their magic
    bytes say image (JPEG/PNG/WebP/GIF) or audio (OGG/MP3/M4A/WAV/WebM/AMR);
    always with nosniff + a sandbox CSP; SVG/HTML are never served inline;
  * links go through the knowledge engine's SSRF guard (public hosts only,
    every redirect re-checked) with a hard size cap;
  * tenant-scoped everywhere (client_id on every query);
  * fail-soft: capture runs inside a SAVEPOINT and can never lose or delay
    the customer's message;
  * data safety: "forget this customer" (Memory) also deletes their files;
    the owner can delete any single file;
  * no hardcoding: platform ceilings via env (OF_MEDIA_STORE_*), workspace
    choices in client_settings.media_store.
"""

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, Response, jsonify, request

import portal_db
from portal_auth import PortalAuthUnavailable, authenticate_portal_request

logger = logging.getLogger("omniflow.portal-inbound-media")

bp = Blueprint("portal_inbound_media", __name__, url_prefix="/api/v1/portal")

TABLE = "portal_inbound_media"
SETTINGS_KEY = "media_store"


def _env_int(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(str(os.environ.get(name, "")).strip() or default)
    except (TypeError, ValueError):
        value = default
    return max(low, min(high, value))


def platform_mode() -> str:
    mode = str(os.environ.get("OF_MEDIA_STORE_MODE", "on")).strip().lower()
    return "off" if mode == "off" else "on"


# Vercel functions cap a response body at 4.5 MB; a stored copy must be
# servable, so the per-file ceiling stays under it.
MAX_FILE_BYTES = _env_int("OF_MEDIA_STORE_MAX_FILE_BYTES", 4 * 1000 * 1000,
                          100 * 1000, 4400 * 1000)
MAX_QUOTA_MB = _env_int("OF_MEDIA_STORE_MAX_QUOTA_MB", 200, 10, 5000)
MAX_RETENTION_DAYS = _env_int("OF_MEDIA_STORE_MAX_RETENTION_DAYS", 90, 1, 3650)
DEFAULT_QUOTA_MB = _env_int("OF_MEDIA_STORE_DEFAULT_QUOTA_MB", 50, 10,
                            MAX_QUOTA_MB)
DEFAULT_RETENTION_DAYS = _env_int("OF_MEDIA_STORE_DEFAULT_RETENTION_DAYS", 30,
                                  1, MAX_RETENTION_DAYS)
PER_REQUEST_FETCHES = _env_int("OF_MEDIA_STORE_PER_REQUEST", 6, 0, 20)
FETCH_TIMEOUT = _env_int("OF_MEDIA_STORE_FETCH_TIMEOUT", 8, 2, 30)
PURGE_EVERY_SECONDS = _env_int("OF_MEDIA_STORE_PURGE_EVERY_SECONDS", 900,
                               60, 86400)
MAX_PER_MESSAGE = 5
LIST_LIMIT = _env_int("OF_MEDIA_STORE_LIST_LIMIT", 100, 10, 500)

KINDS_WITH_COPY = ("image", "audio")
VIDEO_TYPES = ("video", "reel", "ig_reel")
AUDIO_MIMES = {
    "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a",
    "audio/wav": "wav", "audio/webm": "webm", "audio/amr": "amr",
}
IMAGE_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
             "image/gif": "gif"}

_DDL = (
    "CREATE TABLE IF NOT EXISTS " + TABLE + " ("
    " id BIGSERIAL PRIMARY KEY,"
    " client_id BIGINT NOT NULL,"
    " conversation_id BIGINT,"
    " channel TEXT NOT NULL DEFAULT '',"
    " contact_id TEXT NOT NULL DEFAULT '',"
    " external_id TEXT NOT NULL DEFAULT '',"
    " media_index INTEGER NOT NULL DEFAULT 0,"
    " kind TEXT NOT NULL DEFAULT 'file',"
    " mime TEXT NOT NULL DEFAULT '',"
    " size_bytes INTEGER NOT NULL DEFAULT 0,"
    " source_url TEXT NOT NULL DEFAULT '',"
    " content BYTEA,"
    " status TEXT NOT NULL DEFAULT 'link',"
    " note TEXT NOT NULL DEFAULT '',"
    " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
    " stored_at TIMESTAMPTZ,"
    " url_refreshed_at TIMESTAMPTZ);"
    " CREATE INDEX IF NOT EXISTS portal_inbound_media_conv_idx ON " + TABLE +
    " (client_id, conversation_id, id DESC);"
    " CREATE INDEX IF NOT EXISTS portal_inbound_media_copy_idx ON " + TABLE +
    " (client_id, id) WHERE content IS NOT NULL;"
    " CREATE UNIQUE INDEX IF NOT EXISTS portal_inbound_media_ref_uq ON "
    + TABLE + " (client_id, channel, external_id, media_index)"
    " WHERE external_id <> '';"
    # §215: the message row the file arrived with (chat-bubble previews).
    " ALTER TABLE " + TABLE + " ADD COLUMN IF NOT EXISTS message_id BIGINT;"
    " CREATE INDEX IF NOT EXISTS portal_inbound_media_msg_idx ON " + TABLE +
    " (client_id, message_id) WHERE message_id IS NOT NULL"
)

_DDL_READY = False
_CS_READY = False


def ensure_ddl(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    _DDL_READY = True


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


# ---------------------------------------------------------------------------
# settings
# ---------------------------------------------------------------------------

def default_settings() -> Dict[str, Any]:
    return {"keep_copies": True, "retention_days": DEFAULT_RETENTION_DAYS,
            "quota_mb": DEFAULT_QUOTA_MB}


def limits() -> Dict[str, Any]:
    return {"mode": platform_mode(), "max_file_bytes": MAX_FILE_BYTES,
            "max_quota_mb": MAX_QUOTA_MB,
            "max_retention_days": MAX_RETENTION_DAYS}


def clean_settings(stored: Any) -> Dict[str, Any]:
    out = default_settings()
    if isinstance(stored, str):
        try:
            stored = json.loads(stored)
        except ValueError:
            stored = None
    if not isinstance(stored, dict):
        return out
    if isinstance(stored.get("keep_copies"), bool):
        out["keep_copies"] = stored["keep_copies"]
    for key, low, high in (("retention_days", 1, MAX_RETENTION_DAYS),
                           ("quota_mb", 10, MAX_QUOTA_MB)):
        value = stored.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            out[key] = max(low, min(high, value))
    return out


def validate_update(raw: Any, current: Dict[str, Any]
                    ) -> Tuple[Optional[Dict[str, Any]], str]:
    if not isinstance(raw, dict):
        return None, "settings must be an object."
    merged = dict(current)
    if "keep_copies" in raw:
        if not isinstance(raw["keep_copies"], bool):
            return None, "keep_copies must be true or false."
        merged["keep_copies"] = raw["keep_copies"]
    for key, low, high, label in (
            ("retention_days", 1, MAX_RETENTION_DAYS, "Keep files for"),
            ("quota_mb", 10, MAX_QUOTA_MB, "Storage limit")):
        if key not in raw:
            continue
        value = raw[key]
        if isinstance(value, bool) or not isinstance(value, int) \
                or not low <= value <= high:
            return None, (label + " must be a whole number between "
                          + str(low) + " and " + str(high) + ".")
        merged[key] = value
    return merged, ""


def load_settings(cur, client_id: int) -> Dict[str, Any]:
    _ensure_client_settings(cur)
    cur.execute(
        "SELECT settings -> 'media_store' AS media_store FROM "
        + portal_db._q("client_settings") + " WHERE client_id = %s",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    return clean_settings(rows[0].get("media_store") if rows else None)


def save_settings(cur, client_id: int, settings: Dict[str, Any]
                  ) -> Dict[str, Any]:
    clean = clean_settings(settings)
    _ensure_client_settings(cur)
    cur.execute(
        "INSERT INTO " + portal_db._q("client_settings") +
        " (client_id, settings) VALUES (%s, %s::jsonb)"
        " ON CONFLICT (client_id) DO UPDATE SET"
        " settings = client_settings.settings || EXCLUDED.settings,"
        " updated_at = NOW()",
        (client_id, json.dumps({SETTINGS_KEY: clean})),
    )
    return clean


# ---------------------------------------------------------------------------
# content checks (bytes decide, never the declared type)
# ---------------------------------------------------------------------------

def sniff_image(data: bytes) -> str:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return ""


def sniff_audio(data: bytes) -> str:
    if data[:4] == b"OggS":
        return "audio/ogg"
    if data[:3] == b"ID3" or (len(data) > 1 and data[0] == 0xFF
                              and (data[1] & 0xE0) == 0xE0):
        return "audio/mpeg"
    if data[4:8] == b"ftyp":
        return "audio/mp4"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav"
    if data[:4] == b"\x1a\x45\xdf\xa3":
        return "audio/webm"
    if data[:5] == b"#!AMR":
        return "audio/amr"
    return ""


def sniff(kind: str, data: bytes) -> str:
    if not data:
        return ""
    if kind == "image":
        return sniff_image(data)
    if kind == "audio":
        return sniff_audio(data)
    return ""


def classify(entry: Dict[str, Any]) -> str:
    import portal_media_ai

    kind = portal_media_ai._kind(entry)
    if kind:
        return kind
    declared = str(entry.get("type") or "").strip().lower()
    mime = str(entry.get("mime") or "").strip().lower()
    if declared in VIDEO_TYPES or mime.startswith("video/"):
        return "video"
    return "file"


def _public_url(value: Any) -> str:
    text = str(value or "").strip()
    return text[:2000] if text.lower().startswith("https://") else ""


def fetch(url: str, cap: int = 0) -> Tuple[bytes, str]:
    """Download a public link (SSRF-guarded, size-capped).
    Returns (bytes, declared mime); raises ValueError on any problem."""
    import portal_knowledge

    cap = cap or MAX_FILE_BYTES
    portal_knowledge.assert_public_url(url)
    req = urllib.request.Request(str(url).strip(), method="GET")
    req.add_header("User-Agent", "OmniFlow-Media/1.0")
    opener = urllib.request.build_opener(portal_knowledge._SafeRedirectHandler())
    try:
        with opener.open(req, timeout=FETCH_TIMEOUT) as resp:
            mime = str(resp.headers.get("Content-Type") or "").split(";")[0]
            data = resp.read(cap + 1)
    except urllib.error.HTTPError as error:
        raise ValueError("media host answered HTTP " + str(error.code))
    except ValueError:
        raise
    except Exception:
        raise ValueError("media could not be downloaded")
    if len(data) > cap:
        raise ValueError("too_large")
    return data, mime.strip().lower()


class Budget:
    """Per-ingest-request cap on link downloads done only for storage."""

    def __init__(self, limit: int = PER_REQUEST_FETCHES):
        self.left = int(limit)

    def take(self) -> bool:
        if self.left <= 0:
            return False
        self.left -= 1
        return True


def _binary(data: bytes):
    try:
        from psycopg2 import Binary
        return Binary(data)
    except ImportError:
        return data


# ---------------------------------------------------------------------------
# bounds: retention + quota (oldest copies released first)
# ---------------------------------------------------------------------------

def enforce_bounds(cur, client_id: int, settings: Dict[str, Any]) -> None:
    cur.execute(
        "UPDATE " + TABLE + " SET content = NULL, status = 'expired',"
        " note = 'retention' WHERE client_id = %s AND content IS NOT NULL"
        " AND created_at < NOW() - make_interval(days => %s)",
        (client_id, int(settings["retention_days"])),
    )
    cur.execute(
        "SELECT COALESCE(SUM(size_bytes), 0) AS used FROM " + TABLE +
        " WHERE client_id = %s AND content IS NOT NULL",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    used = int((rows[0].get("used") if rows else 0) or 0)
    over = used - int(settings["quota_mb"]) * 1024 * 1024
    if over <= 0:
        return
    cur.execute(
        "UPDATE " + TABLE + " SET content = NULL, status = 'expired',"
        " note = 'quota' WHERE client_id = %s AND id IN ("
        " SELECT id FROM (SELECT id, size_bytes, SUM(size_bytes) OVER"
        " (ORDER BY id) AS run FROM " + TABLE +
        " WHERE client_id = %s AND content IS NOT NULL) s"
        " WHERE s.run - s.size_bytes < %s)",
        (client_id, client_id, over),
    )


def usage(cur, client_id: int) -> Dict[str, int]:
    cur.execute(
        "SELECT COALESCE(SUM(size_bytes) FILTER (WHERE content IS NOT NULL),"
        " 0) AS used, COUNT(*) FILTER (WHERE content IS NOT NULL) AS copies,"
        " COUNT(*) AS files FROM " + TABLE + " WHERE client_id = %s",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    row = rows[0] if rows else {}
    return {"used_bytes": int(row.get("used") or 0),
            "copies": int(row.get("copies") or 0),
            "files": int(row.get("files") or 0)}


# ---------------------------------------------------------------------------
# capture (called by connector_api right after the message row is written)
# ---------------------------------------------------------------------------

def capture(cur, client_id: int, conversation_id: Optional[int],
            item: Dict[str, Any], blobs: Optional[List[bytes]] = None,
            budget: Optional[Budget] = None,
            message_id: Optional[int] = None) -> int:
    """Record every inbound attachment; keep copies of images and voice
    notes. Returns the number of copies stored. Never raises; savepoint
    guarded so the customer's message is never affected."""
    try:
        if platform_mode() == "off" or item.get("direction", "in") != "in":
            return 0
        media = item.get("media")
        if not isinstance(media, list) or not media:
            return 0
        fetched = item.get("_media_fetched")
        fetched = fetched if isinstance(fetched, dict) else {}
        entries = [(index, entry) for index, entry in enumerate(media)
                   if isinstance(entry, dict)][:MAX_PER_MESSAGE]
        if not entries:
            return 0
    except Exception:
        return 0
    try:
        cur.execute("SAVEPOINT of_inbound_media")
    except Exception:
        return 0
    stored = 0
    try:
        ensure_ddl(cur)
        settings = load_settings(cur, client_id)
        budget = budget or Budget()
        channel = str(item.get("channel") or "")[:40]
        contact = str(item.get("from") or "")[:200]
        external_id = str(item.get("id") or "")[:300]
        try:
            message_id = int(message_id) if message_id else None
        except (TypeError, ValueError):
            message_id = None
        for index, entry in entries:
            kind = classify(entry)
            url = _public_url(entry.get("url"))
            data = b""
            if blobs and index < len(blobs) and blobs[index]:
                data = blobs[index]
            elif index in fetched and isinstance(fetched[index], tuple):
                data = fetched[index][0] or b""
            status, note, content, mime = "link", "", None, ""
            if kind in KINDS_WITH_COPY and settings["keep_copies"]:
                if not data and url and budget.take():
                    try:
                        data, _declared = fetch(url)
                    except ValueError as error:
                        note = "too_large" if str(error) == "too_large" \
                            else "download_failed"
                        status = "too_large" if note == "too_large" else "link"
                if data:
                    mime = sniff(kind, data)
                    if not mime:
                        note = "unsupported"
                    elif len(data) > MAX_FILE_BYTES:
                        status, note = "too_large", "too_large"
                    else:
                        status, content = "stored", data
            elif kind in KINDS_WITH_COPY:
                note = "copies_off"
            if not content and not url:
                status = "failed" if status == "link" else status
                note = note or "no_source"
            size = len(content) if content else (len(data) if data else 0)
            cur.execute(
                "INSERT INTO " + TABLE +
                " (client_id, conversation_id, channel, contact_id,"
                " external_id, media_index, kind, mime, size_bytes,"
                " source_url, content, status, note, stored_at, message_id)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,"
                " %s, CASE WHEN %s THEN NOW() ELSE NULL END, %s)"
                " ON CONFLICT (client_id, channel, external_id, media_index)"
                " WHERE external_id <> '' DO NOTHING",
                (client_id, conversation_id, channel, contact, external_id,
                 index, kind, mime or str(entry.get("mime") or "")[:80],
                 size, url, _binary(content) if content else None, status,
                 note, bool(content), message_id),
            )
            if content:
                stored += 1
        if stored:
            enforce_bounds(cur, client_id, settings)
        cur.execute("RELEASE SAVEPOINT of_inbound_media")
    except Exception as error:
        logger.warning("inbound media capture failed: %s", error)
        try:
            cur.execute("ROLLBACK TO SAVEPOINT of_inbound_media")
        except Exception:
            pass
        return 0
    return stored


def forget_contact(cur, client_id: int, contact_id: str) -> int:
    """Data-safety switch: delete every stored file of one contact."""
    contact_id = str(contact_id or "").strip()
    if not contact_id:
        return 0
    ensure_ddl(cur)
    cur.execute(
        "DELETE FROM " + TABLE + " WHERE client_id = %s AND contact_id = %s"
        " RETURNING id",
        (client_id, contact_id),
    )
    return len(portal_db.rows(cur))


# ---------------------------------------------------------------------------
# Instagram: fresh link for an expired CDN URL
# ---------------------------------------------------------------------------

def _attachment_urls(payload: Dict[str, Any]) -> List[str]:
    block = payload.get("attachments")
    data = block.get("data") if isinstance(block, dict) else block
    urls: List[str] = []
    for att in data if isinstance(data, list) else []:
        if not isinstance(att, dict):
            continue
        found = ""
        for key in ("image_data", "video_data", "audio_data"):
            inner = att.get(key)
            if isinstance(inner, dict) and inner.get("url"):
                found = str(inner["url"])
                break
        if not found:
            found = str(att.get("file_url") or "")
        if not found and isinstance(att.get("payload"), dict):
            found = str(att["payload"].get("url") or "")
        urls.append(_public_url(found))
    return urls


def refresh_instagram_url(cur, client_id: int, external_id: str,
                          media_index: int) -> str:
    """Ask the Graph API for the current link of one attachment. Meta only
    answers for the 20 most recent messages of a conversation; anything
    else (no account, older message, API error) returns ""."""
    if not external_id or external_id.startswith("event:"):
        return ""
    try:
        import portal_instagram

        conn_row = portal_instagram._load_settings(cur, client_id)
        token = str((conn_row or {}).get("access_token") or "")
        if not token:
            return ""
        payload = portal_instagram._meta_request(
            "GET", "/" + urllib.parse.quote(external_id, safe="")
            + "?fields=attachments", token)
    except Exception as error:
        logger.info("instagram media refresh failed: %s", error)
        return ""
    urls = _attachment_urls(payload if isinstance(payload, dict) else {})
    if 0 <= media_index < len(urls) and urls[media_index]:
        return urls[media_index]
    return next((u for u in urls if u), "") if len(urls) == 1 else ""


# ---------------------------------------------------------------------------
# periodic retention (connector tick; own connection, throttled)
# ---------------------------------------------------------------------------

_BOOT = time.monotonic()
_LAST_PURGE: Dict[int, float] = {}
_PURGE_LOCK = threading.Lock()


def maybe_purge(client_id: int) -> bool:
    """Retention sweep for one workspace at most every
    PURGE_EVERY_SECONDS per process (the first one only after the process
    has been up that long, so short-lived runs never pay for it). Captures
    and the settings screen also apply the bounds. Never raises."""
    try:
        client_id = int(client_id or 0)
        if client_id <= 0 or platform_mode() == "off":
            return False
        now = time.monotonic()
        with _PURGE_LOCK:
            if now - _BOOT < PURGE_EVERY_SECONDS:
                return False
            if now - _LAST_PURGE.get(client_id, -1e18) < PURGE_EVERY_SECONDS:
                return False
            _LAST_PURGE[client_id] = now
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                ensure_ddl(cur)
                enforce_bounds(cur, client_id, load_settings(cur, client_id))
            conn.commit()
        finally:
            conn.close()
        return True
    except Exception as error:
        logger.info("media retention sweep skipped: %s", error)
        return False


# ---------------------------------------------------------------------------
# HTTP (owner)
# ---------------------------------------------------------------------------

def _principal_or_error(human_only: bool = False):
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": str(error)}}), 503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}),
                      401)
    if human_only and principal.get("via_api_key"):
        return None, (jsonify({"error": {"code": "forbidden",
                                         "message": "Owner sign-in"
                                                    " required."}}), 403)
    return principal, None


def _row_public(row: Dict[str, Any]) -> Dict[str, Any]:
    channel = str(row.get("channel") or "")
    has_copy = bool(row.get("has_copy"))
    has_link = bool(row.get("has_link"))
    return {
        "id": int(row.get("id") or 0),
        "message_id": int(row["message_id"]) if row.get("message_id")
        else None,
        "kind": str(row.get("kind") or "file"),
        "mime": str(row.get("mime") or ""),
        "size_bytes": int(row.get("size_bytes") or 0),
        "status": str(row.get("status") or ""),
        "note": str(row.get("note") or ""),
        "channel": channel,
        "has_copy": has_copy,
        "can_refresh": channel == "instagram"
        and bool(row.get("external_id")),
        "can_open": has_copy or has_link or (
            channel == "instagram" and bool(row.get("external_id"))),
        "created_at": None if row.get("created_at") is None
        else str(row.get("created_at")),
    }


def _unavailable(error: Exception, what: str):
    return jsonify(portal_db.portal_unavailable(error, what)[0]), 503


@bp.get("/conversations/<int:conversation_id>/media")
def list_conversation_media(conversation_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal["client_id"])
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE id = %s AND client_id = %s LIMIT 1",
                    (conversation_id, client_id),
                )
                if not portal_db.rows(cur):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Conversation not"
                                                         " found."}}), 404
                ensure_ddl(cur)
                # message_id: recorded at capture (§215). Files captured
                # before that are matched to the one inbound message
                # written in the same transaction (same NOW()); when a
                # batch makes that ambiguous the file stays unattached.
                msgs = portal_db._q(portal_db.MSGS_TABLE)
                cur.execute(
                    "SELECT f.id, f.kind, f.mime, f.size_bytes, f.status,"
                    " f.note, f.channel, f.external_id, f.created_at,"
                    " (f.content IS NOT NULL) AS has_copy,"
                    " (f.source_url <> '') AS has_link,"
                    " COALESCE(f.message_id, (SELECT MIN(m.id) FROM " + msgs +
                    " m WHERE m.client_id = f.client_id"
                    " AND m.conversation_id = f.conversation_id"
                    " AND m.direction = 'in' AND m.created_at = f.created_at"
                    " HAVING COUNT(*) = 1)) AS message_id"
                    " FROM " + TABLE + " f"
                    " WHERE f.client_id = %s AND f.conversation_id = %s"
                    " ORDER BY f.id DESC LIMIT %s",
                    (client_id, conversation_id, LIST_LIMIT),
                )
                items = [_row_public(r) for r in portal_db.rows(cur)]
            conn.commit()
        finally:
            conn.close()
    except Exception as err:
        return _unavailable(err, "conversation media")
    return jsonify({"media": items}), 200


def _load_row(cur, client_id: int, media_id: int, with_content: bool):
    cur.execute(
        "SELECT id, client_id, conversation_id, channel, contact_id,"
        " external_id, media_index, kind, mime, size_bytes, source_url,"
        " status" + (", content" if with_content else "") + " FROM " + TABLE
        + " WHERE id = %s AND client_id = %s LIMIT 1",
        (media_id, client_id),
    )
    rows = portal_db.rows(cur)
    return rows[0] if rows else None


def _download_name(kind: str, mime: str) -> str:
    ext = IMAGE_EXT.get(mime) or AUDIO_MIMES.get(mime) or "bin"
    return ("customer-image." if kind == "image" else "voice-note.") + ext


def _serve(kind: str, data: bytes, mime: str) -> Response:
    response = Response(data, status=200, mimetype=mime)
    response.headers["Content-Disposition"] = (
        'inline; filename="' + _download_name(kind, mime) + '"')
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
    response.headers["Cache-Control"] = "private, max-age=300"
    return response


def _gone(message: str):
    return jsonify({"error": {"code": "media_expired",
                              "message": message}}), 410


@bp.get("/inbound-media/<int:media_id>/content")
def inbound_media_content(media_id: int):
    """The file itself (images and voice notes only): the stored copy, else
    the provider link, else (Instagram) a freshly requested link. A file
    fetched this way is kept as a copy when the workspace keeps copies."""
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal["client_id"])
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                ensure_ddl(cur)
                row = _load_row(cur, client_id, media_id, True)
                if row is None:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "File not"
                                                         " found."}}), 404
                kind = str(row.get("kind") or "")
                if kind not in KINDS_WITH_COPY:
                    return jsonify({"error": {
                        "code": "open_link",
                        "message": "Open this file with its link."}}), 409
                content = row.get("content")
                if isinstance(content, memoryview):
                    content = content.tobytes()
                if content:
                    mime = sniff(kind, content)
                    conn.commit()
                    if not mime:
                        return _gone("This file cannot be shown.")
                    return _serve(kind, content, mime)
                data, mime = b"", ""
                url = str(row.get("source_url") or "")
                if url:
                    try:
                        data, _declared = fetch(url)
                    except ValueError:
                        data = b""
                refreshed = ""
                if not data and row.get("channel") == "instagram":
                    refreshed = refresh_instagram_url(
                        cur, client_id, str(row.get("external_id") or ""),
                        int(row.get("media_index") or 0))
                    if refreshed:
                        cur.execute(
                            "UPDATE " + TABLE + " SET source_url = %s,"
                            " url_refreshed_at = NOW() WHERE id = %s"
                            " AND client_id = %s",
                            (refreshed, media_id, client_id))
                        try:
                            data, _declared = fetch(refreshed)
                        except ValueError:
                            data = b""
                mime = sniff(kind, data) if data else ""
                if data and mime:
                    settings = load_settings(cur, client_id)
                    if settings["keep_copies"] and platform_mode() == "on":
                        cur.execute(
                            "UPDATE " + TABLE + " SET content = %s,"
                            " mime = %s, size_bytes = %s, status = 'stored',"
                            " note = '', stored_at = NOW() WHERE id = %s"
                            " AND client_id = %s",
                            (_binary(data), mime, len(data), media_id,
                             client_id))
                        enforce_bounds(cur, client_id, settings)
            conn.commit()
        finally:
            conn.close()
    except Exception as err:
        return _unavailable(err, "customer media")
    if not data or not mime:
        return _gone("This file is no longer available from the channel."
                     + (" Instagram only re-sends the latest messages of a"
                        " conversation." if row.get("channel") == "instagram"
                        else ""))
    return _serve(kind, data, mime)


@bp.get("/inbound-media/<int:media_id>/link")
def inbound_media_link(media_id: int):
    """Videos and other files are not copied (size); this returns the
    provider link, refreshed through the Graph API for Instagram."""
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal["client_id"])
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                ensure_ddl(cur)
                row = _load_row(cur, client_id, media_id, False)
                if row is None:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "File not"
                                                         " found."}}), 404
                url = str(row.get("source_url") or "")
                fresh = False
                if row.get("channel") == "instagram":
                    refreshed = refresh_instagram_url(
                        cur, client_id, str(row.get("external_id") or ""),
                        int(row.get("media_index") or 0))
                    if refreshed:
                        url, fresh = refreshed, True
                        cur.execute(
                            "UPDATE " + TABLE + " SET source_url = %s,"
                            " url_refreshed_at = NOW() WHERE id = %s"
                            " AND client_id = %s",
                            (refreshed, media_id, client_id))
            conn.commit()
        finally:
            conn.close()
    except Exception as err:
        return _unavailable(err, "customer media")
    url = _public_url(url)
    if not url:
        return _gone("This file has no link any more.")
    return jsonify({"url": url, "fresh": fresh}), 200


@bp.delete("/inbound-media/<int:media_id>")
def delete_inbound_media(media_id: int):
    principal, error = _principal_or_error(human_only=True)
    if error:
        return error
    client_id = int(principal["client_id"])
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                ensure_ddl(cur)
                cur.execute(
                    "DELETE FROM " + TABLE + " WHERE id = %s AND client_id = %s"
                    " RETURNING id",
                    (media_id, client_id),
                )
                deleted = bool(portal_db.rows(cur))
                if deleted:
                    portal_db.log_action(
                        cur, client_id, "media_store.deleted", "human",
                        principal.get("user_id"), None,
                        "Customer file #" + str(media_id) + " deleted")
            conn.commit()
        finally:
            conn.close()
    except Exception as err:
        return _unavailable(err, "customer media")
    if not deleted:
        return jsonify({"error": {"code": "not_found",
                                  "message": "File not found."}}), 404
    return jsonify({"ok": True}), 200


@bp.get("/media-store/settings")
def get_media_store_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal["client_id"])
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                ensure_ddl(cur)
                settings = load_settings(cur, client_id)
                enforce_bounds(cur, client_id, settings)
                used = usage(cur, client_id)
            conn.commit()
        finally:
            conn.close()
    except Exception as err:
        return _unavailable(err, "media storage settings")
    return jsonify({"settings": settings, "usage": used,
                    "limits": limits()}), 200


@bp.put("/media-store/settings")
def put_media_store_settings():
    principal, error = _principal_or_error(human_only=True)
    if error:
        return error
    raw = request.get_json(silent=True) or {}
    raw = raw.get("settings", raw) if isinstance(raw, dict) else raw
    client_id = int(principal["client_id"])
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                ensure_ddl(cur)
                current = load_settings(cur, client_id)
                merged, problem = validate_update(raw, current)
                if merged is None:
                    conn.rollback()
                    return jsonify({"error": {"code": "bad_request",
                                              "message": problem}}), 400
                saved = save_settings(cur, client_id, merged)
                enforce_bounds(cur, client_id, saved)
                used = usage(cur, client_id)
                portal_db.log_action(
                    cur, client_id, "media_store.settings", "human",
                    principal.get("user_id"), None,
                    ("Customer file copies "
                     + ("on" if saved["keep_copies"] else "off")
                     + ", " + str(saved["retention_days"]) + " days, "
                     + str(saved["quota_mb"]) + " MB."))
            conn.commit()
        finally:
            conn.close()
    except Exception as err:
        return _unavailable(err, "media storage settings")
    return jsonify({"ok": True, "settings": saved, "usage": used,
                    "limits": limits()}), 200
