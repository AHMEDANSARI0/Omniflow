"""Tests for scheduled broadcasts (Phases 121-125)."""
import sys
from datetime import datetime, timedelta, timezone

from flask import Flask

import connector_api
import portal_growth
import test_lib
from test_lib import check, human_principal, install_db_stub, PrincipalStub, status, summary, portal_page_source

app = Flask(__name__)
app.register_blueprint(portal_growth.bp)
app.register_blueprint(connector_api.bp)
client = app.test_client()


def fresh(script):
    """Install a stub with the lazy-schedule migration armed."""
    portal_growth._SCHEDULE_COLUMNS_READY = False
    return install_db_stub(portal_growth, script)

human = human_principal(client_id=1, user_id=11, email="ahmed@example.com")
PrincipalStub(portal_growth, principal=human)

FUTURE = (datetime.now(timezone.utc) + timedelta(hours=3)).isoformat()
RECIPS = [
    {"contact_id": "92300@c.us", "contact_name": "Ali"},
    {"contact_id": "92301@c.us", "contact_name": "Sara"},
]
ROW = {"id": 7, "audience": "all", "body": "Sale tomorrow!", "recipient_count": 2,
       "send_at": FUTURE, "created_at": None}

print("== schedule endpoint ==")

conn = fresh([[], RECIPS, [ROW], []])
response = client.post("/api/v1/portal/broadcasts/schedule",
                       json={"audience": "all", "body": "Sale tomorrow!", "send_at": FUTURE})
check("200 schedule", status(response) == 200 and response.get_json()["ok"] is True, status(response))
check("scheduled shape", response.get_json()["scheduled"]["id"] == 7
      and response.get_json()["scheduled"]["recipient_count"] == 2, response.get_json())
check("alter lazy", "ADD COLUMN IF NOT EXISTS send_at" in conn.cur.executed[0][0])
check("insert carries schedule", conn.cur.executed[2][0].count("send_at") >= 1
      and str(conn.cur.executed[2][1][4])[:10] == FUTURE[:10], conn.cur.executed[2][1][:5])
check("audit logged", conn.cur.executed[3][1][1] == "broadcast.scheduled", str(conn.cur.executed[3][1]))

for payload, label in [
    ({"audience": "mega", "body": "x", "send_at": FUTURE}, "bad audience"),
    ({"audience": "all", "body": "", "send_at": FUTURE}, "empty body"),
    ({"audience": "all", "body": "x", "send_at": "not-a-date"}, "junk date"),
    ({"audience": "all", "body": "x", "send_at": "2026-01-01T10:00:00+00:00"}, "past date"),
]:
    conn = fresh([[], RECIPS, [ROW], []])
    response = client.post("/api/v1/portal/broadcasts/schedule", json=payload)
    check("400 " + label, status(response) == 400, status(response))

NAIVE = (datetime.now(timezone.utc) + timedelta(hours=3)).replace(tzinfo=None).isoformat()
conn = fresh([[], RECIPS, [ROW], []])
response = client.post("/api/v1/portal/broadcasts/schedule",
                       json={"audience": "all", "body": "x", "send_at": NAIVE})
check("400 naive send_at", status(response) == 400, status(response))

FAR = (datetime.now(timezone.utc) + timedelta(days=31)).isoformat()
conn = fresh([[], RECIPS, [ROW], []])
response = client.post("/api/v1/portal/broadcasts/schedule",
                       json={"audience": "all", "body": "x", "send_at": FAR})
check("400 beyond 30 days", status(response) == 400, status(response))

conn = fresh([[], [], [ROW], []])
response = client.post("/api/v1/portal/broadcasts/schedule",
                       json={"audience": "all", "body": "x", "send_at": FUTURE})
check("400 no recipients", status(response) == 400
      and response.get_json()["error"]["code"] == "no_recipients", status(response))

MANY = [{"contact_id": str(900000 + i) + "@c.us", "contact_name": ""} for i in range(201)]
conn = fresh([[], MANY, [ROW], []])
response = client.post("/api/v1/portal/broadcasts/schedule",
                       json={"audience": "all", "body": "x", "send_at": FUTURE})
check("400 too many", status(response) == 400
      and response.get_json()["error"]["code"] == "too_many_recipients",
      str(status(response)) + " " + response.data[:80].decode("utf-8", "replace"))

print("== list + cancel ==")

conn = fresh([[], [ROW]])
response = client.get("/api/v1/portal/broadcasts/scheduled")
check("200 list", status(response) == 200
      and response.get_json()["scheduled"][0]["id"] == 7, status(response))
check("list filters pending", "materialized_at IS NULL" in conn.cur.executed[1][0])

conn = fresh([[], [{"id": 7}]])
response = client.delete("/api/v1/portal/broadcasts/scheduled/7")
check("200 cancel", status(response) == 200 and response.get_json()["ok"] is True, status(response))

conn = fresh([[], []])
response = client.delete("/api/v1/portal/broadcasts/scheduled/99")
check("404 cancel unknown", status(response) == 404, status(response))

print("== materialization ==")

DUE = [{"id": 9, "client_id": 1, "audience": "all", "body": "Hi {name}!",
        "recipients_json": RECIPS}]
conn = install_db_stub(portal_growth, [DUE, [], [], [], []])
portal_growth.portal_db.CMD_TABLE = "portal_connector_commands"
delivered = portal_growth.materialize_due_broadcasts(conn.cur, 1, conn)
check("delivered count", delivered == 1, delivered)
inserts = [e for e in conn.cur.executed if "INSERT INTO" in e[0] and "portal_connector_commands" in e[0]]
check("one command per recipient", len(inserts) == 2, len(inserts))
check("payload personalized", "Hi Ali!" in str(inserts[0][1]), inserts[0][1][:3] if inserts[0][1] else "")
check("marked materialized", any("materialized_at = NOW()" in e[0] for e in conn.cur.executed))
check("audit broadcast.sent", any(e[1] and "broadcast.sent" in e[1] for e in conn.cur.executed))
check("committed", conn.committed is True)

conn = install_db_stub(portal_growth, [[]])
portal_growth.portal_db.CMD_TABLE = "portal_connector_commands"
check("empty due no commit", portal_growth.materialize_due_broadcasts(conn.cur, 1, conn) == 0
      and conn.committed is False)

print("== connector poll hook ==")

portal_growth._SCHEDULE_COLUMNS_READY = True
conn = install_db_stub(connector_api, [DUE, [], [], 0, 0, [], [], [], [], [{"id": 1, "action": "send_message"}]])
connector_api.portal_db.CMD_TABLE = "portal_connector_commands"
connector_api._AWAY_TABLE_READY = True
response = client.get("/api/v1/connector/whatsapp/commands?client_id=1",
                      headers={"X-Omniflow-Key": "x"})
check("poll still 200", status(response) == 200, status(response))
check("hook materialized first", any("materialized_at = NOW()" in e[0] for e in conn.cur.executed[:7]),
      len(conn.cur.executed))

print("== structural ==")
growth_src = open("/tmp/p13/OmniFlow-Control-Plane/portal_growth.py").read()
check("schedule endpoints", growth_src.count("broadcasts/schedule") >= 2)
check("caps reused", "BROADCAST_MAX_RECIPIENTS" in growth_src.split("def schedule_broadcast")[1].split("def ")[0])
check("future guard", "Pick a time in the future" in growth_src)
connector_src = open("/tmp/p13/OmniFlow-Control-Plane/connector_api.py").read()
check("poll hook guarded", "except Exception:\n                    pass" in connector_src)
portal_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("lib exports", "export async function scheduleBroadcast(" in portal_src
      and "export async function cancelScheduledBroadcast(" in portal_src)
card_src = open("/tmp/p13/Omniflow/app/dashboard/(portal)/broadcasts/ScheduleCard.tsx").read()
check("card responsive", "sm:grid-cols-3" in card_src and "sm:flex-row" in card_src)
page_src = portal_page_source("broadcasts", ("BroadcastsClient.tsx",))
check("page renders card", "<ScheduleCard />" in page_src)

failures = summary("scheduled")
sys.exit(1 if failures else 0)
