"""Tests for customer change requests (address/cancel, 971-990 batch):
public submit guards + dedupe, owner queue + decide flows (address update,
cancel flip, decline), customer notification, audits, and web pins."""
from flask import Flask

import portal_changes
import portal_ratelimit
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_changes.bp)
app.register_blueprint(portal_changes.public_bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
apikey = dict(human, via_api_key=True)
PrincipalStub(portal_changes, principal=human)

LINK_OPEN = {"id": 3, "client_id": 1, "contact_id": "923001234567",
             "status": "open", "expires_at": None}
REQ_ROW = {"id": 12, "link_id": 3, "token": "tok123456", "kind": "address",
           "message": "Ghar shift", "address_text": "House 5, Karachi",
           "status": "pending", "created_at": None, "decided_at": None}


def fresh(script):
    portal_changes._DDL_READY = True
    portal_ratelimit._DDL_READY = True
    db = install_db_stub(portal_changes, script)
    portal_changes.portal_db.CMD_TABLE = "portal_connector_commands"
    portal_changes.portal_db.CONV_TABLE = "portal_conversations"
    return db


print("== public submit ==")

conn = fresh([[{"count": 5}], [LINK_OPEN], [], [dict(REQ_ROW)], []])
response = client.post("/api/v1/public/checkout/tok123456/change-request",
                       json={"kind": "address",
                             "address_text": "House 5, Karachi",
                             "message": "Ghar shift"})
check("submit 200", status(response) == 200
      and response.get_json()["request"]["status"] == "pending",
      response.get_json())
ins_sql, ins_params = conn.cur.executed[3]
check("insert", "INSERT INTO portal_change_requests" in ins_sql
      and ins_params[3] == "address"
      and ins_params[5] == "House 5, Karachi", ins_sql[:60])
check("audit submitted", conn.cur.executed[4][1][1] == "change.submitted"
      and conn.cur.executed[4][1][2] == "customer", conn.cur.executed[4][1])

conn = fresh([[{"count": 5}], []])
response = client.post("/api/v1/public/checkout/tok999/change-request",
                       json={"kind": "cancel"})
check("404 bad token", status(response) == 404, status(response))

conn = fresh([[{"count": 5}], [dict(LINK_OPEN, status="paid")]])
response = client.post("/api/v1/public/checkout/tok123456/change-request",
                       json={"kind": "cancel"})
check("400 closed link", status(response) == 400, status(response))

conn = fresh([[{"count": 5}], [LINK_OPEN], [{"id": 4}]])
response = client.post("/api/v1/public/checkout/tok123456/change-request",
                       json={"kind": "cancel"})
check("409 pending dup", status(response) == 409, status(response))

conn = fresh([])
response = client.post("/api/v1/public/checkout/tok123456/change-request",
                       json={"kind": "address", "address_text": "  "})
check("400 address empty, zero queries", status(response) == 400
      and len(conn.cur.executed) == 0, len(conn.cur.executed))

conn = fresh([])
response = client.post("/api/v1/public/checkout/tok123456/change-request",
                       json={"kind": "refund"})
check("400 bad kind", status(response) == 400, status(response))

conn = fresh([RuntimeError("db down")])
response = client.post("/api/v1/public/checkout/tok/change-request",
                       json={"kind": "cancel"})
check("503 wrap submit", status(response) == 503, status(response))

print("== owner queue ==")

conn = fresh([[dict(REQ_ROW, title="Eid order")], [{"status": "pending", "n": 2}]])
response = client.get("/api/v1/portal/changes/requests?status=pending")
payload = response.get_json()
check("list 200", status(response) == 200
      and payload["requests"][0]["addressText"] == "House 5, Karachi"
      and payload["requests"][0]["title"] == "Eid order", payload)
check("counts", payload["counts"] == {"pending": 2, "approved": 0,
                                      "declined": 0}, payload["counts"])
check("pending filter clause", " AND r.status = %s"
      in conn.cur.executed[0][0], conn.cur.executed[0][0][-60:])

conn = fresh([[REQ_ROW], [{"status": "approved", "n": 1}]])
response = client.get("/api/v1/portal/changes/requests?status=all")
check("all filter no clause", " AND r.status" not in conn.cur.executed[0][0]
      and status(response) == 200, status(response))

response = client.get("/api/v1/portal/changes/requests?status=weird")
check("400 bad status", status(response) == 400, status(response))

conn = fresh([RuntimeError("db down")])
response = client.get("/api/v1/portal/changes/requests")
check("503 wrap list", status(response) == 503, status(response))

print("== decide: approve address ==")

conn = fresh([[REQ_ROW], [LINK_OPEN], [{"id": 3}],
              [dict(REQ_ROW, status="approved")], [], []])
response = client.post("/api/v1/portal/changes/requests/12/decide",
                       json={"action": "approve"})
payload = response.get_json()
check("approve 200", status(response) == 200
      and payload["request"]["status"] == "approved", payload)
addr_sql, addr_params = conn.cur.executed[2]
check("address applied", "SET delivery_address = %s" in addr_sql
      and addr_params[0] == "House 5, Karachi" and addr_params[1] == 3,
      addr_sql[:70])
check("audit approved", conn.cur.executed[4][1][1] == "change.approved",
      conn.cur.executed[4][1])
notify_sql, notify_params = conn.cur.executed[5]
check("customer notified", "connector_commands" in notify_sql
      and "change_request" in notify_params[2], notify_params[2][:80])

print("== decide: approve cancel ==")

conn = fresh([[dict(REQ_ROW, kind="cancel", address_text="")],
              [LINK_OPEN], [{"id": 3}],
              [dict(REQ_ROW, kind="cancel", status="approved")], [], []])
response = client.post("/api/v1/portal/changes/requests/12/decide",
                       json={"action": "approve"})
check("cancel approved", status(response) == 200, status(response))
cancel_sql = conn.cur.executed[2][0]
check("link cancelled", "SET status = 'cancelled'" in cancel_sql
      and "status = 'open'" in cancel_sql, cancel_sql[:90])

conn = fresh([[dict(REQ_ROW, kind="cancel")],
              [dict(LINK_OPEN, status="shipped")], []])
response = client.post("/api/v1/portal/changes/requests/12/decide",
                       json={"action": "approve"})
check("409 not open", status(response) == 409, status(response))

conn = fresh([[dict(REQ_ROW, kind="address", address_text="")], [LINK_OPEN]])
response = client.post("/api/v1/portal/changes/requests/12/decide",
                       json={"action": "approve"})
check("400 empty address", status(response) == 400, status(response))

print("== decide: decline + guards ==")

conn = fresh([[REQ_ROW], [LINK_OPEN],
              [dict(REQ_ROW, status="declined")], [], []])
response = client.post("/api/v1/portal/changes/requests/12/decide",
                       json={"action": "decline"})
check("decline 200", status(response) == 200
      and response.get_json()["request"]["status"] == "declined",
      response.get_json())
check("audit declined", conn.cur.executed[3][1][1] == "change.declined",
      conn.cur.executed[3][1])

conn = fresh([[dict(REQ_ROW, status="approved")]])
response = client.post("/api/v1/portal/changes/requests/12/decide",
                       json={"action": "approve"})
check("409 already decided", status(response) == 409, status(response))

conn = fresh([[]])
response = client.post("/api/v1/portal/changes/requests/99/decide",
                       json={"action": "approve"})
check("404 request", status(response) == 404, status(response))

conn = fresh([])
response = client.post("/api/v1/portal/changes/requests/12/decide",
                       json={"action": "postpone"})
check("400 bad action", status(response) == 400
      and len(conn.cur.executed) == 0, status(response))

PrincipalStub(portal_changes, principal=apikey)
conn = fresh([[REQ_ROW]])
response = client.post("/api/v1/portal/changes/requests/12/decide",
                       json={"action": "approve"})
check("403 api-key decide", status(response) == 403, status(response))
PrincipalStub(portal_changes, principal=human)

conn = fresh([RuntimeError("db down")])
response = client.post("/api/v1/portal/changes/requests/12/decide",
                       json={"action": "approve"})
check("503 wrap decide", status(response) == 503, status(response))

print("== web shape ==")

PORTAL = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts", encoding="utf8").read()
for name in ("listChangeRequests", "decideChangeRequest",
             "submitChangeRequest"):
    check("client " + name, "export async function " + name in PORTAL, name)
check("public request path", '"/change-request"' in PORTAL
      and "controlPlanePublicRequest" in PORTAL, "path")

BFF_LIST = open("/tmp/p13/Omniflow/app/api/omniflow/portal/changes/requests/route.ts",
                encoding="utf8").read()
check("changes bff depth 6", '"../../../../../../lib/' in BFF_LIST, "depth6")
BFF_DECIDE = open("/tmp/p13/Omniflow/app/api/omniflow/portal/changes/requests/[id]/decide/route.ts",
                  encoding="utf8").read()
check("decide bff depth 8", '"../../../../../../../../lib/' in BFF_DECIDE
      and "export async function POST" in BFF_DECIDE, "depth8")
BFF_PUBLIC = open("/tmp/p13/Omniflow/app/api/omniflow/public/checkout/[token]/change-request/route.ts",
                  encoding="utf8").read()
check("public bff depth 7", '"../../../../../../../lib/' in BFF_PUBLIC
      and "submitChangeRequest" in BFF_PUBLIC, "depth7")

GROWTH = open("/tmp/p13/Omniflow/app/dashboard/(portal)/growth/page.tsx",
              encoding="utf8").read()
check("growth panel", "Customer change requests" in GROWTH
      and "decideChange" in GROWTH and "/decide" in GROWTH, "panel")

PAGE = open("/tmp/p13/Omniflow/app/c/[token]/page.tsx", encoding="utf8").read()
check("public page selfserve", 'import SelfServe from "./SelfServe";' in PAGE
      and "<SelfServe" in PAGE, "wiring")
SERVE = open("/tmp/p13/Omniflow/app/c/[token]/SelfServe.tsx",
             encoding="utf8").read()
check("selfserve modes", "Change address" in SERVE and "Cancel order" in SERVE
      and "change-request" in SERVE, "modes")

summary("changes")
