"""Tests for B8: portal_recovery (detection scan, follow-ups, auto
mode, negotiation bounds engine, copy-gen with fallback) + wiring pins
(app.py bp, BFF routes, cards, mounts, portal.ts clients)."""
import json

from flask import Flask

import portal_recovery
import portal_llm
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


def fresh(script):
    portal_recovery._DDL_READY = True
    db = install_db_stub(portal_recovery, script)
    portal_recovery.portal_db.CMD_TABLE = "portal_connector_commands"
    portal_recovery.portal_db.CONV_TABLE = "portal_conversations"
    portal_recovery.portal_db.MSGS_TABLE = "portal_messages"
    return db


def run_api(script, method, path, json_body=None, principal=PRINCIPAL):
    fresh(script)
    app = Flask("recovery-test")
    app.register_blueprint(portal_recovery.bp)
    with PrincipalStub(portal_recovery, principal):
        client = app.test_client()
        if method == "GET":
            return client.get(path)
        if method == "POST":
            return client.post(path, json=json_body)
        if method == "PUT":
            return client.put(path, json=json_body)
    return None


def reset_llm():
    portal_llm.chat_json = ORIG_CHAT
    portal_llm.ENABLED = False
    portal_llm.API_KEY = ""


reset_llm()

# ---------- pure helpers ----------

check("floor from pct", portal_recovery.negotiation_floor(
    1000, {"min_price": 0, "max_discount_pct": 10}) == 900, 900)
check("floor from min_price wins", portal_recovery.negotiation_floor(
    1000, {"min_price": 950, "max_discount_pct": 10}) == 950, 950)
check("floor never below min", portal_recovery.negotiation_floor(
    100, {"min_price": 500, "max_discount_pct": 50}) == 500, 500)

d = portal_recovery.negotiation_decision(
    1000, 1100, {"min_price": 0, "max_discount_pct": 10})
check("offer above price -> accept", d["decision"] == "accept"
      and d["counter_price"] == 1000, d)
d = portal_recovery.negotiation_decision(
    1000, 920, {"min_price": 0, "max_discount_pct": 10})
check("offer above floor -> accept", d["decision"] == "accept"
      and d["counter_price"] == 920, d)
d = portal_recovery.negotiation_decision(
    1000, 880, {"min_price": 0, "max_discount_pct": 10})
check("offer just below floor -> counter at floor", d["decision"] ==
      "counter" and d["counter_price"] == 900, d)
d = portal_recovery.negotiation_decision(
    1000, 500, {"min_price": 0, "max_discount_pct": 10})
check("lowball -> reject", d["decision"] == "reject"
      and d["counter_price"] == 900, d)
check("counter never below floor with min_price",
      portal_recovery.negotiation_decision(
          1000, 100, {"min_price": 800,
                      "max_discount_pct": 50})["counter_price"] == 800,
      "800")

check("fmt price whole", portal_recovery._fmt_price(950.0) == "950",
      "950")
check("fmt price fraction", portal_recovery._fmt_price(949.5) == "949.5",
      "949.5")

# ---------- fallback copy (no key) ----------

res = portal_recovery.fallback_copy("winter sale", "roman")
check("fallback roman 2 variants", len(res) == 2
      and "winter sale" in res[0], res)
res = portal_recovery.fallback_copy("sale", "en")
check("fallback en", all("sale" in v for v in res), res)
res = portal_recovery.fallback_copy("sale", "ur")
check("fallback ur non-empty", len(res) == 2 and all(res), res)

# ---------- scan: slots + dedupe + auto mode ----------

conn = fresh([
    [],                                   # settings default
    [],                                   # checkout scan
    [],                                   # cod scan
    [],                                   # price scan
    [],                                   # inactive scan
    [],                                   # list
])
with conn.cur as cur:
    items, settings = portal_recovery.scan_recoveries(cur, 1)
check("empty scan -> no items", items == [], items)
check("default settings", settings["checkout_hours"] == 24
      and settings["auto_enabled"] is False, settings)
sqls = [s for s, p in conn.cur.executed]
check("scan hits checkout links", any("portal_checkout_links" in s
                                      and "status = 'open'" in s
                                      for s in sqls), "checkout")
check("scan hits cod requests", any("portal_cod_requests" in s
                                    and "status = 'pending'" in s
                                    for s in sqls), "cod")
check("scan hits price phrases", any("ILIKE" in s for s in sqls), "price")
check("scan min value filter", any("SUM(paid_amount) >=" in s
                                   for s in sqls), "value")

# found checkout -> insert new -> auto OFF: no command
conn = fresh([
    [],                                    # settings
    [{"id": 7, "contact_id": "92300", "total": 1200}],   # checkout hit
    [], [],                                # cod, price
    [],                                    # inactive
    [{"id": 9}],                           # insert RETURNING (new)
    [],                                    # list
])
with conn.cur as cur:
    portal_recovery.scan_recoveries(cur, 1)
sqls = [s for s, p in conn.cur.executed]
check("scan upsert dedupes", any("ON CONFLICT (client_id, kind, ref_key)"
                                 " DO NOTHING" in s for s in sqls), "dedupe")
check("no auto command when auto off",
      not any("portal_connector_commands" in s for s in sqls), "no-cmd")

# auto ON: new detection -> command + contacted + audit
conn = fresh([
    [{"auto_enabled": True, "checkout_hours": 24, "cod_hours": 12,
      "inactive_days": 21, "min_value": 5000}],
    [{"id": 7, "contact_id": "92300", "total": 1200}],
    [], [], [],
    [{"id": 9}],                           # new insert
    [{"id": 1}],                           # auto command insert
    [{"id": 1}],                           # update slot
    [],                                    # auto audit log
    [],                                    # list
])
with conn.cur as cur:
    portal_recovery.scan_recoveries(cur, 1)
sqls = [s for s, p in conn.cur.executed]
cmds = [p for s, p in conn.cur.executed
        if "portal_connector_commands" in s]
check("auto queued command", len(cmds) == 1, len(cmds))
check("auto payload source recovery", cmds and "recovery" in str(cmds[0]),
      "src")
check("auto marked contacted", any("SET status = 'contacted'" in s
                                   for s in sqls), "contacted")
check("auto audit row", any("recovery.auto" in str(p)
                            for s, p in conn.cur.executed), "audit")

# ---------- follow-up copy ----------

check("copy exists for all kinds",
      set(portal_recovery.FOLLOWUP_COPY) ==
      {"abandoned_checkout", "unconfirmed_cod", "price_objection",
       "inactive_high_value"}, "kinds")
conn = fresh([
    [{"id": 3, "kind": "abandoned_checkout", "contact_id": "92300",
      "conversation_id": 55, "status": "open"}],
    [{"id": 1}],                           # command insert
    [],                                    # update
    [],                                    # log_action
])
with conn.cur as cur:
    ok = portal_recovery._enqueue_followup(
        cur, 1, "abandoned_checkout", "92300", 55)
check("followup queued", ok is True, ok)
cmd = [p for s, p in conn.cur.executed
       if "portal_connector_commands" in s][0]
check("followup body roman urdu", "Assalam-o-Alaikum" in str(cmd)
      and "pending" in str(cmd), cmd)
check("followup carries conversation", "55" in str(cmd), cmd)

# ---------- owner API ----------

r = run_api([[], [], [], [], [], []], "GET", "/api/v1/portal/recovery")
check("recovery list 200", r.status_code == 200
      and r.get_json()["items"] == [], r.get_json())
r = run_api([], "GET", "/api/v1/portal/recovery",
            principal=dict(PRINCIPAL, via_api_key=True))
check("recovery api key 403", r.status_code == 403, r.status_code)

r = run_api([], "POST", "/api/v1/portal/recovery/followup", {})
check("followup 400 no id", r.status_code == 400, r.status_code)
r = run_api([[]], "POST", "/api/v1/portal/recovery/followup", {"id": 9})
check("followup 404 missing", r.status_code == 404, r.status_code)
r = run_api([
    [{"id": 3, "kind": "unconfirmed_cod", "contact_id": "92300",
      "conversation_id": None, "status": "contacted"}],
], "POST", "/api/v1/portal/recovery/followup", {"id": 3})
check("followup 409 not open", r.status_code == 409, r.status_code)
r = run_api([
    [{"id": 3, "kind": "unconfirmed_cod", "contact_id": "92300",
      "conversation_id": None, "status": "open"}],
    [{"id": 1}], [], [],
], "POST", "/api/v1/portal/recovery/followup", {"id": 3})
check("followup 200", r.status_code == 200
      and "COD" in r.get_json()["copy"], r.get_json())

r = run_api([
    [{"id": 3, "kind": "price_objection", "contact_id": "92300",
      "conversation_id": 5, "status": "open"}],
    [],                                     # update -> RETURNING []
], "POST", "/api/v1/portal/recovery/dismiss", {"id": 3})
check("dismiss 200", r.status_code == 200, r.status_code)
r = run_api([[]], "POST", "/api/v1/portal/recovery/dismiss", {"id": 3})
check("dismiss 404 closed", r.status_code == 404, r.status_code)

r = run_api([[]], "GET", "/api/v1/portal/recovery/settings")
check("settings get default", r.status_code == 200
      and r.get_json()["settings"]["auto_enabled"] is False, r.get_json())
r = run_api([[], []], "PUT", "/api/v1/portal/recovery/settings",
            {"auto_enabled": True, "checkout_hours": 9999,
             "cod_hours": 0, "inactive_days": 5, "min_value": 2500})
check("settings put 200 clamped", r.status_code == 200
      and r.get_json()["settings"]["checkout_hours"] == 168
      and r.get_json()["settings"]["cod_hours"] == 1, r.get_json())
r = run_api([], "PUT", "/api/v1/portal/recovery/settings", {})
check("settings put 400", r.status_code == 400, r.status_code)

# ---------- negotiation API ----------

r = run_api([[]], "POST", "/api/v1/portal/negotiation/decide",
            {"price": 1000, "offer": 900})
check("decide 403 disabled", r.status_code == 403, r.status_code)
r = run_api([], "POST", "/api/v1/portal/negotiation/decide",
            {"price": "abc", "offer": 900})
check("decide 400 bad numbers", r.status_code == 400, r.status_code)
r = run_api([[], []], "PUT", "/api/v1/portal/negotiation/bounds",
            {"enabled": True, "min_price": 800, "max_discount_pct": 30})
check("neg settings put 200", r.status_code == 200, r.status_code)
r = run_api([], "PUT", "/api/v1/portal/negotiation/bounds",
            {"enabled": True, "min_price": -5, "max_discount_pct": 10})
check("neg settings 400 bad min", r.status_code == 400, r.status_code)

# counter with LLM phrasing that contains the price -> used
portal_llm.chat_json = lambda *a, **k: {"message": "Bhai 900 final he -"
                                        " bhej dete hain."}
r = run_api([
    [{"enabled": True, "min_price": 0, "max_discount_pct": 10}],
    [{"id": 1}],                            # round insert
    [],                                     # log_action
], "POST", "/api/v1/portal/negotiation/decide",
    {"price": 1000, "offer": 880})
body = r.get_json()
check("decide counter 200", r.status_code == 200
      and body["decision"] == "counter" and body["counter_price"] == 900,
      body)
check("llm phrase used (contains price)", "900" in body["message"]
      and "Bhai" in body["message"], body["message"])

# LLM text WITHOUT the price -> fallback used
portal_llm.chat_json = lambda *a, **k: {"message": "Chalein deal kar lein."}
r = run_api([
    [{"enabled": True, "min_price": 0, "max_discount_pct": 10}],
    [{"id": 1}], [],
], "POST", "/api/v1/portal/negotiation/decide",
    {"price": 1000, "offer": 880})
body = r.get_json()
check("bad llm phrase -> fallback", "Behtareen qeemat 900" in
      body["message"], body["message"])
reset_llm()

# accept + rounds/audit pins
r = run_api([
    [{"enabled": True, "min_price": 0, "max_discount_pct": 10}],
    [{"id": 1}], [],
], "POST", "/api/v1/portal/negotiation/decide",
    {"price": 1000, "offer": 950, "conversation_id": 55})
body = r.get_json()
check("decide accept", body["decision"] == "accept"
      and body["counter_price"] == 950, body)
check("message has clean 950", "950" in body["message"]
      and "950.0" not in body["message"], body["message"])

# ---------- copygen API ----------

r = run_api([[]], "POST", "/api/v1/portal/copygen/broadcast", {})
check("copygen 400 no topic", r.status_code == 400, r.status_code)
r = run_api([[]], "POST", "/api/v1/portal/copygen/broadcast",
            {"topic": "x", "lang": "de"})
check("copygen 400 bad lang", r.status_code == 400, r.status_code)
r = run_api([[]], "POST", "/api/v1/portal/copygen/broadcast",
            {"topic": "winter shawl sale", "lang": "roman"})
check("copygen fallback 200", r.status_code == 200
      and len(r.get_json()["variants"]) == 2
      and r.get_json()["source"] == "fallback"
      and "winter shawl sale" in r.get_json()["variants"][0], r.get_json())

portal_llm.chat_json = lambda *a, **k: {"variants": ["AI one.", "AI two."]}
r = run_api([[]], "POST", "/api/v1/portal/copygen/broadcast",
            {"topic": "sale", "lang": "en"})
check("copygen llm variants", r.get_json()["source"] == "llm"
      and r.get_json()["variants"] == ["AI one.", "AI two."],
      r.get_json())
portal_llm.chat_json = lambda *a, **k: {"variants": ["only one"]}
r = run_api([[]], "POST", "/api/v1/portal/copygen/broadcast",
            {"topic": "sale", "lang": "en"})
check("copygen llm short -> fallback", r.get_json()["source"] ==
      "fallback", r.get_json())
portal_llm.chat_json = lambda *a, **k: None
r = run_api([[]], "POST", "/api/v1/portal/copygen/broadcast",
            {"topic": "sale", "lang": "ur"})
check("copygen no llm -> fallback", r.get_json()["source"] == "fallback"
      and len(r.get_json()["variants"]) == 2, r.get_json())
reset_llm()

# ---------- wiring pins ----------

APP = open("/tmp/smoke971/app.py", encoding="utf8").read()
check("app.py registers recovery bp",
      "aux_app.register_blueprint(portal_recovery_bp)" in APP, "bp")
PORTAL = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts",
              encoding="utf8").read()
for fn in ("listRecoveries", "sendRecoveryFollowup", "dismissRecovery",
           "putRecoverySettings", "getPriceBounds",
           "putPriceBounds", "decideNegotiation",
           "generateBroadcastCopy"):
    check("client " + fn, "export async function " + fn in PORTAL, fn)
BASE = "/tmp/smoke971/"
for route in ("recovery", "recovery_followup", "recovery_dismiss",
              "recovery_settings", "negotiation_bounds",
              "negotiation_decide", "copygen_broadcast"):
    src = open(BASE + "bff_" + route + ".ts", encoding="utf8").read()
    check("bff " + route, "export async function" in src, route)
CARD = open(BASE + "recovery_card.tsx", encoding="utf8").read()
check("recovery card", "Revenue recovery" in CARD
      and "portal/recovery" in CARD and "Auto:" in CARD, "card")
NEG = open(BASE + "negotiation_card.tsx", encoding="utf8").read()
check("negotiation card", "Negotiation bounds" in NEG
      and "negotiation/decide" in NEG, "card")
CGEN = open(BASE + "copygen_card.tsx", encoding="utf8").read()
check("copygen card", "AI copy helper" in CGEN
      and "copygen/broadcast" in CGEN, "card")
OVER = open(BASE + "overview_page.tsx", encoding="utf8").read()
check("overview mounts recovery", "<RecoveryCard />" in OVER, "mount")
BCAST = open(BASE + "broadcasts_page.tsx", encoding="utf8").read()
check("broadcasts mounts copygen", "<CopyGenCard />" in BCAST, "mount")
SET = open(BASE + "settings_page.tsx", encoding="utf8").read()
check("settings mounts negotiation", "<NegotiationCard />" in SET, "mount")

summary("recovery")
