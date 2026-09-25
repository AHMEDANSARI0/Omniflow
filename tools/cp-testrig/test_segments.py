"""236-250: customer segments - saved filters, live members, segment broadcast."""
import json
import os

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")

from flask import Flask

import portal_segments, test_lib
from test_lib import check, human_principal, install_db_stub, summary, PrincipalStub

SRC = open("portal_segments.py", encoding="utf8").read()


def fresh(script):
    portal_segments._SEG_DDL_READY = False
    conn = install_db_stub(portal_segments, script)
    portal_segments.portal_db.CMD_TABLE = "portal_connector_commands"
    return conn


app = Flask(__name__)
app.register_blueprint(portal_segments.bp)
client = app.test_client()
human = human_principal(client_id=1, user_id=11, email="ahmed@example.com")
PrincipalStub(portal_segments, principal=human)

print("== filter validation ==")

conn = fresh([])
response = client.post("/api/v1/portal/segments",
                       json={"name": "S", "filters": {}})
check("400 empty filters", response.status_code == 400, response.status_code)
conn = fresh([])
response = client.post("/api/v1/portal/segments",
                       json={"name": "S", "filters": {"lead_temp": "warmest"}})
check("400 bad lead_temp", response.status_code == 400, response.status_code)
conn = fresh([])
response = client.post("/api/v1/portal/segments",
                       json={"name": "S", "filters": {"idle_days": 0}})
check("400 idle 0", response.status_code == 400, response.status_code)
conn = fresh([])
response = client.post("/api/v1/portal/segments",
                       json={"name": "S", "filters": {"tag": "  "}})
check("400 blank tag", response.status_code == 400, response.status_code)
conn = fresh([])
response = client.post("/api/v1/portal/segments",
                       json={"name": "S", "filters": {"evil": True}})
check("400 unknown key", response.status_code == 400, response.status_code)
conn = fresh([])
response = client.post("/api/v1/portal/segments",
                       json={"name": "", "filters": {"lead_temp": "hot"}})
check("400 empty name", response.status_code == 400, response.status_code)

print("== create segment ==")

conn = fresh([[],
              [{"id": 9, "name": "Hot leads", "filters": {"lead_temp": "hot"},
                "created_at": None}],
              [{"contact_id": "92x"}], []])
response = client.post("/api/v1/portal/segments", json={
    "name": "Hot leads", "filters": {"lead_temp": "hot", "idle_days": 7}})
payload = response.get_json()
check("200 create", response.status_code == 200 and payload.get("ok") is True,
      response.status_code)
check("segment echoed", payload["segment"]["name"] == "Hot leads"
      and payload["segment"]["member_count"] == 1, payload)
insert = conn.cur.executed[1]
check("insert casts jsonb", "%s::jsonb" in insert[0], insert[0][:60])
check("filters json dumped", json.loads(insert[1][2])["lead_temp"] == "hot",
      insert[1])
check("count used same filters", "GROUP BY c.contact_id" in conn.cur.executed[2][0],
      "count")
check("create audit", conn.cur.executed[3][1][1] == "segment.created",
      conn.cur.executed[3][1])
check("audit names filters", "lead_temp" in str(conn.cur.executed[3][1]), "detail")

print("== member sql builder ==")

portal_segments._SEG_DDL_READY = True
conn = install_db_stub(portal_segments, [[
    {"contact_id": "92300@c.us", "name": "Ali", "last_at": None, "chats": 2}]])
portal_segments.portal_db.CMD_TABLE = "portal_connector_commands"
cur = conn.cur
rows = portal_segments._member_rows(
    cur, 1, {"lead_temp": "hot", "status": "open", "tag": "VIP", "idle_days": 7}, 500)
check("member row mapped", rows[0]["contact_id"] == "92300@c.us", rows)
sql, params = cur.executed[0]
check("lead filter", "AND c.lead_temp = %s" in sql, "where")
check("status filter", "AND c.status = %s" in sql, "where")
check("tag exists subquery", "LOWER(ct.tag) = LOWER(%s)" in sql, "tag")
check("idle in HAVING", "HAVING MAX(c.last_message_at)" in sql
      and "make_interval(days => %s)" in sql, "having")
check("params ordered", params[0] == 1 and params[1] == "hot"
      and params[2] == "open" and params[3] == "VIP" and params[4] == 7, params)
check("limit param", params[-1] == 500, params)

print("== list + members + delete + broadcast ==")

conn = fresh([[], [{"id": 9, "name": "S", "filters": {"lead_temp": "hot"},
                "created_at": None}], []])
response = client.get("/api/v1/portal/segments")
payload = response.get_json()
check("200 list", response.status_code == 200
      and payload["segments"][0]["name"] == "S", payload)
check("list count evaluated", payload["segments"][0]["member_count"] == 0, payload)

conn = fresh([[], [{"id": 9, "name": "S", "filters": {"lead_temp": "hot"},
                "created_at": None}], []])
response = client.get("/api/v1/portal/segments/9/members")
check("200 members empty", response.status_code == 200
      and response.get_json() == {"members": []}, response.get_json())

conn = fresh([[], [{"id": 9, "name": "S", "filters": {"status": "open"},
                "created_at": None}],
              [{"contact_id": "92300@c.us", "name": "Ali", "last_at": None,
                "chats": 3}]])
response = client.get("/api/v1/portal/segments/9/members?limit=1")
member = response.get_json()["members"][0]
check("member fields", member["contact_id"] == "92300@c.us" and member["chats"] == 3,
      member)

conn = fresh([[], [], []])
response = client.delete("/api/v1/portal/segments/9")
check("404 delete unknown", response.status_code == 404, response.status_code)

conn = fresh([[], [{"id": 9}], []])
response = client.delete("/api/v1/portal/segments/9")
check("200 delete", response.get_json() == {"ok": True}, response.get_json())
check("delete audit", conn.cur.executed[2][1][1] == "segment.deleted",
      conn.cur.executed[2][1])

conn = fresh([[]])
response = client.post("/api/v1/portal/segments/9/broadcast", json={"body": ""})
check("400 empty body", response.status_code == 400, response.status_code)

conn = fresh([[], [{"id": 9, "name": "S", "filters": {"lead_temp": "hot"},
                "created_at": None}], []])
response = client.post("/api/v1/portal/segments/9/broadcast",
                       json={"body": "Hi {name}"})
check("400 no members", response.status_code == 400, response.status_code)

conn = fresh([[], [{"id": 9, "name": "S", "filters": {"lead_temp": "hot"},
                "created_at": None}],
              [{"contact_id": "92300@c.us", "name": "Ali Khan",
                "last_at": None, "chats": 1},
               {"contact_id": "92301@c.us", "name": "Sana",
                "last_at": None, "chats": 1}], [], [], [], []])
response = client.post("/api/v1/portal/segments/9/broadcast",
                       json={"body": "Hi {name}, sale is live!"})
check("200 broadcast", response.get_json() == {"ok": True, "sent": 2},
      response.get_json())
cmds = [e for e in conn.cur.executed if "portal_connector_commands" in e[0]]
check("one command per member", len(cmds) == 2, len(cmds))
import json as _json
first = cmds[0][1][2]
if isinstance(first, str):
    first = _json.loads(first)
check("personalized", first["body"] == "Hi Ali, sale is live!", first)
check("source segment", first["source"] == "segment", first)
check("broadcast audit", [e for e in conn.cur.executed if "portal_action_log" in e[0]][-1][1][1] == "segment.broadcast", "audit")
check("cap constant", "BROADCAST_CAP = 200" in SRC, "cap")

PrincipalStub(portal_segments, principal=None)
conn = fresh([])
response = client.get("/api/v1/portal/segments")
check("401 unauth list", response.status_code == 401, response.status_code)
response = client.post("/api/v1/portal/segments/9/broadcast",
                       json={"body": "x"})
check("401 unauth broadcast", response.status_code == 401, response.status_code)
PrincipalStub(portal_segments, principal=human)

check("module registered prefix", 'url_prefix="/api/v1/portal"' in SRC, "prefix")

summary("segments")
