"""AI usage/cost ledger + unified AI audit (platform services): the
portal_llm usage scope + recording hook, the ledger write paths (caller
transaction behind a SAVEPOINT / own connection / kill switch), the price
table + cost estimate, the usage report rollups, the audit categories,
timeline + overview read models with their SQL, API auth, and the wiring
pins (scopes at every LLM call site, admin price field, page cards)."""
import os
import time

from flask import Flask

import portal_ai_audit as pa
import portal_ai_usage as pu
import portal_llm
from test_lib import check, install_db_stub, summary

PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}
API_KEY_PRINCIPAL = dict(PRINCIPAL, via_api_key=True)
PRICES = {"gpt-4o-mini": {"input": 0.15, "output": 0.60},
          "default": {"input": 1.0, "output": 2.0}}


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


def run_api(module, script, path, principal=PRINCIPAL):
    pu._DDL_READY = True
    install_db_stub(module, script)
    app = Flask("ai-ops-test")
    app.register_blueprint(module.bp)
    with PrincipalStub(module, principal):
        return app.test_client().get(path)


# ---------- llm scope + hook ----------

print("== llm scope ==")
check("no scope -> defaults", portal_llm.current_scope() == ("", 0, None), "-")
with portal_llm.usage_scope("brain", 7, "CUR"):
    inner = portal_llm.current_scope()
    with portal_llm.usage_scope("intent", 7):
        nested = portal_llm.current_scope()
    after_inner = portal_llm.current_scope()
check("scopes nest, innermost wins, and unwind",
      inner == ("brain", 7, "CUR") and nested == ("intent", 7, None)
      and after_inner == inner and portal_llm.current_scope() == ("", 0, None),
      (inner, nested, after_inner))

recorded = []
_orig_record = pu.record
pu.record = lambda *a, **k: recorded.append((a, k)) or True
with portal_llm.usage_scope("brain", 7, "CUR"):
    portal_llm._record_usage("gpt-4o-mini", {"prompt_tokens": 120,
                                             "completion_tokens": 30},
                             True, time.time() - 0.25)
check("hook passes feature/client/model/tokens/latency/ok + the scope cursor",
      recorded and recorded[0][0][:5] == (7, "brain", "gpt-4o-mini", 120, 30)
      and 200 <= recorded[0][0][5] <= 5000 and recorded[0][0][6] is True
      and recorded[0][1] == {"cur": "CUR"}, recorded)
recorded[:] = []
portal_llm._record_usage("m", None, False, time.time())
check("no usage block -> zero tokens, feature 'other', workspace 0",
      recorded[0][0][:4] == (0, "other", "m", 0) and recorded[0][0][6] is False,
      recorded)

# the real chat_json records through the hook (fake transport)
_orig_post, _orig_runtime = portal_llm._http_post_json, portal_llm._runtime
portal_llm._runtime = lambda: {"base_url": "https://llm.test/v1", "api_key": "k",
                               "model": "gpt-4o-mini", "enabled": True}
portal_llm._http_post_json = lambda url, headers, payload: {
    "choices": [{"message": {"content": "{\"reply\": \"ok\"}"}}],
    "usage": {"prompt_tokens": 11, "completion_tokens": 4, "total_tokens": 15}}
recorded[:] = []
with portal_llm.usage_scope("workflow", 3):
    out = portal_llm.chat_json("s", "u")
check("chat_json success -> parsed payload + one usage record (ok)",
      out == {"reply": "ok"} and len(recorded) == 1
      and recorded[0][0][:5] == (3, "workflow", "gpt-4o-mini", 11, 4)
      and recorded[0][0][6] is True, recorded)
portal_llm._http_post_json = lambda url, headers, payload: None
recorded[:] = []
out = portal_llm.chat_json("s", "u")
check("chat_json transport failure -> None + one failed record",
      out is None and len(recorded) == 1 and recorded[0][0][6] is False
      and recorded[0][0][3:5] == (0, 0), recorded)
portal_llm._http_post_json = lambda url, headers, payload: {
    "choices": [{"message": {"content": "not json"}}],
    "usage": {"prompt_tokens": 9, "completion_tokens": 1}}
recorded[:] = []
out = portal_llm.chat_json("s", "u")
check("unparseable answer -> None, tokens still billed as failed",
      out is None and recorded[0][0][3:5] == (9, 1) and recorded[0][0][6] is False,
      recorded)
portal_llm._runtime = lambda: {"enabled": False, "api_key": ""}
recorded[:] = []
check("engine disabled -> no call, no record", portal_llm.chat_json("s", "u") is None
      and not recorded, "-")
portal_llm._http_post_json, portal_llm._runtime = _orig_post, _orig_runtime
pu.record = _orig_record

# ---------- ledger write paths ----------

print("== ledger ==")
pu._DDL_READY = True
pu.ENABLED = True
conn = install_db_stub(pu, [[], [], []])
ok = pu.record(1, "brain", "gpt-4o-mini", 100, 20, 850, True, cur=conn.cur)
ex = conn.cur.executed
check("caller cursor: SAVEPOINT / INSERT / RELEASE (transaction-safe)",
      ok is True and ex[0][0] == "SAVEPOINT of_ai_usage"
      and ex[1][0].startswith("INSERT INTO portal_ai_usage")
      and ex[1][1] == (1, "brain", "gpt-4o-mini", 100, 20, 850, True)
      and ex[2][0] == "RELEASE SAVEPOINT of_ai_usage", ex)
conn = install_db_stub(pu, [[], Exception("no table"), []])
ok = pu.record(1, "brain", "m", 1, 1, 1, True, cur=conn.cur)
check("insert failure -> ROLLBACK TO SAVEPOINT, caller's transaction survives",
      ok is False and conn.cur.executed[2][0] == "ROLLBACK TO SAVEPOINT of_ai_usage",
      conn.cur.executed)
conn = install_db_stub(pu, [[]])
ok = pu.record(2, "bogus-feature", "m", -5, 3, 10, False)
check("own connection path: one INSERT, committed, feature normalised, negatives clamped",
      ok is True and conn.cur.executed[0][1] == (2, "other", "m", 0, 3, 10, False)
      and conn.committed and conn.closed, conn.cur.executed)
pu.ENABLED = False
conn = install_db_stub(pu, [])
check("OF_AI_USAGE=0 -> nothing written", pu.record(1, "brain", "m", 1, 1, 1, True) is False
      and conn.cur.executed == [], "-")
pu.ENABLED = True

# ---------- prices + cost ----------

print("== prices ==")
check("parse_prices: lower-cases models, drops junk + negatives",
      pu.parse_prices('{"GPT-4o-mini": {"input": 0.15, "output": 0.6}, "x": 1,'
                      ' "neg": {"input": -1, "output": 1}}')
      == {"gpt-4o-mini": {"input": 0.15, "output": 0.6}}, "-")
check("parse_prices: bad JSON / non-object -> {}", pu.parse_prices("nope") == {}
      and pu.parse_prices("[1]") == {} and pu.parse_prices(None) == {}, "-")
check("estimate_cost: per-million maths, default fallback, unknown -> None",
      pu.estimate_cost("gpt-4o-mini", 1000000, 1000000, PRICES) == 0.75
      and pu.estimate_cost("claude-x", 1000000, 0, PRICES) == 1.0
      and pu.estimate_cost("claude-x", 1, 1, {"gpt-4o-mini": PRICES["gpt-4o-mini"]}) is None
      and pu.estimate_cost("m", 1, 1, {}) is None, "-")
import platform_settings  # noqa: E402

_orig_get = platform_settings.get_setting
platform_settings.get_setting = lambda key, default=None: (
    '{"gpt-4o-mini": {"input": 0.15, "output": 0.6}}' if key == "llm.prices_json" else default)
check("prices() reads the admin-saved llm.prices_json", pu.prices()
      == {"gpt-4o-mini": {"input": 0.15, "output": 0.6}}, pu.prices())
platform_settings.get_setting = lambda key, default=None: default
os.environ["OF_AI_PRICES_JSON"] = '{"default": {"input": 1, "output": 1}}'
check("prices() falls back to OF_AI_PRICES_JSON", pu.prices() == {"default": {"input": 1.0, "output": 1.0}},
      pu.prices())
os.environ.pop("OF_AI_PRICES_JSON", None)
check("prices() empty when nothing configured", pu.prices() == {}, pu.prices())
platform_settings.get_setting = _orig_get
check("admin panel accepts the price table on the AI engine group",
      "prices_json" in platform_settings.GROUP_KEYS["llm"], platform_settings.GROUP_KEYS["llm"])

# ---------- usage report ----------

print("== usage report ==")
GROUPS = [
    {"feature": "brain", "model": "gpt-4o-mini", "ok": True, "calls": 10,
     "prompt_tokens": 5000, "completion_tokens": 1000, "avg_latency_ms": 900},
    {"feature": "brain", "model": "gpt-4o-mini", "ok": False, "calls": 2,
     "prompt_tokens": 0, "completion_tokens": 0, "avg_latency_ms": 6000},
    {"feature": "intent", "model": "gpt-4o-mini", "ok": True, "calls": 30,
     "prompt_tokens": 3000, "completion_tokens": 300, "avg_latency_ms": 400},
]
DAILY = [{"day": "2026-09-27", "calls": 20, "tokens": 5000},
         {"day": "2026-09-28", "calls": 22, "tokens": 4300}]
_orig_prices = pu.prices
pu.prices = lambda: PRICES
conn = install_db_stub(pu, [GROUPS, DAILY])
rep = pu.usage_report(conn.cur, 1, 7)
sql, params = conn.cur.executed[0]
check("report SQL: tenant + window, grouped by feature/model/ok",
      "client_id = %s" in sql and "make_interval(days => %s)" in sql
      and params == (1, 7) and "GROUP BY feature, model, ok" in sql
      and "GROUP BY DATE(created_at)" in conn.cur.executed[1][0], sql)
t = rep["totals"]
check("totals: calls/failed/tokens/latency/cost",
      t["calls"] == 42 and t["failed"] == 2 and t["tokens"] == 9300
      and t["prompt_tokens"] == 8000 and t["avg_latency_ms"] == int((9000 + 12000 + 12000) / 42)
      and t["cost_usd"] == round((8000 * 0.15 + 1300 * 0.6) / 1e6, 4)
      and t["priced"] is True, t)
check("by_feature sorted by calls with labels + cost",
      [f["feature"] for f in rep["by_feature"]] == ["intent", "brain"]
      and rep["by_feature"][1]["label"] == "AI Brain answers & drafts"
      and rep["by_feature"][1]["failed"] == 2
      and rep["by_feature"][0]["cost_usd"] == round((3000 * 0.15 + 300 * 0.6) / 1e6, 4),
      rep["by_feature"])
check("by_model + by_day + registry",
      rep["by_model"][0]["model"] == "gpt-4o-mini" and rep["by_model"][0]["calls"] == 42
      and rep["by_day"] == DAILY and rep["prices_configured"] is True
      and [f["key"] for f in rep["features"]] == list(pu.FEATURE_LABELS), rep["by_day"])
pu.prices = lambda: {}
conn = install_db_stub(pu, [GROUPS, DAILY])
rep = pu.usage_report(conn.cur, 1, 7)
check("no price table -> cost None, unpriced count, flag false (never a made-up number)",
      rep["totals"]["cost_usd"] is None and rep["totals"]["priced"] is False
      and rep["totals"]["unpriced_calls"] == 42 and rep["prices_configured"] is False
      and rep["by_feature"][0]["cost_usd"] is None, rep["totals"])
pu.prices = lambda: {"other-model": {"input": 1, "output": 1}}
conn = install_db_stub(pu, [GROUPS, DAILY])
rep = pu.usage_report(conn.cur, 1, 7)
check("partially priced -> totals cost withheld, unpriced calls reported",
      rep["totals"]["cost_usd"] is None and rep["totals"]["unpriced_calls"] == 42, rep["totals"])
conn = install_db_stub(pu, [[], []])
rep = pu.usage_report(conn.cur, 1, 999)
check("empty window + day clamp", rep["totals"]["calls"] == 0 and rep["days"] == pu.MAX_DAYS
      and rep["totals"]["avg_latency_ms"] == 0, rep)
pu.prices = _orig_prices

r = run_api(pu, [[], []], "/api/v1/portal/ai/usage?days=30")
check("GET ai/usage 200", r.status_code == 200 and r.get_json()["days"] == 30, r.get_json())
r = run_api(pu, [[], []], "/api/v1/portal/ai/usage", principal=API_KEY_PRINCIPAL)
check("GET ai/usage readable by API keys", r.status_code == 200, r.status_code)
r = run_api(pu, [], "/api/v1/portal/ai/usage", principal=None)
check("GET ai/usage 401", r.status_code == 401, r.status_code)

# ---------- audit read model ----------

print("== audit ==")
for action, expected in (("escalation.opened", "handoffs"), ("workflow.handoff", "handoffs"),
                         ("bot.escalated", "handoffs"), ("approval.created", "approvals"),
                         ("action.create_order", "actions"), ("workflow.saved", "workflows"),
                         ("ai.answer", "answers"), ("kb.auto_reply", "answers"),
                         ("ai.draft", "drafts"), ("rule_fired", "rules"),
                         ("kb.source_ingested", "knowledge"), ("identity.merged", "memory"),
                         ("notifications.settings", "notifications"),
                         ("ai.settings", "settings"), ("message.sent", "other")):
    check("categorize " + action + " -> " + expected, pa.categorize(action) == expected,
          pa.categorize(action))
check("patterns come from the registry (LIKE prefixes)",
      "escalation.%" in pa._patterns() and "ai.answer%" in pa._patterns()
      and len(pa._patterns()) == sum(len(p) for _k, _l, p in pa.CATEGORIES), "-")

LOG = [
    {"id": 9, "action": "ai.answer", "actor_kind": "automation", "actor_user_id": None,
     "conversation_id": 42, "note": "Brain answered", "created_at": None},
    {"id": 8, "action": "escalation.opened", "actor_kind": "workflow", "actor_user_id": None,
     "conversation_id": 42, "note": "Workflow handoff", "created_at": None},
    {"id": 7, "action": "kb.source_published", "actor_kind": "customer_user",
     "actor_user_id": 11, "conversation_id": None, "note": "Published", "created_at": None},
]
conn = install_db_stub(pa, [LOG])
items = pa.timeline(conn.cur, 1, 7, "", 50)
sql, params = conn.cur.executed[0]
check("timeline SQL: tenant + window + (AI actor kinds OR known prefixes), newest first",
      "client_id = %s" in sql and "actor_kind = ANY(%s)" in sql
      and "action LIKE ANY(%s)" in sql and "ORDER BY id DESC" in sql
      and params[0] == 1 and params[1] == 7 and params[2] == list(pa.AI_ACTOR_KINDS)
      and params[4] == 50, (sql, params))
check("timeline items tagged with categories",
      [i["category"] for i in items] == ["answers", "handoffs", "knowledge"]
      and items[2]["actor_user_id"] == 11 and items[0]["conversation_id"] == 42, items)
conn = install_db_stub(pa, [LOG])
items = pa.timeline(conn.cur, 1, 7, "handoffs", 50)
check("category filter narrows in Python over a wider fetch",
      [i["id"] for i in items] == [8] and conn.cur.executed[0][1][4] == pa.LIST_LIMIT, items)

COUNTS = [{"action": "ai.answer", "actor_kind": "automation", "n": 12},
          {"action": "escalation.opened", "actor_kind": "automation", "n": 3},
          {"action": "workflow.completed", "actor_kind": "workflow", "n": 5},
          {"action": "zzz.unknown", "actor_kind": "bot", "n": 1}]
SUMMARY_ROWS = [{"open_now": 2, "open_high": 1, "opened_7d": 3, "resolved_7d": 1,
                 "avg_resolve_seconds": 60.0}]
import portal_escalation  # noqa: E402

portal_escalation._DDL_READY = True
pu.prices = lambda: {}
conn = install_db_stub(pa, [COUNTS,
                            [], [{"n": 4}], [],          # approvals block
                            [], SUMMARY_ROWS, [], [],    # escalations block
                            [], [], [], []])             # usage block
ov = pa.overview(conn.cur, 1, 7)
ex = conn.cur.executed
cats = {c["key"]: c["count"] for c in ov["by_category"]}
check("overview counts per category + actor",
      ov["total"] == 21 and cats["answers"] == 12 and cats["handoffs"] == 3
      and cats["workflows"] == 5 and cats["other"] == 1
      and ov["by_actor"] == {"automation": 15, "workflow": 5, "bot": 1}, ov)
check("overview: approvals pending + escalation queue + usage totals (savepoint-guarded)",
      ov["approvals_pending"] == 4 and ov["escalations"]["open"] == 2
      and ov["usage"]["totals"]["calls"] == 0 and ov["usage"]["prices_configured"] is False
      and ex[1][0] == "SAVEPOINT of_ai_audit" and ex[3][0] == "RELEASE SAVEPOINT of_ai_audit"
      and "status = 'pending'" in ex[2][0], ex)
conn = install_db_stub(pa, [COUNTS,
                            [], Exception("no approvals table"), [],
                            [], SUMMARY_ROWS, [], [],
                            [], [], [], []])
ov = pa.overview(conn.cur, 1, 7)
check("a missing table blanks only its block (ROLLBACK TO SAVEPOINT)",
      ov["approvals_pending"] is None and ov["escalations"]["open"] == 2
      and conn.cur.executed[3][0] == "ROLLBACK TO SAVEPOINT of_ai_audit", conn.cur.executed[:4])
pu.prices = _orig_prices

r = run_api(pa, [LOG], "/api/v1/portal/ai/audit?days=7&category=handoffs&limit=20")
body = r.get_json()
check("GET ai/audit 200 with categories registry", r.status_code == 200
      and body["category"] == "handoffs" and [i["id"] for i in body["items"]] == [8]
      and body["categories"][0]["key"] == "handoffs", body)
r = run_api(pa, [], "/api/v1/portal/ai/audit?category=bogus")
check("GET ai/audit 400 unknown category", r.status_code == 400, r.status_code)
r = run_api(pa, [COUNTS, [], [{"n": 0}], [], [], SUMMARY_ROWS, [], [], [], [], [], []],
            "/api/v1/portal/ai/overview", principal=API_KEY_PRINCIPAL)
check("GET ai/overview 200 (API keys read-only ok)", r.status_code == 200
      and r.get_json()["total"] == 21, r.status_code)
r = run_api(pa, [], "/api/v1/portal/ai/overview", principal=None)
check("GET ai/overview 401", r.status_code == 401, r.status_code)

# ---------- wiring pins ----------

print("== wiring pins ==")
HERE = os.path.dirname(os.path.abspath(__file__))
CP = os.path.join(HERE, "..", "..", "omniflow-backend-patch")
RIG13 = "/tmp/p13/Omniflow/"


def read(path):
    return open(path, encoding="utf8").read() if os.path.exists(path) else ""


APP = read(os.path.join(CP, "app.py"))
check("blueprints registered", "aux_app.register_blueprint(portal_ai_usage_bp)" in APP
      and "aux_app.register_blueprint(portal_ai_audit_bp)" in APP, "-")
for module, feature in (("portal_brain.py", '"brain", client_id, cur'),
                        ("portal_workflows.py", '"workflow", client_id, cur'),
                        ("portal_recovery.py", '"negotiation", client_id, cur'),
                        ("portal_recovery.py", '"copy", client_id, cur'),
                        ("connector_api.py", '"intent", tenant["client_id"]'),
                        ("portal_insights.py", '"sentiment"')):
    check("usage scope at " + module + " " + feature.split(",")[0],
          "portal_llm.usage_scope(" in read(os.path.join(CP, module))
          and feature in read(os.path.join(CP, module)), module)
LLM = read(os.path.join(CP, "portal_llm.py"))
check("chat_json signature unchanged (stubs keep working), hook inside",
      "def chat_json(system: str, user: str,\n              max_tokens: int = 120)" in LLM
      and "_record_usage(model, last_usage, True, started)" in LLM, "-")
check("no hardcoded prices anywhere", "0.15" not in read(pu.__file__).replace(
    '"gpt-4o-mini": {"input": 0.15, "output": 0.60}', ""), "-")

LIB = read(RIG13 + "lib/omniflow/portal.ts")
check("portal.ts AI ops client", all(t in LIB for t in (
    "export async function getAiUsage", "export async function getAiAudit",
    "export async function getAiOverview", '"api/v1/portal/ai/usage?days="',
    '"api/v1/portal/ai/overview?days="')), "-")
for rel, fn in (("ai/usage/route.ts", "getAiUsage"), ("ai/audit/route.ts", "getAiAudit"),
                ("ai/overview/route.ts", "getAiOverview")):
    src = read(RIG13 + "app/api/omniflow/portal/" + rel)
    check("BFF " + rel, bool(src) and fn in src and "export async function GET" in src
          and ('"' + "../" * 6 + 'lib/omniflow/portal"') in src, rel)
CARD = read(RIG13 + "app/dashboard/(portal)/bot/AiOpsCard.tsx")
check("AI operations card: overview counts, usage by feature, cost honesty, audit timeline",
      all(t in CARD for t in ("/api/omniflow/portal/ai/overview", "/api/omniflow/portal/ai/usage",
                              "/api/omniflow/portal/ai/audit", "by_feature", "prices_configured",
                              "not configured", "by_category", "approvals_pending")), "-")
check("AI operations card mounted on Configure AI", "<AiOpsCard />" in read(
    RIG13 + "app/dashboard/(portal)/bot/page.tsx"), "-")
ADMIN = read(RIG13 + "app/admin/(panel)/integrations/IntegrationsClient.tsx")
check("admin AI engine group has the model-prices field", 'key: "prices_json"' in ADMIN, "-")
check("UI copy English + text glyphs", "karein" not in CARD and "\\u25b6" not in CARD
      and "\\u2714" not in CARD, "-")

raise SystemExit(1 if summary("ai_ops") else 0)
