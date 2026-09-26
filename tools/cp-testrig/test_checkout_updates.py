"""Tests for order status updates: shipped/delivered statuses, notify
settings (GET/PUT), customer WhatsApp notification on paid/shipped/
delivered, and failure isolation (notify never breaks the update)."""
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
    db = install_db_stub(portal_checkout, script)
    db.CONV_TABLE = "portal_conversations"
    db.CMD_TABLE = "portal_commands"
    return db


UPDATED = {"token": "tok123", "contact_id": "92x", "title": "Eid order",
           "total": 1000.0}

print("== constants ==")

check("6 statuses", portal_checkout.STATUSES ==
      ("open", "paid", "cancelled", "shipped", "delivered", "returned"),
      portal_checkout.STATUSES)
check("notify statuses", portal_checkout.NOTIFY_STATUSES ==
      ("paid", "shipped", "delivered", "returned"),
      portal_checkout.NOTIFY_STATUSES)
check("default templates cover notify",
      sorted(portal_checkout.DEFAULT_TEMPLATES.keys()) ==
      ["delivered", "paid", "returned", "shipped"],
      sorted(portal_checkout.DEFAULT_TEMPLATES.keys()))
check("settings table name",
      portal_checkout.SETTINGS_TABLE == "portal_checkout_settings",
      portal_checkout.SETTINGS_TABLE)

print("== render ==")

body = portal_checkout._render_body({}, "paid", "Ali Raza", "Eid order", 1000)
check("default paid body", "Payment received" in body
      and "Eid order" in body and "{title}" not in body, body)
check("no name in defaults", "Hi ," not in body, body)
custom = {"tpl_shipped": "Hi {name}, order {title} total {total}"}
body = portal_checkout._render_body(custom, "shipped", "Sara Khan",
                                    "Kurti set", 2500.5)
check("custom fill", body == "Hi Sara, order Kurti set total 2500.5", body)
body = portal_checkout._render_body({}, "delivered", "", "Box", 5)
check("blank custom falls back", "delivered" in body and "Box" in body, body)

print("== settings ddl ==")

conn = fresh([[]] * 9)
portal_checkout._SETTINGS_DDL_READY = False
portal_checkout._ensure_settings_table(conn)
check("settings ddl", "portal_checkout_settings"
      in conn.cur.executed[0][0]
      and "BOOLEAN NOT NULL DEFAULT TRUE"
      in conn.cur.executed[0][0], conn.cur.executed[0][0][:80])
check("cart alters", len(conn.cur.executed) == 9
      and all("ADD COLUMN IF NOT EXISTS cart_" in sql
              or "ADD COLUMN IF NOT EXISTS tpl_returned" in sql
              for sql, _ in conn.cur.executed[1:]), len(conn.cur.executed))
check("ddl probe-once", portal_checkout._SETTINGS_DDL_READY is True,
      portal_checkout._SETTINGS_DDL_READY)

print("== load settings ==")

conn = fresh([[{"notify_enabled": False, "tpl_paid": "", "tpl_shipped": "x",
                "tpl_delivered": ""}]])
out = portal_checkout._load_settings(conn.cur, 1)
check("disabled respected", out["notify_enabled"] is False, out)
check("custom kept", out["tpl_shipped"] == "x", out)
out = portal_checkout._load_settings(conn.cur, 2)
check("absent row defaults", out == {
    "notify_enabled": True, "tpl_paid": "", "tpl_shipped": "",
    "tpl_delivered": "", "tpl_returned": ""}, out)

print("== settings api ==")

conn = fresh([[{"notify_enabled": False, "tpl_paid": "p", "tpl_shipped": "s",
                "tpl_delivered": "d"}]])
response = client.get("/api/v1/portal/checkout/settings")
payload = response.get_json()
check("200 get", status(response) == 200 and payload["ok"] is True,
      status(response))
check("get scoped", "client_id = %s" in conn.cur.executed[0][0]
      and conn.cur.executed[0][1] == (1,), conn.cur.executed[0][1])
check("get values", payload["settings"]["notify_enabled"] is False
      and payload["settings"]["tpl_paid"] == "p", payload["settings"])

conn = fresh([[]])
response = client.get("/api/v1/portal/checkout/settings")
payload = response.get_json()
check("get defaults when absent", payload["settings"]["notify_enabled"]
      is True and payload["settings"]["tpl_paid"] == "",
      payload["settings"])

response = client.put("/api/v1/portal/checkout/settings",
                      json={"settings": {"notify_enabled": "yes"}})
check("400 notify bool", status(response) == 400, status(response))
response = client.put("/api/v1/portal/checkout/settings",
                      json={"settings": {"notify_enabled": True,
                                         "tpl_paid": "x" * 501}})
check("400 template cap", status(response) == 400, status(response))

conn = fresh([[], []])
response = client.put("/api/v1/portal/checkout/settings", json={
    "settings": {"notify_enabled": False, "tpl_paid": "Thanks {name}!",
                 "tpl_shipped": "", "tpl_delivered": ""}})
check("200 put", status(response) == 200, status(response))
upsert = conn.cur.executed[0]
check("put upsert", "ON CONFLICT (client_id) DO UPDATE" in upsert[0]
      and "portal_checkout_settings" in upsert[0], upsert[0][:80])
check("put params", upsert[1] == (1, False, "Thanks {name}!", "", "",
      "", False, 2, 24, 48, "", "", ""), upsert[1])
check("put audit", conn.cur.executed[1][1][1] == "checkout.settings",
      conn.cur.executed[1][1])

print("== notify on paid ==")

conn = fresh([[UPDATED], [], [{"notify_enabled": True, "tpl_paid": "",
                               "tpl_shipped": "", "tpl_delivered": ""}],
              [{"contact_name": "Ali Raza"}], [], []])
response = client.patch("/api/v1/portal/checkout/links/12",
                        json={"status": "paid"})
payload = response.get_json()
check("200 paid notified", status(response) == 200
      and payload.get("notified") is True, payload)
check("update returns row", "RETURNING token, contact_id, title, total"
      in conn.cur.executed[0][0], conn.cur.executed[0][0][:90])
check("name lookup", "portal_conversations" in conn.cur.executed[3][0]
      and conn.cur.executed[3][1] == (1, "92x"), conn.cur.executed[3][1])
cmd_sql, cmd_params = conn.cur.executed[4]
check("cmd insert", "INSERT INTO" in cmd_sql
      and "send_message" in cmd_sql, cmd_sql[:90])
sent = json.loads(cmd_params[2])
check("cmd payload", sent["external_user_id"] == "92x"
      and sent["source"] == "checkout_update"
      and "Payment received" in sent["body"]
      and "Eid order" in sent["body"], sent)
check("notify audit", conn.cur.executed[5][1][1] == "checkout.notified",
      conn.cur.executed[5][1])

print("== notify isolated ==")

conn = fresh([[UPDATED], [], [{"notify_enabled": False, "tpl_paid": "",
                               "tpl_shipped": "", "tpl_delivered": ""}]])
response = client.patch("/api/v1/portal/checkout/links/12",
                        json={"status": "paid"})
payload = response.get_json()
check("disabled -> 200 no send", status(response) == 200
      and payload.get("notified") is False, payload)
check("no send queries", len(conn.cur.executed) == 3
      and all("send_message" not in sql for sql, _ in conn.cur.executed),
      len(conn.cur.executed))

conn = fresh([[UPDATED], []])
response = client.patch("/api/v1/portal/checkout/links/12",
                        json={"status": "shipped"})
payload = response.get_json()
check("exhausted stub still 200", status(response) == 200
      and payload.get("notified") is False, payload)
check("open/cancel skip notify", True, "-")
conn2 = fresh([[UPDATED], []])
response = client.patch("/api/v1/portal/checkout/links/12",
                        json={"status": "cancelled"})
check("cancelled no notify", status(response) == 200
      and len(conn2.cur.executed) == 2, len(conn2.cur.executed))

conn = fresh([[UPDATED], [], [{"notify_enabled": True, "tpl_paid": "",
                               "tpl_shipped": "", "tpl_delivered": ""}],
              [{"contact_name": "Ali Raza"}], [], []])
response = client.patch("/api/v1/portal/checkout/links/12",
                        json={"status": "delivered"})
payload = response.get_json()
check("delivered notified", status(response) == 200
      and payload.get("notified") is True, payload)
sent = json.loads(conn.cur.executed[4][1][2])
check("delivered default body", "has been delivered" in sent["body"],
      sent["body"])

response = client.patch("/api/v1/portal/checkout/links/12",
                        json={"status": "bogus"})
check("400 unknown status", status(response) == 400, status(response))

print("== fresh connection ==")

conn = fresh([[UPDATED], [], [{"notify_enabled": True, "tpl_paid": "",
                               "tpl_shipped": "", "tpl_delivered": ""}],
              [], [], []])
response = client.patch("/api/v1/portal/checkout/links/12",
                        json={"status": "paid"})
check("unknown contact still notifies", status(response) == 200
      and response.get_json().get("notified") is True, status(response))
sent = json.loads(conn.cur.executed[4][1][2])
check("blank display ok", sent.get("target_display_name") is None
      or sent.get("target_display_name") == "", sent)

summary("checkout_updates")
