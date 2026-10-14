"""Batch 219 (Option 3) - knowledge PDF / Word import + scheduled re-fetch.

Covers: DOCX extraction on real zip fixtures (headings incl. localised
style ids, lists, tables, line breaks, content controls, core title),
the zip-bomb / DTD / damaged-file guards, base64 decoding limits, PDF
extraction on real hand-built PDFs (text, title, page cap, char cap,
text-less = honest no_text, password-protected, pypdf missing), the
/kb/extract endpoint (auth, human-only, stores nothing, no semantic kick),
auto_refresh on create / PUT (web pages only, audited), file "new
version" uploads (origin + note), the refresh job (atomic claim,
unchanged skip, changed -> new version as system, errors, bounded
batch, semantic kick, throttled daemon kick), the tick wiring and the
website surface (BFF route, portal.ts client, Knowledge card).
"""
import base64
import io
import os
import sys
import types
import zipfile

_HERE = os.path.abspath(os.path.dirname(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
_CP = os.path.join(_ROOT, "omniflow-backend-patch")
sys.path = [p for p in sys.path if os.path.abspath(p or ".") != _HERE]
sys.path.insert(0, _CP)
sys.path.append(_HERE)
os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "x")

from flask import Flask  # noqa: E402

import portal_kb_files as kf  # noqa: E402
import portal_knowledge as pk  # noqa: E402
from test_lib import check, install_db_stub, summary  # noqa: E402

PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}
API_KEY_PRINCIPAL = dict(PRINCIPAL, via_api_key=True)
SRC = {"id": 7, "client_id": 1, "title": "Store policy", "kind": "text",
       "origin": "", "status": "draft", "version": 2, "chunk_count": 3,
       "char_count": 900, "last_error": "", "ingested_at": None,
       "created_at": None, "updated_at": None, "auto_refresh": False,
       "checked_at": None}
URL_SRC = dict(SRC, id=8, kind="url", origin="https://example.com/policy",
               status="published")
FILE_SRC = dict(SRC, id=9, kind="file", origin="policy.pdf")


# ---------- fixtures ----------

W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def para(runs, style=None, numbered=False):
    ppr = ""
    if style or numbered:
        ppr = "<w:pPr>" + ('<w:pStyle w:val="%s"/>' % style if style else "") + (
            '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'
            if numbered else "") + "</w:pPr>"
    return "<w:p>" + ppr + "".join("<w:r>" + r + "</w:r>" for r in runs) + "</w:p>"


def t(text):
    return '<w:t xml:space="preserve">%s</w:t>' % text


def make_docx(body, styles=None, title=None, extra=None):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("word/document.xml",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   "<w:document " + W_NS + "><w:body>" + body +
                   "<w:sectPr/></w:body></w:document>")
        if styles is not None:
            z.writestr("word/styles.xml", "<w:styles " + W_NS + ">" + styles +
                       "</w:styles>")
        if title is not None:
            z.writestr("docProps/core.xml",
                       '<cp:coreProperties xmlns:cp="http://schemas.openxml'
                       'formats.org/package/2006/metadata/core-properties" '
                       'xmlns:dc="http://purl.org/dc/elements/1.1/">'
                       "<dc:title>" + title + "</dc:title></cp:coreProperties>")
        for name, data in (extra or {}).items():
            z.writestr(name, data)
    return buf.getvalue()


STYLES = ('<w:style w:type="paragraph" w:styleId="berschrift2">'
          '<w:name w:val="heading 2"/></w:style>'
          '<w:style w:type="paragraph" w:styleId="Gliederung">'
          '<w:name w:val="Outline"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr>'
          "</w:style>")
BODY = (
    para([t("Store Policy")], "Title")
    + para([t("Delivery")], "Heading1")
    + para([t("Orders ship within "), t("24 hours."), "<w:br/>",
            t("Karachi"), "<w:tab/>", t("1-2   days.")])
    + para([t("Returns")], "berschrift2")
    + para([t("7 day return")], numbered=True)
    + para([t("Original packaging")], numbered=True)
    + "<w:tbl><w:tr><w:tc>" + para([t("City")]) + "</w:tc><w:tc>"
    + para([t("Days")]) + "</w:tc></w:tr><w:tr><w:tc>" + para([t("Karachi")])
    + "</w:tc><w:tc>" + para([t("1-2")]) + "</w:tc></w:tr></w:tbl>"
    + para([t("Charges")], "Gliederung")
    + "<w:sdt><w:sdtPr/><w:sdtContent>" + para([t("Call 0300-1234567")])
    + "</w:sdtContent></w:sdt>"
    + para([])
)
DOCX = make_docx(BODY, STYLES, "Policy 2026")
EXPECTED = ("# Store Policy\n\n# Delivery\n\nOrders ship within 24 hours.\n"
            "Karachi 1-2 days.\n\n## Returns\n\n- 7 day return\n"
            "- Original packaging\n\nCity | Days\nKarachi | 1-2\n\n"
            "### Charges\n\nCall 0300-1234567")


def _pdf_str(text):
    return "(" + text.replace("\\", "\\\\").replace("(", "\\(").replace(
        ")", "\\)") + ")"


def make_pdf(pages, title=None):
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>"]
    kids = " ".join("%d 0 R" % (4 + 2 * i) for i in range(len(pages)))
    objs.append(("<< /Type /Pages /Kids [%s] /Count %d >>"
                 % (kids, len(pages))).encode())
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    for i, text in enumerate(pages):
        stream = ""
        if text:
            stream = "BT /F1 12 Tf 14 TL 72 720 Td " + " ".join(
                _pdf_str(line) + " Tj T*" for line in text.split("\n")) + " ET"
        objs.append(("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]"
                     " /Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R"
                     " >>" % (5 + 2 * i)).encode())
        data = stream.encode("latin-1")
        objs.append(b"<< /Length " + str(len(data)).encode() + b" >>\nstream\n"
                    + data + b"\nendstream")
    info = 0
    if title:
        objs.append(("<< /Title %s >>" % _pdf_str(title)).encode())
        info = len(objs)
    out = b"%PDF-1.4\n"
    offsets = []
    for number, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += str(number).encode() + b" 0 obj\n" + obj + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 " + str(len(objs) + 1).encode() + b"\n0000000000 65535 f \n"
    for offset in offsets:
        out += ("%010d 00000 n \n" % offset).encode()
    out += (b"trailer\n<< /Size " + str(len(objs) + 1).encode() + b" /Root 1 0 R"
            + ((b" /Info " + str(info).encode() + b" 0 R") if info else b"")
            + b" >>\nstartxref\n" + str(xref).encode() + b"\n%%EOF\n")
    return out


PAGE1 = "Delivery policy\nOrders ship within 24 hours across Pakistan."
PAGE2 = "Returns\nItems can be returned within 7 days."
PDF = make_pdf([PAGE1, PAGE2], "Store Policy PDF")


def raises(fn, code):
    try:
        fn()
    except kf.ExtractError as error:
        return error.code == code, error.code + ": " + error.message
    return False, "no error"


# ---------- DOCX ----------

print("== docx ==")
text, title = kf.docx_text(DOCX)
check("docx: headings (Title/Heading1/localised id/outline level), runs,"
      " br/tab, lists, table rows, content control", text == EXPECTED, repr(text))
check("docx: core title", title == "Policy 2026", title)
chunks = pk.chunk_text(text)
check("docx text feeds the heading-aware chunker (list/table rows are not"
      " inline headings; a short headed section is kept)",
      [c["heading"] for c in chunks] == ["Delivery", "Returns", "Charges"]
      and chunks[1]["content"].startswith("- 7 day return\n- Original")
      and "City | Days\nKarachi | 1-2" in chunks[1]["content"]
      and chunks[2]["content"] == "Call 0300-1234567", chunks)
TINY = pk.chunk_text("# Delivery\n\n" + "Orders ship within 24 hours across"
                     " Pakistan. " * 3 + "\n\n# B\n\nok")
check("chunker still drops a meaningless tiny section among others",
      [c["heading"] for c in TINY] == ["Delivery"], TINY)
result = kf.extract("Policy.DOCX", DOCX)
check("extract docx: type, text, title, pages 0, not truncated",
      result["type"] == "docx" and result["text"] == EXPECTED
      and result["title"] == "Policy 2026" and result["pages"] == 0
      and result["truncated"] is False, result)
check("docx without styles.xml / core.xml still works (builtin ids)",
      kf.docx_text(make_docx(para([t("Price list")], "Heading2")
                             + para([t("Lawn suit Rs 4500")])))[0]
      == "## Price list\n\nLawn suit Rs 4500", "-")
ok, detail = raises(lambda: kf.extract("x.docx", b"not a zip at all"),
                    "extract_failed")
check("damaged / non-zip docx -> owner message", ok and "not a valid Word"
      in detail, detail)


def _zip_only():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("hello.txt", "hi")
    return buf.getvalue()


ok, detail = raises(lambda: kf.extract("x.docx", _zip_only()), "extract_failed")
check("zip without word/document.xml -> not a valid Word document", ok, detail)
orig = kf.DOCX_PART_BYTES_MAX
kf.DOCX_PART_BYTES_MAX = 1000
big = make_docx(para([t("A" * 5000)]))
ok, detail = raises(lambda: kf.extract("x.docx", big), "too_large")
kf.DOCX_PART_BYTES_MAX = orig
check("zip-bomb guard: declared uncompressed size checked before reading",
      ok and len(big) < 1000, (detail, len(big)))
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w") as z:
    z.writestr("word/document.xml", '<?xml version="1.0"?><!DOCTYPE lol ['
               '<!ENTITY a "aaaa">]><w:document ' + W_NS + '><w:body>'
               + para([t("&a;&a;&a;&a;&a;&a;")]) + "</w:body></w:document>")
ok, detail = raises(lambda: kf.extract("x.docx", buf.getvalue()),
                    "extract_failed")
check("XML with DTD / entity declarations refused", ok
      and "unsupported markup" in detail, detail)
ok, detail = raises(lambda: kf.extract("x.docx", make_docx(para([]))),
                    "no_text")
check("empty Word file -> no_text", ok, detail)

# ---------- types + base64 ----------

print("== types + base64 ==")
ok, detail = raises(lambda: kf.extract("old.doc", b"\xd0\xcf\x11\xe0"),
                    "unsupported_type")
check(".doc -> save as .docx or PDF", ok and ".docx or PDF" in detail, detail)
ok, detail = raises(lambda: kf.extract("virus.exe", b"MZ"), "unsupported_type")
check("other types refused", ok, detail)
check("file_type", kf.file_type("A.PDF") == "pdf" and kf.file_type("x") == ""
      and kf.file_type("a.b.docx") == "docx", "-")
encoded = base64.b64encode(DOCX).decode()
check("decode_base64 plain + data URL + whitespace",
      kf.decode_base64(encoded) == DOCX
      and kf.decode_base64("data:application/vnd.openxml;base64," + encoded) == DOCX
      and kf.decode_base64(encoded[:40] + "\n" + encoded[40:]) == DOCX, "-")
ok, detail = raises(lambda: kf.decode_base64("@@not base64@@"), "bad_request")
check("decode_base64 damaged -> bad_request", ok, detail)
ok, detail = raises(lambda: kf.decode_base64(""), "bad_request")
check("decode_base64 empty -> bad_request", ok, detail)
orig = kf.FILE_BYTES_MAX
kf.FILE_BYTES_MAX = 100
ok, detail = raises(lambda: kf.decode_base64(base64.b64encode(b"x" * 500)
                                             .decode()), "too_large")
ok2, _d = raises(lambda: kf.extract("a.docx", b"x" * 101), "too_large")
kf.FILE_BYTES_MAX = orig
check("size limit enforced before decoding (env OF_KB_FILE_BYTES_MAX)",
      ok and ok2 and "MB" in detail, detail)
check("limits payload", kf.limits()["file_types"][:2] == ["pdf", "docx"]
      and kf.limits()["file_bytes_max"] == kf.FILE_BYTES_MAX
      and kf.limits()["pdf_available"] is True, kf.limits())

# ---------- PDF ----------

print("== pdf ==")
result = kf.extract("policy.pdf", PDF)
check("pdf: text from every page, page count, metadata title",
      "Orders ship within 24 hours across Pakistan." in result["text"]
      and "Items can be returned within 7 days." in result["text"]
      and result["pages"] == 2 and result["title"] == "Store Policy PDF"
      and result["truncated"] is False and result["type"] == "pdf", result)
check("pdf: pages separated by a blank line (chunker blocks)",
      result["text"].index("Returns") > result["text"].index("\n\n"), result)
orig = kf.PDF_PAGES_MAX
kf.PDF_PAGES_MAX = 1
capped = kf.extract("policy.pdf", PDF)
kf.PDF_PAGES_MAX = orig
check("pdf page cap (OF_KB_PDF_PAGES_MAX) -> truncated, first pages kept",
      capped["truncated"] is True and "Pakistan" in capped["text"]
      and "returned" not in capped["text"], capped)
short = kf.extract("policy.pdf", PDF, max_chars=40)
check("pdf char cap -> truncated, within the limit",
      short["truncated"] is True and len(short["text"]) <= 40, short)
ok, detail = raises(lambda: kf.extract("scan.pdf", make_pdf(["", ""])),
                    "no_text")
check("text-less PDF without page images -> honest no_text (§221: scans"
      " with images are offered for OCR, see test_kb_ocr)",
      ok and "no page images" in detail, detail)
ok, detail = raises(lambda: kf.extract("x.pdf", b"hello world"),
                    "extract_failed")
check("non-PDF bytes -> not a valid PDF", ok, detail)
ok, detail = raises(lambda: kf.extract("x.pdf", b"%PDF-1.4\ngarbage"),
                    "extract_failed")
check("damaged PDF -> owner message", ok, detail)
try:
    from pypdf import PdfReader, PdfWriter

    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(PDF)))
    writer.encrypt(user_password="secret", owner_password="owner",
                   algorithm="RC4-128")
    locked = io.BytesIO()
    writer.write(locked)
    ok, detail = raises(lambda: kf.extract("locked.pdf", locked.getvalue()),
                        "encrypted")
    check("password-protected PDF -> remove the password", ok, detail)
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(PDF)))
    writer.encrypt(user_password="", owner_password="owner",
                   algorithm="RC4-128")
    open_pdf = io.BytesIO()
    writer.write(open_pdf)
    check("owner-password-only PDF (opens without a password) is read",
          "Pakistan" in kf.extract("o.pdf", open_pdf.getvalue())["text"], "-")
except Exception as error:  # pragma: no cover - fixture problem
    check("encryption fixtures", False, repr(error))
saved = sys.modules.get("pypdf")
sys.modules["pypdf"] = None
ok, detail = raises(lambda: kf.extract("policy.pdf", PDF), "pdf_unavailable")
available = kf.pdf_available()
if saved is not None:
    sys.modules["pypdf"] = saved
else:
    del sys.modules["pypdf"]
check("pypdf missing -> pdf_unavailable message, limits say so", ok
      and "pypdf" in detail and available is False, detail)
check("docx still works without pypdf (stdlib only)",
      "import pypdf" not in open(kf.__file__, encoding="utf8").read()
      .split("def pdf_text")[0], "-")

# ---------- API ----------


class PrincipalStub:
    def __init__(self, principal):
        self.principal = principal

    def __enter__(self):
        self.orig = pk.authenticate_portal_request
        pk.authenticate_portal_request = lambda: self.principal
        return self

    def __exit__(self, *a):
        pk.authenticate_portal_request = self.orig


KICKS = []
fake_sem = types.ModuleType("portal_kb_semantic")
fake_sem.kick_after_mutation = lambda response: (KICKS.append("after"), response)[1]
fake_sem.kick = lambda client_id, reason="edit", rounds=3: KICKS.append(
    (client_id, reason)) or True
sys.modules["portal_kb_semantic"] = fake_sem


def run_api(script, method, path, json_body=None, principal=PRINCIPAL):
    pk._DDL_READY = True
    conn = install_db_stub(pk, script)
    app = Flask("kb-files-test")
    app.register_blueprint(pk.bp)
    with PrincipalStub(principal):
        client = app.test_client()
        response = getattr(client, method.lower())(path, json=json_body)
    response.conn = conn
    return response


print("== extract api ==")
KICKS.clear()
r = run_api([], "POST", "/api/v1/portal/kb/extract",
            {"filename": "Policy.docx",
             "file_base64": base64.b64encode(DOCX).decode()})
body = r.get_json()
check("POST /kb/extract docx -> text for review, nothing stored",
      r.status_code == 200 and body["text"] == EXPECTED
      and body["filename"] == "Policy.docx" and body["type"] == "docx"
      and r.conn.cur.executed == [], body)
check("extract does not schedule a semantic sync", KICKS == [], KICKS)
r = run_api([], "POST", "/api/v1/portal/kb/extract",
            {"filename": "p.pdf", "file_base64": base64.b64encode(PDF).decode()})
check("POST /kb/extract pdf", r.status_code == 200
      and r.get_json()["pages"] == 2, r.get_json())
r = run_api([], "POST", "/api/v1/portal/kb/extract",
            {"filename": "scan.pdf",
             "file_base64": base64.b64encode(make_pdf([""])).decode()})
check("scanned PDF -> 400 no_text", r.status_code == 400
      and r.get_json()["error"]["code"] == "no_text", r.get_json())
r = run_api([], "POST", "/api/v1/portal/kb/extract",
            {"filename": "a.exe", "file_base64": "TVo="})
check("bad type -> 400 unsupported_type", r.status_code == 400
      and r.get_json()["error"]["code"] == "unsupported_type", r.get_json())
r = run_api([], "POST", "/api/v1/portal/kb/extract", {"filename": "a.pdf"})
check("missing file -> 400 bad_request", r.status_code == 400
      and r.get_json()["error"]["code"] == "bad_request", r.get_json())
r = run_api([], "POST", "/api/v1/portal/kb/extract",
            {"filename": "a.docx", "file_base64": "x"}, principal=API_KEY_PRINCIPAL)
check("extract is human-only (API key 403)", r.status_code == 403, r.status_code)
r = run_api([], "POST", "/api/v1/portal/kb/extract", {}, principal=None)
check("extract 401", r.status_code == 401, r.status_code)
KICKS.clear()
r = run_api([[SRC], [dict(SRC, title="Renamed")]], "PUT",
            "/api/v1/portal/kb/sources/7", {"title": "Renamed"})
check("other writes still schedule the semantic sync", KICKS == ["after"], KICKS)

print("== auto_refresh api ==")
r = run_api([[URL_SRC], [dict(URL_SRC, auto_refresh=True)], []], "PUT",
            "/api/v1/portal/kb/sources/8", {"auto_refresh": True})
sql = r.conn.cur.executed
check("PUT auto_refresh on a web page -> saved + audited (status untouched)",
      r.status_code == 200 and r.get_json()["source"]["auto_refresh"] is True
      and "auto_refresh = %s" in sql[1][0] and "status" not in sql[1][0]
      .split("WHERE")[0] and sql[2][1][1] == "kb.source_auto_refresh_on",
      sql)
r = run_api([[dict(URL_SRC, auto_refresh=True)],
             [dict(URL_SRC, auto_refresh=False)], []], "PUT",
            "/api/v1/portal/kb/sources/8", {"auto_refresh": False})
check("PUT auto_refresh off -> audited off", r.status_code == 200
      and r.conn.cur.executed[2][1][1] == "kb.source_auto_refresh_off",
      r.conn.cur.executed)
r = run_api([[dict(URL_SRC, auto_refresh=True)],
             [dict(URL_SRC, auto_refresh=True)]], "PUT",
            "/api/v1/portal/kb/sources/8", {"auto_refresh": True})
check("PUT auto_refresh unchanged -> no duplicate audit",
      r.status_code == 200 and len(r.conn.cur.executed) == 2, r.conn.cur.executed)
r = run_api([[SRC]], "PUT", "/api/v1/portal/kb/sources/7", {"auto_refresh": True})
check("PUT auto_refresh on a text source -> 400, nothing written",
      r.status_code == 400 and r.conn.rolled_back
      and len(r.conn.cur.executed) == 1, r.get_json())
r = run_api([], "PUT", "/api/v1/portal/kb/sources/8", {"auto_refresh": "yes"})
check("PUT auto_refresh must be a real boolean", r.status_code == 400, r.status_code)
pk.fetch_url = lambda url: ("# Policy\n\nOrders ship within 24 hours across "
                            "Pakistan.", "Policy")
url_created = dict(URL_SRC, id=22, version=0, chunk_count=0, status="draft")
script = [[{"n": 0}], [url_created], [], [], [], [],
          [dict(url_created, version=1, chunk_count=1, auto_refresh=True)], []]
r = run_api(script, "POST", "/api/v1/portal/kb/sources",
            {"kind": "url", "url": "https://example.com/policy",
             "auto_refresh": True})
insert = r.conn.cur.executed[1]
check("POST url with auto_refresh -> stored on insert, still a draft",
      r.status_code == 200 and insert[1][-1] is True
      and "'draft', %s)" in insert[0]
      and r.get_json()["source"]["status"] == "draft", insert)
created = dict(SRC, id=23, version=0, chunk_count=0)
r = run_api([[{"n": 0}], [created], [], [], [], [], [dict(created, version=1)],
             []], "POST", "/api/v1/portal/kb/sources",
            {"kind": "text", "text": "Orders ship within 24 hours.",
             "auto_refresh": True})
check("auto_refresh ignored for non-url sources", r.status_code == 200
      and r.conn.cur.executed[1][1][-1] is False, r.conn.cur.executed[1])

print("== file new version ==")
NEW = "Updated policy\n\nOrders ship within 12 hours now."
r = run_api([[FILE_SRC], [], [], [], [], [dict(FILE_SRC, version=3,
                                                origin="policy-v2.pdf")], []],
            "POST", "/api/v1/portal/kb/sources/9/reindex",
            {"text": NEW, "filename": "policy-v2.pdf"})
sql = r.conn.cur.executed
update = [e for e in sql if e[0].startswith("UPDATE")][0]
version_insert = [e for e in sql if "portal_kb_source_versions" in e[0]
                  and e[0].startswith("INSERT")][0]
check("file 'new version' upload: origin updated, note names the file,"
      " status kept", r.status_code == 200
      and "origin = %s" in update[0].split("WHERE")[0]
      and "policy-v2.pdf" in update[1]
      and version_insert[1][-1] == "new upload: policy-v2.pdf"
      and "status" not in update[0].split("WHERE")[0], (update, version_insert))
r = run_api([[SRC], [], [], [], [], [dict(SRC, version=3)], []], "POST",
            "/api/v1/portal/kb/sources/7/reindex",
            {"text": NEW, "filename": "ignored.pdf"})
update = [e for e in r.conn.cur.executed if e[0].startswith("UPDATE")][0]
check("filename ignored for pasted-text sources", r.status_code == 200
      and "origin" not in update[0].split("WHERE")[0], update)

print("== public shape + stale ==")
from datetime import datetime, timedelta, timezone  # noqa: E402

old = datetime.now(timezone.utc) - timedelta(days=pk.URL_STALE_DAYS + 5)
recent = datetime.now(timezone.utc) - timedelta(days=1)
check("stale when neither indexed nor checked recently",
      pk._is_stale(dict(URL_SRC, ingested_at=old, checked_at=None)), "-")
check("a recent unchanged check clears stale",
      not pk._is_stale(dict(URL_SRC, ingested_at=old, checked_at=recent)), "-")
pub = pk.source_public(dict(URL_SRC, auto_refresh=True, checked_at=recent))
check("source_public exposes auto_refresh + checked_at",
      pub["auto_refresh"] is True and pub["checked_at"] == recent.isoformat(), pub)
check("auto_refresh never reported for non-url rows",
      pk.source_public(dict(SRC, auto_refresh=True))["auto_refresh"] is False, "-")
limits = pk._limits()
check("limits: refresh_hours + file limits", limits["refresh_hours"]
      == pk.REFRESH_HOURS and limits["file_bytes_max"] == kf.FILE_BYTES_MAX
      and limits["file_types"][:2] == ["pdf", "docx"] and "pdf_available" in limits,
      limits)
check("DDL adds the columns idempotently", all(c in pk._DDL for c in (
    "ADD COLUMN IF NOT EXISTS auto_refresh BOOLEAN NOT NULL DEFAULT FALSE",
    "ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ",
    "ADD COLUMN IF NOT EXISTS refresh_attempt_at TIMESTAMPTZ")), "-")
check("ingest stamps checked_at with ingested_at",
      "ingested_at = NOW(), checked_at = NOW()" in open(
          pk.__file__, encoding="utf8").read(), "-")

# ---------- refresh job ----------

print("== refresh job ==")
PAGE = "# Policy\n\nOrders ship within 24 hours across Pakistan."
AUTO = dict(URL_SRC, auto_refresh=True)
FETCHED = []


def fetch_ok(url):
    FETCHED.append(url)
    return PAGE, "Policy"


pk.fetch_url = fetch_ok
conn = install_db_stub(pk, [[{"id": 8}],
                            [{"version": 2, "content": pk.stored_text(PAGE),
                              "chunk_count": 1, "char_count": 1, "note": "",
                              "created_at": None}], []])
outcome = pk.refresh_source(1, AUTO)
sql = conn.cur.executed
check("unchanged page: claimed, compared, only checked_at moves (no version)",
      outcome == "unchanged" and "refresh_attempt_at = NOW()" in sql[0][0]
      and "GREATEST(" in sql[0][0] and sql[0][1] == (8, 1, pk.REFRESH_HOURS)
      and "SET checked_at = NOW(), last_error = ''" in sql[2][0]
      and "updated_at" not in sql[2][0] and len(sql) == 3
      and FETCHED == ["https://example.com/policy"], sql)
check("claim is atomic (due condition repeated in the UPDATE)",
      "AND auto_refresh" in sql[0][0] and "RETURNING id" in sql[0][0], sql[0][0])
FETCHED.clear()
conn = install_db_stub(pk, [[]])
check("row already claimed elsewhere -> skipped, no fetch",
      pk.refresh_source(1, AUTO) == "skipped" and FETCHED == [], "-")
changed_row = dict(AUTO, version=3, chunk_count=1)
conn = install_db_stub(pk, [[{"id": 8}],
                            [{"version": 2, "content": "old text here",
                              "chunk_count": 1, "char_count": 1, "note": "",
                              "created_at": None}],
                            [AUTO], [], [], [], [], [changed_row], []])
outcome = pk.refresh_source(1, AUTO)
sql = conn.cur.executed
log = sql[-1]
check("changed page -> new version by 'system', status untouched",
      outcome == "changed" and log[1][1] == "kb.source_ingested"
      and log[1][2] == "system" and log[1][3] is None
      and "automatic refresh: page changed" in log[1][5]
      and not any("status" in e[0].split("WHERE")[0] for e in sql
                  if e[0].startswith("UPDATE")), sql)
conn = install_db_stub(pk, [[{"id": 8}],
                            [{"version": 2, "content": "old", "chunk_count": 1,
                              "char_count": 1, "note": "", "created_at": None}],
                            [dict(AUTO, auto_refresh=False)]])
check("owner switched it off mid-run -> skipped, nothing indexed",
      pk.refresh_source(1, AUTO) == "skipped" and len(conn.cur.executed) == 3,
      conn.cur.executed)
pk.fetch_url = lambda url: (_ for _ in ()).throw(
    ValueError("The page answered with HTTP 404."))
conn = install_db_stub(pk, [[{"id": 8}], []])
outcome = pk.refresh_source(1, AUTO)
check("fetch failure -> last_error 'Automatic refresh: ...'",
      outcome == "error" and conn.cur.executed[1][1][0]
      == "Automatic refresh: The page answered with HTTP 404.", conn.cur.executed)
pk.fetch_url = lambda url: ("tiny", "")
conn = install_db_stub(pk, [[{"id": 8}], []])
check("empty page -> error, old version kept",
      pk.refresh_source(1, AUTO) == "error" and "no readable text"
      in conn.cur.executed[1][1][0], conn.cur.executed)
pk.fetch_url = lambda url: (_ for _ in ()).throw(RuntimeError("boom"))
conn = install_db_stub(pk, [[{"id": 8}], []])
check("unexpected fetch crash -> generic error (fail-soft)",
      pk.refresh_source(1, AUTO) == "error", conn.cur.executed)

conn = install_db_stub(pk, [[AUTO]])
due = pk.due_refresh(conn.cur, 1)
sql = conn.cur.executed[0]
check("due_refresh: opted-in web pages past the interval, oldest first,"
      " bounded", due == [AUTO] and "kind = 'url' AND auto_refresh" in sql[0]
      and "ORDER BY GREATEST(" in sql[0]
      and sql[1] == (1, pk.REFRESH_HOURS, pk.REFRESH_BATCH), sql)

orig_due, orig_one = pk.due_refresh, pk.refresh_source
outcomes = iter(["changed", "unchanged"])
pk.due_refresh = lambda cur, client_id, limit=0: [AUTO, dict(AUTO, id=9),
                                                  dict(AUTO, id=10)]


def one(client_id, source):
    if source["id"] == 10:
        raise RuntimeError("db hiccup")
    return next(outcomes)


pk.refresh_source = one
KICKS.clear()
install_db_stub(pk, [])
counts = pk.run_refresh(1)
check("run_refresh: per-source isolation + semantic kick when something"
      " changed", counts == {"changed": 1, "unchanged": 1, "error": 1,
                             "skipped": 0} and KICKS == [(1, "edit")],
      (counts, KICKS))
outcomes = iter(["unchanged", "unchanged"])
pk.due_refresh = lambda cur, client_id, limit=0: [AUTO, dict(AUTO, id=9)]
KICKS.clear()
counts = pk.run_refresh(1)
check("nothing changed -> no semantic kick", KICKS == [] and
      counts["unchanged"] == 2, (counts, KICKS))
pk.due_refresh, pk.refresh_source = orig_due, orig_one

STARTED = []
orig_job = pk._refresh_job
pk._refresh_job = lambda client_id: STARTED.append(client_id)
pk._REFRESH_LAST.clear()
pk._REFRESH_RUNNING.clear()
first = pk.kick_refresh(5)
import time as _time  # noqa: E402

_time.sleep(0.05)
second = pk.kick_refresh(5)
other = pk.kick_refresh(6)
zero = pk.kick_refresh(0)
_time.sleep(0.05)  # let the daemon threads run before inspecting them
check("kick_refresh: daemon start, throttled per tenant, ignores client 0",
      first is True and second is False and other is True and zero is False
      and sorted(STARTED) == [5, 6], (first, second, other, zero, STARTED))
pk._REFRESH_RUNNING.add(7)
check("kick_refresh: one job per tenant at a time",
      pk.kick_refresh(7) is False, "-")
pk._REFRESH_RUNNING.clear()
pk._refresh_job = orig_job
pk._REFRESH_RUNNING.add(5)
pk.run_refresh = lambda client_id: (_ for _ in ()).throw(RuntimeError("x"))
pk._refresh_job(5)
check("_refresh_job never raises and releases the tenant",
      5 not in pk._REFRESH_RUNNING, "-")

# ---------- wiring ----------

print("== wiring ==")


def read(rel):
    path = os.path.join(_ROOT, rel)
    return open(path, encoding="utf8").read() if os.path.exists(path) else ""


CONNECTOR = read("omniflow-backend-patch/connector_api.py")
sem_at = CONNECTOR.find('portal_kb_semantic.kick(tenant["client_id"], "tick")')
ref_at = CONNECTOR.find('portal_knowledge.kick_refresh(tenant["client_id"])')
check("tick calls kick_refresh after the semantic top-up, in its own"
      " try/except", 0 < sem_at < ref_at and "except Exception:\n"
      "                    pass" in CONNECTOR[ref_at:ref_at + 200], (sem_at, ref_at))
KSRC = read("omniflow-backend-patch/portal_knowledge.py")
check("env-driven refresh + file limits (no hardcoding)", all(e in KSRC + open(
    kf.__file__, encoding="utf8").read() for e in (
        "OF_KB_AUTO_REFRESH_HOURS", "OF_KB_REFRESH_BATCH",
        "OF_KB_REFRESH_TICK_SECONDS", "OF_KB_FILE_BYTES_MAX",
        "OF_KB_PDF_PAGES_MAX", "OF_KB_EXTRACT_SECONDS",
        "OF_KB_DOCX_PART_BYTES_MAX")), "-")
check("refresh never touches status (auto-publish lock)",
      "status" not in KSRC[KSRC.index("def refresh_source("):
                           KSRC.index("def run_refresh(")], "-")

LIB = read("lib/omniflow/portal.ts")
check("portal.ts: extract client + new fields", all(x in LIB for x in (
    "export async function extractKbFile", '"api/v1/portal/kb/extract"',
    "auto_refresh?: boolean;", "checked_at?: string | null;",
    "refresh_hours?: number;", "file_bytes_max?: number;",
    "pdf_available?: boolean;",
    "patch: { status?: KbSourceStatus; title?: string; auto_refresh?: boolean }",
    "filename ? { text, filename } : { text }")), "-")
BFF = read("app/api/omniflow/portal/kb/extract/route.ts")
check("BFF /kb/extract: auth, pdf/docx only, forwards to extractKbFile",
      all(x in BFF for x in ("requirePortalAccessToken", "extractKbFile",
                              "export async function POST", '".pdf", ".docx"',
                              '"../../../../../../lib/omniflow/portal"')), "-")
PUT = read("app/api/omniflow/portal/kb/sources/[id]/route.ts")
POST = read("app/api/omniflow/portal/kb/sources/route.ts")
REIDX = read("app/api/omniflow/portal/kb/sources/[id]/reindex/route.ts")
check("BFF forwards auto_refresh (PUT boolean, POST url only) + reindex"
      " filename", "typeof payload.auto_refresh === \"boolean\"" in PUT
      and "auto_refresh: autoRefresh" in PUT
      and 'kind === "url" && payload?.auto_refresh === true' in POST
      and "reindexKbSource(accessToken, id, text, filename)" in REIDX, "-")
CARD = read("app/dashboard/(portal)/knowledge-base/KbSourcesCard.tsx")
check("Knowledge card: PDF/Word upload via extract, review before indexing",
      all(x in CARD for x in ("/api/omniflow/portal/kb/extract",
                              "readAsDataURL", ".pdf,.docx",
                              "Review the text below, then add it as a draft.",
                              "Older .doc files are not supported",
                              "Scanned PDFs and photos are read with AI after you confirm.")), "-")
check("Knowledge card: upload new version + auto-refresh toggle with"
      " consent copy", all(x in CARD for x in (
          "Upload new version", "Auto-refresh on", "Auto-refresh off",
          "auto_refresh: next", "Keep this page up to date",
          "Turn on automatic refresh?", "is published. The new file",
          '"checked " + formatWhen(source.checked_at)')), "-")
check("Knowledge card: limits from the Control Plane (no hardcoded interval)",
      "limits?.refresh_hours" in CARD and "limits?.file_bytes_max" in CARD
      and "payload?.limits.pdf_available === false" in CARD, "-")
check("Knowledge card: file-derived title never leaks to another kind",
      "autoTitle.current" in CARD and "title === autoTitle.current" in CARD, "-")
check("Knowledge card: English copy, no emoji-capable glyphs",
      "karein" not in CARD and "nahi" not in CARD and all(
          code not in CARD for code in ("\\u25b6", "\\u2714", "\\u26a1",
                                        "\\u2699", "\\u27a1")), "-")

raise SystemExit(1 if summary("kb_files") else 0)
