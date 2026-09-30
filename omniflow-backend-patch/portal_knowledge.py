"""Knowledge engine (MASTER-UPGRADE engine 4): document / page ingestion,
deterministic chunking, versioning, health and keyword retrieval for the
AI. D1 (delivered §211): ``portal_kb_semantic`` plugs meaning-based
recall into ``retrieve`` below (hybrid keyword + embeddings, reciprocal
rank fusion) without changing the retrieval contract; keyword-only is
the automatic fallback.

Audit-first (what already existed and stays):

* ``portal_kb_entries`` (portal_kb) - owner-written Q&A answers with
  trigger keywords. They still power the instant auto-reply on the
  ingest path and the assist panel, untouched. Retrieval here searches
  them TOGETHER with the new document chunks so the brain sees one
  ranked knowledge list.
* ``portal_kb_gaps`` (portal_growth) - unanswered questions; unchanged.
* The KB auto-publish LOCK (owner law): nothing ingested here is ever
  used by the AI until the owner publishes the source. New sources start
  as ``draft``; ``published`` sources feed retrieval; ``paused`` sources
  are kept but silent.

Sources (``portal_kb_sources``) are pasted text, uploaded text files
(the browser reads .txt/.md/.csv/.json/.html and posts the text) or web
pages (fetched server-side with an SSRF guard). Every ingest writes a
new version snapshot (``portal_kb_source_versions``, raw text kept so a
version can be rolled back or re-chunked) and replaces the source's
chunks (``portal_kb_chunks``). Retrieval is a single tenant-scoped SQL
candidate fetch (ILIKE on the query tokens) plus a deterministic
BM25-style ranking in Python: term frequency, inverse candidate
frequency, heading/title boosts, phrase bonus and query coverage. Every
hit carries a citation (source title + section) so the brain trace can
show where an answer came from. Fail-soft everywhere.
"""

import html as html_lib
import ipaddress
import logging
import math
import os
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_db
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)

logger = logging.getLogger("omniflow.portal-knowledge")

bp = Blueprint("portal_knowledge", __name__, url_prefix="/api/v1/portal")

SOURCES_TABLE = "portal_kb_sources"
VERSIONS_TABLE = "portal_kb_source_versions"
CHUNKS_TABLE = "portal_kb_chunks"
ENTRIES_TABLE = "portal_kb_entries"

KINDS: Tuple[str, ...] = ("text", "file", "url")
STATUSES: Tuple[str, ...] = ("draft", "published", "paused")


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        value = int(os.environ.get(name, "") or default)
    except Exception:
        value = default
    return max(lo, min(hi, value))


MAX_SOURCES = _env_int("OF_KB_SOURCES_MAX", 50, 1, 1000)
MAX_SOURCE_CHARS = _env_int("OF_KB_SOURCE_CHARS_MAX", 200000, 1000, 2000000)
CHUNK_CHARS = _env_int("OF_KB_CHUNK_CHARS", 700, 200, 4000)
CHUNK_OVERLAP = _env_int("OF_KB_CHUNK_OVERLAP", 80, 0, 400)
MAX_VERSIONS = _env_int("OF_KB_VERSIONS_MAX", 10, 1, 100)
URL_TIMEOUT = _env_int("OF_KB_URL_TIMEOUT", 8, 2, 60)
URL_BYTES_MAX = _env_int("OF_KB_URL_BYTES_MAX", 1500000, 10000, 20000000)
URL_STALE_DAYS = _env_int("OF_KB_URL_STALE_DAYS", 30, 1, 365)
RETRIEVE_CANDIDATES = _env_int("OF_KB_RETRIEVE_CANDIDATES", 200, 10, 2000)
QUERY_TOKENS_MAX = _env_int("OF_KB_QUERY_TOKENS_MAX", 12, 3, 32)
MAX_TITLE_CHARS = 120
MAX_HEADING_CHARS = 160
SNIPPET_CHARS = 400
MIN_CHUNK_CHARS = 20
INSERT_BATCH = 200

_DDL_READY = False

_DDL = """
CREATE TABLE IF NOT EXISTS portal_kb_sources (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'text',
  origin TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  version INT NOT NULL DEFAULT 0,
  chunk_count INT NOT NULL DEFAULT 0,
  char_count INT NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  ingested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_kb_sources_client
  ON portal_kb_sources (client_id, status);
CREATE TABLE IF NOT EXISTS portal_kb_source_versions (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  source_id BIGINT NOT NULL,
  version INT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  chunk_count INT NOT NULL DEFAULT 0,
  char_count INT NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_kb_source_versions_source
  ON portal_kb_source_versions (client_id, source_id, version DESC);
CREATE TABLE IF NOT EXISTS portal_kb_chunks (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  source_id BIGINT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  position INT NOT NULL DEFAULT 0,
  heading TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  char_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_kb_chunks_source
  ON portal_kb_chunks (client_id, source_id, position);
"""


def _ensure_ddl(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    _DDL_READY = True


# ---------------------------------------------------------------------------
# Pure text helpers: normalisation, tokens, HTML, chunking, ranking
# ---------------------------------------------------------------------------

#: Function words that carry no retrieval signal (English + Roman Urdu).
STOPWORDS = frozenset("""
a an the is are am was were be been being of to in on at for and or but if
then than so as by with from into onto about over under up down out off this
that these those it its i me my we our you your he she they them their his
her what which who whom whose when where why how do does did done have has
had having can could will would shall should may might must not no yes ok
okay please plz pls hi hello hey thanks thank
ka ki ke ko ki se me mein main hai hain he hen ho hoon hun hu tha thi the
thay thi ye yeh wo woh is us un in ab aur or ya bhi to per par pe ap aap tum
mera meri mere hamara hamari apna apni apne kya kia kyun kyu kaise kaisa
kaisi kab kahan kon konsa kar karo karen karein kro krna karna kiya raha
rahi rahe hoga hogi honge chahiye chaiye bhai ji han haan nahi nhi na
""".split())

_WORD_RE = re.compile(r"\w+", re.UNICODE)
_BLANK_RE = re.compile(r"\n\s*\n")
_SENTENCE_RE = re.compile(r"(?<=[.!?\u06d4])\s+")
_HEADING_RE = re.compile(r"^(#{1,6}\s+|\d+(\.\d+)*[.)]\s+)")


def normalize(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "").lower()).strip()


def _collapse(text: Any) -> str:
    """Whitespace-collapsed but case-preserving (titles and headings are
    shown to the owner; matching lower-cases separately)."""
    return re.sub(r"\s+", " ", str(text or "")).strip()


def words(text: Any) -> List[str]:
    return [w for w in _WORD_RE.findall(str(text or "").lower())]


def tokenize(text: Any, limit: int = 0, keep_stopwords: bool = False) -> List[str]:
    """Unique retrieval tokens in order of appearance (stop words and
    one-character fragments dropped). ``limit`` keeps the longest tokens
    first so the SQL candidate fetch uses the most selective ones."""
    seen: List[str] = []
    for word in words(text):
        if len(word) < 2:
            continue
        if not keep_stopwords and word in STOPWORDS:
            continue
        if word not in seen:
            seen.append(word)
    if limit and len(seen) > limit:
        seen = sorted(seen, key=lambda w: (-len(w), seen.index(w)))[:limit]
    return seen


def query_tokens(text: Any) -> List[str]:
    """Tokens for a customer question; falls back to stop words when the
    question is made of them only (\"kya hai\") so short questions still
    get a candidate fetch."""
    tokens = tokenize(text, QUERY_TOKENS_MAX)
    if not tokens:
        tokens = tokenize(text, QUERY_TOKENS_MAX, keep_stopwords=True)
    return tokens


_TAG_RE = re.compile(r"<[^>]+>")
_DROP_RE = re.compile(
    r"<(script|style|noscript|svg|head|template|iframe)[^>]*>.*?</\1\s*>",
    re.IGNORECASE | re.DOTALL)
_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_BLOCK_RE = re.compile(
    r"</?(p|div|br|li|ul|ol|tr|td|th|table|section|article|header|footer|"
    r"h[1-6]|blockquote|pre|hr|dd|dt|dl|nav|main|aside|figure|figcaption)"
    r"[^>]*>", re.IGNORECASE)
_HEAD_TAG_RE = re.compile(r"<h([1-6])[^>]*>(.*?)</h\1\s*>",
                          re.IGNORECASE | re.DOTALL)
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)


def html_title(markup: str) -> str:
    match = _TITLE_RE.search(str(markup or ""))
    if not match:
        return ""
    return _collapse(html_lib.unescape(_TAG_RE.sub(" ", match.group(1))))[
        :MAX_TITLE_CHARS]


def html_to_text(markup: str) -> str:
    """Readable text from HTML: scripts/styles/head dropped, headings kept
    as markdown-style lines (so chunking can carry them), block tags become
    paragraph breaks, entities unescaped, whitespace collapsed."""
    text = str(markup or "")
    text = _COMMENT_RE.sub(" ", text)
    text = _DROP_RE.sub(" ", text)
    text = _HEAD_TAG_RE.sub(
        lambda m: "\n\n" + "#" * int(m.group(1)) + " "
        + _TAG_RE.sub(" ", m.group(2)).strip() + "\n\n", text)
    text = _BLOCK_RE.sub("\n\n", text)
    text = _TAG_RE.sub(" ", text)
    text = html_lib.unescape(text)
    text = text.replace("\xa0", " ")
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n")]
    out: List[str] = []
    blank = False
    for line in lines:
        if line:
            out.append(line)
            blank = False
        elif not blank and out:
            out.append("")
            blank = True
    return "\n".join(out).strip()


def clean_text(text: Any) -> str:
    """Normalise pasted / uploaded text: CRLF, tabs, trailing spaces, at
    most one blank line in a row."""
    value = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    value = value.replace("\t", " ").replace("\x00", "")
    lines = [re.sub(r"[ ]+", " ", line).rstrip() for line in value.split("\n")]
    out: List[str] = []
    blank = False
    for line in lines:
        if line.strip():
            out.append(line)
            blank = False
        elif not blank and out:
            out.append("")
            blank = True
    return "\n".join(out).strip()


def _is_heading(block: str) -> bool:
    if "\n" in block or len(block) > 80:
        return False
    if _HEADING_RE.match(block):
        return True
    stripped = block.rstrip(":").strip()
    if block.endswith(":") and len(stripped.split()) <= 8:
        return True
    letters = [c for c in stripped if c.isalpha()]
    return bool(letters) and len(stripped.split()) <= 6 and all(
        c.isupper() for c in letters)


def _heading_text(block: str) -> str:
    return _collapse(_HEADING_RE.sub("", block).rstrip(":"))[:MAX_HEADING_CHARS]


def _split_heading(block: str) -> Tuple[str, str]:
    """(heading, body) for a block whose first line is a heading and the
    rest a paragraph ("Returns\nItems can be returned..."); ("", block)
    otherwise. A first line counts as a heading when it is short, has no
    sentence punctuation and the line after it is longer."""
    if "\n" not in block:
        return "", block
    first, rest = block.split("\n", 1)
    first, rest = first.strip(), rest.strip()
    if not first or not rest:
        return "", block
    if _is_heading(first):
        return _heading_text(first), rest
    if (len(first) <= 60 and len(first.split()) <= 8
            and not first.endswith((".", "!", "?", ",", ";"))
            and len(rest.split("\n", 1)[0]) > len(first)):
        return _heading_text(first), rest
    return "", block


def _split_long(block: str, size: int) -> List[str]:
    """A block bigger than one chunk: pack sentences up to ``size``; a
    single sentence longer than that is cut at its last space."""
    pieces: List[str] = []
    current = ""
    for sentence in _SENTENCE_RE.split(block):
        sentence = sentence.strip()
        if not sentence:
            continue
        parts: List[str] = []
        while len(sentence) > size:
            cut = sentence.rfind(" ", 0, size)
            if cut < size // 2:
                cut = size
            parts.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        if sentence:
            parts.append(sentence)
        for part in parts:
            if current and len(current) + len(part) + 1 > size:
                pieces.append(current)
                current = part
            else:
                current = (current + " " + part).strip()
    if current:
        pieces.append(current)
    return pieces


def _overlap_tail(text: str, overlap: int) -> str:
    if overlap <= 0 or len(text) <= overlap:
        return ""
    tail = text[-overlap:]
    cut = tail.find(" ")
    return tail[cut + 1:].strip() if cut >= 0 else tail.strip()


def chunk_text(text: str, size: int = 0,
               overlap: Optional[int] = None) -> List[Dict[str, Any]]:
    """Deterministic, heading-aware chunks: paragraphs are packed up to
    ``size`` characters, headings label the chunks that follow them, over-
    long paragraphs split at sentence boundaries, and each chunk starts
    with a short overlap from the previous one so context is not cut."""
    size = size or CHUNK_CHARS
    overlap = CHUNK_OVERLAP if overlap is None else max(0, overlap)
    overlap = min(overlap, size // 3)
    blocks = [b.strip() for b in _BLANK_RE.split(clean_text(text)) if b.strip()]
    chunks: List[Dict[str, Any]] = []
    heading = ""
    current = ""
    current_heading = ""
    previous_text = ""

    def flush() -> None:
        nonlocal current, previous_text
        body = current.strip()
        if body:
            chunks.append({"position": len(chunks),
                           "heading": current_heading, "content": body})
            previous_text = body
        current = ""

    for block in blocks:
        if _is_heading(block):
            flush()
            previous_text = ""  # no overlap across sections
            heading = _heading_text(block)
            continue
        inline_heading, block = _split_heading(block)
        if inline_heading:
            flush()
            previous_text = ""
            heading = inline_heading
        # long paragraphs are packed a little below ``size`` so the overlap
        # carried in from the previous chunk still fits
        pieces = [block] if len(block) <= size else _split_long(
            block, max(size // 2, size - overlap))
        for piece in pieces:
            if current and len(current) + len(piece) + 2 > size:
                flush()
            if not current:
                current_heading = heading
                tail = _overlap_tail(previous_text, overlap)
                current = (tail + " " + piece).strip() if tail and len(
                    tail) + len(piece) + 1 <= size else piece
            else:
                current = current + "\n\n" + piece
    flush()
    if len(chunks) > 1:
        chunks = [c for c in chunks if len(c["content"]) >= MIN_CHUNK_CHARS]
        for index, chunk in enumerate(chunks):
            chunk["position"] = index
    return chunks


def _matches(word: str, token: str) -> bool:
    """Exact match, or a prefix match once the token is long enough to be
    a stem (return -> returned/returns, deliver -> delivery). Short Roman
    Urdu words (din, kab) stay exact."""
    if word == token:
        return True
    if len(token) >= 4 and word.startswith(token):
        return True
    return len(word) >= 4 and token.startswith(word) and len(token) - len(word) <= 3


def _count(token: str, word_list: List[str]) -> int:
    return sum(1 for w in word_list if _matches(w, token))


def score_candidates(tokens: List[str], candidates: List[Dict[str, Any]],
                     n: int) -> List[Dict[str, Any]]:
    """BM25-style ranking without an index: per-token tf saturation,
    inverse candidate frequency, title/heading boost, adjacent-token phrase
    bonus and query coverage. Deterministic; ties break on shorter text
    then id."""
    if not tokens or not candidates:
        return []
    prepared = []
    for row in candidates:
        title_words = words(row.get("title"))
        body_words = words(row.get("content")) + words(row.get("extra"))
        title_hits = {t: _count(t, title_words) for t in tokens}
        body_hits = {t: _count(t, body_words) for t in tokens}
        prepared.append((row, title_words, body_words, title_hits, body_hits))
    total = len(prepared)
    df = {t: sum(1 for p in prepared if p[3][t] or p[4][t]) for t in tokens}
    idf = {t: math.log(1.0 + total / (1.0 + df[t])) + 0.1 for t in tokens}
    ranked = []
    for row, title_words, body_words, title_hits, body_hits in prepared:
        matched: List[str] = []
        score = 0.0
        for token in tokens:
            tf = body_hits[token]
            in_title = title_hits[token] > 0
            if not tf and not in_title:
                continue
            matched.append(token)
            weight = (1.0 + math.log(1.0 + tf)) if tf else 0.6
            if in_title:
                weight += 1.5
            score += weight * idf[token]
        if not matched:
            continue
        if len(tokens) > 1:
            text_words = title_words + body_words
            for a, b in zip(tokens, tokens[1:]):
                for i in range(len(text_words) - 1):
                    if _matches(text_words[i], a) and _matches(text_words[i + 1], b):
                        score += 1.0
                        break
        coverage = len(matched) / float(len(tokens))
        score *= 0.5 + 0.5 * coverage
        ranked.append((round(score, 4), matched, row))
    ranked.sort(key=lambda item: (-item[0], len(str(item[2].get("content") or "")),
                                  int(item[2].get("id") or 0)))
    hits = []
    for score, matched, row in ranked[:max(1, n)]:
        content = str(row.get("content") or "")
        hits.append({
            "kind": str(row.get("kind") or "entry"),
            "id": int(row.get("id") or 0),
            "title": str(row.get("title") or ""),
            "content": content[:SNIPPET_CHARS],
            "source_id": int(row.get("source_id") or 0),
            "source": str(row.get("source_title") or ""),
            "position": int(row.get("position") or 0),
            "score": score,
            "matched": matched,
        })
    return hits


# ---------------------------------------------------------------------------
# URL fetch with SSRF guard
# ---------------------------------------------------------------------------

def assert_public_url(url: str, resolver=None) -> Tuple[str, str]:
    """Validate an owner-supplied URL: http(s) only, a real host name, no
    credentials, and every resolved address public (no loopback, private,
    link-local, multicast or reserved ranges). Returns (scheme, host).
    Raises ValueError with an owner-readable message."""
    parsed = urllib.parse.urlsplit(str(url or "").strip())
    if parsed.scheme not in ("http", "https"):
        raise ValueError("Only http and https links are supported.")
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if not host or parsed.username or parsed.password:
        raise ValueError("That link is not a valid web address.")
    if host == "localhost" or host.endswith(".localhost") or host.endswith(
            ".local") or host.endswith(".internal"):
        raise ValueError("Internal addresses cannot be fetched.")
    resolve = resolver or socket.getaddrinfo
    try:
        infos = resolve(host, parsed.port or (443 if parsed.scheme == "https"
                                                else 80))
    except Exception:
        raise ValueError("That web address could not be resolved.")
    addresses = []
    for info in infos or []:
        try:
            addresses.append(ipaddress.ip_address(info[4][0]))
        except Exception:
            continue
    if not addresses:
        raise ValueError("That web address could not be resolved.")
    for address in addresses:
        if (address.is_private or address.is_loopback or address.is_link_local
                or address.is_multicast or address.is_reserved
                or address.is_unspecified):
            raise ValueError("Internal addresses cannot be fetched.")
    return parsed.scheme, host


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-validates every redirect target (a public page may not bounce
    the fetch onto an internal address)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        assert_public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_url(url: str) -> Tuple[str, str]:
    """Download a public page and return (text, title). Raises ValueError
    with an owner-readable message on any problem."""
    assert_public_url(url)
    req = urllib.request.Request(str(url).strip(), method="GET")
    req.add_header("Accept", "text/html, text/plain;q=0.9, */*;q=0.5")
    req.add_header("User-Agent", "OmniFlow-Knowledge/1.0 (+knowledge sources)")
    opener = urllib.request.build_opener(_SafeRedirectHandler())
    try:
        with opener.open(req, timeout=URL_TIMEOUT) as resp:
            content_type = str(resp.headers.get("Content-Type") or "").lower()
            raw = resp.read(URL_BYTES_MAX + 1)
    except urllib.error.HTTPError as error:
        raise ValueError("The page answered with HTTP " + str(error.code) + ".")
    except ValueError:
        raise
    except Exception:
        raise ValueError("The page could not be fetched (timeout or "
                         "connection error).")
    if len(raw) > URL_BYTES_MAX:
        raise ValueError("The page is too large to import (limit "
                         + str(URL_BYTES_MAX // 1000) + " KB).")
    kind = content_type.split(";")[0].strip()
    if kind and not (kind.startswith("text/") or kind in (
            "application/json", "application/xhtml+xml", "application/xml")):
        raise ValueError("Only web pages and text files can be imported "
                         "from a link (got " + kind + ").")
    charset = "utf-8"
    match = re.search(r"charset=([\w-]+)", content_type)
    if match:
        charset = match.group(1)
    try:
        body = raw.decode(charset, "replace")
    except Exception:
        body = raw.decode("utf-8", "replace")
    if kind in ("text/html", "application/xhtml+xml") or "<html" in body[:2000].lower():
        return html_to_text(body), html_title(body)
    return clean_text(body), ""


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

SOURCE_COLS = ("id, client_id, title, kind, origin, status, version, chunk_count,"
               " char_count, last_error, ingested_at, created_at, updated_at")


def _iso(value: Any) -> Optional[str]:
    if value is None or value == "":
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _is_stale(row: Dict[str, Any]) -> bool:
    if str(row.get("kind") or "") != "url":
        return False
    stamp = row.get("ingested_at")
    if not isinstance(stamp, datetime):
        return False
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp < datetime.now(timezone.utc) - timedelta(days=URL_STALE_DAYS)


def source_public(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": int(row.get("id") or 0),
        "title": str(row.get("title") or ""),
        "kind": str(row.get("kind") or "text"),
        "origin": str(row.get("origin") or ""),
        "status": str(row.get("status") or "draft"),
        "version": int(row.get("version") or 0),
        "chunk_count": int(row.get("chunk_count") or 0),
        "char_count": int(row.get("char_count") or 0),
        "last_error": str(row.get("last_error") or ""),
        "stale": _is_stale(row),
        "ingested_at": _iso(row.get("ingested_at")),
        "created_at": _iso(row.get("created_at")),
        "updated_at": _iso(row.get("updated_at")),
    }


def get_source(cur, client_id: int, source_id: int) -> Optional[Dict[str, Any]]:
    cur.execute(
        "SELECT " + SOURCE_COLS + " FROM " + portal_db._q(SOURCES_TABLE) +
        " WHERE id = %s AND client_id = %s",
        (int(source_id), client_id),
    )
    rows = portal_db.rows(cur)
    return rows[0] if rows else None


def list_sources(cur, client_id: int) -> List[Dict[str, Any]]:
    cur.execute(
        "SELECT " + SOURCE_COLS + " FROM " + portal_db._q(SOURCES_TABLE) +
        " WHERE client_id = %s ORDER BY updated_at DESC, id DESC LIMIT %s",
        (client_id, MAX_SOURCES + 50),
    )
    return portal_db.rows(cur)


def health(sources: List[Dict[str, Any]]) -> Dict[str, Any]:
    out = {"sources": len(sources), "published": 0, "drafts": 0, "paused": 0,
           "chunks": 0, "errors": 0, "stale": 0}
    for row in sources:
        status = str(row.get("status") or "draft")
        if status == "published":
            out["published"] += 1
            out["chunks"] += int(row.get("chunk_count") or 0)
        elif status == "paused":
            out["paused"] += 1
        else:
            out["drafts"] += 1
        if str(row.get("last_error") or ""):
            out["errors"] += 1
        if _is_stale(row):
            out["stale"] += 1
    return out


def ingest(cur, client_id: int, source: Dict[str, Any], text: str,
           note: str = "", actor_user_id: Optional[int] = None) -> Dict[str, Any]:
    """Chunk ``text`` for ``source``: replace its chunks, snapshot the raw
    text as the next version, prune old versions, refresh the counters and
    audit. Returns the updated source row. Never publishes."""
    source_id = int(source.get("id") or 0)
    content = clean_text(text)[:MAX_SOURCE_CHARS]
    chunks = chunk_text(content)
    version = int(source.get("version") or 0) + 1
    cur.execute(
        "DELETE FROM " + portal_db._q(CHUNKS_TABLE) +
        " WHERE client_id = %s AND source_id = %s",
        (client_id, source_id),
    )
    for start in range(0, len(chunks), INSERT_BATCH):
        batch = chunks[start:start + INSERT_BATCH]
        values = ", ".join(["(%s, %s, %s, %s, %s, %s, %s)"] * len(batch))
        params: List[Any] = []
        for chunk in batch:
            params.extend([client_id, source_id, version, chunk["position"],
                           chunk["heading"], chunk["content"],
                           len(chunk["content"])])
        cur.execute(
            "INSERT INTO " + portal_db._q(CHUNKS_TABLE) +
            " (client_id, source_id, version, position, heading, content,"
            " char_count) VALUES " + values,
            tuple(params),
        )
    cur.execute(
        "INSERT INTO " + portal_db._q(VERSIONS_TABLE) +
        " (client_id, source_id, version, content, chunk_count, char_count,"
        " note) VALUES (%s, %s, %s, %s, %s, %s, %s)",
        (client_id, source_id, version, content, len(chunks), len(content),
         str(note or "")[:200]),
    )
    cur.execute(
        "DELETE FROM " + portal_db._q(VERSIONS_TABLE) +
        " WHERE client_id = %s AND source_id = %s AND version <= %s",
        (client_id, source_id, version - MAX_VERSIONS),
    )
    cur.execute(
        "UPDATE " + portal_db._q(SOURCES_TABLE) +
        " SET version = %s, chunk_count = %s, char_count = %s, last_error = '',"
        " ingested_at = NOW(), updated_at = NOW()"
        " WHERE id = %s AND client_id = %s RETURNING " + SOURCE_COLS,
        (version, len(chunks), len(content), source_id, client_id),
    )
    rows = portal_db.rows(cur)
    updated = rows[0] if rows else dict(source, version=version,
                                        chunk_count=len(chunks),
                                        char_count=len(content), last_error="")
    portal_db.log_action(
        cur, client_id, "kb.source_ingested", "customer_user", actor_user_id,
        None, "Indexed '" + str(updated.get("title") or "")[:60] + "' v"
        + str(version) + " (" + str(len(chunks)) + " sections, "
        + str(len(content)) + " chars)" + (" - " + note if note else ""),
    )
    return updated


def record_error(cur, client_id: int, source_id: int, message: str) -> None:
    cur.execute(
        "UPDATE " + portal_db._q(SOURCES_TABLE) +
        " SET last_error = %s, updated_at = NOW()"
        " WHERE id = %s AND client_id = %s",
        (str(message or "")[:300], int(source_id), client_id),
    )


def version_content(cur, client_id: int, source_id: int,
                    version: Optional[int] = None) -> Optional[Dict[str, Any]]:
    where = " AND version = %s" if version else ""
    params: Tuple[Any, ...] = (client_id, int(source_id)) + (
        (int(version),) if version else ())
    cur.execute(
        "SELECT version, content, chunk_count, char_count, note, created_at FROM "
        + portal_db._q(VERSIONS_TABLE) +
        " WHERE client_id = %s AND source_id = %s" + where +
        " ORDER BY version DESC LIMIT 1",
        params,
    )
    rows = portal_db.rows(cur)
    return rows[0] if rows else None


def list_versions(cur, client_id: int, source_id: int) -> List[Dict[str, Any]]:
    cur.execute(
        "SELECT version, chunk_count, char_count, note, created_at FROM "
        + portal_db._q(VERSIONS_TABLE) +
        " WHERE client_id = %s AND source_id = %s ORDER BY version DESC LIMIT %s",
        (client_id, int(source_id), MAX_VERSIONS),
    )
    return [{"version": int(r.get("version") or 0),
             "chunk_count": int(r.get("chunk_count") or 0),
             "char_count": int(r.get("char_count") or 0),
             "note": str(r.get("note") or ""),
             "created_at": _iso(r.get("created_at"))}
            for r in portal_db.rows(cur)]


def retrieve(cur, client_id: int, query: str, n: int = 5,
             include_entries: bool = True) -> List[Dict[str, Any]]:
    """The one knowledge read for the brain and the owner's tester: active
    Q&A entries + chunks of PUBLISHED sources, ranked deterministically.

    Keyword ranking first (BM25-style over the query tokens); when the
    semantic index is active and populated, meaning-based hits are fused
    in (portal_kb_semantic.hybrid). Every hit carries ``via``
    (keyword|semantic|both) and ``semantic`` (similarity or None).
    Blank query -> [] without touching the DB."""
    if not str(query or "").strip():
        return []
    tokens = query_tokens(query)
    keyword = _keyword_hits(cur, client_id, tokens,
                            max(n, SEMANTIC_KEYWORD_POOL), include_entries)
    try:
        import portal_kb_semantic

        fused = portal_kb_semantic.hybrid(cur, client_id, query, keyword, n,
                                          include_entries, SNIPPET_CHARS)
    except Exception as error:  # fail-soft: keyword ranking stands
        logger.info("semantic retrieval skipped: %s", error)
        fused = None
    if fused is not None:
        return fused
    out = []
    for hit in keyword[:max(1, n)]:
        hit["via"] = "keyword"
        hit["semantic"] = None
        out.append(hit)
    return out


SEMANTIC_KEYWORD_POOL = _env_int("OF_KB_HYBRID_KEYWORD_POOL", 12, 1, 100)


def _keyword_hits(cur, client_id: int, tokens: List[str], n: int,
                  include_entries: bool) -> List[Dict[str, Any]]:
    """Keyword candidates (ILIKE on the tokens) ranked by score_candidates.
    No tokens -> [] without touching the DB."""
    if not tokens:
        return []
    patterns = ["%" + t + "%" for t in tokens]
    limit = RETRIEVE_CANDIDATES
    parts: List[str] = []
    params: List[Any] = []
    if include_entries:
        parts.append(
            "SELECT 'entry' AS kind, e.id AS id, e.title AS title,"
            " e.content AS content, e.keywords AS extra, 0 AS source_id,"
            " '' AS source_title, 0 AS position FROM "
            + portal_db._q(ENTRIES_TABLE) + " e"
            " WHERE e.client_id = %s AND e.is_active IS TRUE"
            " AND (e.title ILIKE ANY(%s) OR e.keywords ILIKE ANY(%s)"
            " OR e.content ILIKE ANY(%s))")
        params.extend([client_id, patterns, patterns, patterns])
    parts.append(
        "SELECT 'chunk' AS kind, c.id AS id, c.heading AS title,"
        " c.content AS content, '' AS extra, c.source_id AS source_id,"
        " s.title AS source_title, c.position AS position FROM "
        + portal_db._q(CHUNKS_TABLE) + " c JOIN " + portal_db._q(SOURCES_TABLE) +
        " s ON s.id = c.source_id AND s.client_id = c.client_id"
        " WHERE c.client_id = %s AND s.status = 'published'"
        " AND (c.heading ILIKE ANY(%s) OR c.content ILIKE ANY(%s))")
    params.extend([client_id, patterns, patterns])
    params.append(limit)
    cur.execute(" UNION ALL ".join(parts) + " LIMIT %s", tuple(params))
    return score_candidates(tokens, portal_db.rows(cur), n)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

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
    return principal, None


def _human_or_error():
    principal, error = _principal_or_error()
    if error:
        return None, error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return None, forbidden
    return principal, None


def _bad(message: str, code: str = "bad_request", status: int = 400):
    return jsonify({"error": {"code": code, "message": message}}), status


def _limits() -> Dict[str, Any]:
    return {"max_sources": MAX_SOURCES, "max_chars": MAX_SOURCE_CHARS,
            "chunk_chars": CHUNK_CHARS, "max_versions": MAX_VERSIONS,
            "kinds": list(KINDS)}


def _title_from(text: str, fallback: str) -> str:
    for line in str(text or "").split("\n"):
        line = _HEADING_RE.sub("", line).strip().strip("#").strip()
        if line:
            return line[:MAX_TITLE_CHARS]
    return fallback[:MAX_TITLE_CHARS]


@bp.get("/kb/sources")
def get_sources():
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            rows = list_sources(cur, client_id)
        conn.commit()
    finally:
        conn.close()
    return jsonify({"sources": [source_public(r) for r in rows],
                    "health": health(rows), "limits": _limits()}), 200


@bp.post("/kb/sources")
def post_source():
    """Create a source and index it right away. It stays a DRAFT until the
    owner publishes it (KB auto-publish lock)."""
    principal, error = _human_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True) or {}
    kind = str(payload.get("kind") or "text").strip().lower()
    if kind not in KINDS:
        return _bad("kind must be one of text, file, url.")
    title = str(payload.get("title") or "").strip()[:MAX_TITLE_CHARS]
    origin = ""
    if kind == "url":
        url = str(payload.get("url") or "").strip()[:2000]
        if not url:
            return _bad("A web address is required.")
        try:
            text, page_title = fetch_url(url)
        except ValueError as problem:
            return _bad(str(problem), "fetch_failed")
        origin = url
        title = title or page_title or _title_from(text, url)
    else:
        text = clean_text(payload.get("text"))
        origin = str(payload.get("filename") or "").strip()[:200] if kind == "file" else ""
        title = title or _title_from(text, origin or "Pasted text")
    if len(text) < MIN_CHUNK_CHARS:
        return _bad("There is not enough text to index (at least "
                    + str(MIN_CHUNK_CHARS) + " characters).")
    if len(text) > MAX_SOURCE_CHARS:
        return _bad("That source is too long (limit "
                    + str(MAX_SOURCE_CHARS) + " characters). Split it into"
                    " smaller documents.", "too_long")
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "SELECT COUNT(*) AS n FROM " + portal_db._q(SOURCES_TABLE) +
                " WHERE client_id = %s",
                (client_id,),
            )
            rows = portal_db.rows(cur)
            if int((rows[0] if rows else {}).get("n") or 0) >= MAX_SOURCES:
                conn.rollback()
                return _bad("This workspace already has the maximum of "
                            + str(MAX_SOURCES) + " sources.", "limit", 409)
            cur.execute(
                "INSERT INTO " + portal_db._q(SOURCES_TABLE) +
                " (client_id, title, kind, origin, status)"
                " VALUES (%s, %s, %s, %s, 'draft') RETURNING " + SOURCE_COLS,
                (client_id, title, kind, origin),
            )
            rows = portal_db.rows(cur)
            source = rows[0] if rows else {"id": 0, "title": title,
                                           "kind": kind, "version": 0}
            source = ingest(cur, client_id, source, text, "created",
                            principal.get("user_id"))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "source": source_public(source)}), 200


@bp.put("/kb/sources/<int:source_id>")
def put_source(source_id: int):
    """Owner review: publish / pause / back to draft, rename."""
    principal, error = _human_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True) or {}
    status = str(payload.get("status") or "").strip().lower()
    title = str(payload.get("title") or "").strip()[:MAX_TITLE_CHARS]
    if status and status not in STATUSES:
        return _bad("status must be one of draft, published, paused.")
    if not status and not title:
        return _bad("Nothing to update.")
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            source = get_source(cur, client_id, source_id)
            if source is None:
                conn.rollback()
                return _bad("No such source.", "not_found", 404)
            if status == "published" and int(source.get("chunk_count") or 0) == 0:
                conn.rollback()
                return _bad("This source has no indexed text yet. Re-index it"
                            " before publishing.", "empty_source")
            sets = ["updated_at = NOW()"]
            params: List[Any] = []
            if status:
                sets.append("status = %s")
                params.append(status)
            if title:
                sets.append("title = %s")
                params.append(title)
            params.extend([int(source_id), client_id])
            cur.execute(
                "UPDATE " + portal_db._q(SOURCES_TABLE) + " SET " +
                ", ".join(sets) + " WHERE id = %s AND client_id = %s RETURNING "
                + SOURCE_COLS,
                tuple(params),
            )
            rows = portal_db.rows(cur)
            updated = rows[0] if rows else dict(source)
            if status and status != str(source.get("status") or ""):
                portal_db.log_action(
                    cur, client_id, "kb.source_" + status, "customer_user",
                    principal.get("user_id"), None,
                    ("Published" if status == "published" else
                     "Paused" if status == "paused" else "Unpublished")
                    + " source '" + str(updated.get("title") or "")[:60] + "'",
                )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "source": source_public(updated)}), 200


@bp.delete("/kb/sources/<int:source_id>")
def delete_source(source_id: int):
    principal, error = _human_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            source = get_source(cur, client_id, source_id)
            if source is None:
                conn.rollback()
                return _bad("No such source.", "not_found", 404)
            cur.execute(
                "DELETE FROM " + portal_db._q(CHUNKS_TABLE) +
                " WHERE client_id = %s AND source_id = %s",
                (client_id, int(source_id)),
            )
            cur.execute(
                "DELETE FROM " + portal_db._q(VERSIONS_TABLE) +
                " WHERE client_id = %s AND source_id = %s",
                (client_id, int(source_id)),
            )
            cur.execute(
                "DELETE FROM " + portal_db._q(SOURCES_TABLE) +
                " WHERE id = %s AND client_id = %s",
                (int(source_id), client_id),
            )
            portal_db.log_action(
                cur, client_id, "kb.source_deleted", "customer_user",
                principal.get("user_id"), None,
                "Deleted source '" + str(source.get("title") or "")[:60] + "'",
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True}), 200


@bp.post("/kb/sources/<int:source_id>/reindex")
def reindex_source(source_id: int):
    """Re-fetch a web page, or re-chunk pasted/uploaded text (new text in
    the body, else the latest stored version). Publication state is kept."""
    principal, error = _human_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True) or {}
    new_text = clean_text(payload.get("text"))
    if new_text and len(new_text) > MAX_SOURCE_CHARS:
        return _bad("That text is too long (limit " + str(MAX_SOURCE_CHARS)
                    + " characters).", "too_long")
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            source = get_source(cur, client_id, source_id)
            if source is None:
                conn.rollback()
                return _bad("No such source.", "not_found", 404)
            note = "re-indexed"
            if str(source.get("kind") or "") == "url":
                try:
                    text, _title = fetch_url(str(source.get("origin") or ""))
                except ValueError as problem:
                    record_error(cur, client_id, source_id, str(problem))
                    conn.commit()
                    return _bad(str(problem), "fetch_failed")
                note = "re-fetched"
            elif new_text:
                text = new_text
                note = "text replaced"
            else:
                latest = version_content(cur, client_id, source_id)
                text = str((latest or {}).get("content") or "")
                if len(text) < MIN_CHUNK_CHARS:
                    conn.rollback()
                    return _bad("No stored text to re-index. Paste the text"
                                " again.", "empty_source")
            if len(text) < MIN_CHUNK_CHARS:
                record_error(cur, client_id, source_id,
                             "The page returned no readable text.")
                conn.commit()
                return _bad("The page returned no readable text.",
                            "fetch_failed")
            source = ingest(cur, client_id, source, text, note,
                            principal.get("user_id"))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "source": source_public(source)}), 200


@bp.get("/kb/sources/<int:source_id>/versions")
def get_versions(source_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            source = get_source(cur, client_id, source_id)
            if source is None:
                conn.rollback()
                return _bad("No such source.", "not_found", 404)
            versions = list_versions(cur, client_id, source_id)
        conn.commit()
    finally:
        conn.close()
    return jsonify({"source": source_public(source), "versions": versions}), 200


@bp.post("/kb/sources/<int:source_id>/rollback")
def rollback_source(source_id: int):
    """Re-index from an earlier version's stored text (creates a new
    version, so history is never rewritten)."""
    principal, error = _human_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True) or {}
    try:
        version = int(payload.get("version") or 0)
    except Exception:
        version = 0
    if version <= 0:
        return _bad("version is required.")
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            source = get_source(cur, client_id, source_id)
            if source is None:
                conn.rollback()
                return _bad("No such source.", "not_found", 404)
            snapshot = version_content(cur, client_id, source_id, version)
            if snapshot is None or len(str(snapshot.get("content") or "")) < MIN_CHUNK_CHARS:
                conn.rollback()
                return _bad("That version is no longer stored.", "not_found", 404)
            source = ingest(cur, client_id, source, str(snapshot.get("content")),
                            "rolled back to v" + str(version),
                            principal.get("user_id"))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "source": source_public(source)}), 200


@bp.get("/kb/search")
def search_knowledge():
    """Owner tester: exactly what the AI would retrieve for a question."""
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    query = str(request.args.get("q") or "").strip()[:300]
    if not query:
        return _bad("q is required.")
    try:
        n = int(request.args.get("n") or 5)
    except Exception:
        n = 5
    n = max(1, min(10, n))
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            hits = retrieve(cur, client_id, query, n)
        conn.commit()
    finally:
        conn.close()
    return jsonify({"query": query, "tokens": query_tokens(query),
                    "hits": hits}), 200


@bp.after_request
def _kb_semantic_after(response):
    """D1: a successful owner write schedules a semantic-index sync."""
    try:
        import portal_kb_semantic

        return portal_kb_semantic.kick_after_mutation(response)
    except Exception:
        return response

