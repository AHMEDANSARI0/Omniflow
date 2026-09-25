"""Tests for data safety: owner-only export (bounded JSON attachment),
retention defaults/save/run (close idle + purge rejected)."""
from flask import Flask

import portal_checkout
import portal_datasafety
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_datasafety.bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
agent = dict(human, role="agent")
PrincipalStub(portal_datasafety, principal=human)
PrincipalStub(portal_checkout, principal=human)


def fresh(script):
    portal_datasafety._RETENTION_DDL_READY = True
    portal_checkout._CHECKOUT_DDL_READY = True
    db = install_db_stub(portal_datasafety, script)
    db.CONV_TABLE = "portal_conversations"
    db.CMD_TABLE = "portal_commands"
    return db


print("== retention ==")

conn = fresh([[], []])
response = client.get("/api/v1/portal/data/retention")
payload = response.get_json()
check("defaults", payload["retention"]["close_idle_days"] == 14
      and payload["retention"]["purge_rejected_days"] == 30,
      payload.get("retention"))

conn = fresh([[], [], []])
response = client.put("/api/v1/portal/data/retention", json={
    "close_idle_days": 7, "purge_rejected_days": 45})
check("200 save", status(response) == 200
      and response.get_json()["retention"]["close_idle_days"] == 7,
      status(response))
ins_params = conn.cur.executed[0][1]
check("clamped 1-90", ins_params[1] == 7 and ins_params[2] == 45,
      ins_params[1:])

conn = fresh([[], [], []])
response = client.put("/api/v1/portal/data/retention", json={
    "close_idle_days": 500, "purge_rejected_days": "x"})
check("clamps invalid", response.get_json()["retention"]
      == {"close_idle_days": 90, "purge_rejected_days": 30}, "-")

PrincipalStub(portal_datasafety, principal=agent)
PrincipalStub(portal_checkout, principal=agent)
response = client.put("/api/omniflow/x", json={})
response = client.put("/api/v1/portal/data/retention", json={})
check("403 agent save", status(response) == 403, status(response))
response = client.post("/api/v1/portal/data/retention/run")
check("403 agent run", status(response) == 403, status(response))
PrincipalStub(portal_datasafety, principal=human)
PrincipalStub(portal_checkout, principal=human)

print("== retention run ==")

conn = fresh([[{"close_idle_days": 7, "purge_rejected_days": 30}],
              [{"id": 1}, {"id": 2}], 5, []])
response = client.post("/api/v1/portal/data/retention/run")
payload = response.get_json()
check("200 run", status(response) == 200 and payload["closed"] == 2
      and payload["purged"] == 5, payload)
close_sql = conn.cur.executed[1][0]
check("closes idle open", "status = 'closed'" in close_sql
      and "status = 'open'" in close_sql, close_sql[:110])
purge_sql = conn.cur.executed[2][0]
check("purges rejected", "DELETE FROM portal_action_requests" in purge_sql
      and "status = 'rejected'" in purge_sql, purge_sql[:100])
check("run audit", conn.cur.executed[3][1][1] == "data.retention_run",
      conn.cur.executed[3][1])

conn = fresh([[{"close_idle_days": 7, "purge_rejected_days": 30}], [], []])
response = client.post("/api/v1/portal/data/retention/run")
check("zero counts ok", response.get_json()["closed"] == 0, "-")

print("== export ==")

CONV = {"id": 7, "client_id": 1, "contact_id": "92x", "status": "open"}
MSG = {"id": 3, "client_id": 1, "conversation_id": 7, "body": "hi"}
LINKROW = {"id": 9, "client_id": 1, "contact_id": "92x", "title": "T",
           "items": [], "total": 500, "paid_amount": 0, "discount": 0,
           "status": "paid", "created_at": None, "expires_at": None,
           "view_count": 0, "courier": "", "tracking_number": ""}
conn = fresh([[CONV], [MSG], [{"id": 5, "client_id": 1}], [LINKROW], []])
response = client.get("/api/v1/portal/data/export")
check("200 export", status(response) == 200, status(response))
check("attachment header", "attachment" in response.headers.get(
    "Content-Disposition", "")
      and ".json" in response.headers.get("Content-Disposition", ""),
      response.headers.get("Content-Disposition"))
data = response.get_json()
check("export counts", data["counts"] == {
    "conversations": 1, "messages": 1, "contacts": 1,
    "checkout_links": 1, "returns": 0}, data.get("counts"))
check("export bodies", data["messages"][0]["body"] == "hi"
      and data["checkout_links"][0]["id"] == 9, "-")

PrincipalStub(portal_datasafety, principal=agent)
PrincipalStub(portal_checkout, principal=agent)
conn = fresh([[], [], [], [], []])
response = client.get("/api/v1/portal/data/export")
check("403 agent export", status(response) == 403, status(response))
PrincipalStub(portal_datasafety, principal=human)
PrincipalStub(portal_checkout, principal=human)

conn = fresh([RuntimeError("db down")])
response = client.get("/api/v1/portal/data/export")
check("503 on failure", status(response) == 503, status(response))

summary("datasafety")
