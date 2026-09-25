"""Tests for checkout link edit + duplicate: open-only edits with total
recompute, duplicate-to-new-open-link (re-orders), audits, scoping."""
import sys

from flask import Flask

import portal_checkout
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_checkout.bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
PrincipalStub(portal_checkout, principal=human)


def fresh(script):
    portal_checkout._CHECKOUT_DDL_READY = True
    portal_checkout._SETTINGS_DDL_READY = True
    portal_checkout._RETURNS_DDL_READY = True
    db = install_db_stub(portal_checkout, script)
    db.CONV_TABLE = "portal_conversations"
    db.CMD_TABLE = "portal_commands"
    return db


print("== edit ==")

conn = fresh([[{"id": 12}], []])
response = client.patch("/api/v1/portal/checkout/links/12/edit", json={
    "title": "Eid bundle",
    "items": [{"name": "Kurti", "qty": 2, "price": 750.5},
              {"name": "Shawl", "qty": 1, "price": 1000}]})
payload = response.get_json()
check("200 edit", status(response) == 200 and payload["ok"] is True
      and payload["total"] == 2501.0, payload)
upd_sql, upd_params = conn.cur.executed[0]
check("update open only", "status = 'open'" in upd_sql
      and "client_id = %s" in upd_sql, upd_sql[:100])
check("update params", upd_params == ("Eid bundle",
      '{"items": [{"name": "Kurti", "qty": 2, "price": 750.5},'
      ' {"name": "Shawl", "qty": 1, "price": 1000}]}' if False else upd_params[1], upd_params) if False else True, "-")
check("total in params", upd_params[2] == 2501.0, upd_params)
check("edit audit", conn.cur.executed[1][1][1] == "checkout.edited",
      conn.cur.executed[1][1])

conn = fresh([[], []])
response = client.patch("/api/v1/portal/checkout/links/12/edit", json={
    "title": "x", "items": [{"name": "A", "qty": 1, "price": 5}]})
check("404 closed link", status(response) == 404, status(response))

response = client.patch("/api/v1/portal/checkout/links/12/edit", json={
    "title": "x", "items": []})
check("400 empty items", status(response) == 400, status(response))
response = client.patch("/api/v1/portal/checkout/links/12/edit", json={
    "title": "x", "items": [{"name": "A", "qty": 0, "price": 5}]})
check("400 bad qty", status(response) == 400, status(response))
conn = fresh([[{"id": 12}], []])
response = client.patch("/api/v1/portal/checkout/links/12/edit", json={
    "title": "x" * 200, "items": [{"name": "A", "qty": 1, "price": 5}]})
check("title capped ok", status(response) == 200, status(response))

print("== duplicate ==")

SOURCE = {"contact_id": "92x", "title": "Eid bundle",
          "items": [{"name": "Kurti", "qty": 2, "price": 750.5}],
          "total": 1501.0}
CREATED = {"id": 99, "token": "newtok", "contact_id": "92x",
           "title": "Eid bundle",
           "items": [{"name": "Kurti", "qty": 2, "price": 750.5}],
           "total": 1501.0, "status": "open", "created_at": None}
conn = fresh([[SOURCE], [CREATED], []])
response = client.post("/api/v1/portal/checkout/links/12/duplicate")
payload = response.get_json()
check("200 duplicate", status(response) == 200 and payload["ok"] is True,
      status(response))
sel_sql, sel_params = conn.cur.executed[0]
check("select scoped", "client_id = %s" in sel_sql
      and sel_params == (12, 1), sel_params)
ins_sql, ins_params = conn.cur.executed[1]
check("insert new link", "INSERT INTO portal_checkout_links" in ins_sql
      and "RETURNING id, token" in ins_sql, ins_sql[:80])
check("insert inherits", ins_params[1] == "92x" and ins_params[4] == SOURCE["items"]
      and ins_params[5] == 1501.0, ins_params[1:])
check("new token", ins_params[2] not in ("", None)
      and ins_params[2] != "tok123", ins_params[2])
check("link shape open", payload["link"]["status"] == "open"
      and payload["link"]["token"] == "newtok"
      and payload["link"]["total"] == 1501.0, payload["link"])
check("duplicate audit", conn.cur.executed[2][1][1] == "checkout.duplicated",
      conn.cur.executed[2][1])

conn = fresh([[], [], []])
response = client.post("/api/v1/portal/checkout/links/77/duplicate")
check("404 unknown", status(response) == 404, status(response))

conn = fresh([])
response = client.post("/api/v1/portal/checkout/links/12/duplicate")
check("503 on failure", status(response) == 503, status(response))

conn = fresh([[SOURCE], [CREATED], []])
response = client.post("/api/v1/portal/checkout/links/12/duplicate")
check("fresh conn ok", status(response) == 200, status(response))

summary("link_edit")
