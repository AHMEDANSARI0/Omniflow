"""Tests for checkout link discounts: net total recompute on create/edit,
validation bounds, duplicate carries the discount, public exposure, DDL."""
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


ITEMS = [{"name": "Kurti", "qty": 1, "price": 1000}]

print("== ddl ==")

conn = fresh([[], [], [], [], []])
portal_checkout._CHECKOUT_DDL_READY = False
portal_checkout._ensure_checkout_tables(conn)
alter_sql = conn.cur.executed[2][0]
check("ddl discount", "ADD COLUMN IF NOT EXISTS discount" in alter_sql
      and alter_sql.index("discount") > alter_sql.index("paid_amount"),
      alter_sql[:120])

print("== create ==")

conn = fresh([[{"id": 5}], []])
response = client.post("/api/v1/portal/checkout/links", json={
    "contact_id": "92x", "title": "Sale", "discount_amount": 200,
    "items": ITEMS})
check("200 discounted create", status(response) == 200, status(response))
ins_params = conn.cur.executed[0][1]
check("net total stored", ins_params[5] == 800, ins_params[5])
check("discount stored", ins_params[6] == 200, ins_params[6])
check("expiry params shifted", ins_params[7] is None and ins_params[8] is None,
      ins_params[7:])

conn = fresh([[{"id": 5}], []])
response = client.post("/api/v1/portal/checkout/links", json={
    "contact_id": "92x", "title": "Sale", "discount_amount": 1500,
    "items": [{"name": "K", "qty": 1, "price": 100}]})
ins_params = conn.cur.executed[0][1]
check("total floors at zero", ins_params[5] == 0 and ins_params[6] == 1500,
      ins_params[5:7])

conn = fresh([[{"id": 5}], []])
response = client.post("/api/v1/portal/checkout/links", json={
    "contact_id": "92x", "title": "Sale", "items": ITEMS})
ins_params = conn.cur.executed[0][1]
check("no discount defaults zero", ins_params[5] == 1000
      and ins_params[6] == 0, ins_params[5:7])

conn = fresh([[], []])
response = client.post("/api/v1/portal/checkout/links", json={
    "contact_id": "92x", "title": "S", "discount_amount": -5, "items": ITEMS})
check("400 negative", status(response) == 400, status(response))
response = client.post("/api/v1/portal/checkout/links", json={
    "contact_id": "92x", "title": "S", "discount_amount": "free",
    "items": ITEMS})
check("400 string", status(response) == 400, status(response))
response = client.post("/api/v1/portal/checkout/links", json={
    "contact_id": "92x", "title": "S", "discount_amount": 200000,
    "items": ITEMS})
check("400 over cap", status(response) == 400, status(response))

print("== edit ==")

conn = fresh([[{"id": 12}], []])
response = client.patch("/api/v1/portal/checkout/links/12/edit", json={
    "title": "t", "discount_amount": 300, "items": ITEMS})
check("200 edit discount", status(response) == 200, status(response))
upd_sql, upd_params = conn.cur.executed[0]
check("edit sets discount", "discount = %s" in upd_sql, upd_sql[:130])
check("edit net params", upd_params[2] == 700 and upd_params[3] == 300,
      upd_params[2:4])

conn = fresh([[{"id": 12}], []])
response = client.patch("/api/v1/portal/checkout/links/12/edit", json={
    "title": "t", "expires_in_days": 3, "items": ITEMS})
upd_params = conn.cur.executed[0][1]
check("edit expiry position shifted", upd_params[3] == 0
      and upd_params[4] == 3, upd_params[3:5])

print("== duplicate ==")

SOURCE = {"contact_id": "92x", "title": "Sale", "items": ITEMS,
          "total": 800, "discount": 200}
CREATED = {"id": 99, "token": "newtok", "contact_id": "92x",
           "title": "Sale", "items": ITEMS, "total": 800,
           "status": "open", "created_at": None}
conn = fresh([[SOURCE], [CREATED], []])
response = client.post("/api/v1/portal/checkout/links/12/duplicate")
check("200 duplicate", status(response) == 200, status(response))
sel_sql = conn.cur.executed[0][0]
check("dup selects discount", "discount" in sel_sql, sel_sql[:80])
ins_params = conn.cur.executed[1][1]
check("dup carries discount", ins_params[6] == 200, ins_params[5:])

print("== exposure ==")

ROW = {"id": 9, "token": "tok", "contact_id": "92x", "title": "T",
       "items": ITEMS, "total": 800, "status": "open", "created_at": None,
       "expires_at": None, "view_count": 0, "paid_amount": 0}
public = portal_checkout._public(dict(ROW, discount=200))
check("_public discount", public["discount"] == 200, public["discount"])
public = portal_checkout._public(dict(ROW))
check("_public default zero", public["discount"] == 0, public["discount"])

conn = fresh([[{"count": 5}], [dict(ROW, discount=200)], []])
response = client.get("/api/v1/portal/checkout/links")
sel_sql = conn.cur.executed[0][0]
check("list selects discount", "discount" in sel_sql, sel_sql[:90])

conn = fresh([[{"count": 5}], [dict(ROW, discount=200)], []])
payload, code = portal_checkout.public_checkout("tok")
check("public exposes discount", code == 200
      and payload["discount"] == 200, (code, payload.get("discount")))

summary("link_discount")
