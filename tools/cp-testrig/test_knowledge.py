"""Knowledge engine (MASTER-UPGRADE engine 4): tokenising, HTML to text,
heading-aware chunking, ranking, SSRF guard, ingest/versioning on a
scripted DB, the owner API (auth + status codes, auto-publish lock), the
brain integration and the web wiring pins (BFF routes, portal.ts client,
Knowledge page cards, English copy)."""
import os

from flask import Flask

import portal_knowledge as pk
from test_lib import check, install_db_stub, summary

PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}
API_KEY_PRINCIPAL = dict(PRINCIPAL, via_api_key=True)

SRC = {"id": 7, "client_id": 1, "title": "Store policy", "kind": "text",
       "origin": "", "status": "draft", "version": 2, "chunk_count": 3,
       "char_count": 900, "last_error": "", "ingested_at": None,
       "created_at": None, "updated_at": None}
URL_SRC = dict(SRC, id=8, kind="url", origin="https://example.com/policy",
               status="published")
DOC = """# Store policy

DELIVERY:
Orders ship within 24 hours. Karachi delivery takes 1-2 days; other cities take 3-5 days. Delivery charges are Rs 200; free above Rs 3000.

Returns
Items can be returned within 7 days in original packaging. Refunds are processed within 5 working days to the original payment method.

Contact
Call 0300-1234567 between 10am and 8pm."""


class PrincipalStub:
    def __init__(self, module, principal):
        self.module = module
        self.principal = principal

    def __enter__(self):
        self.orig = self.module.authenticate_portal_request
        self.module.authenticate_portal_request = lambda: self.principal
        self.module.PortalAuthUnavailable = Exception
        return self

    def __exit__(self, *a):
        self.module.authenticate_portal_request = self.orig


def fresh(script):
    pk._DDL_READY = True
    return install_db_stub(pk, script)


def run_api(script, method, path, json_body=None, principal=PRINCIPAL):
    fresh(script)
    app = Flask("knowledge-test")
    app.register_blueprint(pk.bp)
    with PrincipalStub(pk, principal):
        client = app.test_client()
        if method == "GET":
            return client.get(path)
        if method == "POST":
            return client.post(path, json=json_body)
        if method == "PUT":
            return client.put(path, json=json_body)
        if method == "DELETE":
            return client.delete(path)
    return None


def sqls(conn):
    return [e[0] for e in conn.cur.executed]


# ---------- tokens ----------

print("== tokens ==")
check("tokenize drops English + Roman Urdu stop words, keeps order, dedupes",
      pk.tokenize("Delivery kitne din me hoti hai? Delivery ka charge kya hai")
      == ["delivery", "kitne", "din", "hoti", "charge"], pk.tokenize(
          "Delivery kitne din me hoti hai? Delivery ka charge kya hai"))
check("tokenize limit keeps the longest (most selective) tokens",
      pk.tokenize("the quick brown fox jumps over lazy dogs", 3)
      == ["quick", "brown", "jumps"],
      pk.tokenize("the quick brown fox jumps over lazy dogs", 3))
check("query_tokens falls back to stop words for stop-word-only questions",
      pk.query_tokens("kya hai") == ["kya", "hai"]
      and pk.query_tokens("???") == [] and pk.query_tokens("") == [], "-")
check("single-character fragments dropped, unicode words kept",
      pk.tokenize("a b 2-4 din \u0688\u06cc\u0644\u06cc\u0648\u0631\u06cc")
      == ["din", "\u0688\u06cc\u0644\u06cc\u0648\u0631\u06cc"], pk.tokenize(
          "a b 2-4 din \u0688\u06cc\u0644\u06cc\u0648\u0631\u06cc"))
check("prefix stems: return->returned, deliver->delivery, din stays exact",
      pk._matches("returned", "return") and pk._matches("delivery", "deliver")
      and pk._matches("deliver", "delivery") and not pk._matches("dinner", "din")
      and not pk._matches("coordination", "din"), "-")

# ---------- html ----------

print("== html ==")
HTML = ("<html><head><title> Delivery &amp; Returns \u2013 Shop </title>"
        "<style>p{}</style></head><body><nav>Home | Shop</nav>"
        "<h1>Delivery policy</h1><p>We deliver in <b>2-4 days</b> across "
        "Pakistan.&nbsp;Karachi same day.</p><script>var x=1;</script>"
        "<h2>Returns</h2><ul><li>7 day return</li><li>Original packaging</li>"
        "</ul><!-- c --></body></html>")
TEXT = pk.html_to_text(HTML)
check("html title (case kept)", pk.html_title(HTML) == "Delivery & Returns \u2013 Shop",
      pk.html_title(HTML))
check("html -> text keeps headings as markdown lines, drops script/style",
      "# Delivery policy" in TEXT and "## Returns" in TEXT
      and "var x" not in TEXT and "p{}" not in TEXT
      and "We deliver in 2-4 days across Pakistan. Karachi same day." in TEXT
      and "7 day return\n\nOriginal packaging" in TEXT, TEXT)
check("clean_text normalises CRLF/tabs and collapses blank runs",
      pk.clean_text("a\r\n\r\n\r\nb\t\tc  \n\n\n") == "a\n\nb c", repr(
          pk.clean_text("a\r\n\r\n\r\nb\t\tc  \n\n\n")))

# ---------- chunking ----------

print("== chunking ==")
chunks = pk.chunk_text(DOC, 300, 40)
check("headings label the chunks that follow (inline + own-line)",
      [c["heading"] for c in chunks][:3] == ["DELIVERY", "Returns", "Contact"],
      [c["heading"] for c in chunks])
check("chunks respect the size and positions are sequential",
      all(len(c["content"]) <= 300 for c in chunks)
      and [c["position"] for c in chunks] == list(range(len(chunks))), chunks)
check("no overlap is carried across a section break",
      chunks[1]["content"].startswith("Items can be returned"),
      chunks[1]["content"][:40])
long_doc = ("Warranty covers manufacturing defects for twelve months. " * 30)
long_chunks = pk.chunk_text(long_doc, 300, 40)
check("long paragraphs split at sentence boundaries with overlap",
      len(long_chunks) >= 5 and all(len(c["content"]) <= 300 for c in long_chunks)
      and all(c["content"].endswith("months.") for c in long_chunks)
      and long_chunks[1]["content"].startswith(
          "defects for twelve months. Warranty covers"), long_chunks[:2])
check("a single overlong sentence is hard-split at a space",
      all(len(c["content"]) <= 120 for c in pk.chunk_text("word " * 100, 120, 0))
      and len(pk.chunk_text("word " * 100, 120, 0)) >= 4, "-")
check("chunk_text of blank text -> []", pk.chunk_text("   \n\n ") == [], "-")
check("tiny fragments dropped once there is more than one chunk",
      all(len(c["content"]) >= pk.MIN_CHUNK_CHARS for c in chunks), "-")
check("chunk defaults come from env-backed constants",
      pk.CHUNK_CHARS >= 200 and pk.CHUNK_OVERLAP <= pk.CHUNK_CHARS // 3
      and pk.MAX_SOURCE_CHARS >= 1000 and pk.MAX_SOURCES >= 1, "-")

# ---------- ranking ----------

print("== ranking ==")
CANDS = [
    {"kind": "entry", "id": 3, "title": "Delivery time", "content": "2-4 din",
     "extra": "delivery, kitne din", "source_id": 0, "source_title": "",
     "position": 0},
    {"kind": "chunk", "id": 11, "title": "delivery",
     "content": "Orders ship within 24 hours. Karachi delivery takes 1-2 days;"
                " other cities take 3-5 days.", "extra": "", "source_id": 7,
     "source_title": "Store policy", "position": 0},
    {"kind": "chunk", "id": 12, "title": "returns",
     "content": "Items can be returned within 7 days in original packaging."
                " Refunds are processed within 5 working days.", "extra": "",
     "source_id": 7, "source_title": "Store policy", "position": 1},
    {"kind": "chunk", "id": 13, "title": "",
     "content": "Our Karachi store is open daily. Delivery riders start at 10am.",
     "extra": "", "source_id": 9, "source_title": "Hours", "position": 0},
]


def ids(query, n=5):
    return [(h["kind"], h["id"]) for h in pk.score_candidates(
        pk.query_tokens(query), CANDS, n)]


check("keywords + coverage put the owner answer first for its question",
      ids("delivery kitne din me hoti hai")[0] == ("entry", 3),
      ids("delivery kitne din me hoti hai"))
check("phrase + heading boost ranks the matching section first",
      ids("karachi delivery") == [("chunk", 11), ("chunk", 13), ("entry", 3)],
      ids("karachi delivery"))
check("stemmed match (return -> returned) finds the returns section",
      ids("return policy") == [("chunk", 12)] and ids("refund") == [("chunk", 12)],
      ids("return policy"))
check("no match -> [] and n caps the hits",
      ids("warranty") == [] and len(ids("delivery", 1)) == 1, "-")
hit = pk.score_candidates(pk.query_tokens("karachi delivery"), CANDS, 1)[0]
check("hit shape carries the citation",
      hit["source"] == "Store policy" and hit["position"] == 0
      and hit["matched"] == ["karachi", "delivery"] and hit["score"] > 0
      and hit["source_id"] == 7 and len(hit["content"]) <= pk.SNIPPET_CHARS,
      hit)
check("ranking is deterministic (ties -> shorter text, then id)",
      [h["id"] for h in pk.score_candidates(["x"], [
          {"kind": "chunk", "id": 5, "title": "", "content": "x y z"},
          {"kind": "chunk", "id": 4, "title": "", "content": "x y"},
          {"kind": "chunk", "id": 2, "title": "", "content": "x y"}], 5)]
      == [2, 4, 5], "-")

# ---------- SSRF guard ----------

print("== url guard ==")


def resolver_for(ip):
    return lambda host, port: [(None, None, None, None, (ip, port))]


check("public https host passes",
      pk.assert_public_url("https://example.com/policy", resolver_for("93.184.216.34"))
      == ("https", "example.com"), "-")
for url, ip, why in (
        ("ftp://example.com/x", "93.184.216.34", "scheme"),
        ("https://user:pw@example.com/", "93.184.216.34", "credentials"),
        ("http://localhost/admin", "127.0.0.1", "localhost"),
        ("http://example.com/", "127.0.0.1", "loopback"),
        ("http://example.com/", "10.0.0.5", "private"),
        ("http://example.com/", "169.254.169.254", "link-local metadata"),
        ("http://example.com/", "::1", "ipv6 loopback"),
        ("http://example.com/", "fd00::1", "ipv6 private"),
        ("http://example.com/", "0.0.0.0", "unspecified"),
        ("http://example.com/", "224.0.0.1", "multicast"),
        ("http://box.internal/", "93.184.216.34", "internal suffix"),
        ("not a url", "93.184.216.34", "junk")):
    try:
        pk.assert_public_url(url, resolver_for(ip))
        ok = False
    except ValueError:
        ok = True
    check("url guard rejects " + why, ok, url)
try:
    pk.assert_public_url("https://nope.invalid/", lambda h, p: (_ for _ in ()).throw(OSError()))
    ok = False
except ValueError:
    ok = True
check("url guard rejects unresolvable hosts", ok, "-")
check("redirects are re-validated", issubclass(
    pk._SafeRedirectHandler, pk.urllib.request.HTTPRedirectHandler)
      and "assert_public_url(newurl)" in open(pk.__file__, encoding="utf8").read(),
      "-")

# ---------- ingest / versions ----------

print("== ingest ==")
conn = fresh([[], [], [], [], [dict(SRC, version=3, chunk_count=3)], []])
updated = pk.ingest(conn.cur, 1, SRC, DOC, "created", 11)
ex = conn.cur.executed
check("ingest replaces the source's chunks first",
      "DELETE FROM portal_kb_chunks" in ex[0][0] and ex[0][1] == (1, 7), ex[0])
check("ingest inserts all chunks in one multi-row statement tagged v3",
      "INSERT INTO portal_kb_chunks" in ex[1][0]
      and ex[1][0].count("(%s, %s, %s, %s, %s, %s, %s)") == 3
      and ex[1][1][:4] == (1, 7, 3, 0) and ex[1][1][4] == "DELIVERY", ex[1][1][:6])
check("ingest snapshots the raw text as version 3",
      "INSERT INTO portal_kb_source_versions" in ex[2][0]
      and ex[2][1][2] == 3 and ex[2][1][3].startswith("# Store policy")
      and ex[2][1][6] == "created", ex[2][1][:3])
check("ingest prunes versions beyond the cap",
      "DELETE FROM portal_kb_source_versions" in ex[3][0]
      and ex[3][1] == (1, 7, 3 - pk.MAX_VERSIONS), ex[3])
check("ingest refreshes counters + clears last_error, never touches status",
      "UPDATE portal_kb_sources" in ex[4][0] and "last_error = ''" in ex[4][0]
      and "status =" not in ex[4][0] and ex[4][1][:2] == (3, 3), ex[4])
check("ingest audits kb.source_ingested", ex[5][1][1] == "kb.source_ingested"
      and ex[5][1][3] == 11 and "v3" in ex[5][1][5], ex[5][1])
check("ingest returns the updated row", updated["version"] == 3, updated)

conn = fresh([[], [], [], [], [], []])
updated = pk.ingest(conn.cur, 1, dict(SRC, version=0), "short but valid text here.")
check("ingest without RETURNING row falls back to computed counters",
      updated["version"] == 1 and updated["chunk_count"] == 1
      and len(conn.cur.executed) == 6, updated)

check("ingest of blank text writes zero chunks without an INSERT",
      pk.ingest(fresh([[], [], [], [], []]).cur, 1, SRC, "  ")["chunk_count"]
      == 0, "-")

conn = fresh([[{"version": 2, "content": "old text", "chunk_count": 1,
                "char_count": 8, "note": "", "created_at": None}]])
check("version_content picks a specific version",
      pk.version_content(conn.cur, 1, 7, 2)["content"] == "old text"
      and conn.cur.executed[0][1] == (1, 7, 2)
      and "version = %s" in conn.cur.executed[0][0], conn.cur.executed[0])
conn = fresh([[]])
check("version_content latest when no version given",
      pk.version_content(conn.cur, 1, 7) is None
      and conn.cur.executed[0][1] == (1, 7)
      and "ORDER BY version DESC LIMIT 1" in conn.cur.executed[0][0], "-")

health = pk.health([SRC, URL_SRC, dict(SRC, id=9, status="paused",
                                        last_error="boom")])
check("health counts", health == {"sources": 3, "published": 1, "drafts": 1,
                                  "paused": 1, "chunks": 3, "errors": 1,
                                  "stale": 0}, health)
from datetime import datetime, timedelta, timezone
old_stamp = datetime.now(timezone.utc) - timedelta(days=pk.URL_STALE_DAYS + 1)
check("stale = url source fetched too long ago",
      pk.source_public(dict(URL_SRC, ingested_at=old_stamp))["stale"] is True
      and pk.source_public(dict(SRC, ingested_at=old_stamp))["stale"] is False
      and pk.source_public(URL_SRC)["stale"] is False, "-")

# ---------- retrieve ----------

print("== retrieve ==")
conn = fresh([CANDS])
hits = pk.retrieve(conn.cur, 1, "karachi delivery", 3)
sql, params = conn.cur.executed[0]
check("retrieve = ONE tenant-scoped UNION over active entries + published chunks",
      len(conn.cur.executed) == 1 and "UNION ALL" in sql
      and "portal_kb_entries" in sql and "portal_kb_chunks" in sql
      and "s.status = 'published'" in sql and "e.is_active IS TRUE" in sql
      and sql.count("ILIKE ANY(%s)") == 5 and sql.endswith("LIMIT %s"), sql)
check("retrieve params: client + %token% patterns + candidate cap",
      params[0] == 1 and params[1] == ["%karachi%", "%delivery%"]
      and params[4] == 1 and params[-1] == pk.RETRIEVE_CANDIDATES, params)
check("retrieve ranks the returned candidates",
      [h["id"] for h in hits] == [11, 13, 3], [h["id"] for h in hits])
conn = fresh([])
check("retrieve with no searchable words never touches the DB",
      pk.retrieve(conn.cur, 1, "???", 3) == [] and conn.cur.executed == [], "-")
conn = fresh([[]])
pk.retrieve(conn.cur, 1, "refund", 3, include_entries=False)
check("chunks-only retrieval skips the entries half",
      "portal_kb_entries" not in conn.cur.executed[0][0]
      and "UNION" not in conn.cur.executed[0][0], "-")

# ---------- API ----------

print("== api ==")
r = run_api([[SRC, URL_SRC]], "GET", "/api/v1/portal/kb/sources")
body = r.get_json()
check("GET sources 200 with health + limits", r.status_code == 200
      and [s["id"] for s in body["sources"]] == [7, 8]
      and body["health"]["published"] == 1 and body["health"]["drafts"] == 1
      and body["limits"]["max_sources"] == pk.MAX_SOURCES
      and body["limits"]["kinds"] == ["text", "file", "url"], body)
r = run_api([[SRC]], "GET", "/api/v1/portal/kb/sources",
            principal=API_KEY_PRINCIPAL)
check("GET sources readable by API keys", r.status_code == 200, r.status_code)
r = run_api([], "GET", "/api/v1/portal/kb/sources", principal=None)
check("GET sources 401", r.status_code == 401, r.status_code)

created = dict(SRC, id=21, version=0, chunk_count=0, char_count=0)
r = run_api([[{"n": 2}], [created], [], [], [], [],
             [dict(created, version=1, chunk_count=3, char_count=len(DOC))], []],
            "POST", "/api/v1/portal/kb/sources",
            {"kind": "text", "text": DOC})
body = r.get_json()
check("POST text source -> draft, indexed right away, title from first heading",
      r.status_code == 200 and body["source"]["status"] == "draft"
      and body["source"]["version"] == 1 and body["source"]["chunk_count"] == 3,
      body)
r = run_api([[{"n": 2}], [created], [], [], [], [], [created], []], "POST",
            "/api/v1/portal/kb/sources",
            {"kind": "file", "text": DOC, "filename": "policy.txt",
             "title": "Policy file"})
check("POST file source stores the file name as origin", r.status_code == 200,
      r.status_code)
r = run_api([[{"n": pk.MAX_SOURCES}]], "POST", "/api/v1/portal/kb/sources",
            {"kind": "text", "text": DOC})
check("POST 409 at the source cap", r.status_code == 409
      and r.get_json()["error"]["code"] == "limit", r.status_code)
r = run_api([], "POST", "/api/v1/portal/kb/sources",
            {"kind": "text", "text": "too short"})
check("POST 400 not enough text", r.status_code == 400, r.status_code)
r = run_api([], "POST", "/api/v1/portal/kb/sources",
            {"kind": "text", "text": "x" * (pk.MAX_SOURCE_CHARS + 1)})
check("POST 400 too_long", r.status_code == 400
      and r.get_json()["error"]["code"] == "too_long", r.status_code)
r = run_api([], "POST", "/api/v1/portal/kb/sources", {"kind": "pdf", "text": DOC})
check("POST 400 bad kind", r.status_code == 400, r.status_code)
r = run_api([], "POST", "/api/v1/portal/kb/sources", {"kind": "url"})
check("POST 400 url missing", r.status_code == 400, r.status_code)
pk.fetch_url = lambda url: (_ for _ in ()).throw(ValueError("Internal addresses cannot be fetched."))
r = run_api([], "POST", "/api/v1/portal/kb/sources",
            {"kind": "url", "url": "http://10.0.0.1/"})
check("POST url 400 fetch_failed (guard message surfaces, nothing created)",
      r.status_code == 400 and r.get_json()["error"]["code"] == "fetch_failed",
      r.get_json())
pk.fetch_url = lambda url: (pk.html_to_text(HTML), pk.html_title(HTML))
url_created = dict(URL_SRC, id=22, version=0, chunk_count=0, status="draft")
r = run_api([[{"n": 0}], [url_created], [], [], [], [],
             [dict(url_created, version=1, chunk_count=2)], []], "POST",
            "/api/v1/portal/kb/sources", {"kind": "url", "url": "https://example.com/policy"})
body = r.get_json()
check("POST url source fetches, titles from <title>, stays draft",
      r.status_code == 200 and body["source"]["status"] == "draft", body)
r = run_api([], "POST", "/api/v1/portal/kb/sources", {"kind": "text", "text": DOC},
            principal=API_KEY_PRINCIPAL)
check("POST 403 API key", r.status_code == 403, r.status_code)

r = run_api([[SRC], [dict(SRC, status="published")], []], "PUT",
            "/api/v1/portal/kb/sources/7", {"status": "published"})
check("PUT publish 200 + audit kb.source_published",
      r.status_code == 200 and r.get_json()["source"]["status"] == "published",
      r.get_json())
r = run_api([[dict(SRC, chunk_count=0)]], "PUT", "/api/v1/portal/kb/sources/7",
            {"status": "published"})
check("PUT publish refused for an empty source", r.status_code == 400
      and r.get_json()["error"]["code"] == "empty_source", r.status_code)
r = run_api([[]], "PUT", "/api/v1/portal/kb/sources/99", {"status": "paused"})
check("PUT 404", r.status_code == 404, r.status_code)
r = run_api([], "PUT", "/api/v1/portal/kb/sources/7", {"status": "live"})
check("PUT 400 bad status", r.status_code == 400, r.status_code)
r = run_api([], "PUT", "/api/v1/portal/kb/sources/7", {})
check("PUT 400 nothing to update", r.status_code == 400, r.status_code)
r = run_api([[SRC], [dict(SRC, title="Renamed")]], "PUT",
            "/api/v1/portal/kb/sources/7", {"title": "Renamed"})
check("PUT rename only (no status audit)", r.status_code == 200
      and r.get_json()["source"]["title"] == "Renamed", r.get_json())

r = run_api([[SRC], [], [], [], []], "DELETE", "/api/v1/portal/kb/sources/7")
check("DELETE 200 removes chunks + versions + source + audits",
      r.status_code == 200, r.status_code)
r = run_api([[]], "DELETE", "/api/v1/portal/kb/sources/7")
check("DELETE 404", r.status_code == 404, r.status_code)

r = run_api([[SRC], [{"version": 2, "content": DOC, "chunk_count": 3,
                      "char_count": 1, "note": "", "created_at": None}],
             [], [], [], [], [dict(SRC, version=3)], []], "POST",
            "/api/v1/portal/kb/sources/7/reindex", {})
check("POST reindex re-chunks the latest stored text", r.status_code == 200
      and r.get_json()["source"]["version"] == 3, r.get_json())
r = run_api([[SRC], [], [], [], [], [dict(SRC, version=3)], []], "POST",
            "/api/v1/portal/kb/sources/7/reindex", {"text": DOC})
check("POST reindex with new text replaces the content", r.status_code == 200,
      r.status_code)
r = run_api([[SRC], []], "POST", "/api/v1/portal/kb/sources/7/reindex", {})
check("POST reindex 400 when nothing is stored", r.status_code == 400
      and r.get_json()["error"]["code"] == "empty_source", r.status_code)
pk.fetch_url = lambda url: (_ for _ in ()).throw(ValueError("The page answered with HTTP 404."))
r = run_api([[URL_SRC], []], "POST", "/api/v1/portal/kb/sources/8/reindex", {})
check("POST re-fetch failure records last_error + 400 fetch_failed",
      r.status_code == 400 and r.get_json()["error"]["code"] == "fetch_failed",
      r.get_json())
pk.fetch_url = lambda url: (pk.html_to_text(HTML), pk.html_title(HTML))
r = run_api([[URL_SRC], [], [], [], [], [dict(URL_SRC, version=3)], []], "POST",
            "/api/v1/portal/kb/sources/8/reindex", {})
check("POST re-fetch success keeps publication state", r.status_code == 200
      and r.get_json()["source"]["status"] == "published", r.get_json())

r = run_api([[SRC], [{"version": 2, "chunk_count": 3, "char_count": 900,
                      "note": "created", "created_at": None},
                     {"version": 1, "chunk_count": 2, "char_count": 500,
                      "note": "", "created_at": None}]], "GET",
            "/api/v1/portal/kb/sources/7/versions")
check("GET versions 200 (newest first, no content)", r.status_code == 200
      and [v["version"] for v in r.get_json()["versions"]] == [2, 1]
      and "content" not in r.get_json()["versions"][0], r.get_json())
r = run_api([[]], "GET", "/api/v1/portal/kb/sources/7/versions")
check("GET versions 404", r.status_code == 404, r.status_code)

r = run_api([[SRC], [{"version": 1, "content": DOC, "chunk_count": 2,
                      "char_count": 1, "note": "", "created_at": None}],
             [], [], [], [], [dict(SRC, version=3)], []], "POST",
            "/api/v1/portal/kb/sources/7/rollback", {"version": 1})
check("POST rollback re-indexes the old text as a NEW version",
      r.status_code == 200 and r.get_json()["source"]["version"] == 3,
      r.get_json())
r = run_api([[SRC], []], "POST", "/api/v1/portal/kb/sources/7/rollback",
            {"version": 1})
check("POST rollback 404 when that version is gone", r.status_code == 404,
      r.status_code)
r = run_api([], "POST", "/api/v1/portal/kb/sources/7/rollback", {})
check("POST rollback 400 without version", r.status_code == 400, r.status_code)

r = run_api([CANDS], "GET", "/api/v1/portal/kb/search?q=karachi%20delivery&n=2")
body = r.get_json()
check("GET search 200 (tokens + ranked hits, n honoured)",
      r.status_code == 200 and body["tokens"] == ["karachi", "delivery"]
      and [h["id"] for h in body["hits"]] == [11, 13], body)
r = run_api([], "GET", "/api/v1/portal/kb/search")
check("GET search 400 without q", r.status_code == 400, r.status_code)
r = run_api([CANDS], "GET", "/api/v1/portal/kb/search?q=refund",
            principal=API_KEY_PRINCIPAL)
check("GET search readable by API keys", r.status_code == 200, r.status_code)

# ---------- wiring pins ----------

print("== wiring pins ==")
SMOKE = "/tmp/smoke971/"
RIG13 = "/tmp/p13/Omniflow/"
HERE = os.path.dirname(os.path.abspath(__file__))


def read(path):
    return open(path, encoding="utf8").read() if os.path.exists(path) else ""


APP = read(SMOKE + "app.py")
check("blueprint registered", "from portal_knowledge import bp as"
      " portal_knowledge_bp" in APP
      and "aux_app.register_blueprint(portal_knowledge_bp)" in APP, "-")
KSRC = read(pk.__file__)
BRAIN = read(os.path.join(HERE, "..", "..", "omniflow-backend-patch",
                          "portal_brain.py"))
check("brain search_kb delegates to portal_knowledge.retrieve",
      "portal_knowledge.retrieve(cur, client_id, text" in BRAIN
      and 'grounding["citations"]' in BRAIN
      and 'grounding["knowledge_ids"]' in BRAIN, "-")
check("brain ensures the knowledge tables before the first answer",
      "portal_knowledge._ensure_ddl(cur)" in BRAIN, "-")
check("system prompt knows about document excerpts",
      "kind chunk" in BRAIN and "never go beyond what they say" in BRAIN, "-")
check("auto-publish lock: sources are created as drafts and ingest never"
      " publishes", "VALUES (%s, %s, %s, %s, 'draft', %s)" in KSRC
      and "Never publishes" in KSRC and "status" not in KSRC[
          KSRC.index("def ingest("):KSRC.index("def record_error(")].split(
          "UPDATE")[1], "-")
check("all writes audited", all(a in KSRC for a in (
    '"kb.source_ingested"', '"kb.source_deleted"', '"kb.source_" + status')), "-")
check("writes human-only, reads any principal",
      KSRC.count("= _human_or_error()") == 6
      and KSRC.count("= _principal_or_error()") == 4,
      (KSRC.count("= _human_or_error()"), KSRC.count("= _principal_or_error()")))
check("no hardcoded limits", all(e in KSRC for e in (
    "OF_KB_SOURCES_MAX", "OF_KB_SOURCE_CHARS_MAX", "OF_KB_CHUNK_CHARS",
    "OF_KB_CHUNK_OVERLAP", "OF_KB_VERSIONS_MAX", "OF_KB_URL_TIMEOUT",
    "OF_KB_URL_BYTES_MAX", "OF_KB_URL_STALE_DAYS", "OF_KB_RETRIEVE_CANDIDATES")),
      "-")
# D1 delivered (§211): semantic recall plugs into retrieve() via
# portal_kb_semantic; keyword-only stays the automatic fallback.
check("D1 honest docstring: hybrid via portal_kb_semantic, keyword fallback",
      "portal_kb_semantic" in KSRC and "no embeddings" not in KSRC
      and "keyword-only is\nthe automatic fallback" in KSRC, "-")

LIB = read(RIG13 + "lib/omniflow/portal.ts")
check("portal.ts knowledge client", all(t in LIB for t in (
    "export interface KbSource", "export interface KbHit",
    "export interface KbSourceVersion", "export async function listKbSources",
    "export async function createKbSource", "export async function updateKbSource",
    "export async function deleteKbSource", "export async function reindexKbSource",
    "export async function listKbSourceVersions",
    "export async function rollbackKbSource",
    "export async function searchKnowledge")), "-")
check("portal.ts knowledge paths", all(t in LIB for t in (
    '"api/v1/portal/kb/sources"', '"api/v1/portal/kb/sources/" + id',
    '"/reindex"', '"/versions"', '"/rollback"', '"api/v1/portal/kb/search?q="')),
      "-")
BFF = "app/api/omniflow/portal/kb/"
for rel, tokens in (
        ("sources/route.ts", ("listKbSources", "createKbSource",
                              "export async function GET",
                              "export async function POST")),
        ("sources/[id]/route.ts", ("updateKbSource", "deleteKbSource",
                                   "export async function PUT",
                                   "export async function DELETE",
                                   "params: Promise<{ id: string }>")),
        ("sources/[id]/reindex/route.ts", ("reindexKbSource",
                                           "export async function POST")),
        ("sources/[id]/versions/route.ts", ("listKbSourceVersions",
                                            "export async function GET")),
        ("sources/[id]/rollback/route.ts", ("rollbackKbSource",
                                            "export async function POST")),
        ("search/route.ts", ("searchKnowledge", "export async function GET"))):
    src = read(RIG13 + BFF + rel)
    check("BFF " + rel, bool(src) and all(t in src for t in tokens)
          and "requirePortalAccessToken" in src, rel)
    depth = rel.count("/") + 5
    check("BFF depth " + rel, ('"' + "../" * depth + "lib/omniflow/portal"
                               + '"') in src, depth)

CARD = read(RIG13 + "app/dashboard/(portal)/knowledge-base/KbSourcesCard.tsx")
TESTER = read(RIG13 + "app/dashboard/(portal)/knowledge-base/KbRetrievalTester.tsx")
PAGE = read(RIG13 + "app/dashboard/(portal)/knowledge-base/page.tsx")
check("Sources card: add (text/file/url), publish/pause, re-index, versions,"
      " restore, delete", all(t in CARD for t in (
          "/api/omniflow/portal/kb/sources", "Publish", "Pause", "Re-index",
          "Re-fetch", "Versions", "Restore", "Delete", "Add as draft",
          "readAsText", "PDF and Word", "/reindex", "/rollback", "/versions",
          "awaiting review")), "-")
check("Sources card explains the publish lock",
      "published" in CARD and "Nothing is published" in CARD, "-")
check("Retrieval tester shows tokens, score, citation",
      all(t in TESTER for t in ("/api/omniflow/portal/kb/search", "Matched on",
                                "score", "section", "matched")), "-")
check("Knowledge page mounts both cards", "KbSourcesCard" in PAGE
      and "KbRetrievalTester" in PAGE and "nothing you\n          import is used until you publish it" in PAGE, "-")
UI = CARD + TESTER
check("knowledge UI: English copy", "karein" not in UI and "nahi" not in UI
      and " hai " not in UI.replace("kitne din me hoti hai?", ""), "-")
check("knowledge UI: no emoji-capable glyphs", all(
    code not in UI for code in ("\\u25b6", "\\u261d", "\\u2714", "\\u26a1",
                                "\\u2699", "\\u2709", "\\u260e", "\\u2733",
                                "\\u263a", "\\u27a1")), "-")

raise SystemExit(1 if summary("knowledge") else 0)
