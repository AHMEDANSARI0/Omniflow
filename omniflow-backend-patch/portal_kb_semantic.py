"""Knowledge semantic index (owner decision D1 - delivered in §211).

Audit-first: this is NOT a second knowledge engine. ``portal_knowledge``
stays the one ingestion/versioning/retrieval owner and
``portal_knowledge.retrieve`` stays the one read the brain and the owner's
tester call. This module only adds meaning-based recall to that read:

* ``portal_kb_embeddings`` - one vector per retrievable item: chunks of
  PUBLISHED sources and ACTIVE Q&A entries. Vectors are L2-normalised
  REAL[] columns in the existing Postgres (no pgvector, no new service),
  keyed by (client_id, kind, ref_id) and a content hash, so re-indexing a
  source with unchanged text or rolling back a version reuses the stored
  vector instead of paying for it again.
* ``sync`` - embeds whatever is missing or changed (budgeted, batched),
  reuses vectors by content hash and drops vectors whose item was deleted,
  unpublished or deactivated. Runs on a daemon thread after owner edits,
  from the connector tick (throttled) and from the "Build index" button.
* ``hybrid`` - called from ``portal_knowledge.retrieve``: embeds the
  question once (small LRU cache), scores it against the tenant's vectors
  (in-process cache, TTL) and fuses the result with the existing keyword
  ranking by reciprocal rank fusion. Hits keep the exact retrieval
  contract plus ``via`` (keyword|semantic|both) and ``semantic``.

Laws kept:
* KB auto-publish LOCK - semantic hits are re-read through the same
  "published source / active entry" filters as keyword hits, so a paused
  or draft source never reaches the AI even if its vector still exists.
* Fail-soft - any provider/config/DB problem returns ``None`` and the
  caller falls back to pure keyword retrieval. A failing provider trips a
  short cooldown so the reply path never waits on a dead endpoint twice.
* Costs go through ``portal_llm`` (platform AI gate + usage ledger) under
  the ``kb_embed`` feature, attributed to the persona of the calling scope.
* Customer text is only embedded (never executed or used as a prompt).
"""

import hashlib
import logging
import os
import threading
import time
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_db
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)

logger = logging.getLogger("omniflow.portal-kb-semantic")

bp = Blueprint("portal_kb_semantic", __name__, url_prefix="/api/v1/portal")

EMB_TABLE = "portal_kb_embeddings"
STATE_TABLE = "portal_kb_semantic_state"
CHUNKS_TABLE = "portal_kb_chunks"
SOURCES_TABLE = "portal_kb_sources"
ENTRIES_TABLE = "portal_kb_entries"
FEATURE = "kb_embed"


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        value = int(os.environ.get(name, "") or default)
    except Exception:
        value = default
    return max(lo, min(hi, value))


def _env_float(name: str, default: float, lo: float, hi: float) -> float:
    try:
        value = float(os.environ.get(name, "") or default)
    except Exception:
        value = default
    return max(lo, min(hi, value))


SYNC_BUDGET = _env_int("OF_KB_EMBED_SYNC_MAX", 400, 1, 20000)
SCAN_MAX = _env_int("OF_KB_EMBED_SCAN_MAX", 5000, 50, 50000)
ITEMS_MAX = _env_int("OF_KB_EMBED_ITEMS_MAX", 20000, 50, 200000)
CACHE_SECONDS = _env_int("OF_KB_EMBED_CACHE_SECONDS", 60, 0, 3600)
TICK_SECONDS = _env_int("OF_KB_EMBED_TICK_SECONDS", 600, 30, 86400)
COOLDOWN_SECONDS = _env_int("OF_KB_EMBED_COOLDOWN_SECONDS", 300, 10, 86400)
QUERY_TIMEOUT = _env_float("OF_KB_EMBED_QUERY_TIMEOUT", 3.0, 0.5, 30.0)
QUERY_CACHE_MAX = _env_int("OF_KB_EMBED_QUERY_CACHE", 256, 0, 10000)
REL_WINDOW = _env_float("OF_KB_EMBED_REL_WINDOW", 0.12, 0.0, 1.0)
RRF_K = _env_int("OF_KB_EMBED_RRF_K", 60, 1, 1000)
POOL = _env_int("OF_KB_EMBED_POOL", 12, 3, 100)
TEXT_CHARS = _env_int("OF_EMBED_TEXT_CHARS", 2000, 200, 20000)

_DDL_READY = False

_DDL = """
CREATE TABLE IF NOT EXISTS portal_kb_embeddings (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  kind TEXT NOT NULL,
  ref_id BIGINT NOT NULL,
  source_id BIGINT NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  dims INT NOT NULL DEFAULT 0,
  vector REAL[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, kind, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_portal_kb_embeddings_hash
  ON portal_kb_embeddings (client_id, model, dims, content_hash);
CREATE TABLE IF NOT EXISTS portal_kb_semantic_state (
  client_id BIGINT PRIMARY KEY,
  last_sync_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  last_embedded INT NOT NULL DEFAULT 0,
  last_reused INT NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  dims INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""


def _ensure_ddl(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    _DDL_READY = True


# ---------------------------------------------------------------------------
# Config, text, hashing (pure)
# ---------------------------------------------------------------------------

def config() -> Dict[str, Any]:
    """Effective embedding config; inactive on any error."""
    try:
        import portal_llm
        return portal_llm.embed_runtime()
    except Exception:
        return {"active": False, "reason": "no_key", "model": "",
                "dimensions": 0, "min_similarity": 0.3, "mode": "on",
                "key_source": "none", "base_url": ""}


def item_text(row: Dict[str, Any]) -> str:
    """The text a vector represents. Chunks carry their document + section
    so a bare paragraph still knows what it is about."""
    kind = str(row.get("kind") or "")
    title = str(row.get("title") or "").strip()
    content = str(row.get("content") or "").strip()
    if kind == "chunk":
        source = str(row.get("source_title") or "").strip()
        head = " > ".join(p for p in (source, title) if p)
        text = (head + "\n" + content) if head else content
    else:
        extra = str(row.get("extra") or "").strip()
        text = "\n".join(p for p in (title, content, extra) if p)
    return text[:TEXT_CHARS]


def content_hash(text: str) -> str:
    return hashlib.sha1(str(text or "").encode("utf-8")).hexdigest()


def dot(a: List[float], b: List[float]) -> float:
    if len(a) != len(b):
        return -1.0
    return sum(x * y for x, y in zip(a, b))


# ---------------------------------------------------------------------------
# Provider health (cooldown) + caches
# ---------------------------------------------------------------------------

_LOCK = threading.Lock()
_DOWN_UNTIL = {"t": 0.0, "error": ""}
_QUERY_CACHE: "OrderedDict[Tuple[str, int, str], List[float]]" = OrderedDict()
_VEC_CACHE: Dict[int, Dict[str, Any]] = {}
_RUNNING: set = set()
_LAST_KICK: Dict[int, float] = {}


def _provider_down() -> bool:
    return time.monotonic() < _DOWN_UNTIL["t"]


def _trip(error: str) -> None:
    _DOWN_UNTIL["t"] = time.monotonic() + COOLDOWN_SECONDS
    _DOWN_UNTIL["error"] = str(error or "")[:200]


def _heal() -> None:
    _DOWN_UNTIL["t"] = 0.0
    _DOWN_UNTIL["error"] = ""


def invalidate(client_id: int) -> None:
    with _LOCK:
        _VEC_CACHE.pop(int(client_id), None)


def reset_caches() -> None:
    """Tests / admin: forget every in-process cache and cooldown."""
    with _LOCK:
        _VEC_CACHE.clear()
        _QUERY_CACHE.clear()
        _RUNNING.clear()
        _LAST_KICK.clear()
    _heal()


def _embed(texts: List[str], cfg: Dict[str, Any], client_id: int, cur,
           timeout: Optional[float] = None
           ) -> Tuple[Optional[List[List[float]]], str]:
    import portal_llm

    try:
        _feature, _cid, _cur, agent_id = portal_llm.current_scope()
    except Exception:
        agent_id = 0
    with portal_llm.usage_scope(FEATURE, client_id, cur, agent_id=agent_id):
        return portal_llm.embed_texts(texts, timeout=timeout, runtime=cfg)


def query_vector(cur, client_id: int, text: str,
                 cfg: Dict[str, Any]) -> Optional[List[float]]:
    """One question -> one vector (cached per model/dims/text)."""
    clean = " ".join(str(text or "").split())[:TEXT_CHARS]
    if not clean:
        return None
    key = (str(cfg.get("model") or ""), int(cfg.get("dimensions") or 0),
           clean.lower())
    with _LOCK:
        if key in _QUERY_CACHE:
            _QUERY_CACHE.move_to_end(key)
            return _QUERY_CACHE[key]
    if _provider_down():
        return None
    vectors, error = _embed([clean], cfg, client_id, cur, QUERY_TIMEOUT)
    if not vectors:
        if error and "blocked by the platform" not in error:
            _trip(error)
        return None
    _heal()
    vector = vectors[0]
    if QUERY_CACHE_MAX:
        with _LOCK:
            _QUERY_CACHE[key] = vector
            while len(_QUERY_CACHE) > QUERY_CACHE_MAX:
                _QUERY_CACHE.popitem(last=False)
    return vector


def load_vectors(cur, client_id: int,
                 cfg: Dict[str, Any]) -> List[Tuple[str, int, List[float]]]:
    """The tenant's current vectors for the configured model/dims (cached
    CACHE_SECONDS per process; sync invalidates its own process)."""
    model = str(cfg.get("model") or "")
    dims = int(cfg.get("dimensions") or 0)
    now = time.monotonic()
    with _LOCK:
        cached = _VEC_CACHE.get(int(client_id))
        if (cached and cached["model"] == model and cached["dims"] == dims
                and now - cached["at"] < CACHE_SECONDS):
            return cached["rows"]
    cur.execute(
        "SELECT kind, ref_id, vector FROM " + portal_db._q(EMB_TABLE) +
        " WHERE client_id = %s AND model = %s AND dims = %s"
        " ORDER BY id LIMIT %s",
        (client_id, model, dims, SCAN_MAX),
    )
    rows: List[Tuple[str, int, List[float]]] = []
    for row in portal_db.rows(cur):
        vector = row.get("vector")
        if not vector:
            continue
        try:
            rows.append((str(row.get("kind") or ""), int(row.get("ref_id") or 0),
                         [float(v) for v in vector]))
        except Exception:
            continue
    if CACHE_SECONDS:
        with _LOCK:
            _VEC_CACHE[int(client_id)] = {"at": now, "model": model,
                                          "dims": dims, "rows": rows}
    return rows


def rank_semantic(qvec: List[float],
                  vectors: List[Tuple[str, int, List[float]]],
                  min_sim: float, pool: int) -> List[Tuple[float, str, int]]:
    """Cosine (dot of unit vectors) ranking, filtered by an absolute floor
    and a window below the best match so a weak tail never rides along.
    Deterministic: ties break on kind then id."""
    scored = []
    for kind, ref_id, vector in vectors:
        sim = dot(qvec, vector)
        if sim >= min_sim:
            scored.append((round(sim, 4), kind, ref_id))
    if not scored:
        return []
    scored.sort(key=lambda s: (-s[0], s[1], s[2]))
    floor = max(min_sim, scored[0][0] - REL_WINDOW)
    return [s for s in scored if s[0] >= floor][:max(1, pool)]


# ---------------------------------------------------------------------------
# Hybrid retrieval (called by portal_knowledge.retrieve)
# ---------------------------------------------------------------------------

def _fetch_items(cur, client_id: int, keys: List[Tuple[str, int]],
                 include_entries: bool) -> Dict[Tuple[str, int], Dict[str, Any]]:
    """Re-read semantic-only hits through the SAME publish/active filters
    as the keyword path (auto-publish lock)."""
    chunk_ids = [ref for kind, ref in keys if kind == "chunk"]
    entry_ids = [ref for kind, ref in keys if kind == "entry"]
    out: Dict[Tuple[str, int], Dict[str, Any]] = {}
    if chunk_ids:
        cur.execute(
            "SELECT c.id AS id, c.heading AS title, c.content AS content,"
            " c.source_id AS source_id, s.title AS source_title,"
            " c.position AS position FROM " + portal_db._q(CHUNKS_TABLE) +
            " c JOIN " + portal_db._q(SOURCES_TABLE) +
            " s ON s.id = c.source_id AND s.client_id = c.client_id"
            " WHERE c.client_id = %s AND s.status = 'published'"
            " AND c.id = ANY(%s)",
            (client_id, chunk_ids),
        )
        for row in portal_db.rows(cur):
            out[("chunk", int(row.get("id") or 0))] = dict(row, kind="chunk")
    if entry_ids and include_entries:
        cur.execute(
            "SELECT e.id AS id, e.title AS title, e.content AS content FROM "
            + portal_db._q(ENTRIES_TABLE) + " e"
            " WHERE e.client_id = %s AND e.is_active IS TRUE AND e.id = ANY(%s)",
            (client_id, entry_ids),
        )
        for row in portal_db.rows(cur):
            out[("entry", int(row.get("id") or 0))] = dict(row, kind="entry")
    return out


def _hit_from_row(row: Dict[str, Any], snippet_chars: int) -> Dict[str, Any]:
    return {
        "kind": str(row.get("kind") or "entry"),
        "id": int(row.get("id") or 0),
        "title": str(row.get("title") or ""),
        "content": str(row.get("content") or "")[:snippet_chars],
        "source_id": int(row.get("source_id") or 0),
        "source": str(row.get("source_title") or ""),
        "position": int(row.get("position") or 0),
        "score": 0.0,
        "matched": [],
    }


def fuse(keyword_hits: List[Dict[str, Any]],
         semantic: List[Tuple[float, str, int]],
         items: Dict[Tuple[str, int], Dict[str, Any]],
         n: int, snippet_chars: int = 400) -> List[Dict[str, Any]]:
    """Reciprocal rank fusion of the keyword list and the semantic list.

    An item found by both ranks above an item found by one. Keyword hits
    keep their BM25 ``score``; semantic-only hits get ``score`` =
    similarity x 10 (same visual scale in the trace). Ties break on
    keyword rank, then kind, then id - deterministic."""
    table: Dict[Tuple[str, int], Dict[str, Any]] = {}
    for rank, hit in enumerate(keyword_hits, start=1):
        key = (str(hit.get("kind") or ""), int(hit.get("id") or 0))
        entry = dict(hit)
        entry["via"] = "keyword"
        entry["semantic"] = None
        table[key] = {"hit": entry, "rrf": 1.0 / (RRF_K + rank), "kw": rank}
    for rank, (sim, kind, ref_id) in enumerate(semantic, start=1):
        key = (kind, ref_id)
        bonus = 1.0 / (RRF_K + rank)
        if key in table:
            table[key]["rrf"] += bonus
            table[key]["hit"]["via"] = "both"
            table[key]["hit"]["semantic"] = sim
            continue
        row = items.get(key)
        if row is None:  # unpublished / inactive / deleted -> never shown
            continue
        hit = _hit_from_row(row, snippet_chars)
        hit["score"] = round(sim * 10, 4)
        hit["via"] = "semantic"
        hit["semantic"] = sim
        table[key] = {"hit": hit, "rrf": bonus, "kw": 10 ** 6}
    ordered = sorted(table.items(), key=lambda kv: (
        -round(kv[1]["rrf"], 9), kv[1]["kw"], kv[0][0], kv[0][1]))
    return [value["hit"] for _key, value in ordered[:max(1, n)]]


def hybrid(cur, client_id: int, query: str,
           keyword_hits: List[Dict[str, Any]], n: int,
           include_entries: bool = True,
           snippet_chars: int = 400) -> Optional[List[Dict[str, Any]]]:
    """Semantic recall fused into the keyword ranking, or None when the
    index is off / empty / the provider is unavailable (caller keeps the
    keyword result)."""
    if not str(query or "").strip():
        return None
    cfg = config()
    if not cfg.get("active"):
        return None
    try:
        _ensure_ddl(cur)
        vectors = load_vectors(cur, client_id, cfg)
    except Exception as error:
        logger.info("semantic vectors unavailable: %s", error)
        return None
    if not include_entries:
        vectors = [v for v in vectors if v[0] != "entry"]
    if not vectors:
        return None  # nothing indexed yet: no query spend
    qvec = query_vector(cur, client_id, query, cfg)
    if not qvec:
        return None
    semantic = rank_semantic(qvec, vectors,
                             float(cfg.get("min_similarity") or 0.0),
                             max(POOL, n))
    known = {(str(h.get("kind") or ""), int(h.get("id") or 0))
             for h in keyword_hits}
    missing = [(kind, ref) for _sim, kind, ref in semantic
               if (kind, ref) not in known]
    items = _fetch_items(cur, client_id, missing, include_entries) \
        if missing else {}
    return fuse(keyword_hits, semantic, items, n, snippet_chars)


# ---------------------------------------------------------------------------
# Index maintenance
# ---------------------------------------------------------------------------

def _current_items(cur, client_id: int) -> List[Dict[str, Any]]:
    cur.execute(
        "SELECT 'chunk' AS kind, c.id AS id, c.heading AS title,"
        " c.content AS content, '' AS extra, c.source_id AS source_id,"
        " s.title AS source_title FROM " + portal_db._q(CHUNKS_TABLE) +
        " c JOIN " + portal_db._q(SOURCES_TABLE) +
        " s ON s.id = c.source_id AND s.client_id = c.client_id"
        " WHERE c.client_id = %s AND s.status = 'published'"
        " UNION ALL"
        " SELECT 'entry' AS kind, e.id AS id, e.title AS title,"
        " e.content AS content, e.keywords AS extra, 0 AS source_id,"
        " '' AS source_title FROM " + portal_db._q(ENTRIES_TABLE) + " e"
        " WHERE e.client_id = %s AND e.is_active IS TRUE"
        " LIMIT %s",
        (client_id, client_id, ITEMS_MAX),
    )
    return portal_db.rows(cur)


def _existing(cur, client_id: int) -> Dict[Tuple[str, int], Dict[str, Any]]:
    cur.execute(
        "SELECT kind, ref_id, content_hash, model, dims FROM "
        + portal_db._q(EMB_TABLE) + " WHERE client_id = %s",
        (client_id,),
    )
    return {(str(r.get("kind") or ""), int(r.get("ref_id") or 0)): r
            for r in portal_db.rows(cur)}


def _reusable(cur, client_id: int, model: str, dims: int,
              hashes: List[str]) -> Dict[str, List[float]]:
    if not hashes:
        return {}
    cur.execute(
        "SELECT DISTINCT ON (content_hash) content_hash, vector FROM "
        + portal_db._q(EMB_TABLE) +
        " WHERE client_id = %s AND model = %s AND dims = %s"
        " AND content_hash = ANY(%s) ORDER BY content_hash, id DESC",
        (client_id, model, dims, hashes),
    )
    out = {}
    for row in portal_db.rows(cur):
        vector = row.get("vector")
        if vector:
            out[str(row.get("content_hash") or "")] = [float(v) for v in vector]
    return out


def _upsert(cur, client_id: int, item: Dict[str, Any], digest: str,
            model: str, dims: int, vector: List[float]) -> None:
    cur.execute(
        "INSERT INTO " + portal_db._q(EMB_TABLE) +
        " (client_id, kind, ref_id, source_id, content_hash, model, dims,"
        " vector) VALUES (%s, %s, %s, %s, %s, %s, %s, %s::real[])"
        " ON CONFLICT (client_id, kind, ref_id) DO UPDATE SET"
        " source_id = EXCLUDED.source_id,"
        " content_hash = EXCLUDED.content_hash, model = EXCLUDED.model,"
        " dims = EXCLUDED.dims, vector = EXCLUDED.vector, updated_at = NOW()",
        (client_id, str(item.get("kind") or ""), int(item.get("id") or 0),
         int(item.get("source_id") or 0), digest, model, dims,
         [round(v, 7) for v in vector]),
    )


def _delete_stale(cur, client_id: int,
                  keep: List[Tuple[str, int]]) -> int:
    chunk_ids = [ref for kind, ref in keep if kind == "chunk"] or [0]
    entry_ids = [ref for kind, ref in keep if kind == "entry"] or [0]
    cur.execute(
        "DELETE FROM " + portal_db._q(EMB_TABLE) +
        " WHERE client_id = %s AND NOT ("
        " (kind = 'chunk' AND ref_id = ANY(%s))"
        " OR (kind = 'entry' AND ref_id = ANY(%s)))",
        (client_id, chunk_ids, entry_ids),
    )
    return int(getattr(cur, "rowcount", 0) or 0)


def _save_state(cur, client_id: int, error: str, embedded: int, reused: int,
                model: str, dims: int) -> None:
    cur.execute(
        "INSERT INTO " + portal_db._q(STATE_TABLE) +
        " (client_id, last_sync_at, last_error, last_embedded, last_reused,"
        " model, dims, updated_at) VALUES (%s, NOW(), %s, %s, %s, %s, %s, NOW())"
        " ON CONFLICT (client_id) DO UPDATE SET last_sync_at = NOW(),"
        " last_error = EXCLUDED.last_error,"
        " last_embedded = EXCLUDED.last_embedded,"
        " last_reused = EXCLUDED.last_reused, model = EXCLUDED.model,"
        " dims = EXCLUDED.dims, updated_at = NOW()",
        (client_id, str(error or "")[:300], int(embedded), int(reused),
         model, int(dims)),
    )


def sync(cur, client_id: int, budget: Optional[int] = None,
         cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Bring the tenant's vectors in line with its published knowledge.

    Reuses vectors by content hash (re-index / rollback cost nothing),
    embeds up to ``budget`` changed items in provider batches, drops
    vectors of deleted/unpublished/inactive items, records the outcome.
    Returns {ok, embedded, reused, removed, pending, error}."""
    cfg = cfg or config()
    out = {"ok": False, "embedded": 0, "reused": 0, "removed": 0,
           "pending": 0, "error": ""}
    if not cfg.get("active"):
        out["error"] = "not_active:" + str(cfg.get("reason") or "")
        return out
    import portal_llm

    _ensure_ddl(cur)
    model = str(cfg.get("model") or "")
    dims = int(cfg.get("dimensions") or 0)
    items = _current_items(cur, client_id)
    existing = _existing(cur, client_id)
    todo: List[Tuple[Dict[str, Any], str, str]] = []
    keep: List[Tuple[str, int]] = []
    for item in items:
        key = (str(item.get("kind") or ""), int(item.get("id") or 0))
        keep.append(key)
        text = item_text(item)
        if not text.strip():
            continue
        digest = content_hash(text)
        have = existing.get(key)
        if (have and str(have.get("content_hash") or "") == digest
                and str(have.get("model") or "") == model
                and int(have.get("dims") or 0) == dims):
            continue
        todo.append((item, text, digest))
    reuse = _reusable(cur, client_id, model, dims,
                      sorted({d for _i, _t, d in todo}))
    fresh: List[Tuple[Dict[str, Any], str, str]] = []
    for item, text, digest in todo:
        if digest in reuse:
            _upsert(cur, client_id, item, digest, model, dims, reuse[digest])
            out["reused"] += 1
        else:
            fresh.append((item, text, digest))
    limit = SYNC_BUDGET if budget is None else max(0, int(budget))
    batch_size = portal_llm.EMBED_MAX_INPUTS
    error = ""
    done = 0
    for start in range(0, min(len(fresh), limit), batch_size):
        batch = fresh[start:min(start + batch_size, limit)]
        vectors, error = _embed([t for _i, t, _d in batch], cfg, client_id,
                                cur)
        if not vectors:
            if error and "blocked by the platform" not in error:
                _trip(error)
            break
        _heal()
        for (item, _text, digest), vector in zip(batch, vectors):
            _upsert(cur, client_id, item, digest, model, dims, vector)
        done += len(batch)
    out["embedded"] = done
    out["pending"] = max(0, len(fresh) - done)
    out["removed"] = _delete_stale(cur, client_id, keep)
    out["error"] = error
    out["ok"] = not error
    _save_state(cur, client_id, error, done, out["reused"], model, dims)
    invalidate(client_id)
    if done or out["reused"] or out["removed"]:
        try:
            portal_db.log_action(
                cur, client_id, "kb.semantic_synced", "system", None, None,
                "Semantic index: " + str(done) + " embedded, "
                + str(out["reused"]) + " reused, " + str(out["removed"])
                + " removed" + (", " + str(out["pending"]) + " pending"
                                if out["pending"] else ""))
        except Exception:
            pass
    return out


def status(cur, client_id: int) -> Dict[str, Any]:
    """Owner-facing index health (no secrets)."""
    cfg = config()
    _ensure_ddl(cur)
    model = str(cfg.get("model") or "")
    dims = int(cfg.get("dimensions") or 0)
    cur.execute(
        "SELECT (SELECT COUNT(*) FROM " + portal_db._q(CHUNKS_TABLE) +
        " c JOIN " + portal_db._q(SOURCES_TABLE) +
        " s ON s.id = c.source_id AND s.client_id = c.client_id"
        " WHERE c.client_id = %s AND s.status = 'published') AS chunks,"
        " (SELECT COUNT(*) FROM " + portal_db._q(ENTRIES_TABLE) +
        " WHERE client_id = %s AND is_active IS TRUE) AS entries,"
        " (SELECT COUNT(*) FROM " + portal_db._q(EMB_TABLE) +
        " WHERE client_id = %s AND model = %s AND dims = %s) AS indexed",
        (client_id, client_id, client_id, model, dims),
    )
    counts = (portal_db.rows(cur) or [{}])[0]
    cur.execute(
        "SELECT last_sync_at, last_error, last_embedded, last_reused FROM "
        + portal_db._q(STATE_TABLE) + " WHERE client_id = %s",
        (client_id,),
    )
    state = (portal_db.rows(cur) or [{}])[0]
    total = int(counts.get("chunks") or 0) + int(counts.get("entries") or 0)
    indexed = min(int(counts.get("indexed") or 0), total) if total else 0
    stamp = state.get("last_sync_at")
    return {
        "active": bool(cfg.get("active")),
        "reason": str(cfg.get("reason") or ""),
        "mode": str(cfg.get("mode") or "on"),
        "model": model,
        "dimensions": dims,
        "min_similarity": float(cfg.get("min_similarity") or 0.0),
        "key_source": str(cfg.get("key_source") or "none"),
        "total": total,
        "indexed": indexed,
        "pending": max(0, total - indexed),
        "coverage": round(indexed / float(total), 4) if total else 0.0,
        "running": int(client_id) in _RUNNING,
        "provider_cooldown": _provider_down(),
        "last_sync_at": stamp.isoformat() if hasattr(stamp, "isoformat")
        else (str(stamp) if stamp else None),
        "last_error": str(state.get("last_error") or ""),
        "last_embedded": int(state.get("last_embedded") or 0),
        "last_reused": int(state.get("last_reused") or 0),
    }


def _sync_job(client_id: int, rounds: int) -> None:
    try:
        for _ in range(max(1, rounds)):
            conn = portal_db._conn()
            try:
                with conn.cursor() as cur:
                    result = sync(cur, client_id)
                conn.commit()
            finally:
                conn.close()
            if not result.get("pending") or result.get("error"):
                break
    except Exception as error:
        logger.info("semantic sync failed client=%s: %s", client_id, error)
    finally:
        with _LOCK:
            _RUNNING.discard(int(client_id))


def kick(client_id: int, reason: str = "edit", rounds: int = 3) -> bool:
    """Run a sync on a daemon thread after the caller's commit. One job per
    tenant per process; ``tick`` kicks are throttled to TICK_SECONDS.
    Returns True when a job was started. Never raises."""
    try:
        client_id = int(client_id or 0)
        if client_id <= 0 or not config().get("active"):
            return False
        now = time.monotonic()
        with _LOCK:
            if client_id in _RUNNING:
                return False
            if reason == "tick" and now - _LAST_KICK.get(client_id, -1e9) \
                    < TICK_SECONDS:
                return False
            if reason == "tick" and _provider_down():
                return False
            _RUNNING.add(client_id)
            _LAST_KICK[client_id] = now
        threading.Thread(target=_sync_job, args=(client_id, rounds),
                         daemon=True,
                         name="of-kb-embed-" + str(client_id)).start()
        return True
    except Exception as error:
        with _LOCK:
            _RUNNING.discard(int(client_id or 0))
        logger.info("semantic kick skipped: %s", error)
        return False


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def _principal():
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


def _status_response(client_id: int, started: bool = False):
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            payload = status(cur, client_id)
        conn.commit()
    finally:
        conn.close()
    if started:
        payload["running"] = True
    payload["started"] = started
    return jsonify(payload), 200


@bp.get("/kb/semantic")
def get_semantic_status():
    principal, error = _principal()
    if error:
        return error
    try:
        return _status_response(int(principal.get("client_id") or 0))
    except Exception as problem:
        return jsonify(portal_db.portal_unavailable(
            problem, "knowledge semantic index")[0]), 503


@bp.post("/kb/semantic/sync")
def post_semantic_sync():
    """Owner "Build index now": starts a background sync (the website
    request budget is short) and returns the current status."""
    principal, error = _principal()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    client_id = int(principal.get("client_id") or 0)
    cfg = config()
    if not cfg.get("active"):
        return jsonify({"error": {
            "code": "not_configured",
            "message": ("Semantic search is switched off by the platform."
                        if cfg.get("reason") == "off" else
                        "Semantic search needs an AI key with embeddings."
                        " Ask the platform admin to configure it."),
        }}), 409
    rounds = 1 if str(request.args.get("once") or "") == "1" else 10
    started = kick(client_id, "manual", rounds=rounds)
    try:
        return _status_response(client_id, started)
    except Exception as problem:
        return jsonify(portal_db.portal_unavailable(
            problem, "knowledge semantic index")[0]), 503


def kick_after_mutation(response):
    """after_request hook for the knowledge blueprints: a successful owner
    write (source/entry create, edit, publish, pause, delete, re-index,
    rollback) schedules a background sync. Never alters the response."""
    try:
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return response
        if int(getattr(response, "status_code", 500)) >= 400:
            return response
        if not config().get("active"):
            return response
        principal = authenticate_portal_request()
        if principal:
            kick(int(principal.get("client_id") or 0), "edit")
    except Exception:
        pass
    return response
