"""Master-upgrade engine 8: the Policy/Rule hub.

Covers portal_policy: the shared evaluator (keyword ops incl. the
kabhi/abhi whole-word law, all/any groups, empty-never-matches,
unknown-op-safe), rule_fired audit, the rules_summary families
(routing/listen/negotiation/hours/handoff/autonomy/approvals, each
fail-soft) on a scripted stub, the API (rules 200/401/503, evaluate
200/400) and the web pins (app registration, routing+listen unified
audit, BFF routes, Rules page, sidebar).
"""
import json

from flask import Flask

import portal_policy
from test_lib import install_db_stub
from test_lib import check, summary
from test_lib import PrincipalStub


class Principal:
    def __init__(self, module, principal=None, exc=None):
        self.stub = PrincipalStub(module, principal, exc)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.stub.restore()
        return False


PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}

app = Flask(__name__)
app.register_blueprint(portal_policy.bp)
client = app.test_client()

print("== shared evaluator ==")

check("contains word-boundary",
      portal_policy.match_condition(
          {"field": "keyword", "op": "contains", "value": "abhi"},
          {"text": "kabhi bhi bhej dena"}) is False, "no false hit")
check("contains real hit",
      portal_policy.match_condition(
          {"field": "keyword", "op": "contains", "value": "refund"},
          {"text": "refund chahiye bhai"}) is True, "hit")
check("starts_with",
      portal_policy.match_condition(
          {"field": "keyword", "op": "starts_with", "value": "salam"},
          {"text": "Salam, price kya hai"}) is True, "starts")
check("not_contains",
      portal_policy.match_condition(
          {"field": "keyword", "op": "not_contains", "value": "refund"},
          {"text": "order kab aayega"}) is True, "not")
check("is on ctx field",
      portal_policy.match_condition(
          {"field": "sentiment", "op": "is", "value": "negative"},
          {"sentiment": "Negative"}) is True, "is")

check("all-group both true",
      portal_policy.evaluate(
          {"all": [
              {"field": "keyword", "op": "contains", "value": "refund"},
              {"field": "sentiment", "op": "is", "value": "negative"},
          ]},
          {"text": "refund chahiye", "sentiment": "negative"}) is True,
      "all")
check("all-group one false",
      portal_policy.evaluate(
          {"all": [
              {"field": "keyword", "op": "contains", "value": "refund"},
              {"field": "urgency", "op": "is", "value": "high"},
          ]},
          {"text": "refund chahiye", "urgency": "low"}) is False,
      "all-false")
check("any-group matches",
      portal_policy.evaluate(
          {"any": [
              {"field": "keyword", "op": "contains", "value": "jaldi"},
              {"field": "keyword", "op": "contains", "value": "urgent"},
          ]},
          {"text": "ye urgent hai"}) is True, "any")
check("empty rules never match",
      portal_policy.evaluate({}, {"text": "kuch bhi"}) is False, "empty")
check("unknown op never matches",
      portal_policy.evaluate(
          {"all": [{"field": "keyword", "op": "regex", "value": ".*"}]},
          {"text": "salam"}) is False, "safe")

print("== rule_fired audit ==")

conn = install_db_stub(portal_policy, [[]])
portal_policy.rule_fired(conn.cursor(), 1, "routing", 7, "Routing: refund",
                         {"conversation_id": 77})
check("audit row", any("portal_action_log" in sql
                       for sql, _p in conn.cur.executed), "audit")

print("== rules_summary families ==")

conn = install_db_stub(portal_policy, [
    [{"n": 3}],                                        # routing count
    [{"n": 2}],                                        # listen count
    [{"enabled": True, "floor_percent": 5,
      "max_percent": 15}],                             # negotiation
    [{"working_hours_enabled": True, "human_handoff_enabled": False,
      "working_hours_start": "09:00", "working_hours_end": "18:00"}],
    [{"autonomy": "auto"}],                            # brain settings
    [{"n": 2}],                                        # active workflows
    [{"n": 4}],                                        # pending approvals
])
families = portal_policy.rules_summary(conn.cursor(), 1)
by_set = {item["ruleSet"]: item for item in families}
check("8 families", len(families) == 8, len(families))
check("routing summary", by_set["routing"]["count"] == 3
      and by_set["routing"]["href"] == "/dashboard/team", by_set["routing"])
check("negotiation bounds text", "5% - 15%" in by_set["negotiation"]["summary"],
      by_set["negotiation"])
check("hours active", by_set["hours"]["count"] == 1
      and "09:00" in by_set["hours"]["summary"], by_set["hours"])
check("autonomy auto", by_set["autonomy"]["count"] == 1
      and "Auto-reply" in by_set["autonomy"]["summary"],
      by_set["autonomy"])
check("approvals pending", "4 pending" in by_set["approvals"]["summary"],
      by_set["approvals"])
check("workflows family", by_set["workflows"]["count"] == 2
      and by_set["workflows"]["href"] == "/dashboard/workflows",
      by_set["workflows"])

# fail-soft: broken tables still return the full family list
conn = install_db_stub(portal_policy, [
    Exception("routing gone"), Exception("listen gone"),
    Exception("negotiation gone"), Exception("bot gone"),
    Exception("brain gone"), Exception("workflows gone"),
    Exception("approvals gone"),
])
families = portal_policy.rules_summary(conn.cursor(), 1)
check("fail-soft 8 families", len(families) == 8, len(families))
check("zeros on failure", all(item["count"] == 0 for item in families),
      [item["count"] for item in families])

print("== API ==")

with Principal(portal_policy, principal=None):
    check("rules 401", client.get(
        "/api/v1/portal/policy/rules").status_code == 401, 401)
    check("evaluate 401", client.post(
        "/api/v1/portal/policy/evaluate",
        json={"rules": {"all": []}}).status_code == 401, 401)

with Principal(portal_policy, PRINCIPAL):
    conn = install_db_stub(portal_policy, [
        [{"n": 1}], [{"n": 0}],
        [{"enabled": False, "floor_percent": 5, "max_percent": 15}],
        [{"working_hours_enabled": False,
          "human_handoff_enabled": False,
          "working_hours_start": None, "working_hours_end": None}],
        [{"autonomy": "suggest"}],
        [{"n": 0}],
        [{"n": 0}],
    ])
    r = client.get("/api/v1/portal/policy/rules")
    body = r.get_json()
    check("rules 200", r.status_code == 200
          and len(body["families"]) == 8
          and body["families"][0]["label"] == "Routing rules", body)

    r = client.post("/api/v1/portal/policy/evaluate",
                    json={"rules": {"all": [
                        {"field": "keyword", "op": "contains",
                         "value": "refund"}]},
                        "context": {"text": "refund chahiye"}})
    check("evaluate 200 matched", r.status_code == 200
          and r.get_json()["matched"] is True, r.get_json())

    r = client.post("/api/v1/portal/policy/evaluate",
                    json={"rules": "not-an-object"})
    check("evaluate 400", r.status_code == 400, r.status_code)

portal_policy.PortalAuthUnavailable = Exception
with Principal(portal_policy, exc=Exception("db down")):
    r = client.get("/api/v1/portal/policy/rules")
    check("auth down 503", r.status_code == 503, r.status_code)
del portal_policy.PortalAuthUnavailable

print("== web pins ==")

RIG13 = "/tmp/p13/Omniflow/"
APP = open(RIG13 + "omniflow-backend-patch/app.py", encoding="utf8").read()
check("policy registered", "portal_policy_bp" in APP, "app")
ROUTING = open(RIG13 + "omniflow-backend-patch/portal_routing.py",
               encoding="utf8").read()
LISTEN = open(RIG13 + "omniflow-backend-patch/portal_listen.py",
              encoding="utf8").read()
check("routing unified audit",
      "portal_policy.rule_fired" in ROUTING
      and '"routing"' in ROUTING, "routing")
check("listen unified audit",
      "portal_policy.rule_fired" in LISTEN
      and '"listen"' in LISTEN, "listen")
import os
check("bff routes", all(os.path.exists(RIG13 + path) for path in (
    "app/api/omniflow/portal/policy/rules/route.ts",
    "app/api/omniflow/portal/policy/evaluate/route.ts")), "bff")
check("rules page", os.path.exists(
    RIG13 + "app/dashboard/(portal)/rules/page.tsx"), "page")
SIDEBAR = open(RIG13 + "app/dashboard/components/DashSidebar.tsx",
               encoding="utf8").read()
SIDEBAR += "\n" + open(RIG13 + "app/dashboard/components/portalNav.ts",
               encoding="utf8").read()  # §246 nav entries live in portalNav.ts
check("sidebar entry", 'label: "Rules"' in SIDEBAR
      and "/dashboard/rules" in SIDEBAR, "sidebar")
PORTAL = open(RIG13 + "lib/omniflow/portal.ts", encoding="utf8").read()
check("portal.ts helpers", "export async function listPolicyRules"
      in PORTAL and "export async function testPolicyRule" in PORTAL,
      "helpers")

summary("policy")
