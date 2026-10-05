"""§241 AI execution traces + audit linkage (portal_ai_traces, portal_llm
scope collector, portal_brain trace enrichment, portal_ai_audit links).

Units (filter parsing incl. non-ASCII digits, plurals, cost only when every
call is priced, tool details, labels), the usage_scope collector (innermost
scope, cap, ledger still written, a stubbed ledger still collects), HTTP
guards (401 / 503 / 403 API key / 400 before any DB work / 503 without
internals), then the real thing on pgserver: the REAL portal_brain
maybe_answer inside an ingest-style transaction (inbound message + answer +
queued reply + audit row share one NOW()), a handoff, a two-message batch in
one transaction, a foreign workspace on the SAME conversation / agent ids,
list filters, the step-by-step detail, agent version at answer time, rename
/ delete fallbacks, missing optional tables, a deleted message, a pre-241
trace, the audit links, roles and read-only.
"""
import json
import os
import sys
import tempfile
import time

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "svc-test-key")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "admin-test-key")
for name in ("OF_AI_PRICES_JSON", "OF_BRAIN_MIN_CONFIDENCE"):
    os.environ.pop(name, None)
sys.path.insert(0, os.getcwd())
sys.modules.pop("portal_db", None)

from flask import Flask  # noqa: E402

from test_lib import check, summary  # noqa: E402
import portal_db  # noqa: E402
import portal_txn  # noqa: E402
import portal_llm  # noqa: E402
import portal_ai_traces as tr  # noqa: E402
import portal_ai_automation as qa  # noqa: E402
from portal_auth import PortalAuthUnavailable  # noqa: E402

HERE = os.getcwd()


def src(name):
    return open(os.path.join(HERE, name), encoding="utf8").read()


class Args(dict):
    def get(self, key, default=None):
        return super().get(key, default)


print("== filters ==")
f, msg = tr.parse_filters(Args())
check("blank -> defaults (7 days, 50 rows, no filters)", msg == "" and f == {
    "days": 7, "kind": "", "decision": "", "agent_id": 0, "conversation_id": 0, "limit": 50}, f)
f, _ = tr.parse_filters(Args(days=" 90 ", kind="draft", decision="handoff", agent_id="12",
                             conversation_id="7", limit="500"))
check("valid filters kept, limit clamped to 100", f == {
    "days": 90, "kind": "draft", "decision": "handoff", "agent_id": 12, "conversation_id": 7,
    "limit": 100}, f)
for bad in ({"days": "0"}, {"days": "91"}, {"days": "7.5"}, {"days": "-1"}, {"days": "\u0663"},
            {"days": "1e1"}, {"kind": "chat"}, {"decision": "sent"}, {"agent_id": "0"},
            {"agent_id": "-4"}, {"agent_id": "\u0663"}, {"conversation_id": "x"},
            {"conversation_id": "1" * 19}, {"limit": "0"}, {"limit": "abc"}, {"limit": "1000"}):
    f, msg = tr.parse_filters(Args(bad))
    check("refused " + json.dumps(bad), f is None and msg, (f, msg))
check("kinds are the three the brain writes", set(tr.KINDS) == {"ingest_answer", "voice_answer", "draft"})
brain_src = src("portal_brain.py")
written = set(__import__("re").findall(r'_write_trace\([^)]*?"([a-z_]+)"', brain_src, __import__("re").S))
check("every trace kind the brain writes has a label", written and written <= set(tr.KINDS), written)
check("labels are plain words (no emoji)", all(ord(ch) < 0x2000 for text in tr.KINDS.values() for ch in text))

print("== helpers ==")
check("plurals", tr._count(1, "order") == "1 order" and tr._count(0, "order") == "0 orders"
      and tr._count(2, "entry", "entries") == "2 entries" and tr._count(1, "entry", "entries") == "1 entry")
check("grounding: dict / JSON text / junk", tr._grounding({"a": 1}) == {"a": 1}
      and tr._grounding('{"a": 2}') == {"a": 2} and tr._grounding("nope") == {} and tr._grounding([1]) == {})
check("ids: positive ints / ASCII digit text only", tr._id(5) == 5 and tr._id("12") == 12
      and tr._id(True) is None and tr._id(0) is None and tr._id(-3) is None and tr._id("\u0663") is None
      and tr._id(None) is None)
calls = [{"model": "m1", "prompt_tokens": 1000, "completion_tokens": 500},
         {"model": "m2", "prompt_tokens": 10, "completion_tokens": 0}]
prices = {"m1": {"input": 1.0, "output": 2.0}, "m2": {"input": 100.0, "output": 0.0}}
check("cost: summed when every call is priced", tr._cost(calls, prices) == round((1000 + 1000) / 1e6 + 1000 / 1e6, 6),
      tr._cost(calls, prices))
check("cost: None when prices are not configured or a model has no price",
      tr._cost(calls, {}) is None and tr._cost(calls, {"m1": prices["m1"]}) is None and tr._cost([], prices) is None)
check("cost: the 'default' price covers unlisted models", tr._cost(calls[:1], {"default": prices["m1"]}) == 0.002)
check("reason: none on a plain send, label + detail on policy",
      tr._reason({}, "send") is None
      and tr._reason({"reason": "policy:refund"}, "handoff") == {
          "key": "policy", "label": qa.BRAIN_REASONS["policy"], "detail": "refund"}
      and tr._reason({}, "handoff")["key"] == "unknown")
check("confidence: numbers only (bool refused)", tr._confidence({"confidence": 0.91234}) == 0.912
      and tr._confidence({"confidence": True}) is None and tr._confidence({"confidence": "0.9"}) is None)
check("agent: current name, else the snapshot, else 'Agent #id'",
      tr._agent({"agent_id": 4, "agent_name": "Old"}, {4: "New"}) == {"id": 4, "name": "New"}
      and tr._agent({"agent_id": 4, "agent_name": "Old"}, {}) == {"id": 4, "name": "Old"}
      and tr._agent({"agent_id": "4"}, {}) == {"id": 4, "name": "Agent #4"}
      and tr._agent({}, {}) is None)
g = {"conversation_messages": 3, "tools": ["customer_orders", "search_kb", "business_facts", "customer_memory",
                                           "agent_persona", "customer_profile", "sales_context",
                                           "loyalty_context", 7],
     "order_ids": [11, 12], "kb_ids": [1], "knowledge_ids": [5, 6],
     "citations": [{"source": "faq.pdf", "section": "Returns"}, {"source": "terms.pdf", "section": ""}],
     "fact_ids": [9], "memory_ids": [1, 2, 3],
     "sales": {"stage": "consideration", "ask_next": "size", "objection": "price", "approved_answer": True},
     "loyalty": {"tier": "gold", "orders": 1}}
items = {i["key"]: i for i in tr._tool_items(g, {"id": 4, "name": "Sana"})}
check("tool details: every step explained, non-text tools ignored",
      list(items) == ["conversation", "customer_orders", "search_kb", "business_facts", "customer_memory",
                      "agent_persona", "customer_profile", "sales_context", "loyalty_context"], list(items))
check("tool details: counts + refs", items["conversation"]["detail"] == "3 messages read"
      and items["customer_orders"]["detail"] == "2 orders" and items["customer_orders"]["refs"] == [11, 12]
      and items["search_kb"]["detail"] == "1 entry, 2 document passages"
      and items["search_kb"]["refs"] == ["Returns", "terms.pdf"]
      and items["business_facts"]["detail"] == "1 fact" and items["customer_memory"]["detail"] == "3 memories"
      and items["agent_persona"]["detail"] == "Sana", items)
check("tool details: sales + loyalty summaries", items["sales_context"]["detail"] ==
      "stage consideration, asks next: size, concern: price (approved answer)"
      and items["loyalty_context"]["detail"] == "tier gold, 1 past order", items)
check("tool labels come from the §240 registry", items["search_kb"]["label"] == qa.TOOL_LABELS["search_kb"])
check("refs capped", len(tr._tool_items({"tools": ["customer_orders"], "order_ids": list(range(50))}, None)[0]["refs"])
      == tr.MAX_REFS)
s = tr._summary({"id": 3, "kind": "ingest_answer", "decision": "send", "conversation_id": 0, "created_at": None,
                 "grounding": {"tools": ["search_kb"], "llm_called": True, "confidence": 0.9,
                               "model_calls": [{"model": "m1", "prompt_tokens": 100, "completion_tokens": 20,
                                                "latency_ms": 40}, "junk"]}}, {}, {})
check("summary: model / tokens / latency from the calls; conversation 0 -> None; no price -> None",
      s["model"] == "m1" and s["tokens"] == 120 and s["latency_ms"] == 40 and s["cost_usd"] is None
      and s["conversation_id"] is None and s["reason"] is None and s["tools"] == ["Knowledge base"]
      and s["kind_label"] == "Automatic reply" and s["llm_called"] is True, s)
s = tr._summary({"id": 4, "kind": "draft", "decision": "handoff", "grounding": "{}"}, {}, {})
check("summary: pre-241 trace -> no model, latency None, reason unknown",
      s["model"] is None and s["tokens"] == 0 and s["latency_ms"] is None and s["reason"]["key"] == "unknown", s)

blocked = tr.build_detail(None, 7, {"id": 9, "kind": "ingest_answer", "decision": "handoff", "conversation_id": 0,
                                    "grounding": {"tools": [], "reason": "injection_suspected", "llm_called": False,
                                                  "guard": {"level": "high", "score": 9, "signals": ["override"]}}})
bs = {s["key"]: s for s in blocked["steps"]}
check("blocked message: guard blocked, agent/tools/model skipped, decision blocked, no reply",
      [s["key"] for s in blocked["steps"]] == ["input", "guard", "agent", "tools", "model", "decision", "response"]
      and bs["guard"]["status"] == "blocked" and bs["agent"]["status"] == "skipped"
      and bs["tools"]["status"] == "skipped" and bs["tools"]["detail"]["items"] == []
      and bs["model"]["status"] == "skipped" and bs["decision"]["status"] == "blocked"
      and bs["response"]["status"] == "skipped" and bs["response"]["detail"]["escalated"] is False
      and bs["input"]["status"] == "unknown" and blocked["audit"] == [], blocked)
down = tr.build_detail(None, 7, {"id": 10, "kind": "voice_answer", "decision": "handoff", "conversation_id": 0,
                                 "grounding": {"tools": ["search_kb"], "reason": "llm_unavailable",
                                               "llm_called": False, "channel": "voice",
                                               "model_calls": [{"model": "m", "ok": False}]}})
ds = {s["key"]: s for s in down["steps"]}
check("engine down: model failed, decision warn with its label, channel echoed",
      ds["model"]["status"] == "failed" and ds["decision"]["status"] == "warn"
      and ds["decision"]["detail"]["reason"]["label"] == qa.BRAIN_REASONS["llm_unavailable"]
      and ds["agent"]["status"] == "ok" and ds["agent"]["detail"] == {"name": "Default assistant"}
      and down["channel"] == "voice" and down["kind_label"] == "Phone call reply", down)
voice = tr.build_detail(None, 7, {"id": 11, "kind": "voice_answer", "decision": "send", "conversation_id": 0,
                                  "grounding": {"llm_called": True, "confidence": 0.9}})
draft = tr.build_detail(None, 7, {"id": 12, "kind": "draft", "decision": "send", "conversation_id": 0,
                                  "grounding": {"llm_called": True}})
check("voice / draft replies say where the reply went (nothing invented)",
      voice["steps"][6]["detail"]["type"] == "voice" and voice["steps"][6]["status"] == "ok"
      and draft["steps"][6]["detail"]["type"] == "draft" and "not stored" in draft["steps"][6]["detail"]["note"]
      and voice["steps"][4]["status"] == "ok", (voice["steps"][6], draft["steps"][6]))
check("no pre-241 model info and no llm flag -> model step skipped",
      tr.build_detail(None, 7, {"id": 13, "kind": "draft", "decision": "handoff", "grounding": {}})["steps"][4]["status"]
      == "skipped")

print("== usage_scope collector ==")
saved_record = None
import portal_ai_usage  # noqa: E402
ledger = []
saved_record, portal_ai_usage.record = portal_ai_usage.record, (lambda *a, **k: ledger.append((a, k)) or True)
with portal_llm.usage_scope("brain", 7, None, agent_id=3) as outer:
    portal_llm._record_usage("gpt-x", {"prompt_tokens": 120, "completion_tokens": 30}, True, time.time() - 0.05)
    with portal_llm.usage_scope("intent", 7) as inner:
        portal_llm._record_usage("small", None, False, time.time())
    portal_llm._record_usage("gpt-y", {"prompt_tokens": 5}, True, time.time(), route="failover")
check("outer scope keeps its own calls (model, tokens, latency, ok, route)",
      [c["model"] for c in outer.calls] == ["gpt-x", "gpt-y"]
      and outer.calls[0]["prompt_tokens"] == 120 and outer.calls[0]["completion_tokens"] == 30
      and 40 <= outer.calls[0]["latency_ms"] < 5000 and outer.calls[0]["ok"] is True
      and outer.calls[0]["route"] == "" and outer.calls[1]["route"] == "failover", outer.calls)
check("inner scope gets only its call", [c["model"] for c in inner.calls] == ["small"]
      and inner.calls[0]["ok"] is False and inner.calls[0]["prompt_tokens"] == 0, inner.calls)
check("the ledger still gets every call with the same numbers", len(ledger) == 3
      and ledger[0][0][:7][2:6] == ("gpt-x", 120, 30, ledger[0][0][5]) and ledger[0][1]["agent_id"] == 3
      and ledger[0][0][5] == outer.calls[0]["latency_ms"] and ledger[2][1].get("route") == "failover", ledger)
portal_llm._record_usage("nobody", None, True, time.time())
check("a call outside any scope collects nowhere and never raises", True and len(ledger) == 4)
with portal_llm.usage_scope("brain", 7) as capped:
    for n in range(portal_llm.MAX_SCOPE_CALLS + 3):
        portal_llm._record_usage("m" + str(n), None, True, time.time())
check("a scope keeps at most MAX_SCOPE_CALLS", len(capped.calls) == portal_llm.MAX_SCOPE_CALLS == 5, capped.calls)
portal_ai_usage.record = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("ledger down"))
with portal_llm.usage_scope("brain", 7) as broken:
    portal_llm._record_usage("gpt-x", None, True, time.time())
check("a broken ledger still lets the trace see the call", [c["model"] for c in broken.calls] == ["gpt-x"])
portal_ai_usage.record = saved_record
check("no scopes left open", portal_llm.current_scope() == ("", 0, None, 0)
      and not getattr(portal_llm._SCOPE, "collectors", []))
check("brain keeps scope.calls on the trace (stub scopes without .calls -> [])",
      "agent_id=_agent_id) as scope:" in brain_src and 'grounding["model_calls"] = _scope_calls(scope)' in brain_src
      and __import__("portal_brain")._scope_calls(object()) == []
      and __import__("portal_brain")._scope_calls(type("S", (), {"calls": [{"model": "a"}, 3]})()) == [{"model": "a"}])
check("brain stores the input LENGTH only, never the text",
      '"input_chars": len(str(message_text or "").strip())' in brain_src
      and 'grounding["customer_message"]' not in brain_src and 'grounding["reply"]' not in brain_src)

traces_src = src("portal_ai_traces.py")
check("read-only module: rolls back, never writes", "conn.rollback()" in traces_src
      and ".commit()" not in traces_src and "INSERT " not in traces_src and "UPDATE " not in traces_src
      and "DELETE " not in traces_src)
import re as _re  # noqa: E402
check("every query the traces module runs is tenant-scoped (8 queries, 8 client_id filters)",
      traces_src.count("cur.execute(") == 8 and traces_src.count("WHERE client_id = %s") == 8
      and traces_src.count("(client_id, ") == 7 and "params: List[Any] = [client_id, filters[\"days\"]]" in traces_src)
app_src = src("app.py")
check("the outbox is read only for automatic chat replies that were sent (drafts / voice never queue one)",
      'if kind == "ingest_answer" and decision == "send" else None)' in traces_src)
check("app registers the traces blueprint", "from portal_ai_traces import bp as portal_ai_traces_bp" in app_src
      and "aux_app.register_blueprint(portal_ai_traces_bp)" in app_src)
audit_src = src("portal_ai_audit.py")
check("audit links run in their own savepoint, fail-soft",
      'with portal_txn.savepoint(cur, conn, "of_trace_link"):\n'
      '                    items = portal_ai_traces.link_audit(cur, client_id, items)' in audit_src)

print("== HTTP guards (no database touched) ==")
app = Flask(__name__)
app.register_blueprint(tr.bp)
import portal_ai_audit  # noqa: E402
app.register_blueprint(portal_ai_audit.bp)
client = app.test_client()
LIST = "/api/v1/portal/ai/traces"
current = {"p": None, "exc": None}


def fake_auth():
    if current["exc"]:
        raise current["exc"]
    return current["p"]


tr.authenticate_portal_request = fake_auth
portal_ai_audit.authenticate_portal_request = fake_auth
db_calls = []
real_conn = portal_db._conn
portal_db._conn = lambda: db_calls.append(1) or (_ for _ in ()).throw(RuntimeError("db down"))
owner = {"client_id": 7, "user_id": 1, "role": "owner", "via_api_key": False}
check("no session -> 401 (list + detail)", client.get(LIST).status_code == 401
      and client.get(LIST + "/1").status_code == 401)
current["exc"] = PortalAuthUnavailable("auth down")
check("auth unavailable -> 503", client.get(LIST).status_code == 503 and client.get(LIST + "/1").status_code == 503)
current["exc"] = None
current["p"] = dict(owner, via_api_key=True)
check("API key -> 403 (a trace shows customer text)", client.get(LIST).status_code == 403
      and client.get(LIST + "/1").status_code == 403)
current["p"] = owner
for bad in ("?days=0", "?days=abc", "?kind=x", "?decision=maybe", "?agent_id=-1", "?limit=0"):
    response = client.get(LIST + bad)
    check("list " + bad + " -> 400 bad_request", response.status_code == 400
          and response.get_json()["error"]["code"] == "bad_request", response.get_json())
for bad in ("abc", "0", "\u0663", "1" * 19, "-2"):
    response = client.get(LIST + "/" + bad)
    check("detail id " + repr(bad) + " -> 400", response.status_code == 400, response.status_code)
check("bad requests never reach the database", not db_calls)
for url in (LIST, LIST + "/5"):
    response = client.get(url)
    check(url + ": database down -> 503 without internals", response.status_code == 503
          and response.get_json()["error"]["code"] == "portal_unavailable"
          and "db down" not in json.dumps(response.get_json()), response.get_json())
portal_db._conn = real_conn

STEP_KEYS = ["input", "guard", "agent", "tools", "model", "decision", "response"]


def run_db():
    try:
        import pgserver
        import psycopg2
    except Exception:
        print("pgserver missing - database half skipped")
        return
    print("== real database (pgserver) ==")
    data = tempfile.mkdtemp(prefix="traces241_")
    server = pgserver.get_server(data, cleanup_mode="stop")  # noqa: F841
    os.environ.update({"DB_HOST": data, "DB_PORT": "5432", "DB_NAME": "postgres", "DB_USER": "postgres",
                       "DB_PASSWORD": "", "PGSSLMODE": "disable"})
    portal_db._ensured = False
    portal_db.ensure_tables()

    def sql(query, args=(), fetch=True):
        c = psycopg2.connect(host=data, dbname="postgres", user="postgres")
        try:
            cur = c.cursor()
            cur.execute(query, args)
            out = cur.fetchall() if fetch and cur.description else None
            c.commit()
            return out
        finally:
            c.close()

    def get(url):
        response = client.get(url)
        return response.status_code, response.get_json()

    # --- fresh database: no trace ledger yet ---
    code, fresh = get(LIST)
    check("fresh db: list 200 with no items, filters echoed", code == 200 and fresh["items"] == []
          and fresh["days"] == 7 and fresh["prices_configured"] is False
          and [k["key"] for k in fresh["kinds"]] == list(tr.KINDS), fresh)
    check("fresh db: detail 404", get(LIST + "/1")[0] == 404)
    check("fresh db: read-only (no trace table created)",
          sql("SELECT to_regclass('portal_brain_traces')")[0] == (None,))

    import portal_brain
    import portal_agents
    import portal_escalation
    sql("CREATE TABLE IF NOT EXISTS portal_action_log (id BIGSERIAL PRIMARY KEY, client_id BIGINT,"
        " action TEXT, actor_kind TEXT, actor_user_id BIGINT, conversation_id BIGINT, note TEXT,"
        " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())", fetch=False)
    c = psycopg2.connect(host=data, dbname="postgres", user="postgres")
    with c.cursor() as cur:
        for module in (portal_brain, portal_ai_usage, portal_agents, portal_escalation):
            module._DDL_READY = False
            module._ensure_ddl(cur)
    c.commit()
    import portal_checkout
    portal_checkout._ensure_checkout_tables(c)
    c.commit()
    c.close()
    for client_id in (7, 8):
        sql("INSERT INTO portal_brain_settings (client_id, autonomy, tone) VALUES (%s, 'auto', '')",
            (client_id,), fetch=False)
    sana = sql("INSERT INTO portal_agents (client_id, name) VALUES (7, 'Sana') RETURNING id")[0][0]
    spy = sql("INSERT INTO portal_agents (client_id, name) VALUES (8, 'Spy') RETURNING id")[0][0]
    sql("INSERT INTO portal_agent_versions (client_id, agent_id, version, created_at) VALUES"
        " (7, %s, 1, NOW() - interval '2 days'), (7, %s, 2, NOW() + interval '1 hour'),"
        " (8, %s, 9, NOW() - interval '2 days')", (sana, sana, sana), fetch=False)
    for client_id, conv, agent in ((7, 11, sana), (8, 11, spy)):
        sql("INSERT INTO portal_conversation_agents (client_id, conversation_id, agent_id) VALUES (%s, %s, %s)",
            (client_id, conv, agent), fetch=False)

    replies = []

    def fake_chat(system_prompt, user_text, max_tokens=300, **_kw):
        answer = replies.pop(0)
        portal_llm._record_usage("gpt-x", {"prompt_tokens": 120, "completion_tokens": 30}, True,
                                 time.time() - 0.02)
        return answer

    saved_chat = portal_llm.chat_json
    portal_llm.chat_json = fake_chat
    # the data tools have their own suites: fixed results here
    tool_names = ("tool_customer_orders", "tool_search_kb", "tool_business_facts", "tool_customer_memory",
                  "tool_customer_profile")
    saved_tools = {name: getattr(portal_brain, name) for name in tool_names}
    portal_brain.tool_customer_orders = lambda *a, **k: [{"id": 501, "status": "paid"}]
    portal_brain.tool_search_kb = lambda *a, **k: [{"id": 3, "kind": "entry", "title": "Delivery"}]
    portal_brain.tool_business_facts = lambda *a, **k: []
    portal_brain.tool_customer_memory = lambda *a, **k: []
    portal_brain.tool_customer_profile = lambda *a, **k: {}

    def ingest(client_id, conv, bodies, answers):
        """One ingest-style transaction: inbound message(s) + brain answer(s)."""
        replies.extend(answers)
        conn = psycopg2.connect(host=data, dbname="postgres", user="postgres")
        try:
            out = []
            for body in bodies:
                with conn.cursor() as cur:
                    cur.execute("INSERT INTO portal_messages (conversation_id, client_id, direction, body)"
                                " VALUES (%s, %s, 'in', %s)", (conv, client_id, body))
                answered = None
                with conn.cursor() as cur:
                    # exactly as connector_api runs the hook
                    with portal_txn.savepoint(cur, conn, "of_hook"):
                        answered = portal_brain.maybe_answer(
                            client_id, conv, "92300111222" + str(conv), "Ali", body, conn)
                out.append(answered)
            conn.commit()
            return out
        finally:
            conn.close()

    sql("INSERT INTO portal_messages (conversation_id, client_id, direction, body, created_at)"
        " VALUES (11, 8, 'in', 'Foreign earlier message', NOW() - interval '1 hour')", fetch=False)
    ASK = "Mera order kahan hai?"
    REPLY = "Aap ka order kal tak pohanch jayega."
    sent = ingest(7, 11, [ASK], [{"reply": REPLY, "confidence": 0.9, "needs_human": False}])
    handoff = ingest(7, 12, ["Mujhe refund chahiye abhi"], [{"reply": "", "confidence": 0.2, "needs_human": False}])
    batch = ingest(7, 13, ["Size?", "Kya yeh blue color mein milta hai?"],
                   [{"reply": "M aur L.", "confidence": 0.9, "needs_human": False},
                    {"reply": "Ji haan, blue mein bhi hai.", "confidence": 0.9, "needs_human": False}])
    foreign = ingest(8, 11, ["Spy question"], [{"reply": "Spy reply", "confidence": 0.95, "needs_human": False}])
    portal_llm.chat_json = saved_chat
    for name, fn in saved_tools.items():
        setattr(portal_brain, name, fn)
    check("the real brain answered inside the ingest transactions", sent == [True] and handoff == [None]
          and batch == [True, True] and foreign == [True], (sent, handoff, batch, foreign))

    rows = sql("SELECT id, conversation_id, decision, grounding FROM portal_brain_traces WHERE client_id = 7"
               " ORDER BY id")
    ids = {}
    for r in rows:
        ids.setdefault(r[1], r[0])
    g_sent = rows[0][3]
    check("trace keeps the model call (model, tokens, latency, ok)", len(g_sent["model_calls"]) == 1
          and g_sent["model_calls"][0]["model"] == "gpt-x" and g_sent["model_calls"][0]["prompt_tokens"] == 120
          and g_sent["model_calls"][0]["completion_tokens"] == 30 and g_sent["model_calls"][0]["ok"] is True
          and g_sent["model_calls"][0]["latency_ms"] >= 20, g_sent.get("model_calls"))
    check("trace keeps phase timings, agent name snapshot and the input length",
          set(g_sent["timings_ms"]) == {"tools", "model"} and all(v >= 0 for v in g_sent["timings_ms"].values())
          and g_sent["agent_name"] == "Sana" and g_sent["input_chars"] == len(ASK), g_sent)
    check("trace never stores the customer's text or the reply", ASK not in json.dumps(g_sent, ensure_ascii=False)
          and REPLY not in json.dumps(g_sent, ensure_ascii=False))
    check("the usage ledger still got the call", sql("SELECT COUNT(*) FROM portal_ai_usage WHERE client_id = 7"
                                                     " AND model = 'gpt-x'")[0][0] == 4)
    same = sql("SELECT (SELECT created_at FROM portal_brain_traces WHERE id = %s)"
               " = (SELECT created_at FROM portal_connector_commands WHERE client_id = 7 ORDER BY id LIMIT 1)",
               (ids[11],))[0][0]
    check("trace + queued reply share the transaction time (the link this module relies on)", same is True)

    # --- list ---
    code, listing = get(LIST)
    check("list: our 5 answers newest first, foreign workspace excluded", code == 200
          and [i["id"] for i in listing["items"]] == sorted([r[0] for r in rows], reverse=True), listing)
    top = {i["id"]: i for i in listing["items"]}[ids[11]]
    check("list: summary of the sent answer", top["decision"] == "send" and top["kind"] == "ingest_answer"
          and top["agent"] == {"id": sana, "name": "Sana"} and top["model"] == "gpt-x" and top["tokens"] == 150
          and top["cost_usd"] is None and top["confidence"] == 0.9 and top["reason"] is None
          and top["conversation_id"] == 11 and "Agent persona" in top["tools"] and top["llm_called"] is True, top)
    low = {i["id"]: i for i in listing["items"]}[ids[12]]
    check("list: the handoff carries its reason", low["decision"] == "handoff"
          and low["reason"]["key"] == "low_confidence" and low["reason"]["label"] == qa.BRAIN_REASONS["low_confidence"]
          and low["agent"] is None, low)
    os.environ["OF_AI_PRICES_JSON"] = json.dumps({"gpt-x": {"input": 2.0, "output": 8.0}})
    code, priced = get(LIST + "?conversation_id=11")
    check("list: cost once prices are set ((120*2 + 30*8) / 1M)", priced["prices_configured"] is True
          and [i["cost_usd"] for i in priced["items"]] == [0.00048], priced)
    os.environ.pop("OF_AI_PRICES_JSON")
    check("filter decision=handoff", [i["id"] for i in get(LIST + "?decision=handoff")[1]["items"]] == [ids[12]])
    check("filter kind=draft -> none", get(LIST + "?kind=draft")[1]["items"] == [])
    check("filter agent_id = ours", [i["id"] for i in get(LIST + "?agent_id=" + str(sana))[1]["items"]] == [ids[11]])
    check("filter agent_id = the foreign agent -> none (tenant)", get(LIST + "?agent_id=" + str(spy))[1]["items"] == [])
    check("filter limit=2", len(get(LIST + "?limit=2")[1]["items"]) == 2)
    sql("UPDATE portal_brain_traces SET created_at = created_at - interval '10 days' WHERE id = %s", (ids[12],),
        fetch=False)
    check("window: a 10-day-old answer is outside 7 days, inside 30",
          ids[12] not in [i["id"] for i in get(LIST)[1]["items"]]
          and ids[12] in [i["id"] for i in get(LIST + "?days=30")[1]["items"]])
    sql("UPDATE portal_brain_traces SET created_at = created_at + interval '10 days' WHERE id = %s", (ids[12],),
        fetch=False)

    # a later follow-up in the same conversation (detail must stay on ITS answer)
    replies.append({"reply": "Koi baat nahi.", "confidence": 0.9, "needs_human": False})
    portal_llm.chat_json = fake_chat
    for name in tool_names:
        setattr(portal_brain, name, (lambda *a, **k: {}) if name == "tool_customer_profile"
                else (lambda *a, **k: []))
    later = ingest(7, 11, ["Shukriya"], [])
    portal_llm.chat_json = saved_chat
    for name, fn in saved_tools.items():
        setattr(portal_brain, name, fn)
    follow_id = sql("SELECT MAX(id) FROM portal_brain_traces WHERE client_id = 7")[0][0]
    check("follow-up answered in the same conversation", later == [True] and follow_id > ids[11])

    # --- detail ---
    code, d = get(LIST + "/" + str(ids[11]))
    steps = {s["key"]: s for s in d["steps"]}
    check("detail: 200 with the seven steps in order", code == 200 and [s["key"] for s in d["steps"]] == STEP_KEYS
          and d["kind_label"] == "Automatic reply" and d["conversation_id"] == 11, d)
    check("detail: the customer message, matched exactly", steps["input"]["status"] == "ok"
          and steps["input"]["detail"]["body"] == ASK and steps["input"]["detail"]["match"] == "exact", steps["input"])
    check("detail: guard summary", steps["guard"]["status"] == "ok" and "level" in steps["guard"]["detail"],
          steps["guard"])
    check("detail: agent + the version live at answer time (not the later one)",
          steps["agent"]["detail"]["name"] == "Sana" and steps["agent"]["detail"]["version"] == 1
          and steps["agent"]["detail"]["auto_reply"] is True, steps["agent"])
    tool_items = {i["key"]: i for i in steps["tools"]["detail"]["items"]}
    check("detail: context it read (history, orders, KB, agent)",
          list(tool_items)[:1] == ["conversation"] and tool_items["customer_orders"]["refs"] == [501]
          and tool_items["customer_orders"]["detail"] == "1 order"
          and tool_items["search_kb"]["detail"] == "1 entry, 0 document passages"
          and tool_items["agent_persona"]["detail"] == "Sana", steps["tools"])
    check("detail: model call + timings, cost None without prices", steps["model"]["status"] == "ok"
          and steps["model"]["detail"]["calls"][0]["model"] == "gpt-x"
          and steps["model"]["detail"]["calls"][0]["cost_usd"] is None
          and set(steps["model"]["detail"]["timings_ms"]) == {"tools", "model"}
          and steps["model"]["detail"]["prices_configured"] is False, steps["model"])
    check("detail: decision", steps["decision"]["status"] == "ok" and steps["decision"]["detail"]["decision"] == "send"
          and steps["decision"]["detail"]["confidence"] == 0.9 and steps["decision"]["detail"]["reason"] is None)
    check("detail: the queued reply (text from the outbox, status pending)", steps["response"]["status"] == "ok"
          and steps["response"]["detail"]["body"] == REPLY and steps["response"]["detail"]["status"] == "pending"
          and steps["response"]["detail"]["type"] == "message" and steps["response"]["detail"]["command_id"] > 0,
          steps["response"])
    check("detail: linked audit row (only this answer's, not the follow-up's)",
          [a["action"] for a in d["audit"]] == ["ai.answer"], d["audit"])
    fd = get(LIST + "/" + str(follow_id))[1]
    check("follow-up detail: its own message + reply", fd["steps"][0]["detail"]["body"] == "Shukriya"
          and fd["steps"][6]["detail"]["body"] == "Koi baat nahi." and len(fd["audit"]) == 1, fd)

    code, h = get(LIST + "/" + str(ids[12]))
    hs = {s["key"]: s for s in h["steps"]}
    check("handoff detail: no reply, escalated, reason labelled", hs["response"]["detail"]["type"] == "handoff"
          and hs["response"]["status"] == "skipped" and hs["response"]["detail"]["escalated"] is True
          and hs["decision"]["status"] == "warn" and hs["decision"]["detail"]["reason"]["key"] == "low_confidence"
          and any(a["action"].startswith("escalation.") for a in h["audit"]), h)

    b1 = get(LIST + "/" + str(rows[2][0]))[1]
    b2 = get(LIST + "/" + str(rows[3][0]))[1]
    check("batch (2 messages, one transaction): each trace finds ITS message by length",
          b1["steps"][0]["detail"]["body"] == "Size?" and b1["steps"][0]["detail"]["match"] == "exact"
          and b2["steps"][0]["detail"]["body"] == "Kya yeh blue color mein milta hai?"
          and b2["steps"][0]["detail"]["match"] == "exact", (b1["steps"][0], b2["steps"][0]))

    foreign_id = sql("SELECT id FROM portal_brain_traces WHERE client_id = 8")[0][0]
    check("a foreign trace id -> 404 (same conversation id, other workspace)",
          get(LIST + "/" + str(foreign_id))[0] == 404)
    check("foreign rows never leak into our detail (same conversation 11)",
          "Spy" not in json.dumps(d) and d["audit"] == [a for a in d["audit"] if a["action"] == "ai.answer"])

    sql("UPDATE portal_agents SET name = 'Sana B' WHERE id = %s", (sana,), fetch=False)
    check("renamed agent shows its current name", get(LIST + "/" + str(ids[11]))[1]["steps"][2]["detail"]["name"]
          == "Sana B")
    sql("DELETE FROM portal_agents WHERE id = %s", (sana,), fetch=False)
    check("deleted agent falls back to the name at answer time",
          get(LIST + "/" + str(ids[11]))[1]["steps"][2]["detail"]["name"] == "Sana")
    sql("DROP TABLE portal_agent_versions", fetch=False)
    code, nov = get(LIST + "/" + str(ids[11]))
    check("missing versions table blanks only the version", code == 200
          and nov["steps"][2]["detail"]["version"] is None and nov["steps"][6]["detail"]["body"] == REPLY, nov)
    sql("DELETE FROM portal_messages WHERE client_id = 7 AND conversation_id = 11", fetch=False)
    gone = get(LIST + "/" + str(ids[11]))[1]["steps"][0]
    check("deleted message: the trace never kept a copy", gone["status"] == "unknown"
          and "body" not in gone["detail"] and gone["detail"]["input_chars"] == len(ASK), gone)

    sql("DELETE FROM portal_connector_commands WHERE id = %s", (steps["response"]["detail"]["command_id"],),
        fetch=False)
    lost = get(LIST + "/" + str(ids[11]))[1]["steps"][6]
    check("queued reply gone: 'no longer on record' (never the follow-up's reply)", lost["status"] == "unknown"
          and "body" not in lost["detail"] and "no longer on record" in lost["detail"]["note"], lost)

    old = sql("INSERT INTO portal_brain_traces (client_id, conversation_id, kind, decision, grounding)"
              " VALUES (7, 0, 'draft', 'send', CAST(%s AS JSONB)) RETURNING id",
              (json.dumps({"tools": ["search_kb"], "confidence": 0.8, "llm_called": True, "kb_ids": [1]}),))[0][0]
    code, od = get(LIST + "/" + str(old))
    check("pre-241 trace: 200, no calls, draft reply note, no conversation reads", code == 200
          and od["steps"][4]["status"] == "ok" and od["steps"][4]["detail"]["calls"] == []
          and od["steps"][6]["detail"]["type"] == "draft" and od["steps"][0]["status"] == "unknown"
          and od["audit"] == [], od)

    # --- audit links ---
    code, audit = get("/api/v1/portal/ai/audit?days=7&limit=50")
    linked = [i for i in audit["items"] if i.get("trace")]
    answer_rows = sorted((i for i in audit["items"] if i["action"] == "ai.answer" and i["conversation_id"] == 11),
                         key=lambda i: i["id"])
    check("audit: ai.answer rows link to their own trace (agent snapshot + model)", code == 200
          and len(answer_rows) == 2
          and answer_rows[0]["trace"] == {"id": ids[11], "agent": {"id": sana, "name": "Sana"}, "model": "gpt-x"}
          and answer_rows[1]["trace"]["id"] == follow_id, answer_rows)
    check("audit: escalation rows of the handoff link to the handoff trace",
          any(i["trace"]["id"] == ids[12] for i in linked if i["action"].startswith("escalation.")), linked)
    batch_links = sorted((i["id"], i["trace"]["id"]) for i in linked if i["conversation_id"] == 13)
    check("audit: one transaction, two answers -> each ai.answer row pairs with its own trace",
          [t for _a, t in batch_links] == [rows[2][0], rows[3][0]], batch_links)
    check("audit: only our traces are linked", {i["trace"]["id"] for i in linked} <= {r[0] for r in rows} | {follow_id})
    current["p"] = dict(owner, via_api_key=True)
    code, keyed = get("/api/v1/portal/ai/audit?days=7")
    check("audit stays open to API keys (links are ids + names, no customer text)", code == 200
          and any(i.get("trace") for i in keyed["items"]))
    current["p"] = owner
    sql("ALTER TABLE portal_brain_traces RENAME TO portal_brain_traces_off", fetch=False)
    code, plain = get("/api/v1/portal/ai/audit?days=7")
    check("audit without the trace ledger: plain rows, no error", code == 200 and plain["items"]
          and not any(i.get("trace") for i in plain["items"]), plain)
    sql("ALTER TABLE portal_brain_traces_off RENAME TO portal_brain_traces", fetch=False)

    # --- roles + read-only ---
    current["p"] = dict(owner, role="agent", user_id=9)
    check("any team role can read traces", get(LIST)[0] == 200)
    current["p"] = owner
    before = sql("SELECT (SELECT COUNT(*) FROM portal_brain_traces), (SELECT COUNT(*) FROM portal_action_log),"
                 " (SELECT COUNT(*) FROM portal_connector_commands)")[0]
    for url in (LIST, LIST + "/" + str(ids[11]), LIST + "?days=90", "/api/v1/portal/ai/audit"):
        client.get(url)
    after = sql("SELECT (SELECT COUNT(*) FROM portal_brain_traces), (SELECT COUNT(*) FROM portal_action_log),"
                " (SELECT COUNT(*) FROM portal_connector_commands)")[0]
    check("reads write nothing", before == after, (before, after))


run_db()
summary("ai_traces")
