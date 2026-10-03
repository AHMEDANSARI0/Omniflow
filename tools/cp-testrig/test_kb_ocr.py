"""Batch 221 - OCR for knowledge uploads (scanned PDFs + document photos).

Covers, on real hand-built PDFs and images: which pages are offered for
AI reading (no / little text + a page-sized image, nested forms, small
logos ignored), whole-scanned vs mixed PDFs, the honest errors when the
vision AI is not available, page-image extraction (JPEG passthrough,
Flate gray / RGB / 1-bit / inverted / image mask / indexed / ICC re-encoded
as a PNG that decodes back to the same pixels, CCITT + CMYK + oversized
via Pillow, Pillow missing -> honest skip, JBIG2 -> skip, raw-size bomb
guard), the OCR call (prompt, JSON reply, max_tokens / timeouts from env,
usage scope kb_ocr per client inside the worker threads, concurrency per
call, AI gate -> ai_blocked, provider failure -> ai_failed, deadline ->
timeout, page validation and per-call cap), uploaded images (magic bytes,
not the file name), the /kb/extract endpoint (ocr flag, human-only,
stores nothing), limits, the usage feature label and the website surface
(BFF route, portal.ts client + timeout, Knowledge card consent/progress).
"""
import base64
import io
import os
import sys
import threading
import time
import types
import zlib

_HERE = os.path.abspath(os.path.dirname(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
_CP = os.path.join(_ROOT, "omniflow-backend-patch")
sys.path = [p for p in sys.path if os.path.abspath(p or ".") != _HERE]
sys.path.insert(0, _CP)
sys.path.append(_HERE)
os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "x")

from flask import Flask  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

import portal_ai_usage  # noqa: E402
import portal_kb_files as kf  # noqa: E402
import portal_knowledge as pk  # noqa: E402
import portal_llm  # noqa: E402
from test_lib import check, install_db_stub, summary  # noqa: E402

PRINCIPAL = {"session_id": "s", "user_id": 11, "client_id": 42, "role": "owner",
             "email": "a@example.com", "display_name": "A", "via_api_key": False}
API_KEY_PRINCIPAL = dict(PRINCIPAL, via_api_key=True)


# ---------- fixtures ----------

def _pdf_str(text):
    return "(" + text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ")"


def build_pdf(pages):
    """pages: list of dicts {text, image: (dict_entries, stream_bytes),
    form: True (wrap the image in a Form XObject)}."""
    objs = [None, None, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []

    def add(obj):
        objs.append(obj)
        return len(objs)

    for page in pages:
        content = ""
        xobj = ""
        if page.get("image"):
            entries, data = page["image"]
            img = add(b"<< /Type /XObject /Subtype /Image " + entries.encode("latin-1")
                      + b" /Length " + str(len(data)).encode() + b" >>\nstream\n"
                      + data + b"\nendstream")
            if page.get("form"):
                body = b"q 600 0 0 800 0 0 cm /Im0 Do Q"
                form = add(b"<< /Type /XObject /Subtype /Form /BBox [0 0 612 792]"
                           b" /Resources << /XObject << /Im0 " + str(img).encode()
                           + b" 0 R >> >> /Length " + str(len(body)).encode()
                           + b" >>\nstream\n" + body + b"\nendstream")
                xobj = " /XObject << /Fm0 %d 0 R >>" % form
                content += "q /Fm0 Do Q "
            else:
                xobj = " /XObject << /Im0 %d 0 R >>" % img
                content += "q 600 0 0 800 0 0 cm /Im0 Do Q "
        if page.get("text"):
            content += "BT /F1 12 Tf 14 TL 72 720 Td " + " ".join(
                _pdf_str(line) + " Tj T*" for line in page["text"].split("\n")) + " ET"
        data = content.encode("latin-1")
        stream = add(b"<< /Length " + str(len(data)).encode() + b" >>\nstream\n"
                     + data + b"\nendstream")
        kids.append(add(("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]"
                         " /Resources << /Font << /F1 3 0 R >>%s >> /Contents %d 0 R >>"
                         % (xobj, stream)).encode()))
    objs[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objs[1] = ("<< /Type /Pages /Kids [%s] /Count %d >>" % (
        " ".join("%d 0 R" % k for k in kids), len(kids))).encode()
    out = b"%PDF-1.4\n"
    offsets = []
    for number, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += str(number).encode() + b" 0 obj\n" + obj + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 " + str(len(objs) + 1).encode() + b"\n0000000000 65535 f \n"
    for offset in offsets:
        out += ("%010d 00000 n \n" % offset).encode()
    out += (b"trailer\n<< /Size " + str(len(objs) + 1).encode()
            + b" /Root 1 0 R >>\nstartxref\n" + str(xref).encode() + b"\n%%EOF\n")
    return out


def scan_image(mode="RGB", size=(600, 400), label="Scanned page"):
    image = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((10, 10, size[0] - 10, 60), fill=(200, 30, 30))
    draw.text((20, 100), label, fill="black")
    return image.convert(mode)


def jpeg(image, **kw):
    out = io.BytesIO()
    image.save(out, "JPEG", quality=90, **kw)
    return out.getvalue()


def png_pixels(data):
    image = Image.open(io.BytesIO(data))
    image.load()
    return image


W, H = 600, 400
GRAY = scan_image("L")
RGB = scan_image("RGB")
BW = scan_image("1")
GRAY_RAW = GRAY.tobytes()
RGB_RAW = RGB.tobytes()
BW_RAW = BW.tobytes()  # PIL "1": 1 = white, rows padded to bytes like PDF

JPEG_RGB = jpeg(RGB)
DCT_ENTRIES = "/Width %d /Height %d /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode" % (W, H)


def flate(entries, raw):
    return ("/Width %d /Height %d %s /Filter /FlateDecode" % (W, H, entries), zlib.compress(raw))


def raises(fn, code):
    try:
        fn()
    except kf.ExtractError as error:
        return error.code == code, error.code + ": " + error.message
    return False, "no error"


# ---------- vision stub ----------

CALLS = []
CALL_LOCK = threading.Lock()
REPLY = {"mode": "ok", "delay": 0.0}
VISION = {"active": True, "reason": "active", "api_key": "k", "model": "m"}


def fake_describe(data, mime, system, prompt, timeout=None, runtime=None, max_tokens=0):
    with CALL_LOCK:
        CALLS.append({"data": data, "mime": mime, "system": system, "prompt": prompt,
                      "timeout": timeout, "max_tokens": max_tokens,
                      "scope": portal_llm.current_scope(),
                      "thread": threading.current_thread().name,
                      "start": time.monotonic()})
    if REPLY["delay"]:
        time.sleep(REPLY["delay"])
    mode = REPLY["mode"]
    if mode == "blocked":
        return None, "blocked by the platform AI controls"
    if mode == "fail":
        return None, "HTTP 429"
    if mode == "empty":
        return {"text": ""}, ""
    if mode == "bad":
        return {"text": 5}, ""
    return {"text": "Line one\r\n\n\n\nLine two  \n# Heading"}, ""


REAL_DESCRIBE = portal_llm.describe_image
portal_llm.describe_image = fake_describe
portal_llm.vision_runtime = lambda: dict(VISION)


def reset(mode="ok", delay=0.0):
    CALLS.clear()
    REPLY["mode"], REPLY["delay"] = mode, delay


# ---------- page detection ----------

print("== which pages are offered ==")
reset()
WHOLE = build_pdf([{"image": (DCT_ENTRIES, JPEG_RGB)}, {"image": (DCT_ENTRIES, JPEG_RGB)}])
r = kf.extract("scan.pdf", WHOLE)
check("whole-scanned PDF -> 200 shape, empty text, both pages offered",
      r["text"] == "" and r["ocr_pages"] == [1, 2] and r["ocr_pages_skipped"] == 0
      and r["page_texts"] == ["", ""] and r["pages"] == 2 and r["type"] == "pdf", r)
check("extract never calls the AI by itself", CALLS == [], len(CALLS))

MIXED = build_pdf([{"text": "Delivery policy\nOrders ship within 24 hours."},
                   {"image": (DCT_ENTRIES, JPEG_RGB)},
                   {"text": "Pg 3", "image": (DCT_ENTRIES, JPEG_RGB)},
                   {"text": "Returns within 7 days for every order placed online."}])
r = kf.extract("mixed.pdf", MIXED)
check("mixed PDF: text kept, scanned + nearly-empty pages offered, per-page text",
      "Orders ship within 24 hours." in r["text"] and "Returns within 7 days" in r["text"]
      and r["ocr_pages"] == [2, 3] and len(r["page_texts"]) == 4
      and r["page_texts"][1] == "" and r["page_texts"][2] == "Pg 3", r)
orig = kf.OCR_TEXT_MIN_CHARS
kf.OCR_TEXT_MIN_CHARS = 0
r0 = kf.extract("mixed.pdf", MIXED)
kf.OCR_TEXT_MIN_CHARS = orig
check("OF_KB_OCR_TEXT_MIN_CHARS=0 -> only pages with no text at all", r0["ocr_pages"] == [], r0["ocr_pages"])

TEXT_ONLY = build_pdf([{"text": "Plain text page with enough characters to skip OCR."}])
r = kf.extract("t.pdf", TEXT_ONLY)
check("text PDF: nothing offered, no page_texts payload",
      r["ocr_pages"] == [] and "page_texts" not in r, r)

LOGO = Image.new("RGB", (60, 40), "blue")
SMALL = build_pdf([{"image": ("/Width 60 /Height 40 /ColorSpace /DeviceRGB /BitsPerComponent 8"
                              " /Filter /DCTDecode", jpeg(LOGO))}])
ok, detail = raises(lambda: kf.extract("logo.pdf", SMALL), "no_text")
check("small logo only -> not a scan -> honest no_text", ok and "no page images" in detail, detail)

FORM = build_pdf([{"image": (DCT_ENTRIES, JPEG_RGB), "form": True}])
r = kf.extract("form.pdf", FORM)
check("image inside a Form XObject is found", r["ocr_pages"] == [1], r)

orig = kf.OCR_PAGES_MAX
kf.OCR_PAGES_MAX = 1
r = kf.extract("scan.pdf", WHOLE)
kf.OCR_PAGES_MAX = orig
check("OF_KB_OCR_PAGES_MAX caps the offer and reports the rest",
      r["ocr_pages"] == [1] and r["ocr_pages_skipped"] == 1, r)

VISION.update(active=False, reason="off", api_key="")
ok, detail = raises(lambda: kf.extract("scan.pdf", WHOLE), "no_text")
check("vision off + whole-scanned -> no_text naming the reason",
      ok and "turned off by the platform admin" in detail and "scanned" in detail, detail)
r = kf.extract("mixed.pdf", MIXED)
check("vision off + mixed -> text only, nothing offered",
      r["ocr_pages"] == [] and "page_texts" not in r and "Orders ship" in r["text"], r)
ok, detail = raises(lambda: kf.ocr("scan.pdf", WHOLE, [1]), "ocr_unavailable")
check("ocr() with vision off -> ocr_unavailable", ok, detail)
VISION.update(reason="no_key")
ok, detail = raises(lambda: kf.ocr("scan.pdf", WHOLE, [1]), "ocr_unavailable")
check("no key -> owner-readable reason", ok and "no AI key" in detail, detail)
VISION.update(active=True, reason="active", api_key="k")
check("ocr_status", kf.ocr_status() == (True, "active"), kf.ocr_status())


# ---------- page images ----------

print("== page images ==")


def page_image(pdf, page=1):
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(pdf))
    obj = kf._page_image(reader.pages[page - 1])
    return kf._xobject_image(obj)


data, mime = page_image(WHOLE)
check("DCT page -> JPEG bytes passed through unchanged", data == JPEG_RGB and mime == "image/jpeg", mime)

cases = [
    ("Flate gray 8-bit", flate("/ColorSpace /DeviceGray /BitsPerComponent 8", GRAY_RAW), GRAY, "L"),
    ("Flate RGB 8-bit", flate("/ColorSpace /DeviceRGB /BitsPerComponent 8", RGB_RAW), RGB, "RGB"),
    ("Flate ICCBased N=3 via indirect stream", None, RGB, "RGB"),
]
for name, image_def, ref, mode in cases[:2]:
    data, mime = page_image(build_pdf([{"image": image_def}]))
    img = png_pixels(data)
    check(name + " -> PNG with identical pixels",
          mime == "image/png" and img.size == (W, H) and img.convert(mode).tobytes() == ref.tobytes(),
          (mime, img.size, img.mode))

# 1-bit: PIL "1" stores 1 = white; PDF DeviceGray 1-bit also 1 = white.
data, mime = page_image(build_pdf([{"image": flate("/ColorSpace /DeviceGray /BitsPerComponent 1", BW_RAW)}]))
check("Flate 1-bit gray -> PNG same pixels",
      png_pixels(data).convert("1").tobytes() == BW_RAW, png_pixels(data).mode)
INVERTED = bytes(b ^ 0xFF for b in BW_RAW)
data, mime = page_image(build_pdf([{"image": flate(
    "/ColorSpace /DeviceGray /BitsPerComponent 1 /Decode [1 0]", INVERTED)}]))
check("/Decode [1 0] inverted samples -> corrected", png_pixels(data).convert("1").tobytes() == BW_RAW, "-")
# Image mask: 0 = painted (black) - same orientation as gray.
data, mime = page_image(build_pdf([{"image": flate("/ImageMask true /BitsPerComponent 1", BW_RAW)}]))
check("image mask -> black ink on white", png_pixels(data).convert("1").tobytes() == BW_RAW, "-")

PAL = RGB.convert("P", palette=Image.ADAPTIVE, colors=16)
palette = bytes(PAL.getpalette()[:48])
hexpal = "<" + palette.hex() + ">"
data, mime = page_image(build_pdf([{"image": flate(
    "/ColorSpace [/Indexed /DeviceRGB 15 %s] /BitsPerComponent 8" % hexpal, PAL.tobytes())}]))
check("Indexed RGB (hex-string palette) -> PNG palette, same colours",
      png_pixels(data).convert("RGB").tobytes() == PAL.convert("RGB").tobytes(), png_pixels(data).mode)
GPAL = GRAY.quantize(colors=4)
gidx = GPAL.tobytes()
gray_levels = bytes(GPAL.getpalette()[0:12:3])
packed = bytearray()
for y in range(H):
    row = gidx[y * W:(y + 1) * W]
    for x in range(0, W, 4):
        chunk = list(row[x:x + 4]) + [0] * (4 - len(row[x:x + 4]))
        packed.append((chunk[0] << 6) | (chunk[1] << 4) | (chunk[2] << 2) | chunk[3])
data, mime = page_image(build_pdf([{"image": flate(
    "/ColorSpace [/Indexed /DeviceGray 3 <%s>] /BitsPerComponent 2" % gray_levels.hex(), bytes(packed))}]))
expect = bytes(gray_levels[v] for v in gidx)
check("Indexed gray 2-bit -> expanded palette, same levels",
      png_pixels(data).convert("L").tobytes() == expect, "-")

ICC = build_pdf([{"image": flate("/ColorSpace [/ICCBased 99 0 R] /BitsPerComponent 8", RGB_RAW)}])
# add the ICC stream object 99 by appending an incremental object (pypdf tolerant)
ICC = ICC.replace(b"%%EOF\n", b"%%EOF\n") + b"99 0 obj\n<< /N 3 /Length 0 >>\nstream\n\nendstream\nendobj\n"
try:
    data, mime = page_image(ICC)
    icc_ok = png_pixels(data).convert("RGB").tobytes() == RGB_RAW
except Exception as error:  # noqa: BLE001
    icc_ok, data = False, str(error)
check("ICCBased N=3 -> treated as RGB", icc_ok, str(data)[:80])

# CCITT (Pillow writes 1-bit images as CCITT G4 in PDFs)
buf = io.BytesIO()
BW.save(buf, "PDF")
CCITT = buf.getvalue()
data, mime = page_image(CCITT)
check("CCITT fax page -> Pillow -> PNG with the same pixels",
      mime == "image/png" and png_pixels(data).convert("1").tobytes() == BW_RAW, mime)

saved = sys.modules.get("PIL")
sys.modules["PIL"] = None
try:
    page_image(CCITT)
    skip = None
except kf._Skip as error:
    skip = error
sys.modules["PIL"] = saved
check("CCITT without Pillow -> honest format skip naming Pillow",
      skip is not None and skip.code == "format" and "Pillow" in skip.message
      and "fax" in skip.message, skip and skip.message)

CMYK_JPEG = jpeg(scan_image("CMYK"))
data, mime = page_image(build_pdf([{"image": (DCT_ENTRIES.replace("/DeviceRGB", "/DeviceCMYK"), CMYK_JPEG)}]))
check("CMYK JPEG -> re-encoded RGB JPEG", mime == "image/jpeg"
      and png_pixels(data).mode == "RGB", mime)
CMYK_RAW = scan_image("CMYK").tobytes()
data, mime = page_image(build_pdf([{"image": flate("/ColorSpace /DeviceCMYK /BitsPerComponent 8", CMYK_RAW)}]))
check("raw CMYK samples -> RGB JPEG via Pillow", mime == "image/jpeg", mime)

try:
    page_image(build_pdf([{"image": ("/Width %d /Height %d /ColorSpace /DeviceGray /BitsPerComponent 1"
                                     " /Filter /JBIG2Decode" % (W, H), b"\x00" * 50)}]))
    skip = None
except kf._Skip as error:
    skip = error
except Exception as error:  # noqa: BLE001
    skip = error
check("JBIG2 -> honest skip (never a crash)", isinstance(skip, kf._Skip) and skip.code == "format"
      and "JBIG2" in skip.message, repr(skip))

try:
    page_image(build_pdf([{"image": ("/Width 100000 /Height 100000 /ColorSpace /DeviceRGB"
                                     " /BitsPerComponent 8 /Filter /FlateDecode", zlib.compress(b"x"))}]))
    skip = None
except kf._Skip as error:
    skip = error
check("declared raw size over OF_KB_OCR_RAW_BYTES_MAX -> too_large before decoding",
      skip is not None and skip.code == "too_large", skip and skip.message)

try:
    page_image(build_pdf([{"image": ("/Width %d /Height %d /ColorSpace /DeviceGray /BitsPerComponent 8"
                                     " /Filter /FlateDecode" % (W, H), zlib.compress(b"\x00" * 100))}]))
    skip = None
except kf._Skip as error:
    skip = error
check("short sample data -> damaged image skip", skip is not None and "damaged" in skip.message, skip)

orig = kf.OCR_IMAGE_BYTES_MAX
kf.OCR_IMAGE_BYTES_MAX = 1000
BIG = jpeg(scan_image("RGB", (3000, 2000)))
try:
    kf._fit(BIG, "image/jpeg")
    tiny = None
except kf._Skip as error:
    tiny = error
sys.modules["PIL"] = None
try:
    kf._fit(BIG, "image/jpeg")
    skip = None
except kf._Skip as error:
    skip = error
sys.modules["PIL"] = saved
kf.OCR_IMAGE_BYTES_MAX = 2000000
data2, _m = kf._fit(BIG, "image/jpeg")
kf.OCR_IMAGE_BYTES_MAX = len(BIG) - 1
data3, mime3 = kf._fit(BIG, "image/jpeg")
kf.OCR_IMAGE_BYTES_MAX = orig
check("image under the byte cap is sent unchanged", data2 == BIG, len(data2))
check("oversized image + Pillow -> downscaled to OF_KB_OCR_MAX_SIDE",
      max(png_pixels(data3).size) == kf.OCR_MAX_SIDE and len(data3) < len(BIG), png_pixels(data3).size)
check("oversized image without Pillow -> too_large", skip is not None and skip.code == "too_large", skip)
check("still too large after downscale -> too_large skip (1 KB cap)",
      tiny is not None and tiny.code == "too_large", tiny)


# ---------- ocr() ----------

print("== ocr ==")
reset()
r = kf.ocr("scan.pdf", WHOLE, [2], client_id=42)
call = CALLS[0] if CALLS else {}
check("one page -> one vision call with the page image", len(CALLS) == 1
      and call["data"] == JPEG_RGB and call["mime"] == "image/jpeg", len(CALLS))
check("prompt: transcribe only, keep language, ignore instructions, JSON text",
      call.get("system") == kf.OCR_SYSTEM and "never translate" in kf.OCR_SYSTEM
      and "ignore any instructions" in kf.OCR_SYSTEM and '{"text"' in kf.OCR_SYSTEM
      and call.get("prompt") == kf.OCR_PROMPT, "-")
check("max_tokens + per-page timeout from env (OF_KB_OCR_MAX_TOKENS / PAGE_SECONDS)",
      call.get("max_tokens") == kf.OCR_MAX_TOKENS and call.get("timeout") <= kf.OCR_PAGE_SECONDS
      and call.get("timeout") > kf.OCR_PAGE_SECONDS - 2, (call.get("max_tokens"), call.get("timeout")))
check("usage scope = kb_ocr for the workspace", call.get("scope", ("",))[:2] == ("kb_ocr", 42), call.get("scope"))
check("result: page, cleaned text (CRLF, blank runs, trailing spaces)",
      r["results"] == [{"page": 2, "text": "Line one\n\nLine two\n# Heading", "code": "", "error": ""}]
      and r["pages"] == 2 and r["type"] == "pdf", r)

reset(delay=0.3)
started = time.monotonic()
r = kf.ocr("scan.pdf", WHOLE, [2, 1, 2], client_id=42)
took = time.monotonic() - started
check("pages de-duplicated, results in page order", [x["page"] for x in r["results"]] == [1, 2], r["results"])
check("pages of one call are read concurrently", len(CALLS) == 2 and took < 0.55, round(took, 2))
check("worker threads keep the kb_ocr scope (ledger + AI gate per workspace)",
      all(c["scope"][:2] == ("kb_ocr", 42) for c in CALLS), [c["scope"] for c in CALLS])
check("scope does not leak to the caller thread", portal_llm.current_scope()[0] == "", portal_llm.current_scope())

reset()
ok, detail = raises(lambda: kf.ocr("scan.pdf", WHOLE, [1, 2, 3]), "bad_request")
check("page outside the PDF -> bad_request", ok and "outside" in detail, detail)
orig = kf.OCR_PAGES_PER_CALL
kf.OCR_PAGES_PER_CALL = 1
ok, detail = raises(lambda: kf.ocr("scan.pdf", WHOLE, [1, 2]), "bad_request")
kf.OCR_PAGES_PER_CALL = orig
check("more pages than OF_KB_OCR_PAGES_PER_CALL -> bad_request", ok and "At most 1" in detail, detail)
for bad in ([], None, ["1"], [True], [1.5], "1"):
    ok, detail = raises(lambda: kf.ocr("scan.pdf", WHOLE, bad), "bad_request")
    check("pages %r -> bad_request" % (bad,), ok, detail)
check("no AI call for rejected requests", CALLS == [], len(CALLS))
ok, detail = raises(lambda: kf.ocr("a.docx", b"PK", [1]), "unsupported_type")
check("docx cannot be OCR'd", ok, detail)
orig = kf.FILE_BYTES_MAX
kf.FILE_BYTES_MAX = 100
ok, detail = raises(lambda: kf.ocr("scan.pdf", WHOLE, [1]), "too_large")
kf.FILE_BYTES_MAX = orig
check("file size limit applies", ok, detail)

r = kf.ocr("mixed.pdf", MIXED, [1])
check("text-only page asked for -> no_image, no AI call",
      r["results"][0]["code"] == "no_image" and CALLS == [], r)

reset("blocked")
r = kf.ocr("scan.pdf", WHOLE, [1, 2], client_id=42)
check("AI gate (kill switch / daily cap) -> ai_blocked with owner copy",
      all(x["code"] == "ai_blocked" and "daily AI limit" in x["error"] for x in r["results"]), r)
reset("fail")
r = kf.ocr("scan.pdf", WHOLE, [1])
check("provider failure -> ai_failed with the reason", r["results"][0]["code"] == "ai_failed"
      and "HTTP 429" in r["results"][0]["error"], r)
reset("empty")
r = kf.ocr("scan.pdf", WHOLE, [1])
check("nothing readable -> empty text, no error", r["results"][0] == {"page": 1, "text": "", "code": "", "error": ""}, r)
reset("bad")
r = kf.ocr("scan.pdf", WHOLE, [1])
check("non-string text in the reply -> empty text, never a crash", r["results"][0]["text"] == "", r)

reset()
orig = kf.OCR_SECONDS
kf.OCR_SECONDS = 3
r = kf.ocr("scan.pdf", WHOLE, [1])
kf.OCR_SECONDS = orig
check("per-call deadline (OF_KB_OCR_SECONDS) exhausted -> timeout, no AI call",
      r["results"][0]["code"] == "timeout" and CALLS == [], r)

reset()
JBIG = build_pdf([{"image": ("/Width %d /Height %d /ColorSpace /DeviceGray /BitsPerComponent 1"
                             " /Filter /JBIG2Decode" % (W, H), b"\x00" * 50)},
                  {"image": (DCT_ENTRIES, JPEG_RGB)}])
r = kf.ocr("j.pdf", JBIG, [1, 2])
check("one unreadable page never sinks the others",
      r["results"][0]["code"] == "format" and r["results"][1]["text"].startswith("Line one")
      and len(CALLS) == 1, r)


# ---------- uploaded images ----------

print("== uploaded images ==")
reset()
PNG_BYTES = io.BytesIO()
RGB.save(PNG_BYTES, "PNG")
WEBP_BYTES = io.BytesIO()
RGB.save(WEBP_BYTES, "WEBP")
for name, data, mime in (("photo.jpg", JPEG_RGB, "image/jpeg"), ("shot.PNG", PNG_BYTES.getvalue(), "image/png"),
                         ("pic.webp", WEBP_BYTES.getvalue(), "image/webp"),
                         ("mislabelled.jpeg", PNG_BYTES.getvalue(), "image/png")):
    reset()
    r = kf.ocr(name, data, None, client_id=42)
    check("image %s -> one call, mime from magic bytes (%s)" % (name, mime),
          len(CALLS) == 1 and CALLS[0]["mime"] == mime and CALLS[0]["data"] == data
          and r["type"] == "image" and r["results"][0]["page"] == 1, (CALLS and CALLS[0]["mime"]))
ok, detail = raises(lambda: kf.ocr("fake.jpg", b"GIF89a....", None), "extract_failed")
check("not really an image -> extract_failed", ok, detail)
r = kf.extract("photo.jpg", JPEG_RGB)
check("extract(image) -> page 1 offered, no AI call yet",
      r["type"] == "image" and r["ocr_pages"] == [1] and r["text"] == "", r)
VISION.update(active=False, reason="llm_disabled", api_key="")
ok, detail = raises(lambda: kf.extract("photo.jpg", JPEG_RGB), "ocr_unavailable")
VISION.update(active=True, reason="active", api_key="k")
check("extract(image) with vision unavailable -> ocr_unavailable", ok and "disabled" in detail, detail)
check("file_type knows images", kf.file_type("A.JPG") == "jpg" and kf.file_type("b.webp") == "webp"
      and kf.file_type("c.gif") == "", "-")
ok, detail = raises(lambda: kf.extract("c.gif", b"GIF89a"), "unsupported_type")
check("other types still refused, message lists images", ok and "JPG, PNG, WebP" in detail, detail)


# ---------- endpoint ----------

print("== extract api ==")


class PrincipalStub:
    def __init__(self, principal):
        self.principal = principal

    def __enter__(self):
        self.orig = pk.authenticate_portal_request
        pk.authenticate_portal_request = lambda: self.principal

    def __exit__(self, *a):
        pk.authenticate_portal_request = self.orig


fake_sem = types.ModuleType("portal_kb_semantic")
fake_sem.kick_after_mutation = lambda response: response
fake_sem.kick = lambda *a, **k: True
sys.modules["portal_kb_semantic"] = fake_sem


def run_api(body, principal=PRINCIPAL):
    pk._DDL_READY = True
    conn = install_db_stub(pk, [])
    app = Flask("kb-ocr-test")
    app.register_blueprint(pk.bp)
    with PrincipalStub(principal):
        response = app.test_client().post("/api/v1/portal/kb/extract", json=body)
    response.conn = conn
    return response


B64 = base64.b64encode(WHOLE).decode()
reset()
r = run_api({"filename": "scan.pdf", "file_base64": B64})
body = r.get_json()
check("POST extract scanned PDF -> 200 with ocr_pages + page_texts, no AI call",
      r.status_code == 200 and body["ocr_pages"] == [1, 2] and body["page_texts"] == ["", ""]
      and body["text"] == "" and body["ocr_pages_skipped"] == 0 and CALLS == [], body)
r = run_api({"filename": "t.pdf", "file_base64": base64.b64encode(TEXT_ONLY).decode()})
check("text PDF response: ocr_pages [] and no page_texts", r.get_json()["ocr_pages"] == []
      and "page_texts" not in r.get_json(), r.get_json())
r = run_api({"filename": "scan.pdf", "file_base64": B64, "ocr": True, "pages": [1]})
body = r.get_json()
check("POST ocr:true -> results, scope uses the principal's workspace, nothing stored",
      r.status_code == 200 and body["ocr"] is True and body["results"][0]["page"] == 1
      and body["results"][0]["text"].startswith("Line one") and CALLS[-1]["scope"][:2] == ("kb_ocr", 42)
      and r.conn.cur.executed == [], body)
r = run_api({"filename": "scan.pdf", "file_base64": B64, "ocr": "yes", "pages": [1]})
check("ocr must be literally true (else plain extract)", "results" not in r.get_json()
      and r.get_json()["ocr_pages"] == [1, 2], r.get_json())
r = run_api({"filename": "scan.pdf", "file_base64": B64, "ocr": True, "pages": [9]})
check("bad page -> 400 bad_request", r.status_code == 400
      and r.get_json()["error"]["code"] == "bad_request", r.get_json())
VISION.update(active=False, reason="off", api_key="")
r = run_api({"filename": "scan.pdf", "file_base64": B64, "ocr": True, "pages": [1]})
VISION.update(active=True, reason="active", api_key="k")
check("vision off -> 400 ocr_unavailable", r.status_code == 400
      and r.get_json()["error"]["code"] == "ocr_unavailable", r.get_json())
r = run_api({"filename": "photo.jpg", "file_base64": base64.b64encode(JPEG_RGB).decode(),
             "ocr": True, "pages": [1]})
check("image upload with ocr -> type image", r.status_code == 200 and r.get_json()["type"] == "image", r.get_json())
r = run_api({"filename": "scan.pdf", "file_base64": B64, "ocr": True, "pages": [1]}, API_KEY_PRINCIPAL)
check("OCR is human-only (API key 403)", r.status_code == 403, r.status_code)
r = run_api({"filename": "scan.pdf", "file_base64": B64, "ocr": True, "pages": [1]}, None)
check("OCR needs auth (401)", r.status_code == 401, r.status_code)
saved_ocr = kf.ocr
kf.ocr = lambda *a, **k: 1 / 0
r = run_api({"filename": "scan.pdf", "file_base64": B64, "ocr": True, "pages": [1]})
kf.ocr = saved_ocr
check("unexpected error -> 400 extract_failed, never a 500", r.status_code == 400
      and r.get_json()["error"]["code"] == "extract_failed", r.status_code)

limits = pk._limits()
check("limits: ocr availability + caps + image types (from env)",
      limits["ocr_available"] is True and limits["ocr_reason"] == "active"
      and limits["ocr_pages_max"] == kf.OCR_PAGES_MAX
      and limits["ocr_pages_per_call"] == kf.OCR_PAGES_PER_CALL
      and limits["image_types"] == ["jpg", "jpeg", "png", "webp"]
      and limits["file_types"][:2] == ["pdf", "docx"], limits)
check("usage card label for kb_ocr", portal_ai_usage.FEATURE_LABELS.get("kb_ocr")
      == "Knowledge document reading (OCR)" and portal_ai_usage.FEATURES[-1][0] == "other", "-")


# ---------- real describe_image over HTTP (fake provider) ----------

print("== real vision call ==")
import http.server  # noqa: E402
import json  # noqa: E402

SEEN = []


class Provider(http.server.BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        SEEN.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
        reply = json.dumps({"choices": [{"message": {"content": json.dumps(
            {"text": "# Price list\nShirt | Rs 1500"})}}],
            "usage": {"prompt_tokens": 900, "completion_tokens": 12}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)

    def log_message(self, *a):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
LEDGER = []
saved_record = portal_llm._record_usage
portal_llm._record_usage = lambda model, usage, ok, started: LEDGER.append(
    (portal_llm.current_scope()[:2], model, ok, (usage or {}).get("prompt_tokens")))
portal_llm.describe_image = REAL_DESCRIBE
portal_llm.vision_runtime = lambda: {"active": True, "reason": "active", "api_key": "sk-test",
                                     "base_url": "http://127.0.0.1:%d/v1" % server.server_port,
                                     "model": "vision-model"}
saved_gate = portal_ai_usage.gate
portal_ai_usage.gate = lambda feature, client_id, cur=None: None
r = kf.ocr("scan.pdf", WHOLE, [1, 2], client_id=42)
portal_ai_usage.gate = lambda feature, client_id, cur=None: (
    "daily_cap" if (feature, client_id) == ("kb_ocr", 42) else None)
blocked = kf.ocr("scan.pdf", WHOLE, [1], client_id=42)
portal_ai_usage.gate = saved_gate
portal_llm._record_usage = saved_record
server.shutdown()
req = SEEN[0]["body"] if SEEN else {}
parts = req.get("messages", [{}, {}])[1].get("content", []) if req else []
check("real call: both pages read, text returned",
      [x["text"] for x in r["results"]] == ["# Price list\nShirt | Rs 1500"] * 2, r)
check("wire payload: model, JSON mode, max_tokens from env, image data URI, key header",
      len(SEEN) == 2 and SEEN[0]["path"] == "/v1/chat/completions"
      and SEEN[0]["auth"] == "Bearer sk-test" and req["model"] == "vision-model"
      and req["response_format"] == {"type": "json_object"}
      and req["max_tokens"] == kf.OCR_MAX_TOKENS and req["temperature"] == 0
      and parts[1]["image_url"]["url"] == "data:image/jpeg;base64," + base64.b64encode(JPEG_RGB).decode(),
      {k: req.get(k) for k in ("model", "max_tokens", "response_format")})
check("ledger rows tagged kb_ocr for workspace 42 (one per page)",
      LEDGER == [(("kb_ocr", 42), "vision-model", True, 900)] * 2, LEDGER)
check("the AI gate sees feature kb_ocr + the workspace and blocks before the provider",
      blocked["results"][0]["code"] == "ai_blocked" and len(SEEN) == 2, (blocked, len(SEEN)))


# ---------- source pins ----------

print("== source ==")


def read(rel):
    path = os.path.join(_ROOT, rel)
    return open(path, encoding="utf8").read() if os.path.exists(path) else ""


KF = read("omniflow-backend-patch/portal_kb_files.py")
check("env-driven OCR limits (no hardcoding)", all(e in KF for e in (
    "OF_KB_OCR_PAGES_MAX", "OF_KB_OCR_PAGES_PER_CALL", "OF_KB_OCR_SECONDS",
    "OF_KB_OCR_PAGE_SECONDS", "OF_KB_OCR_MAX_TOKENS", "OF_KB_OCR_IMAGE_BYTES_MAX",
    "OF_KB_OCR_RAW_BYTES_MAX", "OF_KB_OCR_MIN_PIXELS", "OF_KB_OCR_TEXT_MIN_CHARS",
    "OF_KB_OCR_MAX_SIDE")), "-")
check("one vision engine (portal_llm.describe_image), Pillow lazy only",
      "portal_llm.describe_image(" in KF and "\nimport PIL" not in KF
      and "\nfrom PIL" not in KF and "urllib" not in KF, "-")
LIB = read("lib/omniflow/portal.ts")
check("portal.ts: ocr option, result types, longer env timeout",
      all(x in LIB for x in ("ocr?: { pages: number[] }", "ocr: true, pages: ocr.pages",
                             "export interface KbOcrPayload", "ocr_pages?: number[];",
                             "page_texts?: string[];", "OMNIFLOW_KB_FILE_TIMEOUT_MS",
                             "kbFileTimeoutMs()", "AbortSignal.timeout(timeoutMs)",
                             "ocr_available?: boolean;")), "-")
BFF = read("app/api/omniflow/portal/kb/extract/route.ts")
check("BFF: images allowed, ocr pages validated, maxDuration",
      all(x in BFF for x in ('".jpg", ".jpeg", ".png", ".webp"', "export const maxDuration = 60",
                             "payload?.ocr === true", "Number.isInteger(page)",
                             "extractKbFile(accessToken, filename, fileBase64, ocr)")), "-")
CARD = read("app/dashboard/(portal)/knowledge-base/KbSourcesCard.tsx")
check("card: consent before any AI use, credits named",
      all(x in CARD for x in ("Read the text in this image with AI?", "Read them with AI?",
                              "This uses your workspace's AI credits.", "window.confirm(ask)")), "-")
check("card: batches per ocr_pages_per_call, progress, Cancel, stops on AI gate",
      all(x in CARD for x in ("limits?.ocr_pages_per_call", "setOcrProgress", "ocrCancel.current = true",
                              "Reading with AI", '"ai_blocked"', "pages.slice(start, start + perCall)")), "-")
check("card: images shrunk in the browser, review step kept, honest notes",
      all(x in CARD for x in ("createImageBitmap", "IMAGE_MAX_SIDE", "image/jpeg",
                              "check the text for mistakes", "Review the text below, then add it as a draft.",
                              "limits?.ocr_available")), "-")
check("card: English copy, no emoji-capable glyphs",
      "karein" not in CARD and all(code not in CARD for code in (
          "\\u25b6", "\\u2714", "\\u26a1", "\\u2699", "\\u27a1")), "-")

raise SystemExit(1 if summary("kb_ocr") else 0)
