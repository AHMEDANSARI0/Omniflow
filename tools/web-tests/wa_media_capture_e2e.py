"""Batch 220 - real Playwright + Chromium run of the laptop WhatsAppBot photo
capture (src/whatsapp.py) against a WhatsApp-Web-like chat with real blob:
images.

Needs: pip install playwright, and a Chromium binary.
  python tools/web-tests/wa_media_capture_e2e.py <repo root>
  env CHROMIUM=/path/to/chrome (default: Playwright's bundled browser)
      CHROMIUM_ARGS_JSON=/path/args.json (optional extra launch args)
Sandbox note: the @sparticuz/chromium binary also needs
LD_LIBRARY_PATH=/tmp/al2023/lib.
"""
import base64
import json
import os
import sys
import tempfile
import types

ROOT = sys.argv[1]
sys.path.insert(0, os.path.join(ROOT, "src"))
for name, attrs in {
    "config": {"AUDIO_TEMP_DIR": tempfile.mkdtemp(), "BASE_DIR": ROOT},
    "logger": {"Logger": type("L", (), {"__init__": lambda s: setattr(s, "lines", []),
                                        "log": lambda s, m: s.lines.append(m)})},
    "typing_engine": {"TypingEngine": type("T", (), {})},
}.items():
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules[name] = module

from playwright.sync_api import sync_playwright  # noqa: E402
import whatsapp  # noqa: E402

PASS = FAIL = 0


def check(name, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print("  PASS  " + name)
    else:
        FAIL += 1
        print("  FAIL  " + name + "  ::  " + str(detail)[:300])


JID = "923001112233@c.us"
HTML = """<!doctype html><html><body><div id="main">
<div class="message-in"><div data-testid="msg-container" data-id="false_%(j)s_T1">
  <div data-pre-plain-text="[10:40 pm, 03/10/2026] Ali: "><span class="selectable-text">Salam</span></div><span>10:40 pm</span></div></div>
<div class="message-in"><div data-testid="msg-container" data-id="false_%(j)s_P1">
  <div role="button" aria-label="Open picture"><img id="p1"></div><span>10:41 pm</span></div></div>
<div class="message-in"><div data-testid="msg-container" data-id="false_%(j)s_P2">
  <div role="button"><img id="p2"></div><span class="selectable-text">Is ka price?</span><span>10:41 pm</span></div></div>
<div class="message-in"><div data-testid="msg-container" data-id="false_%(j)s_W1">
  <div role="button"><img id="w1" src="data:image/jpeg;base64,/9j/4AAQ" style="width:240px;height:240px"></div>
  <span data-icon="media-download" id="dl" style="display:inline-block;width:20px;height:20px"></span><span>10:42 pm</span></div></div>
<div class="message-in"><div data-testid="msg-container" data-id="false_%(j)s_S1"><img id="s1"></div></div>
<div class="message-in"><div data-testid="msg-container" data-id="false_%(j)s_L1"><img id="l1"></div></div>
<div class="message-in"><div data-testid="msg-container" data-id="false_%(j)s_T2">
  <span class="selectable-text">aur ye bhi</span><span>10:43 pm</span></div></div>
</div></body></html>""" % {"j": JID}

SETUP = """async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 320; canvas.height = 320;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#2a7"; ctx.fillRect(0, 0, 320, 320);
  const jpeg = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
  const webp = await new Promise((r) => canvas.toBlob(r, "image/webp", 0.9));
  const big = new Blob([await jpeg.arrayBuffer(), new Uint8Array(300000)], {type: "image/jpeg"});
  const load = (id, blob) => new Promise((resolve) => {
    const img = document.getElementById(id);
    img.onload = resolve; img.src = URL.createObjectURL(blob);
  });
  await load("p1", jpeg); await load("p2", jpeg); await load("s1", webp); await load("l1", big);
  // WhatsApp-like lazy download: clicking the button loads the full photo later.
  document.getElementById("dl").addEventListener("click", () => {
    window.__dlClicks = (window.__dlClicks || 0) + 1;
    setTimeout(() => { document.getElementById("w1").src = URL.createObjectURL(jpeg); }, 600);
  });
}"""

ARGS_FILE = os.environ.get("CHROMIUM_ARGS_JSON", "")
LAUNCH = {"headless": True, "args": json.load(open(ARGS_FILE)) if ARGS_FILE else []}
if os.environ.get("CHROMIUM"):
    LAUNCH["executable_path"] = os.environ["CHROMIUM"]
with sync_playwright() as pw:
    browser = pw.chromium.launch(**LAUNCH)
    page = browser.new_page()
    page.set_content(HTML)
    page.evaluate(SETUP)

    bot = whatsapp.WhatsAppBot("session")
    bot.page = page
    messages = bot.get_visible_chat_messages(fallback_chat_identifier=JID)
    kinds = {m["id"].rsplit("_", 1)[-1]: (m["kind"], m["text"]) for m in messages}
    print("  parsed:", kinds)
    check("text bubble", kinds.get("T1") == ("text", "Salam"), kinds)
    check("caption-less photo -> image, no time label", kinds.get("P1") == ("image", ""), kinds)
    check("photo caption", kinds.get("P2") == ("image", "Is ka price?"), kinds)
    check("not-yet-downloaded photo -> image", kinds.get("W1") == ("image", ""), kinds)
    check("chat identity resolved from data-id", all(m["chat_identifier"] == JID.split("@")[0] for m in messages),
          [m["chat_identifier"] for m in messages])

    result = bot.download_message_image("false_%s_P1" % JID)
    data = base64.b64decode(result.get("data_b64") or "")
    check("photo P1 copied by id (not the last bubble)", result["status"] == "ok"
          and data[:3] == b"\xff\xd8\xff" and len(data) == result["bytes"]
          and result["mime"] == "image/jpeg", {k: v for k, v in result.items() if k != "data_b64"})
    result = bot.download_message_image("false_%s_W1" % JID)
    clicks = page.evaluate("window.__dlClicks || 0")
    check("lazy photo: download clicked once, then copied", result["status"] == "ok"
          and clicks == 1, (result["status"], clicks))
    check("sticker skipped", bot.download_message_image("false_%s_S1" % JID) == {"status": "sticker"})
    check("over the cap -> too_large", bot.download_message_image(
        "false_%s_L1" % JID, max_bytes=100000) == {"status": "too_large"})
    check("unknown id -> missing", bot.download_message_image("false_%s_ZZ" % JID) == {"status": "missing"})
    browser.close()

print("\nSUMMARY[wa_playwright_e2e]: %d PASS, %d FAIL" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
