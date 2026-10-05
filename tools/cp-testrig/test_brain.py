"""Tests for B6: portal_brain (tools, policy, reasoner, autonomy,
ingest hook, owner API, traces) + wiring pins + web pins."""
import json

from flask import Flask

import portal_brain
import portal_llm
import portal_sales

# §237: the scripted FakeCur answers queries in a fixed order; the sales note
# has its own real-database suite (test_sales.py), so it is off here.
portal_sales.context_for = lambda *a, **k: None
import portal_db
from test_lib import install_db_stub
from test_lib import check, summary

PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}

ORIG_CHAT = portal_llm.chat_json


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


# §224: settings saves take an automatic config snapshot first. Its own
# queries are covered on real PostgreSQL (test_approvals_v2); here it is
# neutral so these scripts keep pinning the brain's own SQL.
import portal_snapshots  # noqa: E402

portal_snapshots.before_change = lambda *args, **kwargs: None
check("brain saves call the snapshot hook (settings + facts save/archive)",
      open("portal_brain.py", encoding="utf8").read().count(
          "portal_snapshots.before_change(") == 3, "hook")


def fresh(script, module=portal_brain):
    portal_brain._DDL_READY = True
    db = install_db_stub(module, script)
    portal_brain.portal_db.CMD_TABLE = "portal_connector_commands"
    portal_brain.portal_db.CONV_TABLE = "portal_conversations"
    return db


def reset():
    portal_brain._DDL_READY = True
    portal_llm.chat_json = ORIG_CHAT
    portal_llm.ENABLED = False
    portal_llm.API_KEY = ""


reset()

# ---------- policy matrix ----------

check("policy clean passes",
      portal_brain.policy_check(
          "Ji bilkul, aapka order process ho gaya he.") == [],
      "clean")
check("policy blocks refund promise",
      any(v.startswith("forbidden:") for v in portal_brain.policy_check(
          "Don't worry, refund will be processed today.")), "refund")
check("policy blocks urdu refund",
      any(v.startswith("forbidden:") for v in portal_brain.policy_check(
          "Ji paise wapas ho jayenge")), "paise")
check("policy blocks discount promise",
      any(v.startswith("forbidden:") for v in portal_brain.policy_check(
          "I can give you a discount on this order")), "discount")
check("policy blocks delivery promise",
      any(v.startswith("forbidden:") for v in portal_brain.policy_check(
          "Pakka kal pohnch jayega")), "date")
check("policy blocks ai meta",
      any(v.startswith("forbidden:") for v in portal_brain.policy_check(
          "As an AI language model I cannot")), "meta")
check("policy blocks long text",
      any(v == "too_long" for v in portal_brain.policy_check(
          "x" * (portal_brain.MAX_DRAFT_CHARS + 1))), "long")

# ---------- tools: tenant-scoped, shaped ----------

conn = fresh([[{"direction": "in", "body": "order kahan he",
                "created_at": "t2"},
               {"direction": "out", "body": "checking", "created_at": "t1"}]])
with conn.cur as cur:
    msgs = portal_brain.tool_recent_messages(cur, 1, 55, 10)
check("recent messages reversed chronological",
      [m["body"] for m in msgs] == ["checking", "order kahan he"], msgs)

conn = fresh([[{"id": 9, "total": 1200.0, "status": "paid",
                "paid_amount": 1200.0, "updated_at": "u"}]])
with conn.cur as cur:
    orders = portal_brain.tool_customer_orders(cur, 1, "92300", 3)
check("orders shaped", orders == [{"id": 9, "total": 1200.0,
      "status": "paid", "paid_amount": 1200.0, "updated_at": "u"}], orders)
with conn.cur as cur:
    check("orders empty contact",
          portal_brain.tool_customer_orders(cur, 1, "", 3) == [], "empty")

conn = fresh([[{"id": 3, "title": "Delivery time", "content": "2-4 din"}]])
with conn.cur as cur:
    kb = portal_brain.tool_search_kb(cur, 1, "delivery", 3)
check("kb search shaped (knowledge engine: kind/source/score added)",
      len(kb) == 1 and kb[0]["id"] == 3 and kb[0]["title"] == "Delivery time"
      and kb[0]["content"] == "2-4 din" and kb[0]["kind"] == "entry"
      and kb[0]["source"] == "" and kb[0]["score"] > 0, kb)
kb_sql = conn.cur.executed[0][0]
check("kb search = one ranked query over entries + published chunks",
      len(conn.cur.executed) == 1 and "portal_kb_entries" in kb_sql
      and "portal_kb_chunks" in kb_sql and "s.status = 'published'" in kb_sql
      and "ILIKE ANY(%s)" in kb_sql, kb_sql[:120])
conn = fresh([[{"kind": "entry", "id": 3, "title": "Delivery time",
                "content": "2-4 din", "extra": "", "source_id": 0,
                "source_title": "", "position": 0},
               {"kind": "chunk", "id": 41, "title": "delivery",
                "content": "Karachi delivery takes 1-2 days.", "extra": "",
                "source_id": 7, "source_title": "Store policy", "position": 2}]])
with conn.cur as cur:
    kb = portal_brain.tool_search_kb(cur, 1, "karachi delivery", 3)
check("kb search ranks the document section first and cites its source",
      [h["id"] for h in kb] == [41, 3] and kb[0]["kind"] == "chunk"
      and kb[0]["source"] == "Store policy", kb)
conn = fresh([[{"id": 3, "title": "Delivery time", "content": "2-4 din"}]])
with conn.cur as cur:
    kb = portal_brain.tool_search_kb(cur, 1, "refund policy", 3)
check("kb search drops candidates that do not match the question",
      kb == [], kb)

conn = fresh([[], []])
with conn.cur as cur:
    prof = portal_brain.tool_customer_profile(cur, 1, "92300")
check("profile language key", "language" in prof, prof)

# ---------- settings ----------

conn = fresh([[]])
with conn.cur as cur:
    check("default settings suggest",
          portal_brain._load_settings(cur, 1) ==
          {"autonomy": "suggest", "tone": ""}, "defaults")
conn = fresh([[{"autonomy": "auto", "tone": "warm"}]])
with conn.cur as cur:
    check("stored settings read",
          portal_brain._load_settings(cur, 1) ==
          {"autonomy": "auto", "tone": "warm"}, "stored")

# ---------- decide: confidence / policy / needs_human ----------

grounding: dict = {}
check("decide llm none -> handoff",
      portal_brain._decide(None, grounding)[0] == "handoff", "handoff")
grounding = {}
check("decide low confidence -> handoff",
      portal_brain._decide({"reply": "x", "confidence": 0.2},
                           grounding)[0] == "handoff", "low")
grounding = {}
check("decide needs_human -> handoff",
      portal_brain._decide({"reply": "x", "needs_human": True,
                            "confidence": 0.9}, grounding)[0] == "handoff",
      "needs")
grounding = {}
d, reply, g = portal_brain._decide(
    {"reply": "Aapka order paid he, 2-4 din me delivery hogi.",
     "confidence": 0.9}, grounding)
check("decide good -> send", d == "send" and "order" in reply, (d, reply))
grounding = {}
check("decide policy violation -> handoff",
      portal_brain._decide({"reply": "refund will come tomorrow",
                            "confidence": 0.9}, grounding)[0] == "handoff",
      "policy")

# ---------- maybe_answer: autonomy gates + grounded send ----------

class FakeConn:
    """Wraps the stub cursor like a real conn (context manager)."""

    def __init__(self, cur):
        self.cur = cur

    def cursor(self):
        return self.cur


class CurCtx:
    def __init__(self, cur):
        self.cur = cur

    def __enter__(self):
        return self.cur

    def __exit__(self, *a):
        return False


def run_maybe_answer(script, chat_payload, autonomy="auto"):
    conn = fresh(script)
    captured = {}

    def fake_chat(system, user, max_tokens=120):
        captured["system"] = system
        captured["user"] = user
        return chat_payload

    portal_llm.chat_json = fake_chat
    with conn.cur as cur:
        ok = portal_brain.maybe_answer(
            1, 55, "92300", "Ali", "mera order kahan he", FakeConn(CurCtx(cur)))
    return ok, conn, captured


# autonomy != auto -> immediate None, no llm

# auto + good answer -> True + send_message queued + trace + audit
ok, conn, captured = run_maybe_answer(
    [[{"autonomy": "auto", "tone": "warm"}],
     [{"direction": "in", "body": "salam", "created_at": "t"}],  # msgs
     [],  # orders empty
     [{"kind": "entry", "id": 3, "title": "Order tracking",
       "content": "2-4 din", "extra": "", "source_id": 0, "source_title": "",
       "position": 0},
      {"kind": "chunk", "id": 41, "title": "orders",
       "content": "Order status updates are sent on WhatsApp within 24 hours.",
       "extra": "", "source_id": 7, "source_title": "Store policy",
       "position": 2}],  # kb (entries + published document sections)
     [],  # business facts (v2)
     [],  # customer memory (upgrade)
     [],  # agent persona (upgrade)
     [],  # profile lang? (stored_language select)
     [{"id": 77}],  # trace insert
     [{"id": 88}],  # cmd insert
     [],  # log_action select?
     ],
    {"reply": "Aapka order track ho gaya he, 2-4 din me pohnch jayega "
              "InshaAllah. Koi aur madad chahiye?",
     "confidence": 0.9})
check("auto + good answer -> True", ok is True, ok)
sqls = [s for s, p in conn.cur.executed]
check("send_message queued", any("INSERT INTO portal_connector_commands" in s
                                 and "send_message" in s for s in sqls),
      "queued")
check("trace written", any("INSERT INTO portal_brain_traces" in s
                           for s in sqls), "trace")
ins_params = [p for s, p in conn.cur.executed
              if "portal_connector_commands" in s][0]
check("payload source ai_brain", "ai_brain" in str(ins_params), "source")
check("grounding in prompt", "kb" in captured["user"]
      or "Order tracking" in captured["user"], "grounded")
check("document excerpt + source reach the prompt",
      "Store policy" in captured["user"] and "chunk" in captured["user"],
      captured["user"][:200])
check("system prompt explains KB entries vs document excerpts",
      "kind chunk" in captured["system"] and "never go beyond" in captured["system"],
      "prompt")
trace_params = [p for s, p in conn.cur.executed if "portal_brain_traces" in s][0]
check("trace cites document sections (knowledge_ids + citations)",
      "knowledge_ids" in str(trace_params) and "citations" in str(trace_params)
      and "Store policy" in str(trace_params) and "\"kb_ids\": [3]" in str(trace_params),
      str(trace_params)[:300])
check("policy line in system prompt",
      "NEVER promise refunds" in captured["system"], "policy prompt")

# auto + needs_human -> None + trace decision handoff
ok, conn, _ = run_maybe_answer(
    [[{"autonomy": "auto", "tone": ""}],
     [],  # msgs
     [],  # orders
     [],  # kb
     [],  # facts
     [],  # memory
     [],  # agent persona (upgrade)
     [],  # profile lang
     [{"id": 79}]],  # trace
    {"reply": "kuch samajh nahi aya", "needs_human": True,
     "confidence": 0.9})
check("auto + needs_human -> None (no send)", ok is None, ok)
check("handoff traced", any("portal_brain_traces" in s
                            for s, p in conn.cur.executed), "trace")

# needs_human is a real event: ONE escalation (ledger + audit + owner
# notification through portal_notify), never a silent trace
import portal_escalation  # noqa: E402
import portal_notify  # noqa: E402

portal_escalation._DDL_READY = True
_notified = []
_orig_notify = portal_notify.notify
portal_notify.notify = lambda *a, **k: _notified.append((a, k)) or {"in_app": 1}
try:
    ok, conn, _ = run_maybe_answer(
        [[{"autonomy": "auto", "tone": ""}],
         [], [], [], [], [], [], [],
         [{"id": 80}],  # trace
         [],  # escalation: none open for this chat
         [],  # escalation: persona table absent
         [],  # escalation: team table absent -> nobody assigned
         [{"id": 5}],  # escalation ledger row
         []],  # escalation.opened audit
        {"reply": "kuch samajh nahi aya", "needs_human": True,
         "confidence": 0.9})
finally:
    portal_notify.notify = _orig_notify
esc_rows = [e for e in conn.cur.executed if "portal_escalations" in e[0]
            and e[0].startswith("INSERT")]
audit_rows = [e for e in conn.cur.executed if "portal_action_log" in e[0]]
check("needs_human opens an escalation (source ai, reason needs_human)",
      ok is None and esc_rows and esc_rows[0][1][2] == "needs_human"
      and esc_rows[0][1][3] == "ai" and esc_rows[0][1][1] == 55, esc_rows)
check("escalation audited as automation + owner notified once",
      audit_rows and audit_rows[-1][1][1] == "escalation.opened"
      and audit_rows[-1][1][2] == "automation" and len(_notified) == 1
      and _notified[0][0][1] == "escalation"
      and _notified[0][1].get("dedupe_key") == "conv:55", (audit_rows, _notified))

# llm_unavailable is a platform problem, not a customer situation: no page
_notified = []
portal_notify.notify = lambda *a, **k: _notified.append((a, k)) or {}
try:
    ok, conn, _ = run_maybe_answer(
        [[{"autonomy": "auto", "tone": ""}],
         [], [], [], [], [], [], [], [{"id": 81}]], None)
finally:
    portal_notify.notify = _orig_notify
check("llm unavailable -> traced but NOT escalated",
      ok is None and not any("portal_escalations" in e[0]
                             for e in conn.cur.executed)
      and not _notified, conn.cur.executed[-1][0][:60])

# auto + llm down -> None fail-open
ok, conn, _ = run_maybe_answer(
    [[{"autonomy": "auto", "tone": ""}],
     [],  # msgs
     [],  # orders
     [],  # kb
     [],  # facts
     [],  # memory
     [],  # agent persona (upgrade)
     [],  # profile lang
     [{"id": 80}]],  # trace
    None)
check("auto + llm unavailable -> None", ok is None, ok)

# exception inside -> None (never raises into ingest)
portal_llm.chat_json = lambda *a, **k: (_ for _ in ()).throw(
    RuntimeError("boom"))
conn = fresh([[{"autonomy": "auto", "tone": ""}]])
with conn.cur as cur:
    ok = portal_brain.maybe_answer(1, 55, "92300", "Ali", "x",
                                   FakeConn(CurCtx(cur)))
check("brain exception fails silent", ok is None, ok)
portal_llm.chat_json = ORIG_CHAT

# ---------- owner API ----------

app = Flask("brain-test")
app.register_blueprint(portal_brain.bp)
client = app.test_client()

conn = fresh([[]])
with PrincipalStub(portal_brain, PRINCIPAL):
    r = client.get("/api/v1/portal/brain/settings")
check("settings get 200 default", r.status_code == 200
      and r.get_json()["settings"]["autonomy"] == "suggest",
      r.get_json())

conn = fresh([[{"autonomy": "auto", "tone": "warm"}]])
with PrincipalStub(portal_brain, PRINCIPAL):
    r = client.get("/api/v1/portal/brain/settings")
check("settings get stored", r.get_json()["settings"]["tone"] == "warm",
      r.get_json())

conn = fresh([[], []])
with PrincipalStub(portal_brain, PRINCIPAL):
    r_put = client.put("/api/v1/portal/brain/settings",
                       json={"autonomy": "auto", "tone": "friendly"})
check("settings put 200", r_put.status_code == 200, r_put.status_code)
check("settings upsert", any("ON CONFLICT (client_id)" in s
                             for s, p in conn.cur.executed), "upsert")
with PrincipalStub(portal_brain, PRINCIPAL):
    r_bad = client.put("/api/v1/portal/brain/settings",
                       json={"autonomy": "godmode"})
check("settings 400 bad autonomy", r_bad.status_code == 400,
      r_bad.status_code)
with PrincipalStub(portal_brain, {"via_api_key": True}):
    r_key = client.get("/api/v1/portal/brain/settings")
check("api key 403", r_key.status_code == 403, r_key.status_code)
with PrincipalStub(portal_brain, None):
    r_anon = client.get("/api/v1/portal/brain/settings")
check("anon 401", r_anon.status_code == 401, r_anon.status_code)

conn = fresh([[{"id": 5}], [], [], [], [], [], [], [], [], [], []])
portal_llm.chat_json = lambda *a, **k: {
    "reply": "Aapka order 2-4 din me a jayega.", "confidence": 0.9}
with PrincipalStub(portal_brain, PRINCIPAL):
    r_draft = client.post("/api/v1/portal/brain/draft",
                          json={"conversation_id": 55})
check("draft 200", r_draft.status_code == 200, r_draft.status_code)
body = r_draft.get_json()
check("draft payload", body["decision"] == "send"
      and "2-4 din" in body["draft"] and "kb_ids" in body["grounding"],
      body)
check("draft never queues", all("portal_connector_commands" not in s
                                for s, p in conn.cur.executed), "no send")
portal_llm.chat_json = ORIG_CHAT

conn = fresh([[]])
with PrincipalStub(portal_brain, PRINCIPAL):
    r_404 = client.post("/api/v1/portal/brain/draft",
                        json={"conversation_id": 999})
check("draft other-tenant 404", r_404.status_code == 404, r_404.status_code)
with PrincipalStub(portal_brain, PRINCIPAL):
    r_bad = client.post("/api/v1/portal/brain/draft", json={})
check("draft 400 no id", r_bad.status_code == 400, r_bad.status_code)

conn = fresh([[{"id": 1, "conversation_id": 55, "kind": "draft",
                "decision": "send", "grounding": {}, "created_at": "c"}]])
with PrincipalStub(portal_brain, PRINCIPAL):
    r_tr = client.get("/api/v1/portal/brain/trace?conversation_id=55")
check("trace 200", r_tr.status_code == 200, r_tr.status_code)
check("trace rows", r_tr.get_json()["traces"][0]["id"] == 1,
      r_tr.get_json())

# ---------- v2: structured business facts ----------

check("facts table in ddl", "portal_brain_facts" in portal_brain._DDL,
      "ddl")
check("fact kinds vocab",
      portal_brain.FACT_KINDS ==
      ("policy", "sop", "pricing", "refund", "escalation", "hours"),
      portal_brain.FACT_KINDS)

conn = fresh([[{"id": 7, "kind": "refund", "label": "Refund policy",
                "content": "7 din ke andar"}]])
with conn.cur as cur:
    facts = portal_brain.tool_business_facts(cur, 1, "refund", 3)
check("facts tool shaped", facts == [{"id": 7, "kind": "refund",
      "label": "Refund policy", "content": "7 din ke andar"}], facts)
with conn.cur as cur:
    check("facts empty query", portal_brain.tool_business_facts(
        cur, 1, "  ", 3) == [], "empty")
sqls = [s for s, p in conn.cur.executed]
check("facts query tenant-scoped + active",
      any("client_id = %s AND is_active = TRUE" in s for s in sqls),
      "where")

# maybe_answer grounds on business facts
conn = fresh([[{"autonomy": "auto", "tone": ""}],
              [], [], [],
              [{"id": 12, "kind": "pricing", "label": "Price list",
                "content": "shirt 1500"}],  # facts hit
              [{"id": 5, "kind": "preference", "mtype": "long",
                "content": "evening calls only"}],  # memory hit
              [],  # agent persona (upgrade)
              [],  # profile lang
              [{"id": 90}],  # trace
              [{"id": 91}],  # cmd
              []])  # log
captured = {}


def fake_chat2(system, user, max_tokens=120):
    captured["user"] = user
    return {"reply": "Shirt ka rate 1500 hai.", "confidence": 0.9}


portal_llm.chat_json = fake_chat2
with conn.cur as cur:
    ok = portal_brain.maybe_answer(
        1, 55, "92300", "Ali", "shirt ka rate kya he",
        FakeConn(CurCtx(cur)))
portal_llm.chat_json = ORIG_CHAT
check("v2 brain answers with facts", ok is True, ok)
check("v2 grounding business_facts",
      '"business"' in captured["user"]
      and "Price list" in captured["user"], "grounded")
check("memory grounding customer_memory",
      '"memory"' in captured["user"]
      and "evening calls only" in captured["user"], "grounded")
sqls = [s for s, p in conn.cur.executed]
check("v2 facts select ran", any("portal_brain_facts" in s
                                 and "ILIKE" in s for s in sqls), "select")

# agent persona grounds + tone overrides (Router+Agents upgrade)
agent_row = [{"id": 7, "name": "Sales Aunty", "tone": "cheerful persuasive",
              "instructions": "Always mention the free gift.",
              "escalation_user_id": 9, "is_active": True, "updated_at": "u"}]
conn = fresh([[{"autonomy": "auto", "tone": "warm"}],
              [{"direction": "in", "body": "shirt kitne ka", "created_at": "t"}],
              [],  # orders
              [],  # kb
              [],  # facts
              [],  # memory
              agent_row,  # agent persona (upgrade)
              [],  # profile lang
              [{"id": 90}],  # trace
              [{"id": 91}],  # cmd
              []])  # log
captured_agent = {}


def fake_chat_agent(system, user, max_tokens=120):
    captured_agent["user"] = user
    captured_agent["system"] = system
    return {"reply": "Ji, 1500 ka he.", "confidence": 0.9}


portal_llm.chat_json = fake_chat_agent
with conn.cur as cur:
    ok = portal_brain.maybe_answer(
        1, 55, "92300", "Ali", "shirt kitne ka", FakeConn(CurCtx(cur)))
portal_llm.chat_json = ORIG_CHAT
check("agent persona answers", ok is True, ok)
check("agent grounded in context",
      '"agent"' in captured_agent["user"]
      and "Sales Aunty" in captured_agent["user"], "grounded")
check("agent instructions flow to brain",
      "free gift" in captured_agent["user"], "instructions")
check("agent tone overrides settings",
      "cheerful" in captured_agent["system"], "tone")

# ---------- Control Center: platform cap + persona draft-only ----------

_orig_controls = portal_brain.platform_controls
check("effective autonomy: own <= cap passes through",
      portal_brain.effective_autonomy("auto", {"kill_switch": False,
                                               "autonomy_cap": "auto"}) == "auto"
      and portal_brain.effective_autonomy("suggest", {"autonomy_cap": "auto"})
      == "suggest", "cap")
check("effective autonomy: cap suggest lowers auto",
      portal_brain.effective_autonomy("auto", {"autonomy_cap": "suggest"})
      == "suggest"
      and portal_brain.effective_autonomy("off", {"autonomy_cap": "suggest"})
      == "off", "cap")
check("effective autonomy: kill switch -> off",
      portal_brain.effective_autonomy("auto", {"kill_switch": True,
                                               "autonomy_cap": "auto"}) == "off",
      "kill")
check("effective autonomy: garbage -> safe defaults",
      portal_brain.effective_autonomy("weird", {"autonomy_cap": "nope"})
      == "suggest", "defaults")
check("platform_controls fail-soft defaults",
      portal_brain.platform_controls().get("autonomy_cap") in
      ("auto", "suggest", "off"), portal_brain.platform_controls())

# workspace says auto, platform caps at suggest -> no LLM call, no send
portal_brain.platform_controls = lambda: {"kill_switch": False,
                                          "autonomy_cap": "suggest",
                                          "daily_call_cap": 0,
                                          "source": "panel"}
called = {"n": 0}


def fake_chat_capped(system, user, max_tokens=120):
    called["n"] += 1
    return {"reply": "x", "confidence": 0.9}


portal_llm.chat_json = fake_chat_capped
conn = fresh([[{"autonomy": "auto", "tone": ""}]])
with conn.cur as cur:
    ok = portal_brain.maybe_answer(1, 55, "92300", "Ali", "hi",
                                   FakeConn(CurCtx(cur)))
portal_llm.chat_json = ORIG_CHAT
check("platform cap suggest silences an auto workspace",
      ok is None and called["n"] == 0 and len(conn.cur.executed) == 1,
      (ok, called, len(conn.cur.executed)))

# kill switch -> same (settings read only)
portal_brain.platform_controls = lambda: {"kill_switch": True,
                                          "autonomy_cap": "auto",
                                          "daily_call_cap": 0,
                                          "source": "panel"}
conn = fresh([[{"autonomy": "auto", "tone": ""}]])
with conn.cur as cur:
    ok = portal_brain.maybe_answer(1, 55, "92300", "Ali", "hi",
                                   FakeConn(CurCtx(cur)))
check("kill switch silences the brain", ok is None
      and len(conn.cur.executed) == 1, ok)
portal_brain.platform_controls = _orig_controls

# persona permission can_auto_reply=False -> decision handoff, reason
# agent_draft_only, nothing queued, no escalation (not a handoff reason)
draft_agent = [{"id": 7, "name": "Support Pro", "tone": "formal",
                "instructions": "Policy strict.", "escalation_user_id": None,
                "is_active": True, "updated_at": "u",
                "allowed_actions": None, "max_risk": "medium",
                "can_auto_reply": False}]
conn = fresh([[{"autonomy": "auto", "tone": "warm"}],
              [{"direction": "in", "body": "refund?", "created_at": "t"}],
              [],  # orders
              [],  # kb
              [],  # facts
              [],  # memory
              draft_agent,  # agent persona
              [],  # profile lang
              [{"id": 90}]])  # trace (then handoff: no escalation)
portal_llm.chat_json = lambda system, user, max_tokens=120: {
    "reply": "Refund 7 din me.", "confidence": 0.95}
with conn.cur as cur:
    ok = portal_brain.maybe_answer(1, 55, "92300", "Ali", "refund?",
                                   FakeConn(CurCtx(cur)))
portal_llm.chat_json = ORIG_CHAT
trace = next((e for e in conn.cur.executed if "portal_brain_traces" in e[0]),
             None)
check("draft-only persona never auto-sends", ok is None
      and not any("portal_connector_commands" in e[0]
                  for e in conn.cur.executed), ok)
check("draft-only persona traced as handoff/agent_draft_only",
      trace is not None and trace[1][3] == "handoff"
      and '"agent_draft_only"' in str(trace[1][4])
      and '"agent_auto_reply": false' in str(trace[1][4]), trace)
check("draft-only persona opens no escalation",
      not any("portal_escalations" in e[0] for e in conn.cur.executed),
      "no escalation")

# settings GET carries the platform block (owner-visible cap / pause)
portal_brain.platform_controls = lambda: {"kill_switch": False,
                                          "autonomy_cap": "suggest",
                                          "daily_call_cap": 500,
                                          "source": "panel"}
conn = fresh([[{"autonomy": "auto", "tone": "warm"}]])
with PrincipalStub(portal_brain, PRINCIPAL):
    r_ps = client.get("/api/v1/portal/brain/settings")
portal_brain.platform_controls = _orig_controls
body_ps = r_ps.get_json()["settings"]
check("settings get exposes platform controls",
      body_ps["autonomy"] == "auto"
      and body_ps["platform"] == {"paused": False, "autonomy_cap": "suggest",
                                  "daily_call_cap": 500,
                                  "guard_mode": "standard",
                                  "effective_autonomy": "suggest"}, body_ps)
check("brain DDL chain carries agents DDL (permission columns)",
      "portal_agents._ensure_ddl(cur)" in open("portal_brain.py",
                                               encoding="utf8").read(),
      "chain")

# facts API
conn = fresh([[{"id": 7, "kind": "policy", "label": "Refund",
                "content": "7 din", "keywords": "refund wapas",
                "is_active": True, "updated_at": "u"}]])
with PrincipalStub(portal_brain, PRINCIPAL):
    r_gf = client.get("/api/v1/portal/brain/facts")
check("facts get 200", r_gf.status_code == 200
      and r_gf.get_json()["facts"][0]["id"] == 7, r_gf.get_json())

conn = fresh([[{"id": 21}], []])
with PrincipalStub(portal_brain, PRINCIPAL):
    r_cf = client.post("/api/v1/portal/brain/facts",
                       json={"kind": "sop", "label": "RMA flow",
                             "content": "pehle video bhejwayen",
                             "keywords": "rma return"})
check("facts create 200", r_cf.status_code == 200
      and r_cf.get_json()["fact"]["id"] == 21, r_cf.get_json())
sqls = [s for s, p in conn.cur.executed]
check("facts create insert", any("INSERT INTO portal_brain_facts" in s
                                 for s in sqls), "insert")
audit_rows = [(s, p) for s, p in conn.cur.executed
              if "portal_action_log" in s]
check("facts create audit", bool(audit_rows)
      and "brain.facts" in str(audit_rows[0][1]), "audit")

conn = fresh([[{"id": 21}], []])
with PrincipalStub(portal_brain, PRINCIPAL):
    r_uf = client.post("/api/v1/portal/brain/facts",
                       json={"id": 21, "kind": "sop", "label": "RMA v2",
                             "content": "updated flow", "is_active": False})
check("facts update 200", r_uf.status_code == 200
      and r_uf.get_json()["fact"]["is_active"] is False, r_uf.get_json())
check("facts update tenant guard",
      any("WHERE id = %s AND client_id = %s" in s
          for s, p in conn.cur.executed), "guard")

conn = fresh([[]])
with PrincipalStub(portal_brain, PRINCIPAL):
    r_404f = client.post("/api/v1/portal/brain/facts",
                         json={"id": 999, "kind": "sop", "label": "x",
                               "content": "y"})
check("facts update other-tenant 404", r_404f.status_code == 404,
      r_404f.status_code)

conn = fresh([])
with PrincipalStub(portal_brain, PRINCIPAL):
    r_badk = client.post("/api/v1/portal/brain/facts",
                         json={"kind": "godmode", "label": "x",
                               "content": "y"})
check("facts 400 bad kind", r_badk.status_code == 400,
      r_badk.status_code)
with PrincipalStub(portal_brain, PRINCIPAL):
    r_badl = client.post("/api/v1/portal/brain/facts",
                         json={"kind": "policy", "label": "",
                               "content": "y"})
check("facts 400 empty label", r_badl.status_code == 400,
      r_badl.status_code)

conn = fresh([[{"id": 21}], []])
with PrincipalStub(portal_brain, PRINCIPAL):
    r_df = client.delete("/api/v1/portal/brain/facts?id=21")
check("facts delete 200 soft", r_df.status_code == 200
      and r_df.get_json()["ok"] is True, r_df.get_json())
sqls = [s for s, p in conn.cur.executed]
check("facts delete is soft", any("is_active = FALSE" in s for s in sqls),
      "soft")

conn = fresh([[]])
with PrincipalStub(portal_brain, PRINCIPAL):
    r_d404 = client.delete("/api/v1/portal/brain/facts?id=999")
check("facts delete other-tenant 404", r_d404.status_code == 404,
      r_d404.status_code)
with PrincipalStub(portal_brain, PRINCIPAL):
    r_dbad = client.delete("/api/v1/portal/brain/facts")
check("facts delete 400 no id", r_dbad.status_code == 400,
      r_dbad.status_code)
with PrincipalStub(portal_brain, {"via_api_key": True}):
    r_kf = client.get("/api/v1/portal/brain/facts")
check("facts api key 403", r_kf.status_code == 403, r_kf.status_code)
with PrincipalStub(portal_brain, None):
    r_af = client.get("/api/v1/portal/brain/facts")
check("facts anon 401", r_af.status_code == 401, r_af.status_code)

# ---------- memory upgrade: tool + grounding ----------

conn = fresh([[{"id": 9, "kind": "preference", "mtype": "long",
                "content": "evening calls only"}]])
with conn.cur as cur:
    mem = portal_brain.tool_customer_memory(cur, 1, "92300", 3)
check("memory tool shaped", mem == [{"id": 9, "kind": "preference",
      "mtype": "long", "content": "evening calls only"}], mem)
with conn.cur as cur:
    check("memory empty contact",
          portal_brain.tool_customer_memory(cur, 1, "", 3) == [], "empty")
check("memory query tenant + expiry",
      any("contact_id = %s" in s
          and "expires_at IS NULL OR expires_at > NOW()" in s
          for s, p in conn.cur.executed), "where")
conn = fresh([])
with conn.cur as cur:
    check("memory tool fail-soft on exhaustion",
          portal_brain.tool_customer_memory(cur, 1, "92300", 3) == [],
          "failsoft")
# ---------- wiring pins ----------

CONN = open("/tmp/smoke971/connector_api.py", encoding="utf8").read()
check("connector brain gate before kb",
      CONN.index("portal_brain.maybe_answer(")
      < CONN.index("portal_intents.classify("), "order")
check("connector claims brain", 'claimed_by = "brain"' in CONN, "claim")
check("kb gate still intact after brain",
      "portal_kb.maybe_auto_reply(" in CONN, "kb")
APP = open("/tmp/smoke971/app.py", encoding="utf8").read()
check("app.py registers brain bp",
      "aux_app.register_blueprint(portal_brain_bp)" in APP, "bp")
PORTAL = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts",
              encoding="utf8").read()
for fn in ("getBrainSettings", "putBrainSettings", "draftBrainReply",
           "listBrainTraces", "listBrainFacts", "saveBrainFact",
           "deleteBrainFact"):
    check("client " + fn, "export async function " + fn in PORTAL, fn)
CARD = open("/tmp/p13/Omniflow/app/dashboard/(portal)/settings/BrainCard.tsx",
            encoding="utf8").read()
check("brain card exists", "AI Brain" in CARD
      and "brain/settings" in CARD, "card")
BOT_PAGE = open("/tmp/p13/Omniflow/app/dashboard/(portal)/bot/page.tsx",
                encoding="utf8").read()
SETTINGS_PAGE = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/settings/page.tsx",
    encoding="utf8").read()
check("configure-ai mounts brain card", "<BrainCard />" in BOT_PAGE
      and "<BrainCard />" not in SETTINGS_PAGE, "mount")
check("ai-brain page redirects", "redirect(\"/dashboard/bot\")" in open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/ai-brain/page.tsx",
    encoding="utf8").read(), "redirect")
check("no duplicate nav entry", "ai-brain" not in open(
    "/tmp/p13/Omniflow/app/dashboard/components/DashSidebar.tsx",
    encoding="utf8").read(), "sidebar")
for route in ("brain/settings", "brain/draft", "brain/trace",
              "brain/facts"):
    src = open("/tmp/p13/Omniflow/app/api/omniflow/portal/" + route +
               "/route.ts", encoding="utf8").read()
    check("bff " + route, "export async function" in src, route)
FACTS = open("/tmp/p13/Omniflow/app/dashboard/(portal)/settings/FactsCard.tsx",
             encoding="utf8").read()
check("facts card exists", "Business facts" in FACTS
      and "brain/facts" in FACTS, "card")
check("configure-ai mounts facts card", "<FactsCard />" in BOT_PAGE,
      "mount")

summary("brain")
