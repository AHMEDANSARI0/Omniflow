"""§229 Model Router - tiers, routes, failover, breaker, admin API.

Run from omniflow-backend-patch with PYTHONPATH=$PWD:../tools/cp-testrig.
Units on the planner / validation; portal_llm.chat_json and
chat_messages_json with a fake transport (routing, failover, breaker, the
ledger hook shapes the older tests rely on); then the real admin routes on
`pgserver` (PostgreSQL 16): saving group "router" through the existing
providers API (validation, sealing, masking), the ledger route column on
an old table, the overview report and the provider test. The database
half is skipped when pgserver is missing.
"""
import json
import os
import sys
import time

from test_lib import check, summary

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "svc-test-key")
os.environ["OF_SECRETS_KEY"] = "model-router-test-secret-key-0123456789abcdef"
for name in list(os.environ):
    if name.startswith("OF_ROUTER_") or name.startswith("OF_LLM_"):
        os.environ.pop(name)
sys.path.insert(0, os.getcwd())
sys.modules.pop("portal_db", None)
ROOT = os.environ.get("OF_RIG_WEB_ROOT") or os.path.abspath(os.path.join(os.getcwd(), ".."))

import platform_settings  # noqa: E402
import portal_ai_usage  # noqa: E402
import portal_llm  # noqa: E402
import portal_model_router as R  # noqa: E402

STORE = {}
_real_cached = platform_settings._cached
platform_settings._cached = lambda name: STORE.get(name, "")

MAIN = {"base_url": "https://main.example/v1", "api_key": "k-main", "model": "main-model"}


def configure(**values):
    STORE.clear()
    STORE.update({"router." + k: v for k, v in values.items()})
    R.reset_breaker()


def plan(feature, **values):
    configure(**values)
    return R.plan(feature, MAIN)


def brief(targets):
    return [(t["provider"], t["model"], t["route"], t["base_url"]) for t in targets]


print("== planner ==")
configure()
cfg = R.settings()
check("defaults: routing on, failover on, both tiers on the AI engine, breaker 3 / 60s",
      cfg["mode"] == "on" and cfg["failover"] == "on"
      and cfg["tiers"] == {"fast": {"provider": "primary", "model": ""},
                           "smart": {"provider": "primary", "model": ""}}
      and (cfg["breaker_failures"], cfg["breaker_seconds"]) == (3, 60), cfg)
check("zero config: every task is exactly the AI engine (route blank)",
      all(brief(plan(f)) == [("primary", "main-model", "", "https://main.example/v1")]
          for f in ("brain", "intent", "other", "", "assistant", "nonsense")))
check("fast model on the AI engine -> fast tasks use it",
      brief(plan("intent", fast_model="mini")) == [("primary", "mini", "fast", "https://main.example/v1")])
check("smart tasks stay on the AI engine model when only fast is set",
      brief(plan("brain", fast_model="mini"))[0][1:3] == ("main-model", ""))
check("a tier model equal to the AI engine model is not a route change",
      plan("intent", fast_model="main-model")[0]["route"] == "")
targets = plan("brain", smart_provider="secondary", smart_model="big",
               secondary_api_key="k-sec", secondary_base_url="https://sec.example/v1")
check("smart tier on the secondary provider + AI engine as failover",
      brief(targets) == [("secondary", "big", "smart", "https://sec.example/v1"),
                         ("primary", "main-model", "failover", "https://main.example/v1")]
      and targets[0]["api_key"] == "k-sec" and targets[1]["api_key"] == "k-main", brief(targets))
check("tier on the secondary without a key -> AI engine, no failover",
      brief(plan("brain", smart_provider="secondary", smart_model="big"))
      == [("primary", "big", "smart", "https://main.example/v1")])
targets = plan("intent", fast_model="mini", secondary_api_key="k-sec")
check("failover target: blank secondary address / model reuse the AI engine address / task model",
      brief(targets) == [("primary", "mini", "fast", "https://main.example/v1"),
                         ("secondary", "mini", "failover", "https://main.example/v1")]
      and targets[1]["api_key"] == "k-sec", brief(targets))
check("secondary default model used for failover when set",
      plan("brain", secondary_api_key="k", secondary_model="llama")[1]["model"] == "llama")
check("failover off -> one target",
      len(plan("brain", secondary_api_key="k", failover="off")) == 1)
check("routing off -> AI engine only, whatever else is saved",
      brief(plan("intent", mode="off", fast_model="mini", secondary_api_key="k"))
      == [("primary", "main-model", "", "https://main.example/v1")])
check("routes_json moves a task to another tier",
      plan("intent", fast_model="mini", smart_model="big",
           routes_json='{"intent":"smart"}')[0]["model"] == "big"
      and plan("brain", smart_model="big", routes_json='{"brain":"main"}')[0]["model"] == "main-model")
check("unknown features use the 'other' route (AI engine)",
      R.tier_for("does-not-exist", R.settings()) == "main" and R.tier_for("", R.settings()) == "main")
check("env fallback when the panel is blank", (
    os.environ.__setitem__("OF_ROUTER_FAST_MODEL", "env-mini"),
    plan("intent")[0]["model"] == "env-mini",
    os.environ.pop("OF_ROUTER_FAST_MODEL"))[1])
check("bad saved values fall back to defaults",
      (configure(mode="maybe", fast_provider="mars", breaker_failures="999"),
       R.settings())[1]["mode"] == "on" and R.settings()["tiers"]["fast"]["provider"] == "primary"
      and R.settings()["breaker_failures"] == 20)

print("== breaker ==")
configure(secondary_api_key="k-sec", breaker_failures="2", breaker_seconds="30")
R.note("primary", False)
check("one failure does not pause", not R.is_open("primary"))
R.note("primary", False)
check("N failures in a row pause the provider", R.is_open("primary")
      and R.breaker_state()["primary"]["paused"]
      and 25 <= R.breaker_state()["primary"]["paused_seconds_left"] <= 30)
check("paused AI engine is skipped while the secondary can answer",
      brief(R.plan("brain", MAIN)) == [("secondary", "main-model", "failover", "https://main.example/v1")])
R.note("primary", True)
check("a success closes it again", not R.is_open("primary") and len(R.plan("brain", MAIN)) == 2)
R.note("nope", False)
check("unknown provider names are ignored", "nope" not in R.breaker_state())

print("== validation ==")
cases = [
    ("mode", "ON", ("on", None)), ("mode", "sometimes", "must be on or off"),
    ("fast_provider", "Secondary", ("secondary", None)), ("smart_provider", "x", "primary or secondary"),
    ("fast_model", "gpt-4o-mini", ("gpt-4o-mini", None)),
    ("fast_model", "models/gemini-2.0-flash", ("models/gemini-2.0-flash", None)),
    ("smart_model", "two words", "without spaces"),
    ("secondary_base_url", "https://api.groq.com/openai/v1/", ("https://api.groq.com/openai/v1", None)),
    ("secondary_base_url", "http://localhost:11434/v1", ("http://localhost:11434/v1", None)),
    ("secondary_base_url", "ftp://x", "http(s) address"),
    ("secondary_base_url", "https://x/v1?key=1", "http(s) address"),
    ("secondary_api_key", "has space", "looks wrong"),
    ("routes_json", "[1]", "JSON object"), ("routes_json", "{", "JSON object"),
    ("routes_json", '{"vision":"fast"}', 'unknown task "vision"'),
    ("routes_json", '{"intent":"turbo"}', "fast, smart or main"),
    ("routes_json", '{"sentiment":"smart","intent":"fast"}', ('{"sentiment":"smart"}', None)),
    ("routes_json", '{"intent":"fast"}', ("", None)),
    ("breaker_failures", "0", "between 1 and 20"), ("breaker_seconds", "5", "between 10 and 3600"),
    ("breaker_seconds", "120", ("120", None)), ("fast_model", "", ("", None)),
]
bad = []
for name, raw, expected in cases:
    got = R.clean_value(name, raw)
    if isinstance(expected, tuple):
        if got != expected:
            bad.append((name, raw, got))
    elif not (got[1] and expected in got[1] and got[1].startswith("router." + name)):
        bad.append((name, raw, got))
check("clean_value: every rule (and only real defaults are dropped from routes_json)", not bad, bad)
check("routable tasks are exactly the chat_json features; dedicated ones are not routable",
      set(R.DEFAULT_TIERS) <= set(portal_ai_usage.FEATURE_LABELS)
      and not {"assistant", "vision", "voice_note", "kb_embed", "kb_ocr"} & set(R.DEFAULT_TIERS))

print("== chat_json through the router ==")
calls, ledger = [], []
_real_http, _real_runtime, _real_gate = portal_llm._http_post_json, portal_llm._runtime, portal_ai_usage.gate
_real_record = portal_ai_usage.record
portal_ai_usage.gate = lambda feature, client_id, cur=None: None
portal_ai_usage.record = lambda *a, **k: ledger.append((a, k)) or True
portal_llm._runtime = lambda: dict(MAIN, enabled=True)
replies = {}


def fake_http(url, headers, payload):  # the 3-argument shape older stubs use
    calls.append((url, headers["Authorization"], payload["model"]))
    reply = replies.get(url.split("/v1")[0], {"ok": True})
    if reply is None:
        return None
    if reply == "bad":
        return {"choices": [{"message": {"content": "not json"}}]}
    return {"choices": [{"message": {"content": json.dumps(reply)}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 2}}


portal_llm._http_post_json = fake_http


def run(feature, **values):
    configure(**values)
    calls.clear()
    ledger.clear()
    with portal_llm.usage_scope(feature, 5):
        return portal_llm.chat_json("s", "u")


out = run("intent")
check("zero config: one call to the AI engine, ledger row without a route (old shape)",
      out == {"ok": True} and calls == [("https://main.example/v1/chat/completions", "Bearer k-main",
                                         "main-model")]
      and ledger[0][1] == {"cur": None, "agent_id": 0} and ledger[0][0][:3] == (5, "intent", "main-model"),
      (calls, ledger))
out = run("intent", fast_model="mini")
check("fast task -> fast model; ledger route 'fast'",
      calls[0][2] == "mini" and ledger[0][1].get("route") == "fast" and ledger[0][0][2] == "mini", ledger)
replies = {"https://main.example": None}
out = run("brain", secondary_api_key="k-sec", secondary_base_url="https://sec.example/v1",
          secondary_model="backup-model")
check("AI engine down -> the secondary answers; both calls in the ledger",
      out == {"ok": True}
      and [c[0] for c in calls] == ["https://main.example/v1/chat/completions",
                                    "https://sec.example/v1/chat/completions"]
      and calls[1][1:] == ("Bearer k-sec", "backup-model")
      and [(a[2], a[6], k.get("route", "")) for a, k in ledger]
      == [("main-model", False, ""), ("backup-model", True, "failover")], (calls, ledger))
replies = {"https://main.example": "bad"}
out = run("brain", secondary_api_key="k-sec", secondary_base_url="https://sec.example/v1")
check("AI engine answered with unusable JSON -> no failover (model, not outage)",
      out is None and len(calls) == portal_llm.ATTEMPTS and len(ledger) == 1, calls)
replies = {"https://main.example": None}
out = run("brain")
check("no secondary -> None after the AI engine fails (as before)", out is None and len(calls) == 1)
configure(secondary_api_key="k-sec", secondary_base_url="https://sec.example/v1", breaker_failures="2")
for _ in range(2):
    with portal_llm.usage_scope("brain", 5):
        portal_llm.chat_json("s", "u")
calls.clear()
with portal_llm.usage_scope("brain", 5):
    out = portal_llm.chat_json("s", "u")
check("after 2 outages in a row the AI engine is skipped (straight to the secondary)",
      out == {"ok": True} and [c[0] for c in calls] == ["https://sec.example/v1/chat/completions"], calls)
replies = {}
portal_ai_usage.gate = lambda feature, client_id, cur=None: "kill_switch"
calls.clear()
check("kill switch still stops every call before routing", run("brain", secondary_api_key="k") is None
      and calls == [])
portal_ai_usage.gate = lambda feature, client_id, cur=None: None
portal_llm._runtime = lambda: dict(MAIN, enabled=False)
check("AI engine switched off -> no call even with a secondary", run("brain", secondary_api_key="k") is None
      and calls == [])
portal_llm._runtime = lambda: dict(MAIN, enabled=True)
portal_llm._record_usage, saved_hook = (lambda model, usage, ok, started: ledger.append(model)), \
    portal_llm._record_usage
check("4-argument _record_usage stubs keep working on unrouted calls", run("brain") == {"ok": True}
      and ledger == ["main-model"], ledger)
portal_llm._record_usage = saved_hook
broken = R.plan
R.plan = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("router broke"))
check("a broken router falls back to the AI engine", run("intent", fast_model="mini") == {"ok": True}
      and calls[0][2] == "main-model")
R.plan = broken

print("== assistant failover ==")
posts = []
answers = {}


def fake_detail(url, headers, payload, timeout):
    posts.append((url, payload["model"]))
    got = answers.get(url.split("/v1")[0])
    if got is None:
        return None, "HTTP 503: overloaded"
    if got == "bad":
        return {"choices": [{"message": {"content": "?"}}]}, ""
    return {"choices": [{"message": {"content": '{"answer": "hi"}'}}]}, ""


_real_detail = portal_llm._post_detail
portal_llm._post_detail = fake_detail
answers = {"https://sec.example": "ok"}
runtime = {"active": True, "api_key": "k-main", "base_url": "https://main.example/v1", "model": "asst"}
configure(secondary_api_key="k-sec", secondary_base_url="https://sec.example/v1")
ledger.clear()
with portal_llm.usage_scope("assistant", 5):
    parsed, error = portal_llm.chat_messages_json([{"role": "user", "content": "x"}], runtime)
check("assistant outage -> the secondary answers",
      parsed == {"answer": "hi"} and [p[0].split("/v1")[0] for p in posts]
      == ["https://main.example", "https://sec.example"]
      and ledger[-1][1].get("route") == "failover", (posts, ledger))
posts.clear()
answers = {"https://main.example": "bad"}
parsed, error = portal_llm.chat_messages_json([{"role": "user", "content": "x"}], runtime)
check("assistant: unusable answer is not failed over", parsed is None and len(posts) == 1)
posts.clear()
answers = {}
configure()
parsed, error = portal_llm.chat_messages_json([{"role": "user", "content": "x"}], runtime)
check("assistant without a secondary: the provider's reason comes back (as before)",
      parsed is None and error == "HTTP 503: overloaded" and len(posts) == 1, error)
portal_llm._post_detail = _real_detail
portal_llm._http_post_json, portal_llm._runtime = _real_http, _real_runtime
portal_ai_usage.gate, portal_ai_usage.record = _real_gate, _real_record


def web():
    print("== website pins ==")

    def read(rel):
        return open(os.path.join(ROOT, rel), encoding="utf-8").read()

    page = read("app/admin/(panel)/ai-router/ModelRouterClient.tsx")
    check("admin page: tiers, secondary, routes, dedicated, usage, breaker, save via providers",
          all(s in page for s in ('"/api/omniflow/admin/ai/router?days="', '"/api/omniflow/admin/ai/router/test"',
                                  'group: "router"', "Secondary provider", "Task routes", "Dedicated routes",
                                  "Models in use", "Routing and failover", "routes_json")))
    check("client page imports types only", "import type {" in page
          and 'from "../../../../lib/omniflow/admin-control-plane"' in page)
    check("sidebar entry", 'href: "/admin/ai-router"' in read("app/admin/components/AdminSidebar.tsx"))
    lib = read("lib/omniflow/admin-control-plane.ts")
    check("admin client: router group, overview, test, CP 400 message kept",
          all(s in lib for s in ('| "router";', "export async function getAdminModelRouter(",
                                 "export async function testAdminModelRouter(", "passStatuses: [400]",
                                 "timeoutMs: 20_000")))
    route = read("app/api/omniflow/admin/providers/route.ts")
    check("providers BFF accepts router and returns the CP sentence",
          '  "router",\n];' in route and "message: result.invalid" in route)
    test_route = read("app/api/omniflow/admin/ai/router/test/route.ts")
    check("test BFF: longer budget, target whitelist", "export const maxDuration = 30;" in test_route
          and 'const TARGETS: RouterTestTarget[] = ["primary", "secondary", "fast", "smart"];' in test_route)
    check("overview BFF exists", "getAdminModelRouter" in read("app/api/omniflow/admin/ai/router/route.ts"))
    emoji = (0x25B6, 0x261D, 0x2714, 0x26A1, 0x2699, 0x2709, 0x260E, 0x2733, 0x263A, 0x25FC, 0x27A1)
    for rel in ("app/admin/(panel)/ai-router/ModelRouterClient.tsx", "app/admin/(panel)/ai-router/page.tsx"):
        check("icon law: " + rel, not [c for c in read(rel) if ord(c) in emoji or ord(c) > 0x1F000])


try:
    import pgserver
    import psycopg2
except Exception:
    pgserver = None

if pgserver is None:
    print("  skip: pgserver not installed - database half not run")
    platform_settings._cached = _real_cached
    web()
    sys.exit(1 if summary("model_router") else 0)

# ---------------------------------------------------------------------------
# real PostgreSQL
# ---------------------------------------------------------------------------
print("== admin API on real PostgreSQL ==")
import tempfile  # noqa: E402

data_dir = tempfile.mkdtemp(prefix="of_router_pg_")
server = pgserver.get_server(data_dir, cleanup_mode="stop")
os.environ.update({"DB_HOST": data_dir, "DB_PORT": "5432", "DB_NAME": "postgres",
                   "DB_USER": "postgres", "DB_PASSWORD": "", "PGSSLMODE": "disable"})
import portal_db  # noqa: E402

platform_settings.portal_db = portal_db
portal_ai_usage.portal_db = portal_db
platform_settings._cached = _real_cached
platform_settings.invalidate_cache()
R.reset_breaker()
from flask import Flask  # noqa: E402
import admin_providers  # noqa: E402

admin_providers.portal_db = portal_db
admin_providers.platform_settings = platform_settings


def sql(query, params=None):
    c = psycopg2.connect(host=data_dir, dbname="postgres", user="postgres")
    try:
        with c.cursor() as cur:
            cur.execute(query, params)
            got = cur.fetchall() if cur.description else None
        c.commit()
        return got
    finally:
        c.close()


portal_db.ensure_tables()
sql("CREATE TABLE IF NOT EXISTS portal_action_log (id BIGSERIAL PRIMARY KEY,"
    " client_id BIGINT, action TEXT, actor_kind TEXT, actor_user_id BIGINT,"
    " conversation_id BIGINT, note TEXT, created_at TIMESTAMPTZ DEFAULT NOW())")
# a ledger from before §229 (no route column) with one old row
sql("CREATE TABLE portal_ai_usage (id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL DEFAULT 0,"
    " feature TEXT NOT NULL DEFAULT 'other', model TEXT NOT NULL DEFAULT '',"
    " prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,"
    " latency_ms INTEGER NOT NULL DEFAULT 0, ok BOOLEAN NOT NULL DEFAULT TRUE,"
    " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), agent_id BIGINT)")
sql("INSERT INTO portal_ai_usage (client_id, feature, model, prompt_tokens, completion_tokens)"
    " VALUES (1, 'brain', 'main-model', 1000, 100)")
portal_ai_usage._DDL_READY = False
portal_ai_usage.ENABLED = True
check("ledger write with a route on an old table (column added, old row kept)",
      portal_ai_usage.record(1, "intent", "mini", 200, 10, 300, True, route="fast")
      and portal_ai_usage.record(1, "brain", "backup-model", 500, 50, 900, True, route="failover")
      and portal_ai_usage.record(1, "brain", "main-model", 400, 40, 800, False)
      and sql("SELECT model, route FROM portal_ai_usage ORDER BY id")
      == [("main-model", ""), ("mini", "fast"), ("backup-model", "failover"), ("main-model", "")])

app = Flask("router_test")
app.register_blueprint(admin_providers.bp)
app.register_blueprint(R.bp)
client = app.test_client()
KEY = {"X-Omniflow-Key": os.environ["OMNIFLOW_SERVICE_KEY"]}
check("admin router needs the service key", client.get("/api/v1/admin/ai/router").status_code == 403
      and client.post("/api/v1/admin/ai/router/test", json={}).status_code == 403)


def put(values):
    return client.put("/api/v1/admin/providers", headers=KEY, json={"group": "router", "values": values})


r = put({"fast_model": "two words"})
check("save: invalid value -> 400 with the router sentence", r.status_code == 400
      and r.get_json()["error"]["message"].startswith("router.fast_model must be a model name"),
      r.get_data(as_text=True)[:200])
r = put({"routes_json": '{"vision":"fast"}'})
check("save: unknown task refused", r.status_code == 400 and "unknown task" in r.get_json()["error"]["message"])
check("nothing stored after refusals", platform_settings.get_group("router") == {})
sql("INSERT INTO platform_settings (key, value) VALUES ('llm.api_key', 'k-main'),"
    " ('llm.model', 'main-model'), ('llm.base_url', 'https://main.example/v1'),"
    " ('llm.prices_json', '{\"main-model\": {\"input\": 1, \"output\": 2}, \"mini\": {\"input\": 0.1, \"output\": 0.2}}')"
    " ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value")
r = put({"mode": "On", "fast_provider": "primary", "fast_model": "mini", "smart_provider": "secondary",
         "smart_model": "", "routes_json": '{"sentiment":"smart","intent":"fast"}',
         "secondary_base_url": "https://sec.example/v1/", "secondary_api_key": "sk-secondary-123456",
         "secondary_model": "backup-model", "breaker_failures": "4", "breaker_seconds": "90"})
check("save: valid router settings", r.status_code == 200 and r.get_json()["configured"],
      r.get_data(as_text=True)[:200])
stored = dict(sql("SELECT key, value FROM platform_settings WHERE key LIKE 'router.%'"))
check("stored normalised: lower-case mode, trimmed URL, only non-default routes",
      stored["router.mode"] == "on" and stored["router.secondary_base_url"] == "https://sec.example/v1"
      and stored["router.routes_json"] == '{"sentiment":"smart"}', stored)
check("secondary key sealed at rest (vault)", stored["router.secondary_api_key"].startswith("ofv1:")
      and "sk-secondary" not in stored["router.secondary_api_key"], stored["router.secondary_api_key"][:12])
listed = client.get("/api/v1/admin/providers", headers=KEY).get_json()["groups"]["router"]
check("providers list masks the secondary key", listed["secondary_api_key"].endswith("3456")
      and "sk-" not in listed["secondary_api_key"], listed["secondary_api_key"])
r = put({"secondary_api_key": "", "fast_model": "mini2"})
check("blank key on save keeps the saved key", r.get_json()["kept_blank"] == ["secondary_api_key"]
      and platform_settings.get_group("router")["secondary_api_key"] == "sk-secondary-123456")
put({"fast_model": "mini"})
platform_settings.invalidate_cache()
live = R.settings()
check("runtime reads the saved settings (unsealed key)", live["secondary"]["api_key"] == "sk-secondary-123456"
      and live["tiers"]["smart"] == {"provider": "secondary", "model": ""}
      and live["breaker_failures"] == 4 and live["routes"] == {"sentiment": "smart"}, live)

view = client.get("/api/v1/admin/ai/router?days=7", headers=KEY).get_json()
routes = {r["feature"]: r for r in view["routes"]}
check("overview: effective tiers (smart on the secondary's default model)",
      view["tiers"]["smart"] == {"provider": "secondary", "model": "backup-model"}
      and view["tiers"]["fast"] == {"provider": "primary", "model": "mini"}
      and view["tiers"]["main"] == {"provider": "primary", "model": "main-model"}, view["tiers"])
check("overview: per-task tier, default and model",
      routes["intent"]["tier"] == "fast" and routes["intent"]["model"] == "mini"
      and routes["sentiment"]["tier"] == "smart" and routes["sentiment"]["default_tier"] == "fast"
      and routes["sentiment"]["provider"] == "secondary" and routes["other"]["model"] == "main-model",
      routes["sentiment"])
check("overview: usage per task with failovers and cost from the saved prices",
      routes["brain"]["calls"] == 3 and routes["brain"]["failed"] == 1 and routes["brain"]["failovers"] == 1
      and routes["intent"]["calls"] == 1 and routes["intent"]["cost_usd"] == 0.000022
      and view["usage"]["calls"] == 4 and view["usage"]["failovers"] == 1 and view["usage"]["routed"] == 2,
      (routes["brain"], routes["intent"], view["usage"]))
models = {m["model"]: m for m in view["usage"]["models"]}
check("overview: models in use with average time", models["main-model"]["calls"] == 2
      and models["main-model"]["failed"] == 1 and models["mini"]["avg_latency_ms"] == 300, models)
check("overview: settings echo with the key masked, warnings for unpriced models",
      view["settings"]["secondary_api_key"].endswith("3456") and view["settings"]["fast_model"] == "mini"
      and view["settings"]["routes"] == {"sentiment": "smart"}
      and any("backup-model" in w and "price" in w for w in view["warnings"]), view["warnings"])
check("overview: dedicated routes listed (assistant fails over)",
      {d["feature"] for d in view["dedicated"]} >= {"assistant", "vision", "voice_note", "kb_embed"}
      and [d["failover"] for d in view["dedicated"] if d["feature"] == "assistant"] == [True])
check("overview: breaker settings and state", view["breaker"]["failures"] == 4
      and view["breaker"]["seconds"] == 90 and view["breaker"]["state"]["primary"]["paused"] is False)

seen = []


def fake_detail_ok(url, headers, payload, timeout):
    seen.append((url, headers["Authorization"], payload["model"]))
    if "sec.example" in url:
        return None, "HTTP 401: invalid key"
    return {"choices": [{"message": {"content": '{"ok": true}'}}],
            "usage": {"prompt_tokens": 9, "completion_tokens": 3}}, ""


portal_llm._post_detail = fake_detail_ok
r = client.post("/api/v1/admin/ai/router/test", headers=KEY, json={"target": "fast"})
check("test fast tier -> AI engine with the fast model", r.status_code == 200 and r.get_json()["ok"]
      and seen[-1] == ("https://main.example/v1/chat/completions", "Bearer k-main", "mini"), r.get_json())
r = client.post("/api/v1/admin/ai/router/test", headers=KEY, json={"target": "smart"})
check("test smart tier -> secondary, provider error shown", r.get_json()["ok"] is False
      and r.get_json()["error"] == "HTTP 401: invalid key" and seen[-1][1:] == ("Bearer sk-secondary-123456",
                                                                              "backup-model"), r.get_json())
check("test calls are in the ledger as route 'test' (workspace 0)",
      sql("SELECT client_id, model, route, ok FROM portal_ai_usage WHERE route = 'test' ORDER BY id")
      == [(0, "mini", "test", True), (0, "backup-model", "test", False)])
r = client.post("/api/v1/admin/ai/router/test", headers=KEY, json={"target": "everything"})
check("bad test target -> 400", r.status_code == 400)
sql("DELETE FROM platform_settings WHERE key = 'router.secondary_api_key'")
platform_settings.invalidate_cache()
r = client.post("/api/v1/admin/ai/router/test", headers=KEY, json={"target": "secondary"})
check("secondary without a key -> 409 with what to do", r.status_code == 409
      and "API key" in r.get_json()["error"]["message"])
view = client.get("/api/v1/admin/ai/router", headers=KEY).get_json()
check("smart tier without the secondary key -> warning and AI engine model",
      view["tiers"]["smart"] == {"provider": "primary", "model": "main-model"}
      and any(w.startswith("Smart tasks are set to the secondary") for w in view["warnings"]))
portal_llm._post_detail = _real_detail

server.cleanup()
web()
sys.exit(1 if summary("model_router") else 0)
