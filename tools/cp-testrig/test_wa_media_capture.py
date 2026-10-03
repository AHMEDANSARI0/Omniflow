"""Batch 220: WhatsApp (laptop connector) inbound media capture.

Customer voice notes and photos on the WhatsApp Web connector now reach the
Control Plane as inline bytes (the §212 media-understanding / §214 media
store contract), instead of voice notes being reduced to a transcript and
photos being dropped (or read as the bubble's time label).

Covers, against the REAL laptop modules (src/whatsapp.py,
src/channels/whatsapp_web.py, run_channel.py, src/control_plane_bridge.py)
with a fake Playwright DOM:
  * photo bubble detection (caption only - never the time label), voice
    wins over photo, empty bubbles ignored, text unchanged;
  * in-memory photo download: by message id (not only the last bubble),
    stickers (WebP) skipped, pending -> media-download click -> ok,
    deadline, too_large / missing / failed / unsupported, never raises;
  * the JavaScript is valid (node parse) and the size cap reaches it;
  * adapter: image events + capture_image routing;
  * run_channel: voice copy before the temp file is deleted (marked
    transcribed), CP fallback when local STT fails/raises, size cap,
    capture off = old behaviour, photo / sticker / failure paths, CP body
    placeholders, env parsing, and the real run_worker loop end to end;
  * laptop bridge: id + media + placeholders, media travels alone with its
    own timeout, order kept, private keys never sent, retries then text
    only, bounded media backlog;
  * Control Plane: connector-transcribed voice notes are stored but not
    sent to speech-to-text again; images still described; strict flag;
    exact dedupe by message id; the store keeps the WhatsApp copy.
"""
import base64
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import types

import test_lib
from test_lib import FakeCur, check, summary

RIG = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = os.path.join(RIG, "src")

OGG = b"OggS" + b"\x00" * 60
JPEG = b"\xff\xd8\xff\xe0" + b"j" * 120
WEBP = b"RIFF\x10\x00\x00\x00WEBPVP8 " + b"w" * 40


def b64(data):
    return base64.b64encode(data).decode("ascii")


# ---------------------------------------------------------------------------
# laptop module loading (stubs for Playwright / dotenv / DB-backed modules)
# ---------------------------------------------------------------------------

def stub(name, **attrs):
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules[name] = module
    return module


class _Quiet:
    def __init__(self, *a, **k):
        self.lines = []

    def log(self, line):
        self.lines.append(str(line))


playwright_pkg = stub("playwright")
playwright_pkg.sync_api = stub("playwright.sync_api",
                               sync_playwright=lambda: None)
stub("config", AUDIO_TEMP_DIR=tempfile.mkdtemp(), BASE_DIR=RIG)
stub("logger", Logger=_Quiet)
stub("typing_engine", TypingEngine=_Quiet)
stub("dotenv", load_dotenv=lambda *a, **k: None)
stub("account_lease", ChannelAccountLease=object)
stub("conversation", ConversationManager=object)
if "psycopg2" not in sys.modules:
    try:
        import psycopg2  # noqa: F401
    except Exception:
        stub("psycopg2", connect=lambda *a, **k: None)

if SRC not in sys.path:
    sys.path.insert(0, SRC)

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "test-key")


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


import whatsapp  # noqa: E402
import channels  # noqa: E402
from channels.contracts import ChannelAccount, ChannelEvent  # noqa: E402
from channels.whatsapp_web import WhatsAppWebAdapter  # noqa: E402
import control_plane_bridge as laptop_bridge  # noqa: E402

rc = load("run_channel", os.path.join(RIG, "run_channel.py"))


# ---------------------------------------------------------------------------
# fake Playwright DOM
# ---------------------------------------------------------------------------

class FakeLocator:
    def __init__(self, items=None, texts=None, on_click=None):
        self.items = list(items or [])
        self.texts = list(texts or [])
        self.on_click = on_click

    def count(self):
        return len(self.items) if self.items else len(self.texts)

    @property
    def first(self):
        return self.nth(0)

    def nth(self, index):
        if self.items:
            return self.items[index]
        return FakeLocator(texts=self.texts[index:index + 1],
                           on_click=self.on_click)

    def all_inner_texts(self):
        return list(self.texts)

    def get_attribute(self, name):
        return None

    def click(self, force=False):
        if self.on_click:
            self.on_click()


class Bubble:
    """One [data-testid='msg-container'] element."""

    def __init__(self, mid, caption="", inner="10:42 pm", voice=False,
                 image=False, fetch=None):
        self.mid = mid
        self.caption = caption
        self.inner = inner
        self.voice = voice
        self.image = image
        self.fetch = list(fetch or [])
        self.fetch_args = []
        self.download_clicks = 0

    def get_attribute(self, name):
        return self.mid if name == "data-id" else None

    def inner_text(self):
        return (self.caption + "\n" + self.inner).strip()

    def locator(self, selector):
        if selector == "span.selectable-text":
            return FakeLocator(texts=[self.caption] if self.caption else [])
        if self.voice and selector in ("audio",
                                       "[data-testid='audio-play']"):
            return FakeLocator(texts=["x"])
        if selector in ("[data-icon='media-download']",):
            return FakeLocator(texts=["x"], on_click=self._click)
        return FakeLocator()

    def _click(self):
        self.download_clicks += 1

    def evaluate(self, script, arg=None):
        if script == whatsapp.IMAGE_DETECT_JS:
            return self.image
        if script == whatsapp.IMAGE_FETCH_JS:
            self.fetch_args.append(arg)
            if not self.fetch:
                return {"status": "missing"}
            step = self.fetch.pop(0) if len(self.fetch) > 1 else self.fetch[0]
            if isinstance(step, Exception):
                raise step
            return step
        return "inbound"  # direction probe


class FakePage:
    def __init__(self, bubbles):
        self.bubbles = bubbles
        self.waits = 0

    def locator(self, selector):
        if selector == "[data-testid='msg-container']":
            return FakeLocator(items=self.bubbles)
        return FakeLocator()

    def wait_for_timeout(self, ms):
        self.waits += 1


def make_bot(bubbles):
    bot = whatsapp.WhatsAppBot("session")
    bot.page = FakePage(bubbles)
    for bubble in bubbles:
        bot._chat_identifier_cache[bubble.mid] = "923001112233@c.us"
    return bot


def ok_fetch(data, mime="image/jpeg"):
    return {"status": "ok", "mime": mime, "bytes": len(data),
            "data_b64": b64(data)}


# ---------------------------------------------------------------------------
print("== laptop: photo bubble parsing ==")
photo = Bubble("false_92300@c.us_A1", image=True)
bot = make_bot([photo])
parsed = bot._parse_message_container(photo, 1)
check("caption-less photo -> kind image, empty text (no time label)",
      parsed and parsed["kind"] == "image" and parsed["text"] == "",
      parsed)
captioned = Bubble("false_92300@c.us_A2", caption="Is ka price?", image=True)
parsed = make_bot([captioned])._parse_message_container(captioned, 1)
check("photo caption kept as text", parsed["kind"] == "image"
      and parsed["text"] == "Is ka price?", parsed)
text = Bubble("false_92300@c.us_T1", caption="Salam")
parsed = make_bot([text])._parse_message_container(text, 1)
check("text bubble unchanged", parsed["kind"] == "text"
      and parsed["text"] == "Salam", parsed)
inner_only = Bubble("false_92300@c.us_T2", inner="Order #55 status")
parsed = make_bot([inner_only])._parse_message_container(inner_only, 1)
check("text fallback (inner text) still works", parsed["text"] ==
      "Order #55 status", parsed)
voice = Bubble("false_92300@c.us_V1", voice=True, image=True)
parsed = make_bot([voice])._parse_message_container(voice, 1)
check("voice wins over photo", parsed["kind"] == "voice", parsed)
empty = Bubble("false_92300@c.us_E1", inner="")
check("empty bubble ignored",
      make_bot([empty])._parse_message_container(empty, 1) is None, "none")


class Boom(Bubble):
    def evaluate(self, script, arg=None):
        if script == whatsapp.IMAGE_DETECT_JS:
            raise RuntimeError("detached")
        return super().evaluate(script, arg)


boom = Boom("false_92300@c.us_B1", caption="hi")
parsed = make_bot([boom])._parse_message_container(boom, 1)
check("detection error -> plain text (never raises)",
      parsed["kind"] == "text" and parsed["text"] == "hi", parsed)

print("== laptop: in-memory photo download ==")
target = Bubble("false_92300@c.us_P1", image=True, fetch=[ok_fetch(JPEG)])
later = Bubble("false_92300@c.us_T9", caption="aur ye bhi")
bot = make_bot([text, target, later])
result = bot.download_message_image("false_92300@c.us_P1", max_bytes=123456)
check("photo found by id even when not the last bubble",
      result["status"] == "ok" and base64.b64decode(result["data_b64"])
      == JPEG, result.get("status"))
check("mime sniffed from bytes", result["mime"] == "image/jpeg", result)
check("byte count returned", result["bytes"] == len(JPEG), result)
check("size cap passed into the page script", target.fetch_args == [123456],
      target.fetch_args)
png = Bubble("false_92300@c.us_P2", image=True, fetch=[ok_fetch(
    b"\x89PNG\r\n\x1a\n" + b"p" * 20, "")])
check("png with empty blob type", make_bot([png]).download_message_image(
    "false_92300@c.us_P2")["mime"] == "image/png", "png")
sticker = Bubble("false_92300@c.us_S1", image=True,
                 fetch=[ok_fetch(WEBP, "image/webp")])
check("WebP sticker skipped", make_bot([sticker]).download_message_image(
    "false_92300@c.us_S1") == {"status": "sticker"}, "sticker")
odd = Bubble("false_92300@c.us_U1", image=True,
             fetch=[ok_fetch(b"<svg/>" + b"x" * 30, "image/svg+xml")])
check("unknown bytes -> unsupported", make_bot([odd]).download_message_image(
    "false_92300@c.us_U1") == {"status": "unsupported"}, "svg")
pending = Bubble("false_92300@c.us_W1", image=True,
                 fetch=[{"status": "pending"}, {"status": "pending"},
                        ok_fetch(JPEG)])
bot = make_bot([pending])
result = bot.download_message_image("false_92300@c.us_W1")
check("pending -> download button clicked once -> ok",
      result["status"] == "ok" and pending.download_clicks == 1
      and bot.page.waits == 2, (result.get("status"),
                                pending.download_clicks, bot.page.waits))
stuck = Bubble("false_92300@c.us_W2", image=True,
               fetch=[{"status": "pending"}])
bot = make_bot([stuck])
bot.IMAGE_WAIT_SECONDS = 0.05
check("never loads -> pending after the deadline",
      bot.download_message_image("false_92300@c.us_W2") ==
      {"status": "pending"}, "pending")
large = Bubble("false_92300@c.us_L1", image=True,
               fetch=[{"status": "too_large", "bytes": 9999999}])
check("too_large passed through", make_bot([large]).download_message_image(
    "false_92300@c.us_L1") == {"status": "too_large"}, "large")
check("message scrolled away -> missing", make_bot([text])
      .download_message_image("nope") == {"status": "missing"}, "missing")
broken = Bubble("false_92300@c.us_X1", image=True,
                fetch=[RuntimeError("target closed")])
bot = make_bot([broken])
check("page error -> failed, logged, never raises",
      bot.download_message_image("false_92300@c.us_X1") ==
      {"status": "failed"} and any("Image Capture Error" in line
                                   for line in bot.logger.lines),
      bot.logger.lines)
many = [Bubble("false_92300@c.us_N%d" % i, caption="m%d" % i)
        for i in range(60)]
old = Bubble("false_92300@c.us_OLD", image=True, fetch=[ok_fetch(JPEG)])
check("scan is bounded (IMAGE_SCAN_LIMIT)", make_bot([old] + many)
      .download_message_image("false_92300@c.us_OLD") ==
      {"status": "missing"}, "bounded")

node = shutil.which("node")
if node:
    for label, script in (("detect", whatsapp.IMAGE_DETECT_JS),
                          ("fetch", whatsapp.IMAGE_FETCH_JS)):
        probe = subprocess.run(
            [node, "-e", "new Function('return (' + process.argv[1] + ')')",
             script], capture_output=True, text=True)
        check("page script parses (" + label + ")", probe.returncode == 0,
              probe.stderr[:300])
else:
    print("  (node not found - JS parse check skipped)")
check("candidate filter skips video / quoted / link previews",
      all(token in whatsapp.IMAGE_CANDIDATES_JS for token in (
          "video", "quoted", "a[href^='http']", "blob:", "data:image")),
      "filter")

print("== laptop: adapter ==")
account = ChannelAccount(id=4, client_id=1, platform="whatsapp",
                         account_name="Main", external_account_id="x")


class FakeBot:
    def __init__(self):
        self.calls = []

    def download_message_image(self, mid, max_bytes=0):
        self.calls.append((mid, max_bytes))
        return {"status": "ok", "mime": "image/jpeg", "data_b64": b64(JPEG)}

    def download_latest_voice_note(self, mid):
        return ""


fake_bot = FakeBot()
adapter = WhatsAppWebAdapter(account, "session", bot=fake_bot)


def raw(kind, mid, text_value=""):
    return {"kind": kind, "id": mid, "text": text_value,
            "chat_identifier": "923001112233@c.us", "chat_name": "Ali",
            "direction": "inbound"}


image_event = adapter.normalize_event(raw("image", "MID-IMG", "price?"))
check("image kind -> image event", image_event.message_type == "image"
      and image_event.content == "price?"
      and image_event.metadata["image_message_id"] == "MID-IMG",
      image_event)
check("voice kind unchanged", adapter.normalize_event(raw(
    "voice", "MID-V")).message_type == "audio", "voice")
check("text kind unchanged", adapter.normalize_event(raw(
    "text", "MID-T", "hi")).message_type == "text", "text")
check("capture_image -> bot download with the cap",
      adapter.capture_image(image_event, 777)["status"] == "ok"
      and fake_bot.calls == [("MID-IMG", 777)], fake_bot.calls)
text_event = adapter.normalize_event(raw("text", "MID-T2", "hi"))
check("capture_image ignores non-image events",
      adapter.capture_image(text_event, 777) is None, "text")
other = ChannelEvent(channel_account_id=9, external_user_id="u",
                     external_message_id="m", content="",
                     message_type="image")
check("capture_image ignores other accounts",
      adapter.capture_image(other, 777) is None, "account")
bare = WhatsAppWebAdapter(account, "session", bot=object())
check("older bot without the method -> None",
      bare.capture_image(image_event, 777) is None, "bare")

print("== laptop: run_channel media preparation ==")


class FakeAI:
    def __init__(self, transcript="Mera order kab aayega?", error=None):
        self.transcript = transcript
        self.error = error
        self.deleted = []
        self.seen_bytes = None

    def transcribe_voice(self, path):
        with open(path, "rb") as handle:
            self.seen_bytes = handle.read()
        if self.error:
            raise self.error
        return self.transcript

    def delete_temp_file(self, path):
        self.deleted.append(path)
        os.remove(path)


class FakeManager:
    def __init__(self, ai):
        self.ai = ai


class VoiceAdapter:
    def __init__(self, data=OGG, suffix=".ogg", fail=False):
        self.data, self.suffix, self.fail = data, suffix, fail
        self.path = None

    def download_media(self, event):
        if self.fail:
            return None
        handle = tempfile.NamedTemporaryFile(delete=False, suffix=self.suffix)
        handle.write(self.data)
        handle.close()
        self.path = handle.name
        return handle.name


def voice_event():
    return ChannelEvent(channel_account_id=4,
                        external_user_id="923001112233@c.us",
                        external_message_id="MID-V1", content="",
                        message_type="audio", display_name="Ali",
                        metadata={"voice_message_id": "MID-V1"})


ai = FakeAI()
va = VoiceAdapter()
event, media = rc.prepare_inbound_event(va, FakeManager(ai), voice_event(),
                                        capture_media=True)
check("voice transcribed for the local assistant",
      event.content == "Mera order kab aayega?"
      and event.metadata["transcribed"] is True, event)
check("voice copy = the downloaded bytes, marked transcribed",
      len(media) == 1 and base64.b64decode(media[0]["data_b64"]) == OGG
      and media[0]["type"] == "audio" and media[0]["mime"] == "audio/ogg"
      and media[0]["transcribed"] is True, media)
check("temp file still deleted", ai.deleted == [va.path]
      and not os.path.exists(va.path), ai.deleted)

ai = FakeAI(transcript="  ")
event, media = rc.prepare_inbound_event(VoiceAdapter(), FakeManager(ai),
                                        voice_event(), capture_media=True)
check("local STT empty -> copy still goes to the CP (not transcribed)",
      event is None and len(media) == 1
      and "transcribed" not in media[0], media)
ai = FakeAI(error=RuntimeError("quota"))
event, media = rc.prepare_inbound_event(VoiceAdapter(), FakeManager(ai),
                                        voice_event(), capture_media=True)
check("local STT raises -> no crash, copy kept, file deleted",
      event is None and len(media) == 1 and len(ai.deleted) == 1, media)
ai = FakeAI()
event, media = rc.prepare_inbound_event(VoiceAdapter(), FakeManager(ai),
                                        voice_event(), capture_media=False)
check("capture off -> old behaviour (transcript only)",
      event.content == "Mera order kab aayega?" and media == [], media)
saved_cap = rc.WA_MEDIA_MAX_BYTES
rc.WA_MEDIA_MAX_BYTES = 10
ai = FakeAI()
event, media = rc.prepare_inbound_event(VoiceAdapter(), FakeManager(ai),
                                        voice_event(), capture_media=True)
rc.WA_MEDIA_MAX_BYTES = saved_cap
check("oversize voice -> no copy, transcript kept", media == []
      and event.content and len(ai.deleted) == 1, media)
event, media = rc.prepare_inbound_event(VoiceAdapter(fail=True),
                                        FakeManager(FakeAI()), voice_event(),
                                        capture_media=True)
check("download failure -> skipped as before", event is None
      and media == [], media)
ai = FakeAI()
_event, media = rc.prepare_inbound_event(
    VoiceAdapter(suffix=".webm"), FakeManager(ai), voice_event(), True)
check("audio mime from the file suffix", media[0]["mime"] == "audio/webm",
      media)


class PhotoAdapter:
    def __init__(self, result):
        self.result = result
        self.calls = 0

    def capture_image(self, event, max_bytes):
        self.calls += 1
        return self.result


def photo_event(caption=""):
    return ChannelEvent(channel_account_id=4,
                        external_user_id="923001112233@c.us",
                        external_message_id="MID-P1", content=caption,
                        message_type="image", display_name="Ali",
                        metadata={"image_message_id": "MID-P1"})


pa = PhotoAdapter({"status": "ok", "mime": "image/jpeg",
                   "data_b64": b64(JPEG)})
event, media = rc.prepare_inbound_event(pa, None, photo_event("price?"),
                                        True)
check("photo -> image media for the CP", event.content == "price?"
      and media == [{"type": "image", "mime": "image/jpeg",
                     "data_b64": b64(JPEG)}], media)
event, media = rc.prepare_inbound_event(PhotoAdapter({"status": "sticker"}),
                                        None, photo_event(), True)
check("sticker -> ignored entirely", event is None and media == [], media)
event, media = rc.prepare_inbound_event(PhotoAdapter({"status": "failed"}),
                                        None, photo_event(), True)
check("capture failure -> event kept, no media", event is not None
      and media == [], media)
pa = PhotoAdapter({"status": "ok"})
rc.prepare_inbound_event(pa, None, photo_event(), False)
check("capture off -> browser never touched", pa.calls == 0, pa.calls)
check("adapter without capture_image -> no media",
      rc.prepare_inbound_event(object(), None, photo_event(), True)[1] == [],
      "none")
text_ev = ChannelEvent(channel_account_id=4, external_user_id="u",
                       external_message_id="m", content="hi")
check("text passthrough", rc.prepare_inbound_event(
    object(), None, text_ev, True) == (text_ev, []), "text")

check("CP body: transcribed voice with copy",
      rc.cp_inbound_body(text_ev.__class__(
          channel_account_id=4, external_user_id="u",
          external_message_id="m", content="kab aayega?",
          message_type="audio"), voice_event(), [{"type": "audio"}])
      == "[Voice note] kab aayega?", "voice body")
check("CP body: transcript without copy unchanged",
      rc.cp_inbound_body(ChannelEvent(
          channel_account_id=4, external_user_id="u",
          external_message_id="m", content="kab aayega?",
          message_type="audio"), voice_event(), []) == "kab aayega?", "plain")
check("CP body: voice placeholder", rc.cp_inbound_body(
    None, voice_event(), [{"type": "audio"}]) == "[Voice note]", "ph")
check("CP body: photo placeholder", rc.cp_inbound_body(
    photo_event(), photo_event(), []) == "[Image]", "ph")
check("CP body: caption", rc.cp_inbound_body(
    photo_event("price?"), photo_event("price?"), [{}]) == "price?", "cap")


def reload_with(env):
    saved = {key: os.environ.get(key) for key in env}
    os.environ.update(env)
    try:
        return load("run_channel_env", os.path.join(RIG, "run_channel.py"))
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


check("defaults: capture on, 3 MB", rc.WA_MEDIA_CAPTURE is True
      and rc.WA_MEDIA_MAX_BYTES == 3000000, rc.WA_MEDIA_MAX_BYTES)
check("env off", reload_with({"OMNIFLOW_WA_MEDIA_CAPTURE": "Off"})
      .WA_MEDIA_CAPTURE is False, "off")
check("cap clamped to the request limit", reload_with(
    {"OMNIFLOW_WA_MEDIA_MAX_BYTES": "99999999"}).WA_MEDIA_MAX_BYTES
    == 3200000, "clamp")
check("bad cap -> default", reload_with(
    {"OMNIFLOW_WA_MEDIA_MAX_BYTES": "abc"}).WA_MEDIA_MAX_BYTES == 3000000,
    "bad")

print("== laptop: run_worker loop end to end ==")


class LoopAdapter(WhatsAppWebAdapter):
    def __init__(self, payloads, stop):
        super().__init__(account, "session", bot=FakeBot())
        self.payloads = payloads
        self.stop_event = stop
        self.sent = []

    def start(self):
        self.started = True

    def stop(self):
        self.started = False

    def poll_events(self):
        # The real loop re-checks the stop flag before each event, so stop
        # only after every payload has been handed out.
        for payload in self.payloads:
            yield self.normalize_event(payload)
        self.stop_event.set()

    def download_media(self, event):
        handle = tempfile.NamedTemporaryFile(delete=False, suffix=".ogg")
        handle.write(OGG)
        handle.close()
        return handle.name


class LoopManager:
    def __init__(self):
        self.ai = FakeAI()
        self.processed = []
        self.cp_bridge = None

    def process_event(self, event):
        self.processed.append((event.message_type, event.content))
        return None

    def recover_due_reply(self, account_id):
        return None

    def close(self):
        return None


class LoopBridge:
    instances = []
    command_poll_seconds = 60

    def __init__(self, account_name=None):
        self.ingested = []
        LoopBridge.instances.append(self)

    def report_status(self, state, phone=None):
        return True

    def run_due_commands(self, adapter, stop):
        return None

    def ingest_message(self, **kwargs):
        self.ingested.append(kwargs)


stop = threading.Event()
loop_adapter = LoopAdapter([
    raw("text", "MID-T", "Salam"),
    raw("voice", "MID-V"),
    raw("image", "MID-P"),
    raw("image", "MID-PC", "Ye wala?"),
], stop)
manager = LoopManager()
saved = (rc.create_adapter, rc.ConversationManager, rc.ControlPlaneBridge)
rc.create_adapter = lambda acct: loop_adapter
rc.ConversationManager = lambda: manager
rc.ControlPlaneBridge = LoopBridge
try:
    rc.run_worker(account, stop_event=stop)
finally:
    rc.create_adapter, rc.ConversationManager, rc.ControlPlaneBridge = saved
sent = LoopBridge.instances[-1].ingested if LoopBridge.instances else []
check("4 inbound messages reached the CP", len(sent) == 4, sent)
if len(sent) == 4:
    check("text: no media, no id (unchanged)", sent[0]["body"] == "Salam"
          and sent[0]["media"] is None and sent[0]["message_id"] is None,
          sent[0])
    check("voice: transcript body + transcribed copy + id",
          sent[1]["body"] == "[Voice note] Mera order kab aayega?"
          and sent[1]["media"][0]["transcribed"] is True
          and sent[1]["message_id"] == "MID-V", sent[1].get("body"))
    check("photo: placeholder + jpeg copy + id",
          sent[2]["body"] == "[Image]"
          and sent[2]["media"][0]["mime"] == "image/jpeg"
          and sent[2]["message_id"] == "MID-P", sent[2].get("body"))
    check("captioned photo: caption body", sent[3]["body"] == "Ye wala?",
          sent[3].get("body"))
    check("display name forwarded", all(s["display_name"] == "Ali"
                                        for s in sent), "names")
check("local assistant: text, voice, captioned photo (not the bare photo)",
      manager.processed == [("text", "Salam"),
                            ("audio", "Mera order kab aayega?"),
                            ("image", "Ye wala?")], manager.processed)

print("== laptop: Control Plane bridge ==")


class Recorder:
    def __init__(self, statuses):
        self.statuses = list(statuses)
        self.calls = []

    def __call__(self, method, path, payload=None, timeout=None):
        self.calls.append((path, json.loads(json.dumps(payload)), timeout))
        status = self.statuses.pop(0) if self.statuses else 200
        return status, ({"inserted": len(payload["messages"])}
                        if status == 200 else {})


def new_bridge(statuses, **env):
    saved_env = {key: os.environ.get(key) for key in env}
    os.environ.update(env)
    try:
        bridge = laptop_bridge.ControlPlaneBridge(account_name="Main")
    finally:
        for key, value in saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
    bridge._request = Recorder(statuses)
    return bridge


bridge = new_bridge([200])
bridge.ingest_message("923@c.us", "", media=[
    {"type": "image", "mime": "image/jpeg", "data_b64": b64(JPEG)}],
    message_id="false_923@c.us_ABC", display_name="Ali")
path, payload, timeout = bridge._request.calls[0]
message = payload["messages"][0]
check("media message posted to the WhatsApp ingest route",
      path == "/api/v1/connector/whatsapp/messages", path)
check("exact id for CP dedupe", message["id"] == "waweb:false_923@c.us_ABC",
      message.get("id"))
check("image placeholder body", message["body"] == "[Image]", message)
check("media sent inline", message["media"][0]["data_b64"] == b64(JPEG),
      "media")
check("media upload gets its own (longer) timeout", timeout == 30.0, timeout)
check("queue empty after success", bridge._pending == [], bridge._pending)

bridge = new_bridge([200])
bridge.ingest_message("923@c.us", "", media=[{"type": "audio"}])
check("voice placeholder body", bridge._request.calls[0][1]["messages"][0]
      ["body"] == "[Voice note]", "voice")
bridge = new_bridge([200])
bridge.ingest_message("923@c.us", "Shukriya", direction="out",
                      media=[{"type": "image"}], message_id="X")
out = bridge._request.calls[0][1]["messages"][0]
check("outbound never carries media or id", "media" not in out
      and "id" not in out and bridge._request.calls[0][2] is None, out)
bridge = new_bridge([200])
bridge.ingest_message("923@c.us", "hi", media=[{"type": "image"}, "junk",
                                               {"type": "image"},
                                               {"type": "image"},
                                               {"type": "image"}])
check("media capped at 3 dicts", len(bridge._request.calls[0][1]
                                     ["messages"][0]["media"]) == 2, "cap")

bridge = new_bridge([0, 0, 0])
bridge.ingest_message("a@c.us", "first")
bridge.ingest_message("b@c.us", "", media=[{"type": "image",
                                            "data_b64": b64(JPEG)}],
                      message_id="M1")
bridge.ingest_message("c@c.us", "third")
check("CP offline -> all three queued", len(bridge._pending) == 3,
      len(bridge._pending))
bridge._request.statuses = [200, 200, 200]
bridge._request.calls.clear()
check("flush drains in order", bridge.flush() is True
      and bridge._pending == [], bridge._pending)
groups = [[m["from"] for m in call[1]["messages"]]
          for call in bridge._request.calls]
check("media travels alone, order kept",
      groups == [["a@c.us"], ["b@c.us"], ["c@c.us"]], groups)
check("private retry counters never sent", all(
    not key.startswith("_") for call in bridge._request.calls
    for m in call[1]["messages"] for key in m), "private")

bridge = new_bridge([0, 0, 200, 200])
bridge.ingest_message("a@c.us", "", media=[{"type": "image",
                                            "data_b64": b64(JPEG)}])
check("first failure keeps the file", bridge._pending[0].get("media")
      and bridge._pending[0]["_media_failures"] == 1, bridge._pending)
bridge.flush()
check("second failure drops the file, text stays queued",
      "media" not in bridge._pending[0]
      and bridge._pending[0]["body"] == "[Image]", bridge._pending)
bridge.ingest_message("b@c.us", "next")
check("text then flows (no queue blocking, one request)",
      bridge._pending == []
      and [[m["from"] for m in c[1]["messages"]]
           for c in bridge._request.calls[2:]] == [["a@c.us", "b@c.us"]],
      bridge._request.calls[2:])

bridge = new_bridge([0] * 20)
for index in range(5):
    bridge.ingest_message("x%d@c.us" % index, "", media=[
        {"type": "audio", "data_b64": b64(OGG)}])
held = [item["from"] for item in bridge._pending if item.get("media")]
check("offline media backlog bounded (default 3, newest kept)",
      len(bridge._pending) == 5 and held[-3:] == ["x2@c.us", "x3@c.us",
                                                   "x4@c.us"]
      and len(held) <= 3, held)
bridge = new_bridge([], OMNIFLOW_CP_MEDIA_TIMEOUT_SECONDS="nope",
                    OMNIFLOW_CP_MEDIA_RETRIES="0",
                    OMNIFLOW_CP_MEDIA_BACKLOG="7")
check("env parsing: bad -> default, floor 1, custom backlog",
      bridge.media_timeout_seconds == 30.0 and bridge.media_retries == 1
      and bridge.media_backlog == 7, (bridge.media_timeout_seconds,
                                      bridge.media_retries,
                                      bridge.media_backlog))

# ---------------------------------------------------------------------------
print("== Control Plane: connector-transcribed voice notes ==")
import connector_api  # noqa: E402
import portal_events  # noqa: E402
import portal_inbound_media as im  # noqa: E402
import portal_media_ai as mai  # noqa: E402

calls = {"audio": 0, "image": 0}


def fake_audio(data, mime, cid, cur=None):
    calls["audio"] += 1
    return "CP transcript", ""


def fake_image(data, mime, cid, cur=None):
    calls["image"] += 1
    return ({"category": "product", "description": "A red shoe.",
             "text_in_image": ""}, "")


mai.understand_audio = fake_audio
mai.understand_image = fake_image
ON = {"voice_notes": True, "images": True}
READY = {"voice_notes": {"active": True}, "images": {"active": True}}

normalized = connector_api.normalize_messages([{
    "from": "923@c.us", "body": "[Voice note] Mera order kab aayega?",
    "id": "waweb:false_923@c.us_V1",
    "media": [{"type": "audio", "mime": "audio/ogg", "data_b64": b64(OGG),
               "transcribed": True}]}], default_channel="whatsapp")
check("normalize keeps id, media and the flag",
      normalized[0]["id"] == "waweb:false_923@c.us_V1"
      and normalized[0]["media"][0]["transcribed"] is True
      and normalized[0]["channel"] == "whatsapp", normalized[0])
blobs = mai.detach_blobs(normalized)
check("detach keeps the flag, removes the bytes",
      normalized[0]["media"][0]["transcribed"] is True
      and "data_b64" not in normalized[0]["media"][0]
      and blobs[id(normalized[0])] == [OGG], normalized[0]["media"])
budget = mai.Budget(1)
changed = mai.enrich(FakeCur([[], [], []]), 7, normalized[0],
                     blobs[id(normalized[0])], budget, ON, READY)
check("no second speech-to-text", calls["audio"] == 0 and not changed,
      calls)
check("body untouched", normalized[0]["body"] ==
      "[Voice note] Mera order kab aayega?", normalized[0]["body"])
check("audit note says connector", normalized[0]["media_ai"] ==
      [{"type": "audio", "ok": True, "source": "connector"}],
      normalized[0].get("media_ai"))
check("request budget not spent", budget.left == 1, budget.left)

mixed = {"from": "923@c.us", "body": "[Voice note] ye dekho",
         "direction": "in",
         "media": [{"type": "audio", "transcribed": True},
                   {"type": "image", "mime": "image/jpeg"}]}
mai.enrich(FakeCur([[], [], []]), 7, mixed, [OGG, JPEG], mai.Budget(), ON,
           READY)
check("image beside a transcribed voice note is still described",
      calls == {"audio": 0, "image": 1} and mixed["body"] ==
      "[Voice note] ye dekho\n[Image: product] A red shoe.", mixed["body"])
strict = {"from": "923@c.us", "body": "[Voice note]", "direction": "in",
          "media": [{"type": "audio", "transcribed": "true"}]}
mai.enrich(FakeCur([[], [], []]), 7, strict, [OGG], mai.Budget(), ON, READY)
check("flag is strict (string 'true' still transcribed by the CP)",
      calls["audio"] == 1 and strict["body"] ==
      "[Voice note] CP transcript", strict["body"])
fallback = {"from": "923@c.us", "body": "[Voice note]", "direction": "in",
            "media": [{"type": "audio", "mime": "audio/ogg"}]}
mai.enrich(FakeCur([[], [], []]), 7, fallback, [OGG], mai.Budget(), ON,
           READY)
check("laptop STT failed -> CP transcribes the copy",
      fallback["body"] == "[Voice note] CP transcript", fallback["body"])

key_a, window_a = portal_events._event_key(7, {"from": "923@c.us",
                                              "body": "[Image]",
                                              "id": "waweb:A"})
key_b, _ = portal_events._event_key(7, {"from": "923@c.us",
                                        "body": "[Image]", "id": "waweb:B"})
check("two bare photos are two messages (exact id dedupe, no window)",
      key_a != key_b and key_a == "pid:waweb:A" and window_a == "", key_a)


def settings_row():
    return [{"media_store": None}]


im._DDL_READY = True
im._CS_READY = True
cur = FakeCur([[], settings_row(), [], [], [{"used": 100}], []])
item = {"channel": "whatsapp", "from": "923@c.us",
        "id": "waweb:false_923@c.us_V1", "direction": "in",
        "media": [{"type": "audio", "mime": "audio/ogg",
                   "transcribed": True}]}
stored = im.capture(cur, 7, 55, item, [OGG])
inserts = [e for e in cur.executed
           if str(e[0]).startswith("INSERT INTO portal_inbound_media")]
params = tuple(inserts[0][1]) if inserts else ()
check("store keeps the WhatsApp voice copy", stored == 1
      and params[:9] == (7, 55, "whatsapp", "923@c.us",
                         "waweb:false_923@c.us_V1", 0, "audio", "audio/ogg",
                         len(OGG)), params[:9])

raise SystemExit(1 if summary("wa_media_capture") else 0)
