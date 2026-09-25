"""Tests for checkout link WhatsApp share: contact resolution through the
connector command queue, opt-out-safe send, audit, scoping, validation."""
import json

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


LINK = {"id": 12, "contact_id": "92300xxxxxxx", "title": "Eid bundle",
        "status": "open"}

print("== share ==")

conn = fresh([[LINK], [[]], [], []])
response = client.post("/api/v1/portal/checkout/links/12/share",
                       json={"message": "Your order - 2500. Pay here: x"})
check("200 share", status(response) == 200
      and response.get_json()["ok"] is True, status(response))
sel_sql, sel_params = conn.cur.executed[0]
check("select scoped", "client_id = %s" in sel_sql
      and sel_params == (12, 1), sel_params)
cmd_sql, cmd_params = conn.cur.executed[2]
check("queues send_message", "portal_connector_commands" in cmd_sql
      and "'send_message'" in cmd_sql, cmd_sql[:90])
payload = json.loads(cmd_params[2])
check("payload source", payload["source"] == "checkout_share"
      and payload["external_user_id"] == "92300xxxxxxx"
      and "Pay here" in payload["body"], payload["source"])
check("share audit", conn.cur.executed[-1][1][1] == "checkout.shared",
      conn.cur.executed[-1][1])

conn = fresh([[], [], []])
response = client.post("/api/v1/portal/checkout/links/77/share",
                       json={"message": "hi"})
check("404 unknown link", status(response) == 404, status(response))

conn = fresh([[dict(LINK, contact_id="")], [], [], []])
response = client.post("/api/v1/portal/checkout/links/12/share",
                       json={"message": "hi"})
check("400 no contact", status(response) == 400, status(response))

response = client.post("/api/v1/portal/checkout/links/12/share",
                       json={"message": "   "})
check("400 blank message", status(response) == 400, status(response))
response = client.post("/api/v1/portal/checkout/links/12/share", json={})
check("400 missing message", status(response) == 400, status(response))

conn = fresh([[LINK], [[]], [], []])
response = client.post("/api/v1/portal/checkout/links/12/share",
                       json={"message": "x" * 1500})
check("200 trims to 1000", status(response) == 200
      and len(json.loads(conn.cur.executed[2][1][2])["body"]) == 1000,
      status(response))

conn = fresh([])
response = client.post("/api/v1/portal/checkout/links/12/share",
                       json={"message": "hi"})
check("503 on failure", status(response) == 503, status(response))

conn = fresh([[LINK], [[]], [], []])
response = client.post("/api/v1/portal/checkout/links/12/share",
                       json={"message": "fresh conn ok"})
check("fresh conn ok", status(response) == 200, status(response))

summary("link_share")
