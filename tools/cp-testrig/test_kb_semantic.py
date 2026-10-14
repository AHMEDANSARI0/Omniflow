"""§211 D1 - knowledge semantic index (hybrid keyword + embeddings).

Covers: config resolution (panel > env > AI engine, Gemini defaults),
the embeddings client contract (payload, normalisation, order, errors,
gate, ledger), ranking + reciprocal rank fusion, the auto-publish lock on
semantic hits, hybrid retrieve integration + keyword fallback, index sync
(reuse by content hash, budget/pending, stale removal, error cooldown),
background kicks (dedupe + tick throttle), HTTP endpoints, admin panel
validation, wiring (app/connector/after_request) and the website surface.
"""
import json
import os
import sys
import types
from unittest import mock

_HERE = os.path.abspath(os.path.dirname(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
_CP = os.path.join(_ROOT, "omniflow-backend-patch")
sys.path = [p for p in sys.path if os.path.abspath(p or ".") != _HERE]
sys.path.insert(0, _CP)
sys.path.append(_HERE)
os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "x")

from flask import Flask  # noqa: E402

import platform_settings as ps  # noqa: E402
import portal_llm  # noqa: E402
import portal_kb_semantic as sem  # noqa: E402
import portal_knowledge as kn  # noqa: E402
from test_lib import (  # noqa: E402
    PrincipalStub, check, human_principal, install_db_stub, summary)


def read(*parts):
    return open(os.path.join(_ROOT, *parts), encoding="utf8").read()


# ---------------------------------------------------------------------------
# A tiny deterministic "embedding model": concept buckets, so synonyms in
# English / Roman Urdu land close together while unrelated text does not.
# ---------------------------------------------------------------------------
CONCEPTS = [
    ("delivery", "shipping", "courier", "parcel", "pohnch", "pahunch", "din",
     "days", "arrive", "dispatch"),
    ("refund", "return", "wapas", "exchange", "money back"),
    ("price", "qeemat", "cost", "rate", "kitne ka"),
    ("hours", "timing", "open", "khula", "band"),
]


def fake_vector(text):
    low = str(text).lower()
    vec = [0.05] * (len(CONCEPTS) + 1)
    for i, words in enumerate(CONCEPTS):
        vec[i] += sum(1.0 for w in words if w in low)
    vec[-1] += 0.2
    return portal_llm.normalize_vector(vec)


CALLS = []


def fake_embed_texts(texts, timeout=None, runtime=None):
    CALLS.append(list(texts))
    return [fake_vector(t) for t in texts], ""


ACTIVE = {"active": True, "reason": "active", "mode": "on",
          "api_key": "k", "base_url": "https://api.openai.com/v1",
          "model": "text-embedding-3-small", "dimensions": 256,
          "min_similarity": 0.5, "key_source": "llm"}


def use_config(cfg):
    sem.config = lambda: dict(cfg)


print("== config resolution (platform_settings.embed_config) ==")

_orig_get_setting = ps.get_setting


def settings(values):
    ps.get_setting = lambda key, default=None: values.get(key, default)


env_clear = {k: "" for k in ("OF_KB_EMBED_MODE", "OF_EMBED_API_KEY",
                             "OF_EMBED_BASE_URL", "OF_EMBED_MODEL",
                             "OF_EMBED_DIMENSIONS", "OF_KB_EMBED_MIN_SIM",
                             "OF_LLM_API_KEY", "OF_LLM_BASE_URL",
                             "OF_LLM_ENABLED")}
with mock.patch.dict(os.environ, env_clear):
    settings({})
    cfg = ps.embed_config()
    check("no key anywhere -> inactive no_key", cfg["active"] is False
          and cfg["reason"] == "no_key" and cfg["key_source"] == "none", cfg)
    check("defaults: 256 dims, OpenAI model, 0.30 floor",
          cfg["dimensions"] == 256 and cfg["model"] == "text-embedding-3-small"
          and abs(cfg["min_similarity"] - 0.30) < 1e-9, cfg)

    settings({"llm.api_key": "sk-llm", "llm.base_url":
              "https://generativelanguage.googleapis.com/v1beta/openai/"})
    cfg = ps.embed_config()
    check("reuses the AI engine key + base (key_source llm)",
          cfg["active"] and cfg["key_source"] == "llm"
          and cfg["api_key"] == "sk-llm"
          and cfg["base_url"].endswith("/openai"), cfg)
    check("Gemini base -> gemini-embedding-001 + 0.60 floor",
          cfg["model"] == "gemini-embedding-001"
          and abs(cfg["min_similarity"] - 0.60) < 1e-9, cfg)

    settings({"llm.api_key": "sk-llm", "embeddings.api_key": "sk-emb",
              "embeddings.base_url": "https://emb.example/v1/",
              "embeddings.model": "my-embed", "embeddings.dimensions": "9999",
              "embeddings.min_similarity": "45"})
    cfg = ps.embed_config()
    check("panel values win; base trimmed; dims clamped to 4096",
          cfg["key_source"] == "embeddings" and cfg["api_key"] == "sk-emb"
          and cfg["base_url"] == "https://emb.example/v1"
          and cfg["model"] == "my-embed" and cfg["dimensions"] == 4096
          and abs(cfg["min_similarity"] - 0.45) < 1e-9, cfg)

    settings({"embeddings.mode": "off", "llm.api_key": "sk"})
    check("mode off -> inactive reason off", ps.embed_config()["reason"] == "off",
          ps.embed_config())
    settings({"embeddings.mode": "banana", "llm.api_key": "sk"})
    check("unknown mode falls back to on", ps.embed_config()["mode"] == "on", "-")

with mock.patch.dict(os.environ, dict(env_clear, OF_LLM_ENABLED="0")):
    settings({"llm.api_key": "sk"})
    check("AI engine disabled -> llm_disabled when borrowing its key",
          ps.embed_config()["reason"] == "llm_disabled", ps.embed_config())
with mock.patch.dict(os.environ, dict(env_clear, OF_EMBED_API_KEY="sk-env")):
    settings({})
    check("env key -> key_source env", ps.embed_config()["key_source"] == "env",
          ps.embed_config())
ps.get_setting = _orig_get_setting
check("embeddings group registered for the admin panel",
      ps.GROUP_KEYS["embeddings"] == ["mode", "api_key", "base_url", "model",
                                      "dimensions", "min_similarity"], "-")

print("== embeddings client (portal_llm.embed_texts) ==")

v = portal_llm.normalize_vector([3, 4])
check("normalize_vector -> unit length", abs(v[0] - 0.6) < 1e-9
      and abs(v[1] - 0.8) < 1e-9, v)
check("normalize_vector rejects zero/empty",
      portal_llm.normalize_vector([0, 0]) is None
      and portal_llm.normalize_vector([]) is None, "-")

posted = []


def fake_post(url, headers, payload, timeout):
    posted.append((url, headers, payload, timeout))
    return {"data": [{"index": 1, "embedding": [0, 2]},
                     {"index": 0, "embedding": [3, 4]}],
            "usage": {"prompt_tokens": 7}}, ""


ledger = []
_orig_post, _orig_rec, _orig_gated = (portal_llm._post_detail,
                                      portal_llm._record_usage,
                                      portal_llm._gated)
portal_llm._post_detail = fake_post
portal_llm._record_usage = lambda model, usage, ok, started: ledger.append(
    (model, usage, ok, portal_llm.current_scope()[0]))
portal_llm._gated = lambda: False
with portal_llm.usage_scope("kb_embed", 3):
    vectors, err = portal_llm.embed_texts(["a", "b"], runtime=ACTIVE)
url, headers, payload, timeout = posted[0]
check("POSTs {base}/embeddings with bearer key",
      url == "https://api.openai.com/v1/embeddings"
      and headers["Authorization"] == "Bearer k", url)
check("payload: model + input list + dimensions",
      payload == {"model": "text-embedding-3-small", "input": ["a", "b"],
                  "dimensions": 256}, payload)
check("vectors re-ordered by index and normalised",
      err == "" and abs(vectors[0][0] - 0.6) < 1e-9 and vectors[1] == [0.0, 1.0],
      vectors)
check("one ledger row, ok, under the caller's kb_embed scope",
      ledger == [("text-embedding-3-small", {"prompt_tokens": 7}, True,
                  "kb_embed")], ledger)

posted.clear()
portal_llm.embed_texts(["x"], runtime=dict(ACTIVE, dimensions=0))
check("dimensions 0 -> param omitted (provider default)",
      "dimensions" not in posted[0][2], posted[0][2])

portal_llm._post_detail = lambda *a: (None, "HTTP 400: dimensions unsupported")
ledger.clear()
vectors, err = portal_llm.embed_texts(["x"], runtime=ACTIVE)
check("provider error -> (None, reason) + failed ledger row",
      vectors is None and err.startswith("HTTP 400") and ledger[0][2] is False,
      (vectors, err, ledger))
portal_llm._post_detail = lambda *a: ({"data": [{"index": 0, "embedding": [1]}]}, "")
vectors, err = portal_llm.embed_texts(["x", "y"], runtime=ACTIVE)
check("count mismatch -> rejected", vectors is None and "unexpected" in err, err)
vectors, err = portal_llm.embed_texts(["x"], runtime=dict(ACTIVE, active=False,
                                                         reason="off"))
check("inactive config -> no call", vectors is None and "not configured" in err,
      err)
portal_llm._gated = lambda: True
vectors, err = portal_llm.embed_texts(["x"], runtime=ACTIVE)
check("platform AI gate (kill switch / cap) blocks embeddings",
      vectors is None and "blocked" in err, err)
check("too many inputs guarded", portal_llm.embed_texts(
    ["x"] * (portal_llm.EMBED_MAX_INPUTS + 1), runtime=ACTIVE)[0] is None, "-")
portal_llm._post_detail, portal_llm._record_usage, portal_llm._gated = (
    _orig_post, _orig_rec, _orig_gated)

print("== ranking + fusion (pure) ==")

q = fake_vector("parcel kab pohnchega")
vecs = [("chunk", 1, fake_vector("Delivery takes 3-5 days by courier")),
        ("chunk", 2, fake_vector("Refunds: return within 7 days")),
        ("entry", 9, fake_vector("Shipping charges and dispatch"))]
ranked = sem.rank_semantic(q, vecs, 0.5, 10)
check("semantic ranks delivery concepts, drops unrelated refund text",
      [r[2] for r in ranked][:2] in ([1, 9], [9, 1]) and 2 not in
      [r[2] for r in ranked], ranked)
check("relative window trims a weak tail",
      sem.rank_semantic(q, vecs + [("chunk", 5, fake_vector("delivery refund price hours"))],
                        0.0, 10)[-1][0] >= ranked[0][0] - sem.REL_WINDOW - 1e-9,
      "-")
check("mismatched vector sizes never match", sem.dot([1.0], [1.0, 0.0]) == -1.0,
      "-")

kw = [{"kind": "chunk", "id": 1, "title": "Delivery", "content": "3-5 days",
       "source_id": 4, "source": "FAQ", "position": 0, "score": 5.0,
       "matched": ["delivery"]},
      {"kind": "entry", "id": 3, "title": "Hours", "content": "9-5",
       "source_id": 0, "source": "", "position": 0, "score": 2.0,
       "matched": ["hours"]}]
items = {("entry", 9): {"kind": "entry", "id": 9, "title": "Shipping",
                        "content": "Dispatch same day"}}
fused = sem.fuse(kw, [(0.91, "entry", 9), (0.88, "chunk", 1),
                      (0.70, "chunk", 77)], items, 5)
check("found by both ranks first (via both, similarity kept)",
      fused[0]["id"] == 1 and fused[0]["via"] == "both"
      and fused[0]["semantic"] == 0.88 and fused[0]["score"] == 5.0, fused[0])
sem_only = [h for h in fused if h["id"] == 9]
check("semantic-only hit: via semantic, score = similarity x 10, contract keys",
      sem_only and sem_only[0]["via"] == "semantic"
      and sem_only[0]["score"] == 9.1 and sem_only[0]["matched"] == []
      and set(kw[0]).issubset(sem_only[0]), sem_only)
check("hit without a published/active row is never returned (publish lock)",
      all(h["id"] != 77 for h in fused), fused)
check("keyword-only hit keeps via keyword + semantic None",
      [h for h in fused if h["id"] == 3][0]["via"] == "keyword"
      and [h for h in fused if h["id"] == 3][0]["semantic"] is None, fused)
check("fusion deterministic", sem.fuse(kw, [(0.91, "entry", 9)], items, 5)
      == sem.fuse(kw, [(0.91, "entry", 9)], items, 5), "-")
check("n respected", len(sem.fuse(kw, [(0.91, "entry", 9)], items, 1)) == 1, "-")

print("== item text + hashing ==")
t_chunk = sem.item_text({"kind": "chunk", "title": "Delivery",
                         "content": "3-5 days", "source_title": "FAQ"})
check("chunk text carries document > section", t_chunk.startswith(
    "FAQ > Delivery\n3-5 days"), t_chunk)
t_entry = sem.item_text({"kind": "entry", "title": "Hours", "content": "9-5",
                         "extra": "timing, open"})
check("entry text = title + answer + keywords", t_entry ==
      "Hours\n9-5\ntiming, open", t_entry)
check("content hash stable + content-sensitive",
      sem.content_hash("a") == sem.content_hash("a")
      and sem.content_hash("a") != sem.content_hash("b"), "-")

print("== hybrid retrieve integration ==")

sem.reset_caches()
use_config(dict(ACTIVE, active=False, reason="no_key"))
conn = install_db_stub(kn, [[{"kind": "chunk", "id": 1, "title": "Delivery",
                              "content": "Delivery takes 3-5 days",
                              "extra": "", "source_id": 4,
                              "source_title": "FAQ", "position": 0}]])
sem.portal_db = kn.portal_db
hits = kn.retrieve(conn.cur, 1, "delivery time", 3)
check("semantic inactive -> pure keyword, one SQL, via keyword",
      len(conn.cur.executed) == 1 and hits and hits[0]["via"] == "keyword"
      and hits[0]["semantic"] is None, (hits, conn.cur.executed))
conn = install_db_stub(kn, [])
check("blank query -> [] without touching the DB",
      kn.retrieve(conn.cur, 1, "   ", 3) == [] and conn.cur.executed == [], "-")
conn = install_db_stub(kn, [])
sem.portal_db = kn.portal_db
check("token-less query (punctuation only) + semantic off -> [] with no DB",
      kn.retrieve(conn.cur, 1, "?!", 3) == [] and conn.cur.executed == [],
      conn.cur.executed)

use_config(ACTIVE)
sem.reset_caches()
sem._DDL_READY = True
CALLS.clear()
portal_llm.embed_texts = fake_embed_texts
conn = install_db_stub(kn, [
    [],  # keyword candidates: no shared words with the question
    [{"kind": "chunk", "ref_id": 1,
      "vector": fake_vector("FAQ > Delivery\nDelivery takes 3-5 days by courier")},
     {"kind": "chunk", "ref_id": 2,
      "vector": fake_vector("FAQ > Refunds\nReturn within 7 days")}],
    [{"id": 1, "title": "Delivery", "content": "Delivery takes 3-5 days by courier",
      "source_id": 4, "source_title": "FAQ", "position": 0}],
])
sem.portal_db = kn.portal_db
hits = kn.retrieve(conn.cur, 1, "parcel kab pohnchega", 3)
check("no word overlap, still finds the delivery section by meaning",
      len(hits) == 1 and hits[0]["id"] == 1 and hits[0]["via"] == "semantic"
      and hits[0]["source"] == "FAQ", hits)
check("question embedded once", CALLS == [["parcel kab pohnchega"]], CALLS)
fetch_sql = conn.cur.executed[-1][0]
check("semantic hits re-read through the publish/active filter",
      "s.status = 'published'" in fetch_sql and "c.id = ANY(%s)" in fetch_sql,
      fetch_sql)

CALLS.clear()
conn = install_db_stub(kn, [[], [{"id": 1, "title": "Delivery", "content": "x",
                                  "source_id": 4, "source_title": "FAQ",
                                  "position": 0}]])
sem.portal_db = kn.portal_db
kn.retrieve(conn.cur, 1, "Parcel  kab   pohnchega", 3)
check("repeat question served from the query + vector caches (no spend)",
      CALLS == [] and len(conn.cur.executed) == 2, (CALLS, conn.cur.executed))

sem.reset_caches()
CALLS.clear()
conn = install_db_stub(kn, [[], []])
sem.portal_db = kn.portal_db
hits = kn.retrieve(conn.cur, 1, "parcel kab pohnchega", 3)
check("empty index -> keyword result, question NOT embedded (no spend)",
      hits == [] and CALLS == [], (hits, CALLS))

sem.reset_caches()
portal_llm.embed_texts = lambda *a, **k: (None, "HTTP 503")
conn = install_db_stub(kn, [[], [{"kind": "chunk", "ref_id": 1,
                                  "vector": fake_vector("delivery")}]])
sem.portal_db = kn.portal_db
hits = kn.retrieve(conn.cur, 1, "parcel kab pohnchega", 3)
check("provider failure -> keyword fallback + cooldown tripped",
      hits == [] and sem._provider_down(), hits)
CALLS.clear()
portal_llm.embed_texts = fake_embed_texts
conn = install_db_stub(kn, [[], []])
sem.portal_db = kn.portal_db
kn.retrieve(conn.cur, 1, "another question", 3)
check("during cooldown the provider is not called again", CALLS == [], CALLS)
sem.reset_caches()

print("== index sync ==")

sem._DDL_READY = True
items_rows = [
    {"kind": "chunk", "id": 11, "title": "Delivery", "content": "3-5 days",
     "extra": "", "source_id": 4, "source_title": "FAQ"},
    {"kind": "chunk", "id": 12, "title": "Refunds", "content": "7 days",
     "extra": "", "source_id": 4, "source_title": "FAQ"},
    {"kind": "entry", "id": 21, "title": "Hours", "content": "9-5",
     "extra": "timing", "source_id": 0, "source_title": ""},
]
same_hash = sem.content_hash(sem.item_text(items_rows[0]))
reuse_hash = sem.content_hash(sem.item_text(items_rows[1]))
CALLS.clear()
conn = install_db_stub(sem, [
    items_rows,
    [{"kind": "chunk", "ref_id": 11, "content_hash": same_hash,
      "model": "text-embedding-3-small", "dims": 256}],
    [{"content_hash": reuse_hash, "vector": [0.6, 0.8]}],
    [],   # upsert reused chunk 12
    [],   # upsert embedded entry 21
    2,    # delete stale (rowcount)
    [],   # save state
    [],   # audit
])
result = sem.sync(conn.cur, 1, cfg=ACTIVE)
check("unchanged item skipped, changed-but-known reused, new embedded",
      result["reused"] == 1 and result["embedded"] == 1
      and CALLS == [[sem.item_text(items_rows[2])]], (result, CALLS))
check("stale vectors removed + nothing pending + ok",
      result["removed"] == 2 and result["pending"] == 0 and result["ok"], result)
sqls = [s for s, _p in conn.cur.executed]
check("sync SQL: publish filter, upsert on (client, kind, ref), keep-list delete",
      "s.status = 'published'" in sqls[0] and "e.is_active IS TRUE" in sqls[0]
      and "ON CONFLICT (client_id, kind, ref_id)" in sqls[3]
      and sqls[5].startswith("DELETE FROM portal_kb_embeddings"), sqls)
check("state saved + audit line", "portal_kb_semantic_state" in sqls[6]
      and "kb.semantic_synced" in str(conn.cur.executed[7][1]), sqls[6:])
upsert_params = conn.cur.executed[4][1]
check("vectors stored with model + dims", upsert_params[5] ==
      "text-embedding-3-small" and upsert_params[6] == 256, upsert_params)

CALLS.clear()
conn = install_db_stub(sem, [items_rows, [], [], [], 0, [], []])
result = sem.sync(conn.cur, 1, budget=1, cfg=ACTIVE)
check("budget respected -> pending reported", result["embedded"] == 1
      and result["pending"] == 2 and len(CALLS) == 1, result)

sem.reset_caches()
portal_llm.embed_texts = lambda *a, **k: (None, "HTTP 401: bad key")
conn = install_db_stub(sem, [items_rows, [], [], 0, [], []])
result = sem.sync(conn.cur, 1, cfg=ACTIVE)
check("provider error -> recorded, not ok, cooldown tripped",
      result["ok"] is False and result["error"] == "HTTP 401: bad key"
      and result["pending"] == 3 and sem._provider_down(), result)
state_params = [p for s, p in conn.cur.executed if "semantic_state" in s][0]
check("error persisted for the owner card", state_params[1] ==
      "HTTP 401: bad key", state_params)
sem.reset_caches()
portal_llm.embed_texts = fake_embed_texts

conn = install_db_stub(sem, [])
result = sem.sync(conn.cur, 1, cfg=dict(ACTIVE, active=False, reason="off"))
check("inactive -> sync is a no-op (no DB)", result["ok"] is False
      and conn.cur.executed == [], result)

print("== status ==")
conn = install_db_stub(sem, [
    [{"chunks": 8, "entries": 2, "indexed": 7}],
    [{"last_sync_at": None, "last_error": "", "last_embedded": 5,
      "last_reused": 2}],
])
st = sem.status(conn.cur, 1)
check("status counts + coverage + pending",
      st["total"] == 10 and st["indexed"] == 7 and st["pending"] == 3
      and st["coverage"] == 0.7 and st["active"] is True, st)
check("status never leaks the key", "k" not in json.dumps(
    {k: v for k, v in st.items() if k == "api_key"}) and "api_key" not in st, st)

print("== background kicks ==")
started = []


class FakeThread:
    def __init__(self, target=None, args=(), daemon=None, name=None):
        started.append((target, args, name))

    def start(self):
        pass


sem.reset_caches()
with mock.patch.object(sem.threading, "Thread", FakeThread):
    first = sem.kick(5, "edit")
    dup = sem.kick(5, "edit")
    check("one job per tenant (dedupe while running)", first is True
          and dup is False and len(started) == 1, started)
    sem._RUNNING.clear()
    check("tick right after a kick is throttled", sem.kick(5, "tick") is False, "-")
    check("edit kick is not throttled", sem.kick(5, "edit") is True, "-")
    sem._RUNNING.clear()
    use_config(dict(ACTIVE, active=False))
    check("inactive -> no kick", sem.kick(6, "edit") is False, "-")
    use_config(ACTIVE)
    check("bad tenant ignored", sem.kick(0, "edit") is False, "-")
sem.reset_caches()

print("== after_request hook ==")
app = Flask("sem-test")


class Resp:
    def __init__(self, code):
        self.status_code = code


kicked = []
with mock.patch.object(sem, "kick", lambda cid, reason="edit", rounds=3:
                       kicked.append((cid, reason)) or True):
    PrincipalStub(sem, principal=human_principal(client_id=4))
    with app.test_request_context("/x", method="GET"):
        sem.kick_after_mutation(Resp(200))
    with app.test_request_context("/x", method="POST"):
        sem.kick_after_mutation(Resp(400))
    with app.test_request_context("/x", method="PUT"):
        out = Resp(200)
        same = sem.kick_after_mutation(out)
check("only successful writes kick; response untouched",
      kicked == [(4, "edit")] and same is out, kicked)

print("== HTTP ==")
http = Flask("sem-http")
http.register_blueprint(sem.bp)
client = http.test_client()
conn = install_db_stub(sem, [[{"chunks": 1, "entries": 0, "indexed": 1}], []])
PrincipalStub(sem, principal=human_principal())
r = client.get("/api/v1/portal/kb/semantic")
check("GET status 200 + shape", r.status_code == 200
      and r.get_json()["indexed"] == 1 and "running" in r.get_json(), r.get_json())
PrincipalStub(sem, principal=None)
check("GET anon 401", client.get("/api/v1/portal/kb/semantic").status_code == 401,
      "-")
PrincipalStub(sem, principal=dict(human_principal(), via_api_key=True))
r = client.post("/api/v1/portal/kb/semantic/sync")
check("POST sync API key -> 403 (human only)", r.status_code == 403, r.status_code)
PrincipalStub(sem, principal=human_principal())
use_config(dict(ACTIVE, active=False, reason="no_key"))
r = client.post("/api/v1/portal/kb/semantic/sync")
check("POST sync not configured -> 409 with owner copy",
      r.status_code == 409 and "platform admin" in r.get_json()["error"]["message"],
      r.get_json())
use_config(ACTIVE)
conn = install_db_stub(sem, [[{"chunks": 3, "entries": 0, "indexed": 0}], []])
with mock.patch.object(sem, "kick", lambda *a, **k: True):
    r = client.post("/api/v1/portal/kb/semantic/sync")
check("POST sync starts a background job + returns status",
      r.status_code == 200 and r.get_json()["started"] is True
      and r.get_json()["running"] is True and r.get_json()["pending"] == 3,
      r.get_json())

print("== admin panel validation ==")
import admin_providers as ap  # noqa: E402

vals, err = ap._clean_group("embeddings", {"mode": "OFF", "dimensions": "512",
                                           "min_similarity": "40",
                                           "unknown": "x"})
check("mode lower-cased + whitelisted; unknown keys dropped",
      err is None and vals == {"mode": "off", "dimensions": "512",
                               "min_similarity": "40"}, (vals, err))
check("mode outside on/off rejected",
      ap._clean_group("embeddings", {"mode": "auto"})[1] is not None, "-")
check("dimensions bounded 0..4096",
      ap._clean_group("embeddings", {"dimensions": "5000"})[1] is not None, "-")
check("similarity bounded 0..100",
      ap._clean_group("embeddings", {"min_similarity": "101"})[1] is not None, "-")
check("api_key treated as secret (masked)", ap._is_secret("embeddings", "api_key"),
      "-")
check("configured chip once anything saved",
      ap._configured("embeddings", {"mode": "on"}) is True
      and ap._configured("embeddings", {}) is False, "-")

print("== wiring + laws ==")
APP = read("omniflow-backend-patch", "app.py")
check("blueprint imported + registered",
      "from portal_kb_semantic import bp as portal_kb_semantic_bp" in APP
      and "aux_app.register_blueprint(portal_kb_semantic_bp)" in APP, "-")
check("connector tick tops up the index (throttled kick)",
      'portal_kb_semantic.kick(tenant["client_id"], "tick")'
      in read("omniflow-backend-patch", "connector_api.py"), "-")
for mod in ("portal_kb.py", "portal_knowledge.py"):
    check(mod + " after_request schedules a sync",
          "@bp.after_request" in read("omniflow-backend-patch", mod)
          and "kick_after_mutation" in read("omniflow-backend-patch", mod), "-")
SEM = read("omniflow-backend-patch", "portal_kb_semantic.py")
check("no pgvector / no new dependency (REAL[] in existing Postgres)",
      "CREATE EXTENSION" not in SEM and "vector REAL[]" in SEM
      and "import numpy" not in SEM and "import requests" not in SEM, "-")
check("costs through portal_llm under kb_embed",
      'FEATURE = "kb_embed"' in SEM and "portal_llm.embed_texts" in SEM, "-")
import portal_ai_usage as pu  # noqa: E402
check("usage ledger label for kb_embed",
      pu.FEATURE_LABELS.get("kb_embed") == "Knowledge semantic index", "-")
check("retrieve keeps the single retrieval contract",
      "portal_kb_semantic.hybrid(" in read("omniflow-backend-patch",
                                           "portal_knowledge.py"), "-")

print("== website ==")
check("BFF status route", "getKbSemanticStatus" in read(
    "app", "api", "omniflow", "portal", "kb", "semantic", "route.ts"), "-")
check("BFF sync route", "syncKbSemantic" in read(
    "app", "api", "omniflow", "portal", "kb", "semantic", "sync", "route.ts"), "-")
PT = read("lib", "omniflow", "portal.ts")
check("portal.ts types + helpers", "export interface KbSemanticStatus" in PT
      and "export async function syncKbSemantic" in PT
      and 'via?: "keyword" | "semantic" | "both";' in PT, "-")
CARD = read("app", "dashboard", "(portal)", "knowledge-base", "KbSemanticCard.tsx")
check("Knowledge page semantic card (build + progress + errors)",
      "Build index now" in CARD and "items indexed" in CARD
      and "last_error" in CARD and "<KbSemanticCard />" in read(
          "app", "dashboard", "(portal)", "knowledge-base", "page.tsx"), "-")
check("tester shows found-by-meaning + similarity",
      "found by meaning" in read("app", "dashboard", "(portal)",
                                 "knowledge-base", "KbRetrievalTester.tsx"), "-")
INTEG = read("app", "admin", "(panel)", "integrations", "IntegrationsClient.tsx")
check("admin Integrations embeddings group", 'id: "embeddings"' in INTEG
      and "min_similarity" in INTEG, "-")
ROUTE = read("app", "api", "omniflow", "admin", "providers", "route.ts")
check("admin BFF accepts embeddings + stt (STT save bug fixed)",
      '"embeddings",' in ROUTE and '"stt",' in ROUTE, "-")
for glyph in ("\u25b6", "\u2699", "\u26a1", "\u2714", "\u2709"):
    check("no emoji-capable glyph " + repr(glyph), glyph not in CARD, "-")

summary("kb_semantic")
