"""Tests for cart recovery: 3-step WhatsApp reminders on open checkout
links (settings DDL + loader, renderer, materializer, API validation,
connector tick wiring)."""
import json
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
    portal_checkout._CART_DDL_READY = True
    db = install_db_stub(portal_checkout, script)
    db.CONV_TABLE = "portal_conversations"
    db.CMD_TABLE = "portal_commands"
    return db


CART_ROW = {"cart_enabled": True, "cart_gap_1": 2, "cart_gap_2": 24,
            "cart_gap_3": 48, "cart_tpl_1": "", "cart_tpl_2": "",
            "cart_tpl_3": ""}
OFF_ROW = dict(CART_ROW, cart_enabled=False)
LINK = {"id": 7, "contact_id": "92x", "title": "Eid kurti", "total": 1500}

print("== constants ==")

check("cart table", portal_checkout.CART_TABLE == "portal_cart_reminders",
      portal_checkout.CART_TABLE)
check("cap", portal_checkout.CART_SEND_CAP == 5, portal_checkout.CART_SEND_CAP)
check("gap defaults", portal_checkout.CART_GAP_DEFAULTS == {1: 2, 2: 24, 3: 48},
      portal_checkout.CART_GAP_DEFAULTS)
check("default templates", sorted(portal_checkout.DEFAULT_CART_TEMPLATES)
      == [1, 2, 3], sorted(portal_checkout.DEFAULT_CART_TEMPLATES))

print("== cart ddl ==")

conn = fresh([[], []])
portal_checkout._CART_DDL_READY = False
portal_checkout._ensure_cart_table(conn)
check("cart ddl", "portal_cart_reminders" in conn.cur.executed[0][0]
      and "UNIQUE (client_id, link_id, step)" in conn.cur.executed[0][0],
      conn.cur.executed[0][0][:90])
check("cart index", "CREATE INDEX IF NOT EXISTS"
      in conn.cur.executed[1][0], conn.cur.executed[1][0][:60])
check("cart ddl probe-once", portal_checkout._CART_DDL_READY is True,
      portal_checkout._CART_DDL_READY)

print("== load cart settings ==")

conn = fresh([[dict(CART_ROW, cart_gap_2=9999, cart_tpl_1="Custom one")]])
out = portal_checkout._load_cart_settings(conn.cur, 1)
check("enabled read", out["cart_enabled"] is True, out)
check("junk gap -> default", out["cart_gap_2"] == 24, out)
check("custom tpl kept", out["cart_tpl_1"] == "Custom one", out)
conn = fresh([[{"cart_enabled": True, "cart_gap_1": "x", "cart_gap_2": 0,
                "cart_gap_3": 5}]])
out = portal_checkout._load_cart_settings(conn.cur, 2)
check("mixed junk gaps", out["cart_gap_1"] == 2 and out["cart_gap_2"] == 24
      and out["cart_gap_3"] == 5, out)
conn = fresh([[]])
out = portal_checkout._load_cart_settings(conn.cur, 1)
check("absent -> off defaults", out == {
    "cart_enabled": False, "cart_gap_1": 2, "cart_gap_2": 24,
    "cart_gap_3": 48, "cart_tpl_1": "", "cart_tpl_2": "",
    "cart_tpl_3": ""}, out)

print("== render ==")

body = portal_checkout._render_cart_body({}, 1, "Eid kurti", 1500)
check("default step1", "You left" in body and "Eid kurti" in body
      and "{title}" not in body, body)
check("default step2", "reserved for you"
      in portal_checkout._render_cart_body({}, 2, "Box", 5), "s2")
check("default step3", "Last reminder"
      in portal_checkout._render_cart_body({}, 3, "Box", 5), "s3")
body = portal_checkout._render_cart_body(
    {"cart_tpl_2": "Hi {name}, {title} for {total}?"}, 2, "Kurti", 900,
    "Sara Khan")
check("custom fill", body == "Hi Sara, Kurti for 900?", body)

print("== materialize: disabled ==")

conn = fresh([[OFF_ROW]])
sent = portal_checkout.materialize_cart_reminders(conn.cur, 1, conn)
check("disabled -> 0", sent == 0, sent)
check("no further queries", len(conn.cur.executed) == 1
      and conn.committed is False, len(conn.cur.executed))

print("== materialize: step 1 send ==")

conn = fresh([[CART_ROW], [LINK], [{"contact_name": "Ali Raza"}], [], [], [],
              [], []])
sent = portal_checkout.materialize_cart_reminders(conn.cur, 1, conn)
check("one send", sent == 1 and conn.committed is True, (sent, conn.committed))
links_sql, links_params = conn.cur.executed[1]
check("open links only", "status = 'open'" in links_sql
      and "NOT EXISTS" in links_sql
      and "portal_cart_reminders" in links_sql, links_sql[:110])
check("interval cast", "::interval" in links_sql, links_sql[:90])
check("links params", links_params == (1, "2", 1, 5), links_params)
cmd_sql, cmd_params = conn.cur.executed[3]
check("cmd queued", "INSERT INTO" in cmd_sql
      and "send_message" in cmd_sql, cmd_sql[:80])
payload = json.loads(cmd_params[2])
check("cmd body", payload["source"] == "cart_recovery"
      and payload["external_user_id"] == "92x"
      and "Eid kurti" in payload["body"]
      and "You left" in payload["body"], payload)
check("display name", payload.get("target_display_name") == "Ali Raza",
      payload.get("target_display_name"))
ins_sql, ins_params = conn.cur.executed[4]
check("reminder insert", "portal_cart_reminders" in ins_sql
      and "ON CONFLICT (client_id, link_id, step) DO NOTHING" in ins_sql,
      ins_sql[:90])
check("insert params", ins_params == (1, 7, 1), ins_params)
check("audit", conn.cur.executed[5][1][1] == "cart.recovery_step_1",
      conn.cur.executed[5][1])
check("step2 next tick sql",
      conn.cur.executed[6][1] == (1, "24", 2, 4), conn.cur.executed[6][1])

print("== materialize: step progression ==")

conn = fresh([[CART_ROW], [], [LINK], [{"contact_name": ""}], [], [], [],
              []])
sent = portal_checkout.materialize_cart_reminders(conn.cur, 1, conn)
check("step2 send", sent == 1, sent)
check("step2 audit", conn.cur.executed[6][1][1] == "cart.recovery_step_2",
      conn.cur.executed[6][1])
payload = json.loads(conn.cur.executed[4][1][2])
check("step2 custom body", "cart_tpl_2" not in payload["body"]
      and "Still thinking" in payload["body"], payload["body"][:60])

print("== materialize: cap + skips ==")

links7 = [dict(LINK, id=i) for i in range(20, 27)]
conn = fresh([[CART_ROW], links7] + [[{"contact_name": "N"}]] * 7
             + [[]] * 21)
sent = portal_checkout.materialize_cart_reminders(conn.cur, 1, conn)
check("cap 5", sent == 5, sent)
check("no commit-less sends", conn.committed is True, conn.committed)
blank = dict(LINK, id=99, contact_id="   ")
conn = fresh([[CART_ROW], [blank], [], []])
sent = portal_checkout.materialize_cart_reminders(conn.cur, 1, conn)
check("blank contact skipped", sent == 0 and conn.committed is False,
      (sent, conn.committed))

print("== settings api: cart ==")

GET_ROW = {"notify_enabled": True, "tpl_paid": "", "tpl_shipped": "",
           "tpl_delivered": "", "tpl_returned": "",
           "cart_enabled": True, "cart_gap_1": 2,
           "cart_gap_2": 9999, "cart_gap_3": 48, "cart_tpl_1": "T1",
           "cart_tpl_2": "", "cart_tpl_3": ""}
conn = fresh([[GET_ROW]])
response = client.get("/api/v1/portal/checkout/settings")
payload = response.get_json()
cart = payload["settings"]["cart"]
check("get cart", cart["enabled"] is True and cart["tpl_1"] == "T1"
      and cart["gap_2"] == 24, cart)
conn = fresh([[]])
response = client.get("/api/v1/portal/checkout/settings")
cart = response.get_json()["settings"]["cart"]
check("get cart defaults", cart == {
    "enabled": False, "gap_1": 2, "gap_2": 24, "gap_3": 48,
    "tpl_1": "", "tpl_2": "", "tpl_3": ""}, cart)

response = client.put("/api/v1/portal/checkout/settings", json={
    "settings": {"notify_enabled": True, "cart": {
        "enabled": True, "gap_1": 0, "gap_2": 24, "gap_3": 48}}})
check("400 gap low", status(response) == 400, status(response))
response = client.put("/api/v1/portal/checkout/settings", json={
    "settings": {"notify_enabled": True, "cart": {
        "enabled": True, "gap_1": 3, "gap_2": 24, "gap_3": 200}}})
check("400 gap high", status(response) == 400, status(response))
response = client.put("/api/v1/portal/checkout/settings", json={
    "settings": {"notify_enabled": True, "cart": {
        "enabled": True, "gap_1": 3, "gap_2": 24, "gap_3": 48,
        "tpl_2": "x" * 501}}})
check("400 cart tpl cap", status(response) == 400, status(response))

conn = fresh([[], []])
response = client.put("/api/v1/portal/checkout/settings", json={
    "settings": {"notify_enabled": True, "cart": {
        "enabled": True, "gap_1": 3, "gap_2": 20, "gap_3": 40,
        "tpl_1": "one", "tpl_2": "two", "tpl_3": "three"}}})
check("200 put cart", status(response) == 200, status(response))
check("put cart params", conn.cur.executed[0][1] == (
    1, True, "", "", "", "", True, 3, 20, 40, "one", "two", "three"),
    conn.cur.executed[0][1])

conn = fresh([[], []])
response = client.put("/api/v1/portal/checkout/settings", json={
    "settings": {"notify_enabled": False, "tpl_paid": "P"}})
check("put without cart ok", status(response) == 200, status(response))
check("put cart defaults", conn.cur.executed[0][1] == (
    1, False, "P", "", "", "", False, 2, 24, 48, "", "", ""),
    conn.cur.executed[0][1])

print("== tick wiring ==")

import io as _io
connector = _io.open("connector_api.py", encoding="utf8").read()
check("connector tick wired",
      "materialize_cart_reminders" in connector
      and "portal_checkout" in connector, "connector_api.py")

summary("cart_recovery")
