"""Tests for the money guard: only owners/admins record advances or set
discounts; agents create/edit plain links freely."""
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
agent = dict(human, role="agent")
PrincipalStub(portal_checkout, principal=human)


def fresh(script):
    portal_checkout._CHECKOUT_DDL_READY = True
    portal_checkout._SETTINGS_DDL_READY = True
    portal_checkout._RETURNS_DDL_READY = True
    db = install_db_stub(portal_checkout, script)
    db.CONV_TABLE = "portal_conversations"
    db.CMD_TABLE = "portal_commands"
    return db


ITEMS = [{"name": "K", "qty": 1, "price": 500}]

print("== advance guard ==")

PrincipalStub(portal_checkout, principal=agent)
conn = fresh([[{"paid_amount": 0, "total": 500, "status": "open"}], []])
response = client.post("/api/v1/portal/checkout/links/12/advance",
                       json={"amount": 100})
payload = response.get_json()
check("403 agent advance", status(response) == 403
      and payload["error"]["code"] == "forbidden"
      and "Only owners" in payload["error"]["message"], (status(response), payload))
check("no db writes on guard", conn.cur.executed == [], conn.cur.executed)

PrincipalStub(portal_checkout, principal=human)
conn = fresh([[{"paid_amount": 0, "total": 500, "status": "open"}], []])
response = client.post("/api/v1/portal/checkout/links/12/advance",
                       json={"amount": 100})
check("200 owner advance", status(response) == 200, status(response))

print("== discount guard ==")

PrincipalStub(portal_checkout, principal=agent)
conn = fresh([[], []])
response = client.post("/api/v1/portal/checkout/links", json={
    "contact_id": "92x", "title": "T", "discount_amount": 100, "items": ITEMS})
check("403 agent discount create", status(response) == 403, status(response))
check("no insert on guard", conn.cur.executed == [], conn.cur.executed)

conn = fresh([[{"id": 5}], []])
response = client.post("/api/v1/portal/checkout/links", json={
    "contact_id": "92x", "title": "T", "items": ITEMS})
check("200 agent plain create", status(response) == 200, status(response))
check("zero discount stored", conn.cur.executed[0][1][6] == 0,
      conn.cur.executed[0][1][5:7])

conn = fresh([[], []])
response = client.post("/api/v1/portal/checkout/links", json={
    "contact_id": "92x", "title": "T", "discount_amount": 0, "items": ITEMS})
check("200 agent zero discount", status(response) == 200, status(response))

conn = fresh([[{"id": 12}], []])
response = client.patch("/api/v1/portal/checkout/links/12/edit", json={
    "title": "t", "discount_amount": 100, "items": ITEMS})
check("403 agent discount edit", status(response) == 403, status(response))

conn = fresh([[{"id": 12}], []])
response = client.patch("/api/v1/portal/checkout/links/12/edit", json={
    "title": "t", "discount_amount": 0, "items": ITEMS})
check("200 agent plain edit", status(response) == 200, status(response))

print("== admin role ==")

PrincipalStub(portal_checkout, principal=dict(human, role="admin"))
conn = fresh([[{"paid_amount": 0, "total": 500, "status": "open"}], []])
response = client.post("/api/v1/portal/checkout/links/12/advance",
                       json={"amount": 100})
check("200 admin advance", status(response) == 200, status(response))

summary("money_guard")
