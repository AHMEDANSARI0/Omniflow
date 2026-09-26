"""Tests for checkout link advances (partial payments): open-only UPDATE
with auto-paid flip, amount validation, audit, due math, DDL column."""
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


print("== ddl ==")

conn = fresh([[], [], [], [], []])
portal_checkout._CHECKOUT_DDL_READY = False
portal_checkout._ensure_checkout_tables(conn)
alter_sql = conn.cur.executed[2][0]
check("ddl paid_amount", "ADD COLUMN IF NOT EXISTS paid_amount"
      in alter_sql and "NUMERIC(12,2)" in alter_sql
      and "NOT NULL DEFAULT 0" in alter_sql, alter_sql[:110])

print("== advance ==")

conn = fresh([[{"paid_amount": 750, "total": 1000, "status": "open"}], []])
response = client.post("/api/v1/portal/checkout/links/12/advance",
                       json={"amount": 250})
payload = response.get_json()
check("200 advance", status(response) == 200 and payload["ok"] is True,
      status(response))
check("advance response", payload["paid_amount"] == 750
      and payload["due"] == 250 and payload["status"] == "open", payload)
upd_sql, upd_params = conn.cur.executed[0]
check("open-only update", "status = 'open'" in upd_sql
      and "COALESCE(paid_amount, 0) + %s" in upd_sql, upd_sql[:110])
check("auto-paid flip", ">= total THEN 'paid' ELSE status END" in upd_sql,
      upd_sql[:150])
check("update params", upd_params == (250, 250, 12, 1), upd_params)
check("advance audit", conn.cur.executed[1][1][1] == "checkout.advance",
      conn.cur.executed[1][1])

conn = fresh([[{"paid_amount": 1000, "total": 1000, "status": "paid"}], []])
response = client.post("/api/v1/portal/checkout/links/12/advance",
                       json={"amount": 1000})
payload = response.get_json()
check("full advance paid", payload["status"] == "paid"
      and payload["due"] == 0, payload)
check("audit notes fully paid", "FULLY PAID"
      in conn.cur.executed[1][1][5], conn.cur.executed[1][1])

conn = fresh([[], []])
response = client.post("/api/v1/portal/checkout/links/12/advance",
                       json={"amount": 100})
check("404 closed link", status(response) == 404, status(response))

response = client.post("/api/v1/portal/checkout/links/12/advance",
                       json={"amount": 0})
check("400 zero", status(response) == 400, status(response))
response = client.post("/api/v1/portal/checkout/links/12/advance",
                       json={"amount": -5})
check("400 negative", status(response) == 400, status(response))
response = client.post("/api/v1/portal/checkout/links/12/advance",
                       json={"amount": "abc"})
check("400 string", status(response) == 400, status(response))
response = client.post("/api/v1/portal/checkout/links/12/advance", json={})
check("400 missing", status(response) == 400, status(response))

conn = fresh([])
response = client.post("/api/v1/portal/checkout/links/12/advance",
                       json={"amount": 100})
check("503 on failure", status(response) == 503, status(response))

conn = fresh([[{"paid_amount": 100, "total": 1000, "status": "open"}], []])
response = client.post("/api/v1/portal/checkout/links/12/advance",
                       json={"amount": 99.555})
check("fresh conn rounding", status(response) == 200
      and conn.cur.executed[0][1][0] == 99.56, conn.cur.executed[0][1])

print("== advance confirmation ==")

conn = fresh([
    [{"paid_amount": 250, "total": 1000, "status": "open",
      "contact_id": "92x"}],
    [],
    [{"notify_enabled": True}],
    [{"contact_name": "Ali"}],
    [],
    [],
    [],
])
response = client.post("/api/v1/portal/checkout/links/12/advance",
                       json={"amount": 250})
check("advance confirm 200", status(response) == 200, status(response))
sqls = [e[0] for e in conn.cur.executed]
check("advance confirm queued", any("portal_connector_commands" in s
      for s in sqls), len(sqls))
cmd_params = next(e[1] for e in conn.cur.executed
                  if "portal_connector_commands" in e[0])
check("advance confirm source tag", "checkout_advance" in str(cmd_params[2]),
      str(cmd_params[2])[:90])
msg_body = str(cmd_params[2])
check("advance confirm split", "Rs 250 received" in msg_body
      and "Rs 750" in msg_body and "on delivery" in msg_body, msg_body)

conn = fresh([
    [{"paid_amount": 1000, "total": 1000, "status": "paid",
      "contact_id": "92x"}],
    [],
    [{"notify_enabled": True}],
    [{"contact_name": "Ali"}],
    [],
    [],
    [],
])
response = client.post("/api/v1/portal/checkout/links/12/advance",
                       json={"amount": 1000})
check("full advance 200", status(response) == 200, status(response))
full_params = next(e[1] for e in conn.cur.executed
                   if "portal_connector_commands" in e[0])
msg_body = str(full_params[2])
check("full advance thanks", "Thank you" in msg_body
      and "on delivery" not in msg_body, msg_body)

conn = fresh([
    [{"paid_amount": 250, "total": 1000, "status": "open",
      "contact_id": "92x"}],
    [],
    [{"notify_enabled": False}],
])
response = client.post("/api/v1/portal/checkout/links/12/advance",
                       json={"amount": 250})
check("advance notify off", status(response) == 200
      and not any("portal_connector_commands" in e[0]
                  for e in conn.cur.executed), status(response))

print("== public shape ==")

ROW = {"id": 9, "token": "tok", "contact_id": "92x", "title": "T",
       "items": [{"name": "K", "qty": 1, "price": 1000}], "total": 1000.0,
       "status": "open", "created_at": None, "expires_at": None,
       "view_count": 0}
public = portal_checkout._public(dict(ROW, paid_amount=250))
check("_public due", public["paid_amount"] == 250 and public["due"] == 750,
      (public["paid_amount"], public["due"]))
public = portal_checkout._public(dict(ROW, paid_amount=1200))
check("_public due floors at zero", public["due"] == 0, public["due"])
public = portal_checkout._public(dict(ROW))
check("_public default zero", public["paid_amount"] == 0
      and public["due"] == 1000.0, (public["paid_amount"], public["due"]))

summary("link_advance")
