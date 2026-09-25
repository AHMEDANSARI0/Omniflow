"""Tests for B6: portal_brain (tools, policy, reasoner, autonomy,
ingest hook, owner API, traces) + wiring pins + web pins."""
import json

from flask import Flask

import portal_brain
import portal_llm
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
check("kb search shaped", kb == [{"id": 3, "title": "Delivery time",
      "content": "2-4 din"}], kb)

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
     [{"id": 3, "title": "Tracking", "content": "2-4 din"}],  # kb
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
      or "Tracking" in captured["user"], "grounded")
check("policy line in system prompt",
      "NEVER promise refunds" in captured["system"], "policy prompt")

# auto + needs_human -> None + trace decision handoff
ok, conn, _ = run_maybe_answer(
    [[{"autonomy": "auto", "tone": ""}],
     [], [], [], [],
     [{"id": 79}]],
    {"reply": "kuch samajh nahi aya", "needs_human": True,
     "confidence": 0.9})
check("auto + needs_human -> None (no send)", ok is None, ok)
check("handoff traced", any("portal_brain_traces" in s
                            for s, p in conn.cur.executed), "trace")

# auto + llm down -> None fail-open
ok, conn, _ = run_maybe_answer(
    [[{"autonomy": "auto", "tone": ""}], [], [], [], [], [{"id": 80}]],
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

conn = fresh([[{"id": 5}], [], [], [], [], [], [], [], []])
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
           "listBrainTraces"):
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
for route in ("brain/settings", "brain/draft", "brain/trace"):
    src = open("/tmp/p13/Omniflow/app/api/omniflow/portal/" + route +
               "/route.ts", encoding="utf8").read()
    check("bff " + route, "export async function" in src, route)

summary("brain")
