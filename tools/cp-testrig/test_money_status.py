"""Tests for the money-actions completion (911-930): marking links PAID is
owner/admin-only, the status BFF exists and relays 403, the client maps
forbidden + passes return reasons, and the growth page shows the note."""
import io
import os

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
    db = install_db_stub(portal_checkout, script)
    portal_checkout.portal_db.CONV_TABLE = "portal_conversations"
    portal_checkout.portal_db.CMD_TABLE = "portal_commands"
    return db


ROW = {"token": "tok123", "contact_id": "923001234567", "title": "Kurti",
       "total": 1500}

print("== guard ==")

PrincipalStub(portal_checkout, principal=agent)
conn = fresh([])
response = client.patch("/api/v1/portal/checkout/links/12",
                        json={"status": "paid"})
payload = response.get_json()
check("403 agent paid", status(response) == 403
      and payload["error"]["message"] == "Only owners can mark links paid.",
      payload)
PrincipalStub(portal_checkout, principal=human)

conn = fresh([[ROW], [], [], [], []])
response = client.patch("/api/v1/portal/checkout/links/12",
                        json={"status": "paid"})
check("200 owner paid", status(response) == 200
      and response.get_json()["ok"] is True
      and response.get_json()["status"] == "paid", status(response))
upd_sql, upd_params = conn.cur.executed[0]
check("update paid", "SET status = %s" in upd_sql and upd_params[0] == "paid",
      upd_sql[:70])
check("audit checkout.paid", conn.cur.executed[1][1][1] == "checkout.paid",
      conn.cur.executed[1][1])

PrincipalStub(portal_checkout, principal=agent)
conn = fresh([[ROW], [], [], [], [], [], [], []])
response = client.patch("/api/v1/portal/checkout/links/12",
                        json={"status": "returned", "reason": "size"})
check("agent returned ok", status(response) == 200, status(response))
conn = fresh([[ROW], [], [], [], []])
response = client.patch("/api/v1/portal/checkout/links/12",
                        json={"status": "shipped"})
check("agent shipped ok", status(response) == 200, status(response))
PrincipalStub(portal_checkout, principal=human)

with app.test_request_context():
    check("default message intact",
          portal_checkout.ensure_money_principal(agent)[0].get_json()
          ["error"]["message"]
          == "Only owners can record advances or discounts.", "default")

print("== client ==")

PORTAL = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts", encoding="utf8").read()
check("status union forbidden",
      '| "not_found"\n  | "forbidden"\n  | null;' in PORTAL, "union")
check("status 403 map",
      '''if (response.status === 404) return "not_found";
  if (response.status === 403) return "forbidden";''' in PORTAL, "403")
check("status sends reason",
      'JSON.stringify({ status, reason: returnReason, note: "" })' in PORTAL,
      "reason")

print("== BFF ==")

BFF = "/tmp/p13/Omniflow/app/api/omniflow/portal/checkout/links/[id]/route.ts"
check("bff exists", os.path.exists(BFF), "[id]/route.ts")
body = open(BFF, encoding="utf8").read()
check("bff 7-up", '"' + "../" * 7 + 'lib/' in body, "depth")
check("bff relays 403", '"forbidden"' in body
      and "Only owners can mark links paid." in body, "403")
check("bff passes reason", "reason || undefined" in body, "reason")

print("== page ==")

PAGE = open("/tmp/p13/Omniflow/app/dashboard/(portal)/growth/page.tsx",
            encoding="utf8").read()
check("status note state", "const [statusNote, setStatusNote]" in PAGE, "state")
check("markLink error paths", '"error" in result' in PAGE
      and "Could not update - try again." in PAGE, "markLink")
check("note render", "statusNoteFor === link.id && statusNote" in PAGE, "render")

summary("money_status")
