"""Tests for V2 B17: plan enforcement wired into the capped create
endpoints (kb entries, keyword alerts, courier companies, immediate
broadcasts) via portal_plans.enforce - legacy/unlimited passes, a
reached cap returns 409 plan_limit, and everything fails open."""
import json

from flask import Flask

import portal_kb
import portal_listen
import portal_growth
import portal_courier
from test_lib import check, install_db_stub, summary

PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}

FREE_AT_CAP = ("free", 100, 5, 100, 25, 1)  # plan + usage rows order


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


def run(module, script, method, path, json_body=None):
    app = Flask("b17")
    app.register_blueprint(module.bp)
    conn = install_db_stub(module, script)
    with PrincipalStub(module, PRINCIPAL):
        client = app.test_client()
        if method == "GET":
            return client.get(path), conn
        if method == "POST":
            return client.post(path, json=json_body), conn
    return None, conn


def plan_row(plan):
    return [{"plan": plan}]


def usage(used):
    """Six slots (one per live counter), each a single-row result."""
    return [[{"n": used}], [{"n": used}], [{"n": used}], [{"n": used}],
            [{"n": used}], [{"n": used}]]


print("== kb entries ==")

portal_kb._BRAND_DDL_READY = True

conn = install_db_stub(portal_kb,
                       [plan_row("free")] + usage(100) +
                       [[{"id": 9}], []])
app = Flask("b17kb")
app.register_blueprint(portal_kb.bp)
with PrincipalStub(portal_kb, PRINCIPAL):
    resp = app.test_client().post(
        "/api/v1/portal/kb",
        json={"entry": {"title": "T", "content": "C", "lang": "en"}})
body = resp.get_json()
check("kb cap 409", resp.status_code == 409
      and body["error"]["code"] == "plan_limit"
      and "(20)" in body["error"]["message"], body)
check("kb cap blocks insert", all(
    "INSERT INTO portal_kb_entries" not in e[0]
    for e in conn.cur.executed), "blocked")

conn = install_db_stub(portal_kb,
                       [plan_row("free")] + usage(5) +
                       [[{"id": 9}], []])
with PrincipalStub(portal_kb, PRINCIPAL):
    resp = app.test_client().post(
        "/api/v1/portal/kb",
        json={"entry": {"title": "T", "content": "C", "lang": "en"}})
check("kb under cap ok", resp.status_code == 200, resp.status_code)

conn = install_db_stub(portal_kb,
                       [plan_row("growth")] + usage(50) +
                       [[{"id": 9}], []])
with PrincipalStub(portal_kb, PRINCIPAL):
    resp = app.test_client().post(
        "/api/v1/portal/kb",
        json={"entry": {"title": "T", "content": "C", "lang": "en"}})
check("kb growth cap 100 ok at 50", resp.status_code == 200,
      resp.status_code)

conn = install_db_stub(portal_kb,
                       [[Exception("boom")]] +
                       [[{"id": 9}], []])
with PrincipalStub(portal_kb, PRINCIPAL):
    resp = app.test_client().post(
        "/api/v1/portal/kb",
        json={"entry": {"title": "T", "content": "C", "lang": "en"}})
check("kb plan read fails open", resp.status_code == 200,
      resp.status_code)

print("== keyword alerts ==")

app = Flask("b17l")
app.register_blueprint(portal_listen.bp)
conn = install_db_stub(portal_listen,
                       [[], [], []] + [[{"total": 0}]]
                       + [plan_row("free")] + usage(25))
with PrincipalStub(portal_listen, PRINCIPAL):
    resp = app.test_client().post("/api/v1/portal/listen/rules",
                                  json={"keyword": "order"})
check("alerts cap 409", resp.status_code == 409
      and resp.get_json()["error"]["code"] == "plan_limit",
      resp.get_json())

conn = install_db_stub(portal_listen,
                       [[{"total": 0}]] + [plan_row("legacy")] + [[], []])
with PrincipalStub(portal_listen, PRINCIPAL):
    resp = app.test_client().post("/api/v1/portal/listen/rules",
                                  json={"keyword": "order"})
sqls = [e[0] for e in conn.cur.executed]
check("alerts legacy ok (no usage queries)",
      resp.status_code == 200 and len(sqls) == 4
      and not any("COUNT(*) AS n" in s for s in sqls),
      [s[:36] for s in sqls])

print("== courier companies ==")

conn = install_db_stub(portal_courier,
                       [[]] + [plan_row("free")] + usage(1))
app = Flask("b17c")
app.register_blueprint(portal_courier.bp)
with PrincipalStub(portal_courier, PRINCIPAL):
    resp = app.test_client().post(
        "/api/v1/portal/courier/providers",
        json={"name": "PostEx", "adapter": "generic",
              "base_url": "https://api.postex.pk"})
check("courier cap 409", resp.status_code == 409
      and resp.get_json()["error"]["code"] == "plan_limit",
      resp.get_json())

conn = install_db_stub(portal_courier,
                       [plan_row("free")] + usage(0) +
                       [[{"id": 9}], []])
with PrincipalStub(portal_courier, PRINCIPAL):
    resp = app.test_client().post(
        "/api/v1/portal/courier/providers",
        json={"name": "PostEx", "adapter": "generic",
              "base_url": "https://api.postex.pk"})
check("courier under cap ok", resp.status_code == 201
      and resp.get_json()["id"] == 9, resp.get_json())

print("== broadcasts ==")

conn = install_db_stub(portal_growth,
                       [[{"contact_id": "92a", "contact_name": "Ali"}]]
                       + [plan_row("free")] + usage(100))
app = Flask("b17g")
app.register_blueprint(portal_growth.bp)
with PrincipalStub(portal_growth, PRINCIPAL):
    resp = app.test_client().post("/api/v1/portal/broadcasts",
                                  json={"audience": "all",
                                        "body": "Sale today!"})
check("broadcast cap 409", resp.status_code == 409
      and resp.get_json()["error"]["code"] == "plan_limit",
      resp.get_json())

conn = install_db_stub(portal_growth,
                       [[{"contact_id": "92a", "contact_name": "Ali"}]]
                       + [plan_row("legacy")]
                       + [[], [], [], [], [], [], [], []])
with PrincipalStub(portal_growth, PRINCIPAL):
    resp = app.test_client().post("/api/v1/portal/broadcasts",
                                  json={"audience": "all",
                                        "body": "Sale today!"})
check("broadcast legacy proceeds", resp.status_code == 200,
      resp.status_code)
check("broadcast insert reached", any(
    "INSERT INTO portal_broadcasts" in e[0]
    for e in conn.cur.executed), "insert")

summary("b17")
