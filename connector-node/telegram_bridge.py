"""OmniFlow Telegram bridge (v0) - runs on the connector laptop.

Copies to the laptop next to the WhatsApp connector. Zero dependencies
(stdlib only). Bridges a Telegram bot to the SAME Control Plane the WhatsApp
connector uses:

  - Inbound: Telegram getUpdates (long poll) -> POST /connector/whatsapp/messages
    with channel="telegram" and contacts addressed as "tg:<chat_id>".
  - Outbound: polls /connector/whatsapp/commands?channel=telegram every
    POLL_SECONDS and delivers send_message commands addressed to "tg:*"
    contacts via sendMessage. WhatsApp-addressed commands are left untouched
    (the WhatsApp bridge keeps polling WITHOUT the channel filter).

Env:
  OMNIFLOW_CP_URL       https://<your-control-plane>   (no trailing slash)
  OMNIFLOW_SERVICE_KEY  the connector service key
  TELEGRAM_BOT_TOKEN    from @BotFather
  OMNIFLOW_CLIENT_ID    optional explicit tenant id (omit to use the default)
  OMNIFLOW_POLL_SECONDS command poll interval (default 15)
  OMNIFLOW_MEDIA_MAX_BYTES  largest voice note / photo forwarded (default 3 MB)

Voice notes, audio files and photos (D5) are downloaded here (getFile) and
forwarded inline (media[].data_b64); the Control Plane turns them into text
(speech-to-text / image understanding) before the assistant reads them.

Run:  python3 telegram_bridge.py
"""

import base64
import json
import os
import time
import urllib.parse
import urllib.request

CP_URL = os.environ.get("OMNIFLOW_CP_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("OMNIFLOW_SERVICE_KEY", "")
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CLIENT_ID = os.environ.get("OMNIFLOW_CLIENT_ID", "")
POLL_SECONDS = float(os.environ.get("OMNIFLOW_POLL_SECONDS", "15"))
TG_TIMEOUT = 55
API_TIMEOUT = 20

INGEST_PATH = "/api/v1/connector/whatsapp/messages"
COMMANDS_PATH = "/api/v1/connector/whatsapp/commands"
ACK_PATH = "/api/v1/connector/whatsapp/commands/ack"
TG_API = "https://api.telegram.org/bot" + BOT_TOKEN + "/"
TG_FILE = "https://api.telegram.org/file/bot" + BOT_TOKEN + "/"
MEDIA_MAX_BYTES = int(os.environ.get("OMNIFLOW_MEDIA_MAX_BYTES",
                                     str(3 * 1024 * 1024)) or 3 * 1024 * 1024)
MEDIA_PLACEHOLDER = {"audio": "[Voice note]", "image": "[Image]"}


def _http_json(url, payload=None, timeout=API_TIMEOUT):
    """POST payload (or GET when payload is None); returns parsed JSON."""
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if SERVICE_KEY:
        headers["X-Omniflow-Key"] = SERVICE_KEY
    request = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read().decode("utf-8", "replace")
    return json.loads(body) if body else {}


def tg_api(method, params=None, timeout=TG_TIMEOUT):
    """Call a Telegram Bot API method (params go in the query string)."""
    query = ""
    if params:
        query = "?" + urllib.parse.urlencode(params)
    return _http_json(TG_API + method + query, None, timeout=timeout)


def _size(value):
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def media_descriptor(message):
    """Voice note / audio / photo -> {type, file_id, mime, size} or None.
    Pure (no network); the largest photo size under the cap is chosen."""
    for key in ("voice", "audio"):
        voice = message.get(key)
        if isinstance(voice, dict) and voice.get("file_id"):
            if _size(voice.get("file_size")) > MEDIA_MAX_BYTES:
                return None
            return {"type": "audio", "file_id": str(voice["file_id"]),
                    "mime": str(voice.get("mime_type") or "audio/ogg"),
                    "size": _size(voice.get("file_size"))}
    photos = message.get("photo")
    if isinstance(photos, list):
        sizes = [p for p in photos if isinstance(p, dict) and p.get("file_id")
                 and _size(p.get("file_size")) <= MEDIA_MAX_BYTES]
        if sizes:
            best = max(sizes, key=lambda p: (_size(p.get("width"))
                                             * _size(p.get("height")),
                                             _size(p.get("file_size"))))
            return {"type": "image", "file_id": str(best["file_id"]),
                    "mime": "image/jpeg", "size": _size(best.get("file_size"))}
    return None


def map_update(update):
    """Telegram update -> CP ingest item, or None when there is nothing to
    forward (no chat, or neither text nor a supported voice note/photo)."""
    message = (update or {}).get("message") or {}
    chat = message.get("chat") or {}
    sender = message.get("from") or {}
    text = message.get("text") or message.get("caption") or ""
    chat_id = chat.get("id")
    media = media_descriptor(message) if chat_id is not None else None
    if chat_id is None or (not str(text).strip() and media is None):
        return None
    if not str(text).strip():
        text = MEDIA_PLACEHOLDER[media["type"]]
    name = " ".join(
        part for part in (sender.get("first_name"), sender.get("last_name"))
        if isinstance(part, str) and part.strip()
    ).strip() or (chat.get("title") if isinstance(chat.get("title"), str) else "")
    item = {
        "from": "tg:" + str(chat_id),
        "body": str(text)[:1000],
        "name": name or None,
        "direction": "in",
        "channel": "telegram",
    }
    if media is not None:
        item["media"] = [media]
    return item


def download_file(file_id):
    """getFile + download -> bytes (capped). Raises on any problem."""
    meta = tg_api("getFile", {"file_id": file_id}, timeout=API_TIMEOUT)
    path = ((meta or {}).get("result") or {}).get("file_path")
    if not path:
        raise ValueError("telegram did not return a file path")
    request = urllib.request.Request(TG_FILE + urllib.parse.quote(path))
    with urllib.request.urlopen(request, timeout=API_TIMEOUT) as response:
        data = response.read(MEDIA_MAX_BYTES + 1)
    if len(data) > MEDIA_MAX_BYTES:
        raise ValueError("file is larger than the media limit")
    return data


def attach_media(item, fetch=None):
    """Inline the media bytes (data_b64) in place; a failed download keeps
    the message (placeholder body) with a note. Never raises."""
    fetch = fetch or download_file
    for entry in (item or {}).get("media") or []:
        file_id = entry.pop("file_id", None)
        if not file_id:
            continue
        try:
            entry["data_b64"] = base64.b64encode(fetch(file_id)).decode("ascii")
        except Exception as error:
            entry["note"] = ("download_failed: " + str(error))[:120]
    return item


def extract_out(command):
    """send_message command -> (tg_chat_id, body) or None for other channels."""
    payload = (command or {}).get("payload") or {}
    to = str(payload.get("external_user_id") or "")
    if not to.startswith("tg:"):
        return None
    chat_id = to[3:]
    if not chat_id.lstrip("-").isdigit():
        return None
    return chat_id, str(payload.get("body") or "")[:4000]


def ingest_messages(items):
    payload = {"messages": items}
    if CLIENT_ID:
        payload["client_id"] = int(CLIENT_ID)
    return _http_json(CP_URL + INGEST_PATH, payload)


def poll_commands():
    path = COMMANDS_PATH + "?limit=20&channel=telegram"
    if CLIENT_ID:
        path += "&client_id=" + urllib.parse.quote(CLIENT_ID)
    return _http_json(CP_URL + path, None, timeout=API_TIMEOUT)


def ack_command(command_id, ok, note=""):
    payload = {"command_id": int(command_id), "ok": bool(ok)}
    if note:
        payload["note"] = str(note)[:300]
    if CLIENT_ID:
        payload["client_id"] = int(CLIENT_ID)
    return _http_json(CP_URL + ACK_PATH, payload)


def run_forever():
    if not (CP_URL and SERVICE_KEY and BOT_TOKEN):
        raise SystemExit(
            "Set OMNIFLOW_CP_URL, OMNIFLOW_SERVICE_KEY and TELEGRAM_BOT_TOKEN."
        )
    print("OmniFlow Telegram bridge started.")
    offset = 0
    while True:
        try:
            result = tg_api(
                "getUpdates",
                {"offset": offset, "timeout": TG_TIMEOUT - 5, "limit": 20},
            )
            for update in result.get("result") or []:
                offset = max(offset, int(update.get("update_id") or 0) + 1)
                item = map_update(update)
                if item:
                    ingest_messages([attach_media(item)])
        except Exception as error:  # keep the bridge alive on any transient error
            print("ingest loop error:", error)
            time.sleep(3)
        try:
            batch = poll_commands()
            for command in batch.get("commands") or []:
                out = extract_out(command)
                if out is None:
                    continue
                chat_id, body = out
                try:
                    tg_api(
                        "sendMessage",
                        {"chat_id": chat_id, "text": body},
                        timeout=API_TIMEOUT,
                    )
                    ack_command(command.get("id"), True)
                except Exception as send_error:
                    ack_command(command.get("id"), False, str(send_error))
        except Exception as error:
            print("command loop error:", error)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    run_forever()
