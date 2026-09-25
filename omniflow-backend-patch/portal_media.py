"""Media + voice (V2 B11) - tenant media library, WhatsApp media
send, and voice-to-text.

Three pieces, all env-driven (no per-shop hardcoding):

* LIBRARY - the owner uploads images / PDFs / audio (<= 8 MB, strict
  mime allowlist) in the dashboard Media page; bytes live in
  portal_media_assets (BYTEA) and every operation is audited. Always
  works - no external config needed.

* WHATSAPP SEND - POST /portal/media/send queues a `send_media`
  connector command; the bridge (send_media_message) downloads the
  bytes from the CP connector endpoint, uploads them to the WhatsApp
  Cloud media API and sends the image/document/audio message. Needs
  OMNIFLOW_WA_CLOUD_URL + OMNIFLOW_WA_TOKEN in the bot/bridge env -
  without them the command is acknowledged with a clear note
  (graceful, never breaks the poll loop).

* VOICE TO TEXT - POST /portal/media/transcribe sends a stored audio
  asset to an OpenAI-compatible speech-to-text endpoint
  (OMNIFLOW_STT_API_KEY, OMNIFLOW_STT_BASE default
  https://api.openai.com/v1, OMNIFLOW_STT_MODEL default whisper-1).
  Without the key: 409 stt_not_configured.

The connector download endpoint (GET /connector/media/<id>) is
machine-facing: guarded by X-Omniflow-Key like every other connector
route. Everything else is human-only (API keys get 403).
"""

import io
import json
import logging
import os
import urllib.error
import urllib.request
import uuid
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request, send_file

import portal_db
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
)

logger = logging.getLogger("omniflow.portal-media")

bp = Blueprint("portal_media", __name__, url_prefix="/api/v1/portal")
connector_bp = Blueprint(
    "portal_media_connector", __name__,
    url_prefix="/api/v1/connector")

TABLE = "portal_media_assets"
MAX_BYTES = 8 * 1024 * 1024

STT_BASE_DEFAULT = "https://api.openai.com/v1"
STT_MODEL_DEFAULT = "whisper-1"

#: (mime prefix or exact) -> asset kind. Anything else is rejected.
KIND_RULES: List[Tuple[str, str]] = [
    ("image/png", "image"),
    ("image/jpeg", "image"),
    ("image/webp", "image"),
    ("application/pdf", "document"),
    ("audio/mpeg", "audio"),
    ("audio/mp4", "audio"),
    ("audio/ogg", "audio"),
    ("audio/wav", "audio"),
    ("audio/x-wav", "audio"),
    ("audio/webm", "audio"),
]

_DDL_READY = False

_DDL = """
CREATE TABLE IF NOT EXISTS portal_media_assets (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'image',
  filename TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  caption TEXT NOT NULL DEFAULT '',
  content BYTEA,
  created_by TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_media_assets
  ON portal_media_assets (client_id, id DESC);
"""


def _ensure_ddl(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    _DDL_READY = True


def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": str(error)}}), 503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}),
                      401)
    if principal.get("via_api_key"):
        return None, (jsonify({"error": {"code": "forbidden",
                                         "message": "Owner sign-in required."}}),
                      403)
    return principal, None


def _authorized() -> bool:
    """Connector-facing guard (same contract as connector_api)."""
    key = request.headers.get("X-Omniflow-Key", "")
    return bool(key) and key in (
        os.environ.get("OMNIFLOW_SERVICE_KEY", ""),
        os.environ.get("OMNIFLOW_ADMIN_API_KEY", ""),
    )


def kind_for_mime(mime: str) -> Optional[str]:
    mime = (mime or "").strip().lower()
    for prefix, kind in KIND_RULES:
        if mime == prefix or mime.startswith(prefix):
            return kind
    return None


def _public(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": int(row.get("id") or 0),
        "kind": str(row.get("kind") or ""),
        "filename": str(row.get("filename") or ""),
        "mime": str(row.get("mime") or ""),
        "size_bytes": int(row.get("size_bytes") or 0),
        "caption": str(row.get("caption") or ""),
        "created_at": None if row.get("created_at") is None
        else str(row.get("created_at")),
    }


def _load_asset(cur, client_id: int, asset_id: int,
                with_content: bool = False) -> Optional[Dict[str, Any]]:
    cols = ("id, client_id, kind, filename, mime, size_bytes, caption,"
            " created_at" + (", content" if with_content else ""))
    cur.execute(
        "SELECT " + cols + " FROM " + portal_db._q(TABLE) +
        " WHERE id = %s AND client_id = %s LIMIT 1",
        (asset_id, client_id),
    )
    rows = portal_db.rows(cur)
    return rows[0] if rows else None


def _contact_opted_out(cur, client_id: int, contact_id: str) -> bool:
    cur.execute(
        "SELECT 1 FROM " + portal_db._q("portal_optouts") +
        " WHERE client_id = %s AND contact_id = %s LIMIT 1",
        (client_id, contact_id),
    )
    return bool(portal_db.rows(cur))


# ---------------------------------------------------------------------------
# Library API (human-only)
# ---------------------------------------------------------------------------

@bp.get("/media")
def list_media():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "SELECT id, kind, filename, mime, size_bytes, caption,"
                " created_at FROM " + portal_db._q(TABLE) +
                " WHERE client_id = %s ORDER BY id DESC LIMIT 30",
                (int(principal["client_id"]),),
            )
            rows = portal_db.rows(cur)
        conn.commit()
    finally:
        conn.close()
    return jsonify({"assets": [_public(r) for r in rows]}), 200


@bp.post("/media")
def upload_media():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    uploaded = request.files.get("file")
    if uploaded is None or not uploaded.filename:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "file is required."}}), 400
    mime = (uploaded.mimetype or "").split(";")[0].strip().lower()
    kind = kind_for_mime(mime)
    if kind is None:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Unsupported file type -"
                                             " images, PDF or audio"
                                             " only."}}), 400
    content = uploaded.read()
    if not content:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "File is empty."}}), 400
    if len(content) > MAX_BYTES:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "File is larger than"
                                             " 8 MB."}}), 400
    caption = str(request.form.get("caption") or "").strip()[:300]
    filename = uploaded.filename[:150]
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "INSERT INTO " + portal_db._q(TABLE) +
                " (client_id, kind, filename, mime, size_bytes, caption,"
                " content, created_by)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s, 'owner')"
                " RETURNING id, kind, filename, mime, size_bytes,"
                " caption, created_at",
                (client_id, kind, filename, mime, len(content), caption,
                 psycopg2_binary(content)),
            )
            rows = portal_db.rows(cur)
            portal_db.log_action(
                cur, client_id, "media.uploaded", "human", None, None,
                (kind + " " + filename + " ("
                 + str(len(content)) + " bytes)"),
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"asset": _public(rows[0]) if rows else None}), 200


def psycopg2_binary(data: bytes):
    """Wrap bytes for BYTEA (psycopg2 when available, else raw)."""
    try:
        from psycopg2 import Binary
        return Binary(data)
    except ImportError:
        return data


@bp.post("/media/delete")
def delete_media():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    payload = request.get_json(silent=True) or {}
    try:
        asset_id = int(payload.get("id") or 0)
    except (TypeError, ValueError):
        asset_id = 0
    if asset_id <= 0:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "id is required."}}), 400
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "DELETE FROM " + portal_db._q(TABLE) +
                " WHERE id = %s AND client_id = %s RETURNING id",
                (asset_id, client_id),
            )
            ok = bool(portal_db.rows(cur))
            if ok:
                portal_db.log_action(
                    cur, client_id, "media.deleted", "human", None,
                    None, "asset " + str(asset_id),
                )
        conn.commit()
    finally:
        conn.close()
    if not ok:
        return jsonify({"error": {"code": "not_found",
                                  "message": "No such asset."}}), 404
    return jsonify({"ok": True}), 200


@bp.get("/media/<int:asset_id>/download")
def download_media(asset_id: int):
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            asset = _load_asset(cur, int(principal["client_id"]),
                                asset_id, with_content=True)
        conn.commit()
    finally:
        conn.close()
    if asset is None or asset.get("content") in (None, b""):
        return jsonify({"error": {"code": "not_found",
                                  "message": "No such asset."}}), 404
    content = asset["content"]
    if isinstance(content, memoryview):
        content = content.tobytes()
    return send_file(io.BytesIO(content),
                     mimetype=str(asset.get("mime") or ""),
                     as_attachment=True,
                     download_name=str(asset.get("filename") or "file"))


# ---------------------------------------------------------------------------
# WhatsApp send (queues send_media; the bridge does the Cloud calls)
# ---------------------------------------------------------------------------

@bp.post("/media/send")
def send_media():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    payload = request.get_json(silent=True) or {}
    try:
        asset_id = int(payload.get("id") or 0)
    except (TypeError, ValueError):
        asset_id = 0
    contact_id = str(payload.get("contact_id") or "").strip()[:100]
    conversation_id = payload.get("conversation_id")
    caption = str(payload.get("caption") or "").strip()[:1000]
    if asset_id <= 0 or not contact_id:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "id and contact_id are"
                                             " required."}}), 400
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            asset = _load_asset(cur, client_id, asset_id)
            if asset is None:
                return jsonify({"error": {"code": "not_found",
                                          "message": "No such"
                                                     " asset."}}), 404
            if _contact_opted_out(cur, client_id, contact_id):
                return jsonify({"error": {"code": "opted_out",
                                          "message": "This customer has"
                                                     " opted out."}}), 409
            command_payload = {
                "external_user_id": contact_id,
                "asset_id": asset_id,
                "kind": str(asset.get("kind") or "image"),
                "filename": str(asset.get("filename") or ""),
                "caption": caption,
            }
            if conversation_id:
                try:
                    command_payload["conversation_id"] = \
                        int(conversation_id)
                except (TypeError, ValueError):
                    pass
            cur.execute(
                "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
                " (client_id, channel, action, payload, status,"
                " requested_by, created_at, updated_at) "
                "VALUES (%s, 'whatsapp', 'send_media',"
                " CAST(%s AS JSONB), 'pending', NULL, NOW(), NOW())"
                " RETURNING id",
                (client_id, json.dumps(command_payload)),
            )
            label = {"image": "Image", "document": "Document",
                     "audio": "Voice note"}.get(
                         str(asset.get("kind")), "Media")
            body = label + " sent: " + str(asset.get("filename") or "")
            if caption:
                body += " - " + caption[:200]
            cur.execute(
                "INSERT INTO " + portal_db._q(portal_db.MSGS_TABLE) +
                " (client_id, conversation_id, contact_id, direction,"
                " body, source, created_at) VALUES (%s, %s, %s,"
                " 'outbound', %s, 'media', NOW())",
                (client_id,
                 command_payload.get("conversation_id"), contact_id,
                 body),
            )
            portal_db.log_action(
                cur, client_id, "media.sent", "human", contact_id,
                command_payload.get("conversation_id"),
                (label + " asset " + str(asset_id) + " to "
                 + contact_id),
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "queued": True}), 200


# ---------------------------------------------------------------------------
# Voice to text (OpenAI-compatible STT, env-driven)
# ---------------------------------------------------------------------------

def _stt_config() -> Optional[Tuple[str, str, str]]:
    key = os.environ.get("OMNIFLOW_STT_API_KEY", "").strip()
    if not key:
        return None
    base = os.environ.get("OMNIFLOW_STT_BASE", "").strip() \
        or STT_BASE_DEFAULT
    model = os.environ.get("OMNIFLOW_STT_MODEL", "").strip() \
        or STT_MODEL_DEFAULT
    return base.rstrip("/"), key, model


def _multipart_body(fields: Dict[str, str], field: str, filename: str,
                    mime: str, data: bytes) -> Tuple[bytes, str]:
    boundary = "omniflow" + uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(("--" + boundary + "\r\n"
                      "Content-Disposition: form-data; name=\""
                      + name + "\"\r\n\r\n" + value + "\r\n")
                     .encode("utf-8"))
    parts.append(("--" + boundary + "\r\n"
                  "Content-Disposition: form-data; name=\"" + field
                  + "\"; filename=\"" + filename + "\"\r\n"
                  "Content-Type: " + mime + "\r\n\r\n")
                 .encode("utf-8"))
    parts.append(data + b"\r\n")
    parts.append(("--" + boundary + "--\r\n").encode("utf-8"))
    return b"".join(parts), boundary


@bp.post("/media/transcribe")
def transcribe_media():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    payload = request.get_json(silent=True) or {}
    try:
        asset_id = int(payload.get("id") or 0)
    except (TypeError, ValueError):
        asset_id = 0
    if asset_id <= 0:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "id is required."}}), 400
    stt = _stt_config()
    if stt is None:
        return jsonify({"error": {"code": "stt_not_configured",
                                  "message": "Set OMNIFLOW_STT_API_KEY"
                                             " on the CP service to"
                                             " enable"
                                             " transcription."}}), 409
    base, key, model = stt
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            asset = _load_asset(cur, client_id, asset_id,
                                with_content=True)
        conn.commit()
    finally:
        conn.close()
    if asset is None:
        return jsonify({"error": {"code": "not_found",
                                  "message": "No such asset."}}), 404
    if str(asset.get("kind")) != "audio":
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Only audio assets can be"
                                             " transcribed."}}), 400
    content = asset.get("content")
    if content is None:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Asset has no"
                                             " content."}}), 404
    if isinstance(content, memoryview):
        content = content.tobytes()
    body, boundary = _multipart_body(
        {"model": model}, "file",
        str(asset.get("filename") or "audio"),
        str(asset.get("mime") or "audio/mpeg"), content)
    request_obj = urllib.request.Request(
        base + "/audio/transcriptions", data=body, method="POST")
    request_obj.add_header("Content-Type",
                           "multipart/form-data; boundary="
                           + boundary)
    request_obj.add_header("Authorization", "Bearer " + key)
    try:
        with urllib.request.urlopen(request_obj, timeout=60) as resp:
            parsed = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            detail = error.read().decode("utf-8", "replace")[:200]
        except OSError:
            pass
        return jsonify({"error": {"code": "stt_error",
                                  "message": "Transcription failed"
                                             " (HTTP "
                                             + str(error.code) + "). "
                                             + detail}}), 502
    except (urllib.error.URLError, OSError) as error:
        return jsonify({"error": {"code": "stt_error",
                                  "message": "Transcription service"
                                             " unreachable: "
                                             + str(error)}}), 502
    text = str(parsed.get("text") or "").strip()
    portal_db_conn = portal_db._conn()
    try:
        with portal_db_conn.cursor() as cur:
            _ensure_ddl(cur)
            portal_db.log_action(
                cur, client_id, "media.transcribed", "human", None,
                None, "asset " + str(asset_id) + " ("
                + str(len(text)) + " chars)",
            )
        portal_db_conn.commit()
    finally:
        portal_db_conn.close()
    return jsonify({"ok": True, "text": text,
                    "model": model}), 200


# ---------------------------------------------------------------------------
# Connector download (machine-facing, X-Omniflow-Key)
# ---------------------------------------------------------------------------

@connector_bp.get("/media/<int:asset_id>")
def connector_download(asset_id: int):
    if not _authorized():
        return jsonify({"error": {"code": "unauthorized",
                                  "message": "Bad service key."}}), 401
    client_id = request.args.get("client_id", type=int)
    if not client_id:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "client_id is"
                                             " required."}}), 400
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            asset = _load_asset(cur, client_id, asset_id,
                                with_content=True)
        conn.commit()
    finally:
        conn.close()
    if asset is None or asset.get("content") in (None, b""):
        return jsonify({"error": {"code": "not_found",
                                  "message": "No such asset."}}), 404
    content = asset["content"]
    if isinstance(content, memoryview):
        content = content.tobytes()
    return send_file(io.BytesIO(content),
                     mimetype=str(asset.get("mime") or ""),
                     as_attachment=False,
                     download_name=str(asset.get("filename") or "file"))
