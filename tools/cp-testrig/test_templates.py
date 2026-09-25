"""Tests for V2 B15: portal_templates (six vertical packs, idempotent
apply, persona only seeds an empty desk, status) + wiring pins."""
import json

from flask import Flask

import portal_templates
import portal_plans
PLANS_FREE_BRANDS = portal_plans.PLANS["free"]["limits"]["brands"]
from test_lib import check, install_db_stub, summary

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


def make_app(module):
    app = Flask("t15")
    app.register_blueprint(module.bp)
    return app


def run(module, script, method, path, json_body=None,
        principal=PRINCIPAL):
    module._DDL_READY = False
    conn = install_db_stub(module, script)
    app = make_app(module)
    with PrincipalStub(module, principal):
        client = app.test_client()
        if method == "GET":
            return client.get(path), conn
        if method == "POST":
            return client.post(path, json=json_body), conn
        if method == "PUT":
            return client.put(path, json=json_body), conn
    return None, conn


print("== pack catalog ==")

packs = portal_templates.VERTICAL_PACKS
check("six verticals", set(packs) == {
    "ecommerce", "salon", "clinic", "restaurant", "real_estate",
    "education"}, sorted(packs))
ok_shape = True
for key, pack in packs.items():
    if not (pack["label"] and pack["description"]):
        ok_shape = False
    if set(pack["persona"]) != {"agent_name", "tone", "greeting",
                                "fallback"}:
        ok_shape = False
    if pack["persona"]["tone"] not in ("friendly", "professional",
                                       "concise"):
        ok_shape = False  # tones must be valid for portal_bot PUT too
    if len(pack["kb"]) != 3 or len(pack["saved_replies"]) != 3:
        ok_shape = False
    if len(pack["keywords"]) != 2 or len(pack["journey"]) != 3:
        ok_shape = False
check("packs uniform shape + valid tones", ok_shape, "shape")
check("kb entries carry lang", all(
    e.get("lang") in ("en", "ur", "roman")
    for pack in packs.values() for e in pack["kb"]), "lang")

print("== templates endpoints ==")

r, conn = run(portal_templates, [[], []], "GET",
              "/api/v1/portal/templates")
body = r.get_json()
check("templates list", r.status_code == 200
      and len(body["packs"]) == 6, r.status_code)
check("templates not applied yet", body["applied"] == "", body)

r, conn = run(portal_templates,
              [[], [], [], [], [], [], [], [], [], [], [], [], [],
               [], [], [], [], []],
              "POST", "/api/v1/portal/templates/apply",
              {"vertical": "ecommerce"})
body = r.get_json()
check("apply 200", r.status_code == 200 and body["ok"] is True, body)
check("apply seeds everything", body["created"] == {
    "kb": 3, "keywords": 2, "saved_replies": 3, "journey": 3,
    "persona": 1}, body["created"])
executed = [e[0] for e in conn.cur.executed]
check("apply writes persona row", any(
    "portal_bot_configs" in s and "INSERT INTO" in s for s in executed),
    "persona")
check("apply kb insert", any(
    "portal_kb_entries" in s and "INSERT INTO" in s for s in executed),
    "kb")
check("apply saved reply insert", any(
    "portal_saved_replies" in s and "INSERT INTO" in s
    for s in executed), "replies")
check("apply listen rule upsert", any(
    "portal_listen_rules" in s and "DO NOTHING" in s
    for s in executed), "rules")
check("apply journey stage insert", any(
    "portal_journey_stages" in s for s in executed), "stages")
check("apply audit", any(
    "template.applied" in json.dumps(e) for e in conn.cur.executed),
    "audit")
check("apply status row", any(
    "portal_templates_applied" in s for s in executed), "status")

# persona is NOT overwritten when a live bot config exists
r, conn = run(portal_templates,
              [[], [{"agent_name": "MyBot", "greeting": "yo",
                     "fallback": "ok"}], [], [], [], [], [], [], [],
               [], [], [], [], [], [], [], [], [], [], []],
              "POST", "/api/v1/portal/templates/apply",
              {"vertical": "salon"})
body = r.get_json()
check("persona untouched on live desk", body["created"]["persona"] == 0,
      body["created"])
executed = [e[0] for e in conn.cur.executed]
check("no persona update issued", not any(
    "portal_bot_configs" in s and "UPDATE" in s for s in executed),
    "persona-skip")

# overwrite_persona=true does update
r, conn = run(portal_templates,
              [[], [{"agent_name": "MyBot", "greeting": "yo",
                     "fallback": "ok"}], [], [], [], [], [], [], [],
               [], [], [], [], [], [], [], [], [], [], []],
              "POST", "/api/v1/portal/templates/apply",
              {"vertical": "salon", "overwrite_persona": True})
check("persona overwrite honored",
      r.get_json()["created"]["persona"] == 1, r.get_json())

r, conn = run(portal_templates, [[]], "POST",
              "/api/v1/portal/templates/apply", {"vertical": "spaces"})
check("apply bad vertical 400", r.status_code == 400, r.status_code)

r, conn = run(portal_templates, [], "POST",
              "/api/v1/portal/templates/apply", {"vertical": "salon"},
              principal=dict(PRINCIPAL, via_api_key=True))
check("apply api key 403", r.status_code == 403, r.status_code)

r, conn = run(portal_templates, [], "GET", "/api/v1/portal/templates",
              principal=dict(PRINCIPAL, via_api_key=True))
check("templates api key 403", r.status_code == 403, r.status_code)

r, conn = run(portal_templates, [], "GET", "/api/v1/portal/templates",
              principal=None)
check("templates anon 401", r.status_code == 401, r.status_code)

print("== plans ==")

check("plan catalog keys", set(portal_plans.PLANS) == {
    "legacy", "free", "growth", "pro"}, "plans")
check("legacy unlimited", all(
    v is None for v in portal_plans.PLANS["legacy"]["limits"].values()),
    "legacy")
check("free has caps", portal_plans.PLANS["free"]["limits"]["team_seats"]
      == 1 and portal_plans.PLANS["free"]["limits"]["kb_entries"] == 20,
    "free")
check("growth caps", portal_plans.PLANS["growth"]["limits"][
    "broadcasts_per_month"] == 1000, "growth")

r, conn = run(portal_plans,
              [[], [], [{"n": 7}], [{"n": 1}], [{"n": 4}], [{"n": 2}],
               [{"n": 0}], [{"n": 2}]],
              "GET", "/api/v1/portal/plans")
body = r.get_json()
check("plans default legacy", body["plan"] == "legacy"
      and body["limits"]["broadcasts_per_month"] is None, body)
check("plans usage counted", body["usage"] == {
    "broadcasts_per_month": 7, "team_seats": 1, "kb_entries": 4,
    "alert_rules": 2, "courier_providers": 0, "brands": 2}, body["usage"])
check("plans brands caps", body["limits"]["brands"] is None
      and PLANS_FREE_BRANDS == 1, "caps")
check("plans catalog shipped", len(body["catalog"]) == 4, "catalog")

r, conn = run(portal_plans,
              [[], [{"plan": "growth"}], [{"n": 0}], [{"n": 0}],
               [{"n": 0}], [{"n": 0}], [{"n": 0}], [{"n": 0}]],
              "GET", "/api/v1/portal/plans")
check("plans stored plan read",
      r.get_json()["plan"] == "growth", r.get_json())

r, conn = run(portal_plans, [[], [], []], "PUT",
              "/api/v1/portal/plans", {"plan": "pro"})
check("plan switch 200", r.status_code == 200
      and r.get_json()["plan"] == "pro", r.get_json())
check("plan switch audited", any(
    "plan.changed" in json.dumps(e) for e in conn.cur.executed), "audit")

r, conn = run(portal_plans, [[], []], "PUT",
              "/api/v1/portal/plans", {"plan": "elite"})
check("plan switch whitelist", r.status_code == 400, r.status_code)

r, conn = run(portal_plans, [], "PUT", "/api/v1/portal/plans",
              {"plan": "pro"}, principal=dict(PRINCIPAL,
                                              via_api_key=True))
check("plans api key 403", r.status_code == 403, r.status_code)

print("== check helper ==")

conn = install_db_stub(portal_plans, [
    [{"plan": "free"}], [{"n": 9}], [{"n": 1}], [{"n": 20}],
    [{"n": 2}], [{"n": 0}], [{"n": 1}],
])
result = portal_plans.check(conn.cursor(), 1, "kb_entries")
check("check capped reached", result == {"ok": False, "used": 20,
                                         "limit": 20,
                                         "plan": "free"}, result)

conn = install_db_stub(portal_plans, [
    [{"plan": "free"}], [{"n": 0}], [{"n": 0}], [{"n": 0}],
    [{"n": 0}], [{"n": 0}], [{"n": 0}],
])
result = portal_plans.check(conn.cursor(), 1, "kb_entries")
check("check under cap ok", result["ok"] is True and result["used"] == 0,
      result)

conn = install_db_stub(portal_plans,
                       [[{"plan": "legacy"}], [{"n": 0}], [{"n": 0}],
                        [{"n": 0}], [{"n": 0}], [{"n": 0}]])
result = portal_plans.check(conn.cursor(), 1, "broadcasts_per_month")
check("check legacy unlimited", result["ok"] is True
      and result["limit"] is None, result)

conn = install_db_stub(portal_plans, [[Exception("boom")]])
result = portal_plans.check(conn.cursor(), 1, "kb_entries")
check("check fails open", result["ok"] is True, result)

print("== wiring pins ==")

try:
    app_src = open("app.py", encoding="utf8").read()
except FileNotFoundError:
    app_src = open("omniflow-backend-patch/app.py",
                   encoding="utf8").read()
check("app imports templates",
      "from portal_templates import bp as portal_templates_bp" in app_src,
      "import")
check("app imports plans",
      "from portal_plans import bp as portal_plans_bp" in app_src,
      "import")
check("app registers templates",
      "aux_app.register_blueprint(portal_templates_bp)" in app_src,
      "register")
check("app registers plans",
      "aux_app.register_blueprint(portal_plans_bp)" in app_src,
      "register")

summary("b15")
