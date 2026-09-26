"""Tests for checkout link expiry + view tracking: DDL columns,
create/edit expiry (1-60 days, 0 clears), public expired gate (open only),
view_count increment (open only), list/public field exposure."""
import datetime

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
check("ddl expiry columns", "ADD COLUMN IF NOT EXISTS expires_at" in alter_sql
      and "ADD COLUMN IF NOT EXISTS view_count" in alter_sql, alter_sql[:90])

print("== create with expiry ==")

conn = fresh([[{"id": 5}], []])
response = client.post("/api/v1/portal/checkout/links", json={
    "contact_id": "92x", "title": "Sale", "expires_in_days": 7,
    "items": [{"name": "Kurti", "qty": 1, "price": 100}]})
check("200 create expiry", status(response) == 200, status(response))
ins_sql, ins_params = conn.cur.executed[0]
check("insert expires_at case", "expires_at" in ins_sql
      and "NOW() + (%s * INTERVAL '1 day')" in ins_sql, ins_sql[:100])
check("insert days params", ins_params[7] == 7 and ins_params[8] == 7,
      ins_params[7:])  # 771: discount param sits at index 6

conn = fresh([[{"id": 5}], []])
response = client.post("/api/v1/portal/checkout/links", json={
    "contact_id": "92x", "title": "Sale",
    "items": [{"name": "Kurti", "qty": 1, "price": 100}]})
ins_params = conn.cur.executed[0][1]
check("no expiry null", ins_params[7] is None and ins_params[8] is None,
      ins_params[7:])

conn = fresh([[], []])
response = client.post("/api/v1/portal/checkout/links", json={
    "contact_id": "92x", "title": "Sale", "expires_in_days": 0,
    "items": [{"name": "K", "qty": 1, "price": 1}]})
check("400 zero create", status(response) == 400, status(response))
response = client.post("/api/v1/portal/checkout/links", json={
    "contact_id": "92x", "title": "Sale", "expires_in_days": 61,
    "items": [{"name": "K", "qty": 1, "price": 1}]})
check("400 over 60", status(response) == 400, status(response))
response = client.post("/api/v1/portal/checkout/links", json={
    "contact_id": "92x", "title": "Sale", "expires_in_days": "soon",
    "items": [{"name": "K", "qty": 1, "price": 1}]})
check("400 string days", status(response) == 400, status(response))

print("== edit expiry ==")

conn = fresh([[{"id": 12}], []])
response = client.patch("/api/v1/portal/checkout/links/12/edit", json={
    "title": "t", "items": [{"name": "A", "qty": 1, "price": 5}],
    "expires_in_days": 3})
check("200 edit expiry", status(response) == 200, status(response))
upd_sql, upd_params = conn.cur.executed[0]
check("edit sets interval", "expires_at = NOW() + (%s * INTERVAL '1 day')"
      in upd_sql, upd_sql[:120])
check("edit days param", upd_params[4] == 3, upd_params)

conn = fresh([[{"id": 12}], []])
response = client.patch("/api/v1/portal/checkout/links/12/edit", json={
    "title": "t", "items": [{"name": "A", "qty": 1, "price": 5}],
    "expires_in_days": 0})
upd_sql = conn.cur.executed[0][0]
check("edit zero clears", "expires_at = NULL" in upd_sql, upd_sql[:120])

conn = fresh([[{"id": 12}], []])
response = client.patch("/api/v1/portal/checkout/links/12/edit", json={
    "title": "t", "items": [{"name": "A", "qty": 1, "price": 5}],
    "expires_in_days": -1})
check("400 negative edit", status(response) == 400, status(response))

conn = fresh([[{"id": 12}], []])
response = client.patch("/api/v1/portal/checkout/links/12/edit", json={
    "title": "t", "items": [{"name": "A", "qty": 1, "price": 5}]})
upd_sql, upd_params = conn.cur.executed[0]
check("no expiry untouched", "expires_at" not in upd_sql
      and len(upd_params) == 6, upd_sql[:100])  # 771 adds discount

print("== public gate ==")

FUTURE = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=2)
PAST = datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc)
ROW = {"id": 9, "token": "tok", "contact_id": "92x", "title": "T",
       "items": [{"name": "K", "qty": 1, "price": 5}], "total": 5.0,
       "status": "open", "created_at": None}

conn = fresh([[{"count": 5}], [dict(ROW, expires_at=PAST, view_count=0)], []])
payload, code = portal_checkout.public_checkout("tok")
check("404 expired open", code == 404 and "expired" in payload["error"]["message"],
      (code, payload))

conn = fresh([[{"count": 5}], [dict(ROW, expires_at=FUTURE, view_count=0)], []])
payload, code = portal_checkout.public_checkout("tok")
check("200 future expiry", code == 200, (code, payload))

conn = fresh([[{"count": 5}], [dict(ROW, status="paid", expires_at=PAST,
                                 view_count=0)], []])
payload, code = portal_checkout.public_checkout("tok")
check("200 paid not gated", code == 200, (code, payload))

conn = fresh([[{"count": 5}], [dict(ROW, expires_at=None, view_count=0)], []])
payload, code = portal_checkout.public_checkout("tok")
check("200 no expiry", code == 200, (code, payload))

conn = fresh([[dict(ROW, expires_at="2020-01-01T00:00:00+00:00",
                    view_count=0)], []])
payload, code = portal_checkout.public_checkout("tok")
check("404 string expiry", code == 404, (code, payload))

print("== view tracking ==")

conn = fresh([[{"count": 5}], [dict(ROW, expires_at=FUTURE, view_count=4)], []])
payload, code = portal_checkout.public_checkout("tok")
upd_sql, upd_params = conn.cur.executed[2]
check("increment open views", "view_count = COALESCE(view_count, 0) + 1"
      in upd_sql and upd_params == ("tok",), upd_sql[:80])
check("public exposes views", payload["view_count"] == 4
      and payload["expires_at"] is not None, payload.get("view_count"))

conn = fresh([[{"count": 5}], [dict(ROW, status="paid", expires_at=None,
                                 view_count=4)], []])
payload, code = portal_checkout.public_checkout("tok")
check("no increment paid", len(conn.cur.executed) == 2,
      len(conn.cur.executed))

print("== list + public shape ==")

conn = fresh([[dict(ROW, expires_at=FUTURE, view_count=2)], []])
response = client.get("/api/v1/portal/checkout/links")
sel_sql = conn.cur.executed[0][0]
check("list selects fields", "expires_at" in sel_sql
      and "view_count" in sel_sql, sel_sql[:90])
links = response.get_json()["links"]
check("list maps fields", links[0]["view_count"] == 2
      and links[0]["expires_at"] is not None, links[0])

public = portal_checkout._public(dict(ROW, expires_at=FUTURE, view_count=2))
check("_public fields", "expires_at" in public and public["view_count"] == 2,
      public.get("view_count"))

summary("link_expiry")
