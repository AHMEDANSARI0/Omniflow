"""OmniFlow social login bridge (§255) - runs on the connector laptop.

LOGIN MODE for the social channels: the account's own session signs in HERE
(passwords and session files never leave the laptop) and the bridge moves
messages between the account and the Control Plane:

  telegram  personal Telegram account (Telethon, api id/hash from
            my.telegram.org): private chats in, replies out.   contact tgu:<user id>
  x         X account (twikit): DMs and mentions in, DMs, mention replies
            and posts out.                                     contacts x:<id> / xc:<id>
  linkedin  LinkedIn account (linkedin-api): messages in and out
            (experimental - LinkedIn changes its private API).  contact li:<conversation id>

UNOFFICIAL: none of the platforms allows automating a personal login; they
may limit, challenge or ban the account. The settings card says so. Prefer
API mode where it exists.

Every command comes from the shared command queue; the Control Plane has
already applied the same rules as API mode (switches, opt-outs, public
comment policy, length limits) before handing it over.

Install only what you use:
  pip install telethon        (telegram)
  pip install twikit          (x)
  pip install linkedin-api    (linkedin)

Env:
  OMNIFLOW_CP_URL         https://<your-control-plane>   (no trailing slash)
  OMNIFLOW_SERVICE_KEY    the connector service key
  OMNIFLOW_CLIENT_ID      optional explicit workspace id
  SOCIAL_LOGIN_CHANNELS   e.g. "telegram,x,linkedin"
  OMNIFLOW_POLL_SECONDS   loop interval (default 20; X / LinkedIn are polled
                          every SOCIAL_FETCH_SECONDS, default 60)
  SOCIAL_SESSION_DIR      where sessions / cookies are kept (default ./social_sessions)
  TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_PHONE, TELEGRAM_PASSWORD (2FA, optional)
  X_USERNAME, X_EMAIL, X_PASSWORD, X_TOTP_SECRET (optional)
  LINKEDIN_EMAIL, LINKEDIN_PASSWORD

Run:  python3 social_login_bridge.py   (the first Telegram run asks for the
login code in this window)
"""

import asyncio
import json
import os
import time
import urllib.parse
import urllib.request

CP_URL = os.environ.get("OMNIFLOW_CP_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("OMNIFLOW_SERVICE_KEY", "")
CLIENT_ID = os.environ.get("OMNIFLOW_CLIENT_ID", "").strip()
CHANNELS = [c.strip().lower() for c in os.environ.get("SOCIAL_LOGIN_CHANNELS", "").split(",") if c.strip()]
POLL_SECONDS = float(os.environ.get("OMNIFLOW_POLL_SECONDS", "20") or 20)
FETCH_SECONDS = float(os.environ.get("SOCIAL_FETCH_SECONDS", "60") or 60)
SESSION_DIR = os.environ.get("SOCIAL_SESSION_DIR", "social_sessions")
API_TIMEOUT = 20

#: laptop name -> Control Plane channel
CP_CHANNEL = {"telegram": "telegram_user", "x": "x", "linkedin": "linkedin"}


# ---------------------------------------------------------------------------
# Control Plane calls (stdlib; run in a thread so the event loop stays free)
# ---------------------------------------------------------------------------

def _http_json(path, payload=None):
    data = None
    headers = {"X-Omniflow-Key": SERVICE_KEY}
    if payload is not None:
        if CLIENT_ID:
            payload = dict(payload, client_id=int(CLIENT_ID))
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    elif CLIENT_ID:
        path += ("&" if "?" in path else "?") + "client_id=" + urllib.parse.quote(CLIENT_ID)
    request = urllib.request.Request(CP_URL + path, data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=API_TIMEOUT) as response:
        body = response.read().decode("utf-8", "replace")
    return json.loads(body) if body else {}


async def cp(path, payload=None):
    return await asyncio.to_thread(_http_json, path, payload)


# ---------------------------------------------------------------------------
# pure mapping helpers (unit-tested)
# ---------------------------------------------------------------------------

def target_of(command, prefixes):
    """(prefix, id) of the command's contact when it has one of the prefixes."""
    payload = (command or {}).get("payload") or {}
    to = str(payload.get("external_user_id") or "")
    for prefix in prefixes:
        if to.startswith(prefix) and len(to) > len(prefix):
            return prefix, to[len(prefix):]
    return None


def x_dm_items(inbox, own_id, after_id):
    """X DM inbox JSON -> (new ingest items, newest message id). Messages
    the account sent itself are skipped; nothing at or before after_id."""
    entries = ((inbox or {}).get("inbox_initial_state") or {}).get("entries") or []
    users = ((inbox or {}).get("inbox_initial_state") or {}).get("users") or {}
    items, newest = [], int(after_id or 0)
    for entry in entries:
        message = (entry or {}).get("message") if isinstance(entry, dict) else None
        data = (message or {}).get("message_data") or {}
        try:
            message_id = int(data.get("id") or (message or {}).get("id") or 0)
        except (TypeError, ValueError):
            continue
        newest = max(newest, message_id)
        sender = str(data.get("sender_id") or "")
        text = str(data.get("text") or "")
        if not message_id or message_id <= int(after_id or 0) or not sender or sender == own_id or not text.strip():
            continue
        name = (users.get(sender) or {}).get("name") if isinstance(users.get(sender), dict) else None
        items.append({"from": "x:" + sender, "body": text[:4000], "name": name, "id": "x-dm:" + str(message_id)})
    return sorted(items, key=lambda item: int(item["id"][5:])), newest


def x_mention_items(global_objects, own_id, after_id):
    """Mentions timeline globalObjects -> (comment items, newest tweet id)."""
    tweets = (global_objects or {}).get("tweets") or {}
    users = (global_objects or {}).get("users") or {}
    items, newest = [], int(after_id or 0)
    for tweet_id, tweet in tweets.items():
        try:
            number = int(tweet_id)
        except (TypeError, ValueError):
            continue
        newest = max(newest, number)
        author = str((tweet or {}).get("user_id_str") or "")
        text = str((tweet or {}).get("full_text") or (tweet or {}).get("text") or "")
        if number <= int(after_id or 0) or not author or author == own_id or not text.strip():
            continue
        name = (users.get(author) or {}).get("name") if isinstance(users.get(author), dict) else None
        items.append({"from": "xc:" + author, "body": text[:4000], "name": name,
                      "id": "x-c:" + str(tweet_id), "comment_id": str(tweet_id), "post_id": str(tweet_id)})
    return sorted(items, key=lambda item: int(item["comment_id"])), newest


def linkedin_items(conversations, own_urn, after_ms):
    """Legacy messaging conversations JSON -> (new items, newest event ms)."""
    items, newest = [], int(after_ms or 0)
    for convo in (conversations or {}).get("elements") or []:
        urn = str((convo or {}).get("entityUrn") or "")
        convo_id = urn.rsplit(":", 1)[-1]
        for event in (convo or {}).get("events") or []:
            created = int((event or {}).get("createdAt") or 0)
            newest = max(newest, created)
            member = ((event.get("from") or {}).get("com.linkedin.voyager.messaging.MessagingMember") or {})
            profile = member.get("miniProfile") or {}
            content = (event.get("eventContent") or {}).get("com.linkedin.voyager.messaging.event.MessageEvent") or {}
            text = str((content.get("attributedBody") or {}).get("text") or content.get("body") or "")
            if created <= int(after_ms or 0) or not convo_id or not text.strip() or profile.get("entityUrn") == own_urn:
                continue
            name = " ".join(p for p in (profile.get("firstName"), profile.get("lastName")) if isinstance(p, str)).strip()
            items.append({"from": "li:" + convo_id, "body": text[:4000], "name": name or None,
                          "id": "li:" + str(event.get("entityUrn") or created)})
    return items, newest


def _state_path(name):
    return os.path.join(SESSION_DIR, name + "_state.json")


def load_state(name):
    try:
        with open(_state_path(name), encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(name, state):
    os.makedirs(SESSION_DIR, exist_ok=True)
    with open(_state_path(name), "w", encoding="utf-8") as handle:
        json.dump(state, handle)


# ---------------------------------------------------------------------------
# channels
# ---------------------------------------------------------------------------

class TelegramAccount:
    name = "telegram"
    prefixes = ("tgu:",)

    def __init__(self):
        self.queue = asyncio.Queue()
        self.client = None

    async def start(self):
        from telethon import TelegramClient, events  # pip install telethon

        os.makedirs(SESSION_DIR, exist_ok=True)
        self.client = TelegramClient(os.path.join(SESSION_DIR, "telegram"),
                                     int(os.environ["TELEGRAM_API_ID"]), os.environ["TELEGRAM_API_HASH"])
        await self.client.start(phone=os.environ.get("TELEGRAM_PHONE") or None,
                                password=os.environ.get("TELEGRAM_PASSWORD") or None)

        @self.client.on(events.NewMessage(incoming=True, func=lambda e: e.is_private))
        async def _incoming(event):
            sender = await event.get_sender()
            if getattr(sender, "bot", False) or not (event.raw_text or "").strip():
                return
            name = " ".join(p for p in (getattr(sender, "first_name", None), getattr(sender, "last_name", None)) if p)
            await self.queue.put({"from": "tgu:" + str(event.sender_id), "body": event.raw_text[:4000],
                                  "name": name or None, "id": "tgu:" + str(event.chat_id) + ":" + str(event.id)})

        me = await self.client.get_me()
        return " ".join(p for p in (me.first_name, me.last_name) if p) or str(me.id)

    async def fetch(self):
        items = []
        while not self.queue.empty():
            items.append(self.queue.get_nowait())
        return items

    async def send(self, command):
        target = target_of(command, self.prefixes)
        if not target or not target[1].isdigit() or command.get("action") not in ("send_message", "send_interactive"):
            raise ValueError("Telegram personal account sends text messages only.")
        body = str((command.get("payload") or {}).get("body") or "")
        sent = await self.client.send_message(int(target[1]), body)
        return str(getattr(sent, "id", ""))


class XAccount:
    name = "x"
    prefixes = ("x:", "xc:")

    def __init__(self):
        self.client = None
        self.own = ""
        self.state = load_state("x")
        self.next_fetch = 0.0

    async def start(self):
        from twikit import Client  # pip install twikit

        os.makedirs(SESSION_DIR, exist_ok=True)
        self.client = Client("en-US")
        await self.client.login(auth_info_1=os.environ["X_USERNAME"], auth_info_2=os.environ.get("X_EMAIL") or None,
                                password=os.environ["X_PASSWORD"], totp_secret=os.environ.get("X_TOTP_SECRET") or None,
                                cookies_file=os.path.join(SESSION_DIR, "x_cookies.json"))
        self.own = str(await self.client.user_id())
        return "@" + os.environ["X_USERNAME"].lstrip("@")

    async def fetch(self):
        if time.monotonic() < self.next_fetch:
            return []
        self.next_fetch = time.monotonic() + FETCH_SECONDS
        from twikit.client.v11 import Endpoint

        first = "dm_id" not in self.state  # the first run imports nothing old
        inbox, _ = await self.client.get(Endpoint.DM_INBOX, params={"include_groups": "true"},
                                         headers=self.client._base_headers)
        dms, dm_newest = x_dm_items(inbox, self.own, self.state.get("dm_id", 0))
        mentions_raw, _ = await self.client.v11.notifications_mentions(40, None)
        mentions, mention_newest = x_mention_items((mentions_raw or {}).get("globalObjects"), self.own,
                                                   self.state.get("mention_id", 0))
        self.state.update(dm_id=dm_newest, mention_id=mention_newest)
        save_state("x", self.state)
        return [] if first else dms + mentions

    async def send(self, command):
        payload = command.get("payload") or {}
        body = str(payload.get("body") or "")
        if command.get("action") == "publish_post":
            tweet = await self.client.create_tweet(text=body)
            return str(getattr(tweet, "id", ""))
        target = target_of(command, self.prefixes)
        if not target:
            raise ValueError("Not an X contact.")
        if target[0] == "xc:":
            if not payload.get("reply_to"):
                raise ValueError("No tweet to reply to.")
            tweet = await self.client.create_tweet(text=body, reply_to=str(payload["reply_to"]))
            return str(getattr(tweet, "id", ""))
        message = await self.client.send_dm(target[1], body)
        return str(getattr(message, "id", ""))


class LinkedInAccount:
    name = "linkedin"
    prefixes = ("li:",)

    def __init__(self):
        self.api = None
        self.own = ""
        self.state = load_state("linkedin")
        self.next_fetch = 0.0

    async def start(self):
        from linkedin_api import Linkedin  # pip install linkedin-api

        os.makedirs(SESSION_DIR, exist_ok=True)
        self.api = await asyncio.to_thread(Linkedin, os.environ["LINKEDIN_EMAIL"], os.environ["LINKEDIN_PASSWORD"],
                                           cookies_dir=SESSION_DIR + os.sep)
        profile = await asyncio.to_thread(self.api.get_user_profile)
        mini = (profile or {}).get("miniProfile") or {}
        self.own = str(mini.get("entityUrn") or "")
        return " ".join(p for p in (mini.get("firstName"), mini.get("lastName")) if p) or "LinkedIn"

    async def fetch(self):
        if time.monotonic() < self.next_fetch:
            return []
        self.next_fetch = time.monotonic() + FETCH_SECONDS
        first = "after_ms" not in self.state
        data = await asyncio.to_thread(self.api.get_conversations)
        items, newest = linkedin_items(data, self.own, self.state.get("after_ms", 0))
        self.state["after_ms"] = newest
        save_state("linkedin", self.state)
        return [] if first else items

    async def send(self, command):
        target = target_of(command, self.prefixes)
        if not target or command.get("action") not in ("send_message", "send_interactive"):
            raise ValueError("LinkedIn login mode sends messages only.")
        body = str((command.get("payload") or {}).get("body") or "")
        failed = await asyncio.to_thread(self.api.send_message, body, conversation_urn_id=target[1])
        if failed:
            raise RuntimeError("LinkedIn refused the message.")
        return ""


ACCOUNTS = {"telegram": TelegramAccount, "x": XAccount, "linkedin": LinkedInAccount}


# ---------------------------------------------------------------------------
# loop
# ---------------------------------------------------------------------------

async def deliver(account, cp_channel):
    """Run the commands and away replies the Control Plane hands over."""
    batch = await cp("/api/v1/connector/whatsapp/commands?limit=20&channel=" + cp_channel)
    for command in batch.get("commands") or []:
        # only a failed SEND is acked as failed; an ack error never re-queues a sent reply
        try:
            ack = {"command_id": int(command["id"]), "ok": True, "note": await account.send(command) or "sent"}
        except Exception as error:
            ack = {"command_id": int(command["id"]), "ok": False, "note": str(error)[:300]}
        await cp("/api/v1/connector/whatsapp/commands/ack", ack)
    away = await cp("/api/v1/connector/away-replies?limit=10&social=" + cp_channel)
    for reply in away.get("away_replies") or []:
        command = {"action": "send_message", "payload": {"external_user_id": reply.get("external_user_id"),
                                                         "body": reply.get("body")}}
        try:
            await account.send(command)
            ack = {"away_id": int(reply["id"]), "ok": True}
        except Exception as error:
            ack = {"away_id": int(reply["id"]), "ok": False, "note": str(error)[:300]}
        await cp("/api/v1/connector/away-replies/ack", ack)


async def run_channel(name):
    cp_channel = CP_CHANNEL[name]
    account = ACCOUNTS[name]()
    try:
        account_name = await account.start()
    except Exception as error:
        print(name, "login failed:", error)
        await cp("/api/v1/connector/social/status", {"channel": cp_channel, "state": "error",
                                                     "error": (name + " login failed: " + str(error))[:300]})
        return
    print(name, "signed in as", account_name)
    backlog = []  # fetched but not yet accepted by the Control Plane (it dedupes by id)
    while True:
        try:
            status = await cp("/api/v1/connector/social/status",
                              {"channel": cp_channel, "state": "connected", "account_name": account_name})
            if status.get("active"):
                backlog.extend(await account.fetch() or [])
                while backlog:
                    await cp("/api/v1/connector/social/messages", {"channel": cp_channel, "messages": backlog[:50]})
                    del backlog[:50]
                await deliver(account, cp_channel)
        except Exception as error:  # keep the bridge alive on any transient error
            print(name, "loop error:", error)
        await asyncio.sleep(POLL_SECONDS)


async def main():
    unknown = [c for c in CHANNELS if c not in ACCOUNTS]
    if not (CP_URL and SERVICE_KEY and CHANNELS) or unknown:
        raise SystemExit("Set OMNIFLOW_CP_URL, OMNIFLOW_SERVICE_KEY and SOCIAL_LOGIN_CHANNELS"
                         " (telegram, x, linkedin)." + (" Unknown: " + ", ".join(unknown) if unknown else ""))
    print("OmniFlow social login bridge started:", ", ".join(CHANNELS))
    await asyncio.gather(*(run_channel(name) for name in CHANNELS))


if __name__ == "__main__":
    asyncio.run(main())
