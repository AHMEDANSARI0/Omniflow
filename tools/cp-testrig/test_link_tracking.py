"""Tests for checkout link courier tracking: scoped UPDATE, validation,
audit, exposure (list + public + _public), duplicate does NOT carry it."""
from flask import Flask

import portal_checkout
import portal_ratelimit
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
    portal_ratelimit._DDL_READY = True
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
check("ddl tracking columns", "courier" in alter_sql
      and "tracking_number" in alter_sql
      and alter_sql.index("courier") > alter_sql.index("discount"),
      alter_sql[:140])

print("== tracking ==")

conn = fresh([[{"id": 12}], []])
response = client.patch("/api/v1/portal/checkout/links/12/tracking",
                        json={"courier": "TCS", "tracking_number": "abc123"})
check("200 tracking", status(response) == 200
      and response.get_json()["ok"] is True, status(response))
upd_sql, upd_params = conn.cur.executed[0]
check("scoped update", "courier = %s, tracking_number = %s" in upd_sql
      and "client_id = %s" in upd_sql, upd_sql[:100])
check("update params", upd_params == ("TCS", "abc123", 12, 1), upd_params)
check("tracking audit", conn.cur.executed[1][1][1] == "checkout.tracking"
      and "abc123" in conn.cur.executed[1][1][5], conn.cur.executed[1][1])

conn = fresh([[{"id": 12}], []])
response = client.patch("/api/v1/portal/checkout/links/12/tracking",
                        json={"courier": "x" * 60, "tracking_number": "y" * 90})
upd_params = conn.cur.executed[0][1]
check("trims to caps", upd_params[0] == "x" * 40
      and upd_params[1] == "y" * 60, (len(upd_params[0]), len(upd_params[1])))

conn = fresh([[], []])
response = client.patch("/api/v1/portal/checkout/links/12/tracking",
                        json={"courier": "TCS", "tracking_number": "x"})
check("404 unknown", status(response) == 404, status(response))

response = client.patch("/api/v1/portal/checkout/links/12/tracking",
                        json={"courier": "TCS"})
check("400 no number", status(response) == 400, status(response))
response = client.patch("/api/v1/portal/checkout/links/12/tracking",
                        json={"tracking_number": "   "})
check("400 blank number", status(response) == 400, status(response))

conn = fresh([])
response = client.patch("/api/v1/portal/checkout/links/12/tracking",
                        json={"tracking_number": "x"})
check("503 on failure", status(response) == 503, status(response))

conn = fresh([[{"id": 12}], []])
response = client.patch("/api/v1/portal/checkout/links/12/tracking",
                        json={"tracking_number": "fresh"})
check("no courier ok", status(response) == 200
      and conn.cur.executed[0][1][0] == "", conn.cur.executed[0][1])

print("== exposure ==")

ROW = {"id": 9, "token": "tok", "contact_id": "92x", "title": "T",
       "items": [{"name": "K", "qty": 1, "price": 1000}], "total": 800,
       "status": "shipped", "created_at": None, "expires_at": None,
       "view_count": 0, "paid_amount": 0, "discount": 0,
       "courier": "TCS", "tracking_number": "abc123"}
public = portal_checkout._public(dict(ROW))
check("_public tracking", public["courier"] == "TCS"
      and public["tracking_number"] == "abc123", public["courier"])
public = portal_checkout._public(dict(ROW, courier=None))
check("_public defaults", public["courier"] == ""
      and public["tracking_number"] == "abc123", public["courier"])

conn = fresh([[{"count": 5}], [dict(ROW)], []])
response = client.get("/api/v1/portal/checkout/links")
sel_sql = conn.cur.executed[0][0]
check("list selects tracking", "courier" in sel_sql
      and "tracking_number" in sel_sql, sel_sql[:100])

conn = fresh([[{"count": 5}], [dict(ROW)], []])
payload, code = portal_checkout.public_checkout("tok")
check("public exposes tracking", code == 200
      and payload["tracking_number"] == "abc123",
      (code, payload.get("tracking_number")))

print("== duplicate leaves tracking behind ==")

SOURCE = {"contact_id": "92x", "title": "Sale",
          "items": [{"name": "K", "qty": 1, "price": 1000}],
          "total": 800, "discount": 0}
CREATED = {"id": 99, "token": "newtok", "contact_id": "92x",
           "title": "Sale", "items": SOURCE["items"], "total": 800,
           "status": "open", "created_at": None}
conn = fresh([[SOURCE], [CREATED], []])
response = client.post("/api/v1/portal/checkout/links/12/duplicate")
check("200 duplicate", status(response) == 200, status(response))
sel_sql = conn.cur.executed[0][0]
check("dup select has no courier", "courier" not in sel_sql, sel_sql[:80])

summary("link_tracking")
