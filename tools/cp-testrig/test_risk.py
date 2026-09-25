"""Tests for B9: portal_risk (RTO score math + WHY factors, threshold
bands, staff tasks advisory-by-default, city rates, address
normalization + ask flow) + wiring pins."""
import json

from flask import Flask

import portal_risk
from test_lib import install_db_stub
from test_lib import check, summary

PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}


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
    portal_risk._DDL_READY = True
    return install_db_stub(portal_risk, script)


def run_api(script, method, path, json_body=None, query="",
            principal=PRINCIPAL):
    fresh(script)
    app = Flask("risk-test")
    app.register_blueprint(portal_risk.bp)
    with PrincipalStub(portal_risk, principal):
        client = app.test_client()
        if method == "GET":
            return client.get(path + query)
        if method == "POST":
            return client.post(path, json=json_body)
        if method == "PUT":
            return client.put(path, json=json_body)
    return None


SETTINGS = {"score_threshold": 70, "staff_tasks": False,
            "city_default_pct": 30}

# ---------- score math (pure) ----------

s, f, r = portal_risk.compute_risk(
    {"delivered": 0, "returned": 0, "avg_value": 0, "confirm_hours": None},
    SETTINGS, None)
check("new customer base 58", s == 58, (s, f))
check("new customer factors present",
      {x["key"] for x in f} == {"base", "new_customer", "city_rate",
                                "confirm_speed"}, f)

# clean history: many delivered, none returned, fast confirm, cheap order
s, f, r = portal_risk.compute_risk(
    {"delivered": 10, "returned": 0, "avg_value": 1500,
     "confirm_hours": 1.0},
    SETTINGS, 0)
check("clean history low score", s <= 45, (s, f))
check("fast confirm negative point",
      any(x["key"] == "confirm_speed" and x["points"] < 0 for x in f), f)
check("clean -> proceed", r == "proceed", r)

# bad history: every other order returned, slow confirm, expensive
s, f, r = portal_risk.compute_risk(
    {"delivered": 2, "returned": 2, "avg_value": 60000,
     "confirm_hours": 60.0},
    SETTINGS, 100)
check("risky history high score", s >= 80, (s, f))
check("risky -> hold", r == "hold", r)
check("return_history factor explains",
      any("2 returned of 4" in x["note"] for x in f), f)
check("high value factor explains",
      any(x["key"] == "order_value" and x["points"] == 12 for x in f), f)
check("city factor max", any(x["key"] == "city_rate"
                             and x["points"] == 25 for x in f), f)

# clamp 0..100
s, f, r = portal_risk.compute_risk(
    {"delivered": 50, "returned": 0, "avg_value": 0, "confirm_hours": 0.5},
    {"score_threshold": 70, "staff_tasks": False, "city_default_pct": 0},
    0)
check("score never below 0", s >= 0, s)

# mid band -> collect_advance
s, f, r = portal_risk.compute_risk(
    {"delivered": 3, "returned": 1, "avg_value": 22000,
     "confirm_hours": 30.0},
    SETTINGS, 40)
check("mid band collect_advance", r == "collect_advance", (s, r))
check("mid band above threshold-20", s >= 50, s)

# ---------- history builder (SQL pins) ----------

conn = fresh([
    [{"status": "delivered", "n": 4, "avg_total": 3000},
     {"status": "returned", "n": 1, "avg_total": 2500}],
    [{"created_at": "t1", "answered_at": "t1+"}],
])
with conn.cur as cur:
    hist = portal_risk.build_history(cur, 1, "92300")
check("history counts", hist["delivered"] == 4 and hist["returned"] == 1,
      hist)
sqls = [s for s, p in conn.cur.executed]
check("history uses links", any("portal_checkout_links" in s and
                                "GROUP BY status" in s for s in sqls),
      "links")
check("history tenant scoped", any("contact_id = %s" in s for s in sqls),
      "scoped")

conn = fresh([[], []])
with conn.cur as cur:
    hist = portal_risk.build_history(cur, 1, "92300")
check("empty history zeroed", hist["delivered"] == 0
      and hist["confirm_hours"] is None, hist)

# ---------- address normalization ----------

res = portal_risk.normalize_address(
    "  Hno 12,   blk-C ,   gulshan-e-iqbal,,   KARACHI   0300-1234567 ")
check("normalize lower + expanded", res["normalized"] ==
    "house no 12, block-c, gulshan-e-iqbal, karachi", res)
check("normalize extracts phone", res["phone"] == "0300-1234567", res)
check("normalize extracts city", res["city"] == "karachi", res)
check("complete address no prompts", res["ask_prompts"] == [], res)

res = portal_risk.normalize_address("jhot bazaar")
check("short address flagged", "too_short" in res["issues"]
      and "no_city" in res["issues"], res)
check("ask prompts roman urdu", any("city" in p.lower()
                                    for p in res["ask_prompts"]), res)

res = portal_risk.normalize_address("model town lahore")
check("missing number flagged", "no_house_number" in res["issues"], res)
check("lahore detected", res["city"] == "lahore", res)

res = portal_risk.normalize_address("")
check("empty address prompt", "empty" in res["issues"]
      and res["ask_prompts"], res)

res = portal_risk.normalize_address("main bazar multan")
check("extra cities param works",
      portal_risk.normalize_address("xyz mytown",
                                    ["mytown"])["city"] == "mytown",
      "extra")

# ---------- API matrix ----------

r = run_api([], "GET", "/api/v1/portal/risk/score")
check("score 400 no contact", r.status_code == 400, r.status_code)
r = run_api([
    [],                                  # settings
    [],                                  # history links
    [],                                  # cod requests
    [],                                  # city rates (score)
    [],                                  # open-task check
], "GET", "/api/v1/portal/risk/score", query="?contact=92300")
check("score 200 advisory default", r.status_code == 200
      and r.get_json()["task_created"] is False
      and r.get_json()["threshold"] == 70, r.get_json())
r = run_api([], "GET", "/api/v1/portal/risk/score",
            query="?contact=x", principal=dict(PRINCIPAL, via_api_key=True))
check("score api key 403", r.status_code == 403, r.status_code)

# hold + staff_tasks ON -> task created + audit
HOLD_HISTORY = [
    [{"status": "returned", "n": 3, "avg_total": 5000},
     {"status": "delivered", "n": 1, "avg_total": 5000}],
    [],
]
r = run_api([
    [{"score_threshold": 70, "staff_tasks": True, "city_default_pct": 30}],
    *HOLD_HISTORY[:1],
    *HOLD_HISTORY[1:],
    [],                                   # city rates
    [],                                   # open task check (none)
    [{"id": 33}],                         # task insert
    [],                                   # log_action
    [],                                   # city rates list
], "GET", "/api/v1/portal/risk/score", query="?contact=92300&total=60000")
body = r.get_json()
check("hold + tasks -> task_created", body.get("task_created") is True,
      body)
check("hold recommendation", body.get("recommendation") == "hold", body)

# dedupe: open task exists -> no new task
r = run_api([
    [{"score_threshold": 70, "staff_tasks": True, "city_default_pct": 30}],
    [{"status": "returned", "n": 3, "avg_total": 5000}],
    [],                                    # cod history
    [{"1": 1}],                            # open task exists
    [],                                    # city rates list
], "GET", "/api/v1/portal/risk/score", query="?contact=92300&total=60000")
check("task dedupe", r.get_json().get("task_created") is False,
      r.get_json())

r = run_api([[], []], "GET", "/api/v1/portal/risk/settings")
check("settings 200 defaults", r.status_code == 200
      and r.get_json()["settings"]["score_threshold"] == 70,
      r.get_json())
r = run_api([[], [], []], "PUT", "/api/v1/portal/risk/settings",
            {"score_threshold": 120, "staff_tasks": True,
             "city_default_pct": 300})
check("settings clamped", r.status_code == 200
      and r.get_json()["settings"]["score_threshold"] == 95
      and r.get_json()["settings"]["city_default_pct"] == 100,
      r.get_json())
r = run_api([], "PUT", "/api/v1/portal/risk/settings", {"score_threshold": 80})
check("settings 400 no staff_tasks", r.status_code == 400, r.status_code)

r = run_api([
    [{"id": 1, "contact_id": "92300", "conversation_id": None,
      "score": 85, "factors": [], "status": "open",
      "created_at": "t"}],
], "GET", "/api/v1/portal/risk/tasks")
check("tasks list 200", r.status_code == 200
      and r.get_json()["tasks"][0]["score"] == 85, r.get_json())
r = run_api([
    [{"id": 1}],
], "POST", "/api/v1/portal/risk/tasks", {"id": 1})
check("task done 200", r.status_code == 200, r.status_code)
r = run_api([[]], "POST", "/api/v1/portal/risk/tasks", {"id": 1})
check("task done 404 closed", r.status_code == 404, r.status_code)
r = run_api([], "POST", "/api/v1/portal/risk/tasks", {})
check("task done 400 no id", r.status_code == 400, r.status_code)

r = run_api([[]], "POST", "/api/v1/portal/address/normalize",
            {"address": "house 9 karachi"})
check("address 200", r.status_code == 200
      and r.get_json()["city"] == "karachi", r.get_json())
r = run_api([[]], "POST", "/api/v1/portal/address/normalize",
            {"address": "   "})
check("address 400 blank", r.status_code == 400, r.status_code)
r = run_api([], "POST", "/api/v1/portal/address/normalize",
            {"address": "x"}, principal=dict(PRINCIPAL, via_api_key=True))
check("address api key 403", r.status_code == 403, r.status_code)

# ---------- wiring pins ----------

APP = open("/tmp/smoke971/app.py", encoding="utf8").read()
check("app.py registers risk bp",
      "aux_app.register_blueprint(portal_risk_bp)" in APP, "bp")
PORTAL = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts",
              encoding="utf8").read()
for fn in ("getRiskScore", "getRiskSettings", "putRiskSettings",
           "listRiskTasks", "completeRiskTask", "normalizeAddress"):
    check("client " + fn, "export async function " + fn in PORTAL, fn)
BASE = "/tmp/smoke971/"
for route in ("risk_score", "risk_settings", "risk_tasks",
              "address_normalize"):
    src = open(BASE + "bff_" + route + ".ts", encoding="utf8").read()
    check("bff " + route, "export async function" in src, route)
RISK = open(BASE + "risk_card.tsx", encoding="utf8").read()
check("risk card", "COD risk check" in RISK
      and "risk/score" in RISK and "Staff tasks:" in RISK, "card")
ADDR = open(BASE + "address_card.tsx", encoding="utf8").read()
check("address card", "Address check" in ADDR
      and "address/normalize" in ADDR and "ask_prompts" in ADDR, "card")
COD = open(BASE + "cod_page.tsx", encoding="utf8").read()
check("cod page mounts both", "<RiskCard />" in COD
      and "<AddressCard />" in COD, "mount")

summary("risk")
