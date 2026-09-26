"""Tests for returns / RTO tracking: returned status, reason codes,
portal_return_requests records, returned-notify template, returns list
endpoint, and settings roundtrip."""
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
    portal_checkout._RETURNS_DDL_READY = True
    db = install_db_stub(portal_checkout, script)
    db.CONV_TABLE = "portal_conversations"
    db.CMD_TABLE = "portal_commands"
    return db


UPDATED = {"token": "tok123", "contact_id": "92x", "title": "Eid kurti",
           "total": 1500.0}
NOTIFY_ON = {"notify_enabled": True, "tpl_paid": "", "tpl_shipped": "",
             "tpl_delivered": "", "tpl_returned": ""}

print("== constants ==")

check("returned status", "returned" in portal_checkout.STATUSES
      and len(portal_checkout.STATUSES) == 6, portal_checkout.STATUSES)
check("reason codes", portal_checkout.RETURN_REASONS ==
      ("size", "fit", "damaged", "late", "changed_mind", "other"),
      portal_checkout.RETURN_REASONS)
check("returns table", portal_checkout.RETURNS_TABLE ==
      "portal_return_requests", portal_checkout.RETURNS_TABLE)
check("returned notifies", "returned" in portal_checkout.NOTIFY_STATUSES,
      portal_checkout.NOTIFY_STATUSES)
check("returned default template",
      "registered" in portal_checkout.DEFAULT_TEMPLATES["returned"]
      and "{name}" not in portal_checkout.DEFAULT_TEMPLATES["returned"],
      portal_checkout.DEFAULT_TEMPLATES["returned"])

print("== returns ddl ==")

conn = fresh([[], []])
portal_checkout._RETURNS_DDL_READY = False
portal_checkout._ensure_returns_table(conn)
check("returns ddl", "portal_return_requests" in conn.cur.executed[0][0]
      and "UNIQUE (client_id, link_id)" in conn.cur.executed[0][0],
      conn.cur.executed[0][0][:90])
check("returns index", "CREATE INDEX IF NOT EXISTS"
      in conn.cur.executed[1][0], conn.cur.executed[1][0][:60])
check("returns probe-once", portal_checkout._RETURNS_DDL_READY is True,
      portal_checkout._RETURNS_DDL_READY)

print("== returned flow ==")

conn = fresh([[UPDATED], [], [], [NOTIFY_ON],
              [{"contact_name": "Ali Raza"}], [], []])
response = client.patch("/api/v1/portal/checkout/links/12",
                        json={"status": "returned", "reason": "size",
                              "note": "too tight"})
payload = response.get_json()
check("200 returned", status(response) == 200
      and payload.get("notified") is True, payload)
ins_sql, ins_params = conn.cur.executed[2]
check("return row", "INSERT INTO portal_return_requests" in ins_sql
      and "ON CONFLICT (client_id, link_id) DO UPDATE" in ins_sql,
      ins_sql[:90])
check("return row params", ins_params == (1, 12, "92x", "size", "too tight"),
      ins_params)
sent = json.loads(conn.cur.executed[5][1][2])
check("returned notify", sent["source"] == "checkout_update"
      and "registered" in sent["body"] and "Eid kurti" in sent["body"],
      sent)
check("notify audit", conn.cur.executed[6][1][1] == "checkout.notified",
      conn.cur.executed[6][1])

response = client.patch("/api/v1/portal/checkout/links/12",
                        json={"status": "returned"})
check("400 missing reason", status(response) == 400, status(response))
response = client.patch("/api/v1/portal/checkout/links/12",
                        json={"status": "returned", "reason": "vibes"})
check("400 bad reason", status(response) == 400, status(response))

conn = fresh([[UPDATED], [], [], [NOTIFY_ON], [], [], []])
response = client.patch("/api/v1/portal/checkout/links/12",
                        json={"status": "returned", "reason": "damaged"})
check("reason damaged ok", status(response) == 200, status(response))
check("no name blank ok", status(response) == 200, status(response))

conn = fresh([[UPDATED], [], [], [NOTIFY_ON], [], [], []])
client.patch("/api/v1/portal/checkout/links/12",
             json={"status": "returned", "reason": "late",
                   "note": "x" * 500})
check("note capped", conn.cur.executed[2][1][4] == "x" * 300,
      len(conn.cur.executed[2][1][4]))

print("== other statuses untouched ==")

conn = fresh([[UPDATED], [], [NOTIFY_ON], [{"contact_name": "A"}], [], []])
response = client.patch("/api/v1/portal/checkout/links/12",
                        json={"status": "paid"})
check("paid no return row", status(response) == 200
      and all("portal_return_requests" not in sql
              for sql, _ in conn.cur.executed), len(conn.cur.executed))
conn2 = fresh([[UPDATED], []])
response = client.patch("/api/v1/portal/checkout/links/12",
                        json={"status": "cancelled"})
check("cancelled no return row", status(response) == 200
      and all("portal_return_requests" not in sql
              for sql, _ in conn2.cur.executed), len(conn2.cur.executed))

print("== settings roundtrip ==")

conn = fresh([[dict(NOTIFY_ON, tpl_returned="Return noted: {title}")]])
response = client.get("/api/v1/portal/checkout/settings")
payload = response.get_json()
check("get tpl_returned", payload["settings"]["tpl_returned"] ==
      "Return noted: {title}", payload["settings"])
check("get selects returned", "tpl_returned"
      in conn.cur.executed[0][0], conn.cur.executed[0][0][:80])

response = client.put("/api/v1/portal/checkout/settings", json={
    "settings": {"notify_enabled": True,
                 "tpl_returned": "x" * 501}})
check("400 returned cap", status(response) == 400, status(response))

conn = fresh([[], []])
response = client.put("/api/v1/portal/checkout/settings", json={
    "settings": {"notify_enabled": True, "tpl_returned": "Got it {name}"}})
check("200 put returned", status(response) == 200, status(response))
check("put returned param", conn.cur.executed[0][1][5] == "Got it {name}",
      conn.cur.executed[0][1])
check("put has returned column", "tpl_returned = EXCLUDED.tpl_returned"
      in conn.cur.executed[0][0], conn.cur.executed[0][0][:80])

print("== returns list api ==")

RET_ROWS = [
    {"id": 3, "link_id": 12, "reason": "size", "note": "tight",
     "created_at": None, "title": "Eid kurti", "total": 1500.0},
    {"id": 2, "link_id": 9, "reason": "damaged", "note": "",
     "created_at": None, "title": "Shoes", "total": 3000.0},
]
conn = fresh([RET_ROWS, [{"total": 7}]])
response = client.get("/api/v1/portal/checkout/returns")
payload = response.get_json()
check("200 list", status(response) == 200 and payload["ok"] is True,
      status(response))
join_sql, join_params = conn.cur.executed[0]
check("join links", "LEFT JOIN portal_checkout_links" in join_sql
      and "ON l.id = r.link_id AND l.client_id = r.client_id" in join_sql,
      join_sql[:110])
check("scoped + limited", "r.client_id = %s" in join_sql
      and "ORDER BY r.id DESC LIMIT 50" in join_sql
      and join_params == (1,), join_sql[:90])
check("list payload", payload["returns"][0]["reason"] == "size"
      and payload["returns"][0]["title"] == "Eid kurti"
      and payload["returns"][0]["total"] == 1500.0
      and payload["counts"]["total"] == 7, payload["counts"])
check("count query", "COUNT(*) AS total"
      in conn.cur.executed[1][0], conn.cur.executed[1][0][:60])

conn = fresh([[], [{"total": 0}]])
response = client.get("/api/v1/portal/checkout/returns")
payload = response.get_json()
check("empty list", payload["returns"] == []
      and payload["counts"]["total"] == 0, payload)

conn = fresh([])
response = client.get("/api/v1/portal/checkout/returns")
check("503 on db failure", status(response) == 503, status(response))

conn = fresh([RET_ROWS, [{"total": 2}]])
response = client.get("/api/v1/portal/checkout/returns")
check("fresh conn ok", status(response) == 200, status(response))

summary("returns")
