"""296-310 part 1: contact merge, weekly summary, broadcast calendar."""
import os

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")

from flask import Flask

from datetime import datetime, timedelta

import portal_conversations, portal_insights, test_lib
from test_lib import check, human_principal, install_db_stub, summary, PrincipalStub

TODAY = datetime.utcnow().date()

CONV_SRC = open("portal_conversations.py", encoding="utf8").read()
INS_SRC = open("portal_insights.py", encoding="utf8").read()


def fresh_conv(script):
    portal_conversations._SAVED_USAGE_DDL_READY = True
    conn = install_db_stub(portal_conversations, script)
    portal_conversations.portal_db.SAVED_REPLIES_TABLE = "portal_saved_replies"
    return conn


def fresh_ins(script):
    portal_insights._PIPE_DDL_READY = True
    conn = install_db_stub(portal_insights, script)
    portal_insights.portal_db.MSGS_TABLE = "portal_messages"
    portal_insights.portal_db.BROADCASTS_TABLE = "portal_broadcasts"
    portal_insights.portal_db.CSAT_TABLE = "portal_csat_requests"
    return conn


app = Flask(__name__)
app.register_blueprint(portal_conversations.bp)
app.register_blueprint(portal_insights.bp)
client = app.test_client()
human = human_principal(client_id=1, user_id=11, email="ahmed@example.com")
PrincipalStub(portal_conversations, principal=human)
PrincipalStub(portal_insights, principal=human)

print("== merge pins ==")

check("merge route", '@bp.post("/customers/merge")' in CONV_SRC, "route")
check("both required", '"Both contacts are required."' in CONV_SRC, "req")
check("same 400", '"Pick two different contacts."' in CONV_SRC, "same")
check("merge 404", '"The duplicate contact has no chats."' in CONV_SRC, "404")
check("conv move", "SET contact_id = %s" in CONV_SRC, "move")
check("stage conflict delete", "k.contact_id = %s" in CONV_SRC, "stage")
check("cod guarded", '_profile_table_exists(cur, "portal_cod_requests")' in CONV_SRC, "cod")
check("stage guarded", '_profile_table_exists(cur, "portal_contact_stage")' in CONV_SRC, "stageg")
check("audit merged", '"customers.merged"' in CONV_SRC, "audit")
check("human guard", "ensure_human_principal(principal)" in CONV_SRC, "human")

print("== merge flow ==")

conn = fresh_conv([[{"total": 2}], [], [{"oid": "s"}], [], [],
                   [{"oid": "c"}], [], []])
response = client.post("/api/v1/portal/customers/merge",
                       json={"keep": "92300keep", "merge": "92300dup"})
check("merge 200", response.status_code == 200, response.status_code)
check("moved count", (response.get_json() or {}).get("moved") == 2, "moved")
execs = conn.cur.executed
check("count first", "COUNT(*) AS total" in execs[0][0], "count")
check("conv update scoped",
      "WHERE client_id = %s AND contact_id = %s" in execs[1][0] and
      execs[1][1] == ("92300keep", 1, "92300dup"), "update")
check("stage probe fired", "to_regclass" in execs[2][0], "probe")
check("stage delete conflicts", "EXISTS" in execs[3][0], "del")
check("stage update", "SET contact_id" in execs[4][0], "stageupd")
check("cod probe fired", "to_regclass" in execs[5][0], "probe2")
check("cod update", "portal_cod_requests" in execs[6][0] and
      execs[6][1] == ("92300keep", 1, "92300dup"), "codupd")
audit_sql, audit_params = execs[7]
check("audit action", audit_params[1] == "customers.merged", "audit")
check("audit note names", "92300dup" in str(audit_params[5]) and
      "92300keep" in str(audit_params[5]), "note")
check("commit", conn.committed is True, "commit")

conn = fresh_conv([[{"total": 0}]])
response = client.post("/api/v1/portal/customers/merge",
                       json={"keep": "92300keep", "merge": "92300ghost"})
check("ghost 404", response.status_code == 404, response.status_code)

conn = fresh_conv([])
response = client.post("/api/v1/portal/customers/merge",
                       json={"keep": "same", "merge": "same"})
check("same 400", response.status_code == 400, response.status_code)

conn = fresh_conv([])
response = client.post("/api/v1/portal/customers/merge",
                       json={"keep": "", "merge": "x"})
check("blank 400", response.status_code == 400, response.status_code)

conn = fresh_conv([[{"total": 1}], [], [{"oid": None}], [{"oid": None}], []])
response = client.post("/api/v1/portal/customers/merge",
                       json={"keep": "92300keep", "merge": "92300dup"})
check("degrade ok", response.status_code == 200, response.status_code)
check("degrade slots", len(conn.cur.executed) == 5, len(conn.cur.executed))

PrincipalStub(portal_conversations, principal=None)
check("merge 401", client.post("/api/v1/portal/customers/merge",
                               json={"keep": "a", "merge": "b"}).status_code == 401,
      "401")
PrincipalStub(portal_conversations, principal=human)

print("== weekly ==")

check("weekly route", '@bp.get("/insights/weekly")' in INS_SRC, "route")
check("7 day window", "NOW() - INTERVAL '" in INS_SRC and
      "days'" in INS_SRC, "window")
check("direction split", 'm.direction' in INS_SRC, "dir")
check("action group", "GROUP BY action" in INS_SRC, "actions")
check("csat avg", "AVG(score)" in INS_SRC, "csat")
check("daily chats", "date_trunc('day', created_at)" in INS_SRC, "daily")
check("daily inbound", "m.direction = 'in'" in INS_SRC, "inb")
check("days fill", 'for offset in range(WINDOW_DAYS - 1, -1, -1)' in INS_SRC, "fill")
check("client scoped", "client_id = %s" in INS_SRC, "scope")

conn = fresh_ins([
    [{"total": 4}],
    [{"direction": "in", "total": 30}, {"direction": "out", "total": 22}],
    [{"action": "cod.confirmed", "total": 2}, {"action": "cod.declined", "total": 1},
     {"action": "broadcast.sent", "total": 1}],
    [{"total": 1}],
    [{"asked": 3, "avg_score": 4.5}],
    [{"day": (TODAY - timedelta(days=1)).isoformat(), "total": 3},
     {"day": (TODAY - timedelta(days=2)).isoformat(), "total": 1}],
    [{"day": (TODAY - timedelta(days=2)).isoformat(), "total": 12}],
])
response = client.get("/api/v1/portal/insights/weekly")
check("weekly 200", response.status_code == 200, response.status_code)
data = response.get_json() or {}
check("chats", data.get("chats") == 4, data.get("chats"))
check("in", data.get("messages_in") == 30, data.get("messages_in"))
check("out", data.get("messages_out") == 22, data.get("messages_out"))
check("cod confirmed", data.get("cod_confirmed") == 2, "confirmed")
check("cod declined", data.get("cod_declined") == 1, "declined")
check("broadcasts", data.get("broadcasts") == 1, "bc")
check("csat asked", data.get("csat_asked") == 3, "asked")
check("csat avg", data.get("csat_avg") == 4.5, "avg")
check("seven day rows", len(data.get("days") or []) == 7, "days")
check("day chats mapped", any(d.get("chats") == 3 for d in data.get("days") or []),
      "mapped")
check("day inbound mapped",
      any(d.get("inbound") == 12 for d in data.get("days") or []), "inmap")

conn = fresh_ins([Exception("db down")])
check("weekly 503", client.get("/api/v1/portal/insights/weekly").status_code == 503,
      "503")

print("== calendar ==")

check("calendar route", '@bp.get("/insights/calendar")' in INS_SRC, "route")
check("month regex", "MONTH_RE" in INS_SRC, "regex")
check("coalesce send_at", "COALESCE(send_at, created_at)" in INS_SRC, "co")
check("scheduled flag", '"materialized_at" is None' in INS_SRC or
      "materialized_at" in INS_SRC, "sched")
check("month default", 'strftime("%Y-%m")' in INS_SRC, "default")

conn = fresh_ins([[
    {"id": 7, "audience": "all", "body": "Sale live!", "recipient_count": 12,
     "send_at": None, "created_at": None, "materialized_at": None},
    {"id": 8, "audience": "hot", "body": "Tomorrow's drop", "recipient_count": 4,
     "send_at": "pending", "created_at": None, "materialized_at": None},
]])
response = client.get("/api/v1/portal/insights/calendar?month=2026-09")
check("calendar 200", response.status_code == 200, response.status_code)
cal = response.get_json() or {}
check("month echo", cal.get("month") == "2026-09", cal.get("month"))
check("two items", len(cal.get("items") or []) == 2, "items")
check("body truncated field", (cal.get("items") or [{}])[0].get("body") == "Sale live!",
      "body")
check("scheduled item", (cal.get("items") or [{}, {}])[1].get("scheduled") is True,
      "sched")

conn = fresh_ins([[]])
response = client.get("/api/v1/portal/insights/calendar?month=2026-13")
check("bad month 400", response.status_code == 400, response.status_code)

conn = fresh_ins([[]])
response = client.get("/api/v1/portal/insights/calendar?month=September")
check("junk month 400", response.status_code == 400, response.status_code)

conn = fresh_ins([[]])
response = client.get("/api/v1/portal/insights/calendar")
check("default month 200", response.status_code == 200, response.status_code)
check("empty days", (response.get_json() or {}).get("days") == [], "empty")

conn = fresh_ins([Exception("boom")])
check("calendar 503", client.get("/api/v1/portal/insights/calendar").status_code == 503,
      "503")

PrincipalStub(portal_insights, principal=None)
check("weekly 401", client.get("/api/v1/portal/insights/weekly").status_code == 401,
      "401")
check("calendar 401", client.get("/api/v1/portal/insights/calendar").status_code == 401,
      "401")
PrincipalStub(portal_insights, principal=human)

summary("workspace_tools")
