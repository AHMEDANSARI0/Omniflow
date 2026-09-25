"""Tests for smart checkout links (server-computed totals, public token
view, merchant status flips)."""
import sys

from flask import Flask

import portal_checkout
import portal_ratelimit
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_checkout.bp)
app.register_blueprint(portal_checkout.public_bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
PrincipalStub(portal_checkout, principal=human)


def fresh(script):
    portal_checkout._CHECKOUT_DDL_READY = True  # skip DDL executes in stubs
    portal_ratelimit._DDL_READY = True
    return install_db_stub(portal_checkout, script)


CREATED = {"id": 12, "token": "tok123", "contact_id": "92x",
           "title": "Eid order", "items": [{"name": "Shirt", "qty": 2,
                                            "price": 500.0}],
           "total": 1000.0, "status": "open", "created_at": None}

print("== create ==")

conn = fresh([[CREATED], []])
response = client.post("/api/v1/portal/checkout/links", json={
    "contact_id": "92x", "title": "Eid order",
    "items": [{"name": "Shirt", "qty": 2, "price": 500}]})
payload = response.get_json()
check("200 create", status(response) == 200 and payload["ok"] is True
      and payload["link"]["token"] == "tok123", status(response))
check("total computed server-side", payload["link"]["total"] == 1000.0,
      payload)
check("items json cast", "CAST(%s AS JSONB)" in conn.cur.executed[0][0],
      conn.cur.executed[0][0][:110])
check("checkout audit", conn.cur.executed[1][1][1] == "checkout.created",
      conn.cur.executed[1][1])

response = client.post("/api/v1/portal/checkout/links",
                       json={"contact_id": "", "items": [{"name": "x"}]})
check("400 no contact", status(response) == 400, status(response))
response = client.post("/api/v1/portal/checkout/links",
                       json={"contact_id": "92x", "items": []})
check("400 empty items", status(response) == 400, status(response))
response = client.post("/api/v1/portal/checkout/links",
                       json={"contact_id": "92x",
                             "items": [{"name": "x", "qty": 0, "price": 5}]})
check("400 bad qty", status(response) == 400, status(response))
response = client.post("/api/v1/portal/checkout/links",
                       json={"contact_id": "92x",
                             "items": [{"name": "x", "qty": 1, "price": -2}]})
check("400 negative price", status(response) == 400, status(response))
response = client.post("/api/v1/portal/checkout/links",
                       json={"contact_id": "92x",
                             "items": [{"name": "x", "qty": 1, "price": 1}] * 21})
check("400 item cap", status(response) == 400, status(response))
response = client.post("/api/v1/portal/checkout/links",
                       json={"contact_id": "92x",
                             "items": [{"name": "", "qty": 1, "price": 1}]})
check("400 nameless item", status(response) == 400, status(response))

print("== list ==")

conn = fresh([[CREATED]])
response = client.get("/api/v1/portal/checkout/links")
check("200 list", status(response) == 200
      and response.get_json()["links"][0]["total"] == 1000.0, status(response))
check("list scoped + capped", "client_id = %s" in conn.cur.executed[0][0]
      and "LIMIT 30" in conn.cur.executed[0][0], "sql")

print("== status ==")

response = client.patch("/api/v1/portal/checkout/links/12",
                        json={"status": "maybe"})
check("400 bad status", status(response) == 400, status(response))

conn = fresh([[]])
response = client.patch("/api/v1/portal/checkout/links/12",
                        json={"status": "paid"})
check("404 unknown link", status(response) == 404, status(response))

conn = fresh([[{"token": "tok123"}], []])
response = client.patch("/api/v1/portal/checkout/links/12",
                        json={"status": "paid"})
check("200 paid", status(response) == 200
      and response.get_json()["status"] == "paid", status(response))
check("paid audit", conn.cur.executed[1][1][1] == "checkout.paid",
      conn.cur.executed[1][1])

print("== public view ==")

conn = fresh([[{"count": 5}], [CREATED], [], []])
# 671: public view also increments view_count for open links
response = client.get("/api/v1/public/checkout/tok123")
payload = response.get_json()
check("200 public", status(response) == 200
      and payload["title"] == "Eid order" and payload["total"] == 1000.0,
      status(response))
check("public strips internals", "contact_id" not in payload
      and "id" not in payload, payload.keys())

conn = fresh([[{"count": 5}], []])
response = client.get("/api/v1/public/checkout/nope")
check("404 public", status(response) == 404, status(response))

payload, code = portal_checkout.public_checkout("")
check("400 blank token", code == 400, code)

PrincipalStub(portal_checkout, principal=None)
response = client.post("/api/v1/portal/checkout/links",
                       json={"contact_id": "x", "items": [{"name": "y"}]})
check("401 create unauth", status(response) == 401, status(response))
PrincipalStub(portal_checkout, principal=human)

sys.exit(1 if summary("checkout") else 0)
