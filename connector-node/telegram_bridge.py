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

Run:  python3 telegram_bridge.py
"""

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


def map_update(update):
    """Telegram update -> CP ingest item, or None when not a text message."""
    message = (update or {}).get("message") or {}
    chat = message.get("chat") or {}
    sender = message.get("from") or {}
    text = message.get("text") or message.get("caption") or ""
    chat_id = chat.get("id")
    if chat_id is None or not str(text).strip():
        return None
    name = " ".join(
        part for part in (sender.get("first_name"), sender.get("last_name"))
        if isinstance(part, str) and part.strip()
    ).strip() or (chat.get("title") if isinstance(chat.get("title"), str) else "")
    return {
        "from": "tg:" + str(chat_id),
        "body": str(text)[:1000],
        "name": name or None,
        "direction": "in",
        "channel": "telegram",
    }


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
                    ingest_messages([item])
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
