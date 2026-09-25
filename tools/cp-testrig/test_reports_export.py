"""Tests for report CSV exports: revenue ledger and returns ledger
(scoped, capped, attachment headers, CSV shape)."""
import sys

from flask import Flask

import portal_checkout
import portal_revenue
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, summary

app = Flask(__name__)
app.register_blueprint(portal_revenue.bp)
app.register_blueprint(portal_checkout.bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
PrincipalStub(portal_revenue, principal=human)
PrincipalStub(portal_checkout, principal=human)

import datetime

DATE = datetime.datetime(2026, 9, 17, 10, 0, 0)

print("== revenue export ==")

portal_checkout._CHECKOUT_DDL_READY = True
portal_checkout._SETTINGS_DDL_READY = True
portal_checkout._RETURNS_DDL_READY = True

conn = install_db_stub(portal_revenue, [[
    {"id": 5, "title": "Kurti", "status": "paid", "total": 1500,
     "updated_at": DATE},
    {"id": 4, "title": "Shoes", "status": "delivered", "total": 3000,
     "updated_at": DATE},
]])
response = client.get("/api/v1/portal/revenue/export")
body = response.get_data(as_text=True)
check("200 csv", response.status_code == 200
      and response.mimetype == "text/csv", response.status_code)
check("attachment", "omniflow-revenue.csv"
      in response.headers.get("Content-Disposition", ""),
      response.headers.get("Content-Disposition"))
check("header row", body.splitlines()[0] ==
      "date,order,status,amount", body.splitlines()[0])
check("rows newest first", body.splitlines()[1].startswith("2026-09-17,Kurti,paid")
      and "1500" in body.splitlines()[1], body.splitlines()[1])
check("scoped + paid family",
      "status IN ('paid', 'shipped', 'delivered')" in conn.cur.executed[0][0]
      and "client_id = %s" in conn.cur.executed[0][0],
      conn.cur.executed[0][0][:100])
check("cap 2000", "LIMIT 2000" in conn.cur.executed[0][0],
      conn.cur.executed[0][0][-40:])

conn = install_db_stub(portal_revenue, [[]])
response = client.get("/api/v1/portal/revenue/export")
body = response.get_data(as_text=True)
check("empty csv header only", body.strip() == "date,order,status,amount",
      body.strip()[:60])

conn = install_db_stub(portal_revenue, [])
response = client.get("/api/v1/portal/revenue/export")
check("503 on failure", response.status_code == 503, response.status_code)

print("== returns export ==")

conn = install_db_stub(portal_checkout, [[
    {"created_at": DATE, "title": "Kurti", "total": 1500,
     "reason": "size", "note": "tight"},
    {"created_at": None, "title": None, "total": None,
     "reason": "other", "note": ""},
]])
response = client.get("/api/v1/portal/checkout/returns/export")
body = response.get_data(as_text=True)
check("200 csv", response.status_code == 200
      and response.mimetype == "text/csv", response.status_code)
check("returns attachment", "omniflow-returns.csv"
      in response.headers.get("Content-Disposition", ""),
      response.headers.get("Content-Disposition"))
check("returns header", body.splitlines()[0] ==
      "date,order,amount,reason,note", body.splitlines()[0])
check("join present", "LEFT JOIN portal_checkout_links"
      in conn.cur.executed[0][0], conn.cur.executed[0][0][:90])
check("scoped + capped", "r.client_id = %s" in conn.cur.executed[0][0]
      and "LIMIT 2000" in conn.cur.executed[0][0],
      conn.cur.executed[0][0][-40:])
check("rows", "size" in body and "tight" in body, body.splitlines()[1])

conn = install_db_stub(portal_checkout, [])
response = client.get("/api/v1/portal/checkout/returns/export")
check("503 on failure", response.status_code == 503, response.status_code)

summary("reports_export")
