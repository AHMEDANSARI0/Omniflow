"""Batch 221 - real browser run of Knowledge OCR, end to end:

Chromium -> the real Knowledge card (KbSourcesCard) -> the real Next.js BFF
route /api/omniflow/portal/kb/extract -> a real Control Plane process
(portal_knowledge + portal_kb_files, Flask) -> a stub vision model.
Only /kb/sources (needs Postgres) is answered in the browser.

Usage (a Next dev server must point its Control Plane at CP_PORT):
  OMNIFLOW_CONTROL_PLANE_URL=http://127.0.0.1:5799 npx next dev -p 3100
  python tools/web-tests/kb_ocr_e2e.py <repo root> http://127.0.0.1:3100
  env CHROMIUM=/path/to/chrome, CHROMIUM_ARGS_JSON=/path/args.json,
      CP_PORT (default 5799)
The script adds a temporary page app/zz-kb-ocr-e2e/ and removes it.
"""
import io
import json
import os
import sys
import threading
import time

ROOT = os.path.abspath(sys.argv[1])
BASE = sys.argv[2].rstrip("/")
CP_PORT = int(os.environ.get("CP_PORT", "5799"))
sys.path.insert(0, os.path.join(ROOT, "omniflow-backend-patch"))
os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "x")
os.environ["OF_KB_OCR_PAGES_PER_CALL"] = "1"

from flask import Flask  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402
from werkzeug.serving import make_server  # noqa: E402

import portal_kb_files as kf  # noqa: E402
import portal_knowledge as pk  # noqa: E402
import portal_llm  # noqa: E402

PASS = FAIL = 0


def check(name, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print("  PASS  " + name)
    else:
        FAIL += 1
        print("  FAIL  " + name + "  ::  " + str(detail)[:300])


# ---------- Control Plane process ----------

TOKEN = "tok-e2e"
SEEN = []
MODE = {"reply": "ok", "delay": 0.2}


def principal():
    from flask import request
    if request.headers.get("Authorization") != "Bearer " + TOKEN:
        return None
    return {"session_id": "s", "user_id": 1, "client_id": 42, "role": "owner",
            "email": "o@example.com", "display_name": "O", "via_api_key": False}


def vision(data, mime, system, prompt, timeout=None, runtime=None, max_tokens=0):
    image = Image.open(io.BytesIO(data))
    SEEN.append({"mime": mime, "size": image.size, "scope": portal_llm.current_scope()[:2]})
    time.sleep(MODE["delay"])
    if MODE["reply"] == "blocked":
        return None, "blocked by the platform AI controls"
    colour = image.convert("RGB").getpixel((5, 5))
    return {"text": "OCR text %dx%d colour %s" % (image.size[0], image.size[1], colour[0])}, ""


pk.authenticate_portal_request = principal
portal_llm.describe_image = vision
portal_llm.vision_runtime = lambda: {"active": True, "reason": "active", "api_key": "k"}
app = Flask("cp-e2e")
app.register_blueprint(pk.bp)
server = make_server("127.0.0.1", CP_PORT, app, threaded=True)
threading.Thread(target=server.serve_forever, daemon=True).start()


# ---------- fixtures ----------

def jpeg_page(shade):
    image = Image.new("RGB", (600, 800), (shade, shade, shade))
    ImageDraw.Draw(image).text((40, 200), "Scanned", fill="black")
    out = io.BytesIO()
    image.save(out, "JPEG", quality=85)
    return out.getvalue()


def build_pdf(pages):
    objs = [None, None, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []

    def add(obj):
        objs.append(obj)
        return len(objs)

    for page in pages:
        content, xobj = "", ""
        if isinstance(page, bytes):
            img = add(b"<< /Type /XObject /Subtype /Image /Width 600 /Height 800"
                      b" /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode"
                      b" /Length " + str(len(page)).encode() + b" >>\nstream\n" + page
                      + b"\nendstream")
            xobj = " /XObject << /Im0 %d 0 R >>" % img
            content = "q 612 0 0 792 0 0 cm /Im0 Do Q"
        else:
            content = "BT /F1 12 Tf 72 720 Td (%s) Tj ET" % page
        data = content.encode("latin-1")
        stream = add(b"<< /Length " + str(len(data)).encode() + b" >>\nstream\n" + data
                     + b"\nendstream")
        kids.append(add(("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources"
                         " << /Font << /F1 3 0 R >>%s >> /Contents %d 0 R >>"
                         % (xobj, stream)).encode()))
    objs[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objs[1] = ("<< /Type /Pages /Kids [%s] /Count %d >>" % (
        " ".join("%d 0 R" % k for k in kids), len(kids))).encode()
    out, offsets = b"%PDF-1.4\n", []
    for number, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += str(number).encode() + b" 0 obj\n" + obj + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 " + str(len(objs) + 1).encode() + b"\n0000000000 65535 f \n"
    out += b"".join(("%010d 00000 n \n" % o).encode() for o in offsets)
    return out + (b"trailer\n<< /Size " + str(len(objs) + 1).encode()
                  + b" /Root 1 0 R >>\nstartxref\n" + str(xref).encode() + b"\n%%EOF\n")


MIXED = build_pdf(["Delivery policy: orders ship within 24 hours across Pakistan.",
                   jpeg_page(200), jpeg_page(120)])
SCANNED = build_pdf([jpeg_page(210), jpeg_page(160), jpeg_page(90)])
photo = Image.new("RGB", (3000, 2000), (230, 230, 230))
ImageDraw.Draw(photo).text((100, 100), "Price list", fill="black")
buf = io.BytesIO()
photo.save(buf, "PNG")
PHOTO = buf.getvalue()

LIMITS = {"max_sources": 50, "max_chars": 200000, "chunk_chars": 900, "max_versions": 10,
          "refresh_hours": 168, "file_bytes_max": 3000000, "pdf_available": True,
          "ocr_available": True, "ocr_pages_max": 50, "ocr_pages_per_call": 1}
SOURCES = {"sources": [], "health": {"sources": 0, "published": 0, "drafts": 0, "paused": 0,
                                     "chunks": 0, "errors": 0, "stale": 0}, "limits": LIMITS}

PAGE_DIR = os.path.join(ROOT, "app", "zz-kb-ocr-e2e")
os.makedirs(PAGE_DIR, exist_ok=True)
with open(os.path.join(PAGE_DIR, "page.tsx"), "w", encoding="utf8") as handle:
    handle.write('import KbSourcesCard from "../dashboard/(portal)/knowledge-base/KbSourcesCard";\n\n'
                 "export default function Page() {\n  return <KbSourcesCard />;\n}\n")

CREATED = []
REINDEXED = []
DIALOGS = []
ANSWER = {"accept": True}


def run():
    launch = {"headless": True}
    if os.environ.get("CHROMIUM"):
        launch["executable_path"] = os.environ["CHROMIUM"]
    if os.environ.get("CHROMIUM_ARGS_JSON"):
        launch["args"] = json.load(open(os.environ["CHROMIUM_ARGS_JSON"]))
    with sync_playwright() as play:
        browser = play.chromium.launch(**launch)
        context = browser.new_context()
        host = BASE.split("//", 1)[1].split(":")[0]
        context.add_cookies([{"name": "of_access_token", "value": TOKEN, "domain": host, "path": "/"}])
        page = context.new_page()

        def sources(route):
            if route.request.method == "POST":
                CREATED.append(json.loads(route.request.post_data or "{}"))
                return route.fulfill(status=201, content_type="application/json",
                                     body=json.dumps({"source": {"id": 1}}))
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(SOURCES))

        page.route("**/api/omniflow/portal/kb/sources", sources)

        def reindex(route):
            REINDEXED.append(json.loads(route.request.post_data or "{}"))
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps({"source": SOURCES["sources"][0] if SOURCES["sources"] else {}}))

        page.route("**/api/omniflow/portal/kb/sources/*/reindex", reindex)

        def dialog(d):
            DIALOGS.append(d.message)
            d.accept() if ANSWER["accept"] else d.dismiss()

        page.on("dialog", dialog)
        try:
            steps(page)
        except Exception:
            print("---- page text at failure ----")
            print(page.inner_text("body")[-1500:])
            print("---- dialogs", DIALOGS, "vision calls", len(SEEN))
            raise
        finally:
            browser.close()


def wait_until(page, predicate, seconds=30):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if predicate():
            return True
        page.wait_for_timeout(100)
    return False


def idle(page):
    wait_until(page, lambda: "Reading with AI" not in page.inner_text("body"), 60)


def steps(page):
    if True:
        page.goto(BASE + "/zz-kb-ocr-e2e", wait_until="networkidle", timeout=180000)
        page.get_by_role("button", name="Upload file").click()
        textarea = page.locator("textarea")
        notice = page.locator("p.text-xs.text-ok, p.text-xs.text-danger").last

        def upload(name, data, mime):
            page.locator('input[type="file"]:not([aria-hidden="true"])').set_input_files(
                {"name": name, "mimeType": mime, "buffer": data})

        check("helper copy says scans/photos are read with AI after consent",
              page.get_by_text("Scanned PDFs and photos are read with AI after you confirm.").count() == 1)

        # 1. mixed PDF, accept
        SEEN.clear(), DIALOGS.clear()
        upload("policy.pdf", MIXED, "application/pdf")
        page.get_by_text("Reading with AI").wait_for(timeout=20000)
        check("progress line + Cancel visible while reading",
              page.get_by_role("button", name="Cancel").count() == 1)
        page.wait_for_function("() => document.querySelector('textarea').value.includes('colour 120')",
                               timeout=30000)
        value = textarea.input_value()
        check("consent asked once with page counts and the credits note",
              len(DIALOGS) == 1 and "2 of 3 pages have no selectable text" in DIALOGS[0]
              and "AI credits" in DIALOGS[0], DIALOGS)
        check("one page per request (OF_KB_OCR_PAGES_PER_CALL=1), workspace scope",
              len(SEEN) == 2 and all(s["scope"] == ("kb_ocr", 42) for s in SEEN), SEEN)
        check("merged text in page order: text page, then scans 2 and 3",
              value.index("Delivery policy") < value.index("colour 200") < value.index("colour 120"), value)
        page.wait_for_function("() => !document.body.innerText.includes('Reading with AI')", timeout=10000)
        check("owner told how many pages AI read + to check them",
              "Read 2 pages with AI - check the text for mistakes." in notice.inner_text(), notice.inner_text())
        page.get_by_role("button", name="Add as draft").click()
        wait_until(page, lambda: bool(CREATED), 20)
        check("reviewed OCR text goes to the normal draft create",
              CREATED and "colour 200" in CREATED[-1].get("text", "")
              and CREATED[-1].get("kind") == "file", CREATED[-1:] and {k: v for k, v in CREATED[-1].items() if k != "text"})

        # 2. whole scanned PDF, decline
        SEEN.clear(), DIALOGS.clear()
        ANSWER["accept"] = False
        page.get_by_role("button", name="Upload file").click()
        upload("scan.pdf", SCANNED, "application/pdf")
        wait_until(page, lambda: bool(DIALOGS), 30)
        page.wait_for_timeout(1500)
        check("decline on a scanned PDF -> no AI call, no error notice",
              len(DIALOGS) == 1 and "This PDF looks scanned. Read its 3 pages with AI?" in DIALOGS[0]
              and SEEN == [] and page.locator("p.text-danger").count() == 0, (DIALOGS, len(SEEN)))
        ANSWER["accept"] = True

        # 3. cancel mid-way
        idle(page)
        SEEN.clear(), DIALOGS.clear()
        MODE["delay"] = 1.5
        upload("scan2.pdf", SCANNED, "application/pdf")
        page.get_by_role("button", name="Cancel").wait_for(timeout=20000)
        page.get_by_role("button", name="Cancel").click()
        page.wait_for_function("() => !document.body.innerText.includes('Reading with AI')", timeout=20000)
        MODE["delay"] = 0.2
        check("Cancel stops before the next page",
              len(SEEN) == 1 and "Stopped - the remaining pages were not read." in notice.inner_text()
              and "colour 210" in textarea.input_value(), (len(SEEN), notice.inner_text()))

        # 4. photo: consent first, shrunk in the browser, sent as JPEG
        idle(page)
        page.wait_for_timeout(2000)  # the cancelled run's in-flight page finishes
        SEEN.clear(), DIALOGS.clear()
        upload("menu.png", PHOTO, "image/png")
        page.wait_for_function("() => document.querySelector('textarea').value.includes('2000x1333')",
                               timeout=30000)
        check("photo: consent before upload", DIALOGS == ["Read the text in this image with AI? This uses"
                                                          " your workspace's AI credits."], DIALOGS)
        check("photo shrunk to 2000 px JPEG in the browser before upload",
              len(SEEN) == 1 and SEEN[0]["mime"] == "image/jpeg" and SEEN[0]["size"] == (2000, 1333),
              SEEN)
        check("title from the file name", page.locator("input[placeholder^='Title']").input_value() == "menu",
              page.locator("input[placeholder^='Title']").input_value())

        # 5. AI gate -> stops with the owner message
        idle(page)
        SEEN.clear(), DIALOGS.clear()
        MODE["reply"] = "blocked"
        upload("scan3.pdf", SCANNED, "application/pdf")
        page.locator("p.text-danger").wait_for(timeout=30000)
        MODE["reply"] = "ok"
        danger = page.locator("p.text-danger").inner_text()
        check("AI limit reached -> stops after the first page, reason said once",
              len(SEEN) == 1 and danger.count("daily AI limit") == 1, (len(SEEN), danger))

        # 6. "Upload new version" of an existing file source uses the same flow
        idle(page)
        SOURCES["sources"] = [{"id": 5, "title": "Rate card", "kind": "file", "origin": "rates.pdf",
                               "status": "draft", "version": 1, "chunk_count": 2, "char_count": 400,
                               "last_error": "", "stale": False, "ingested_at": None,
                               "updated_at": None}]
        page.reload(wait_until="networkidle")
        SEEN.clear(), DIALOGS.clear()
        with page.expect_file_chooser() as chooser:
            page.get_by_role("button", name="Upload new version").click()
        chooser.value.set_files({"name": "rates.pdf", "mimeType": "application/pdf", "buffer": SCANNED})
        wait_until(page, lambda: bool(REINDEXED), 40)
        check("new version of a scanned PDF: consent, AI read, reindexed with the read text",
              len(DIALOGS) == 1 and len(SEEN) == 3 and REINDEXED
              and "colour 90" in REINDEXED[-1].get("text", "")
              and REINDEXED[-1].get("filename") == "rates.pdf", (DIALOGS, len(SEEN), REINDEXED[-1:]))
        SOURCES["sources"] = []

        # 7. vision not available -> images refused up front
        LIMITS["ocr_available"] = False
        page.reload(wait_until="networkidle")
        page.get_by_role("button", name="Upload file").click()
        SEEN.clear(), DIALOGS.clear()
        upload("menu.png", PHOTO, "image/png")
        page.locator("p.text-danger").wait_for(timeout=10000)
        check("no vision AI -> image refused without a request or a prompt",
              SEEN == [] and DIALOGS == [] and "image-understanding AI" in page.locator(
                  "p.text-danger").inner_text(), page.locator("p.text-danger").inner_text())


try:
    run()
finally:
    try:
        os.remove(os.path.join(PAGE_DIR, "page.tsx"))
        os.rmdir(PAGE_DIR)
    except OSError:
        pass
    server.shutdown()

print("\nSUMMARY[kb_ocr_e2e]: %d PASS, %d FAIL" % (PASS, FAIL))
raise SystemExit(1 if FAIL else 0)
