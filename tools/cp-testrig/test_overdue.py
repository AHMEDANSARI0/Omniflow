"""Tests for the needs-reply / overdue filters (list + export scope)."""
import sys

from flask import Flask

import portal_conversations
import test_lib
from test_lib import check, human_principal, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_conversations.bp)
client = app.test_client()
portal_conversations._STAR_COLUMN_READY = True

human = human_principal(client_id=1, user_id=11, email="ahmed@example.com")

print("== list needs_reply / overdue ==")

PrincipalStub(portal_conversations, principal=human)
conn = install_db_stub(portal_conversations, [[]])
response = client.get("/api/v1/portal/conversations?needs_reply=1")
check("needs_reply 200", status(response) == 200, status(response))
sql = conn.cur.executed[0][0]
check("needs_reply subquery", "nr.conversation_id = c.id" in sql and "GROUP BY nr.conversation_id" in sql)
check("no overdue window for 1", "make_interval" not in sql)

conn = install_db_stub(portal_conversations, [[]])
response = client.get("/api/v1/portal/conversations?needs_reply=overdue")
sql = conn.cur.executed[0][0]
check("overdue window added", "make_interval(hours => %s)" in sql, sql[-200:])
check("overdue params (1, 4, 50)", conn.cur.executed[0][1] == (1, 4, 50), conn.cur.executed[0][1])

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations?needs_reply=junk")
check("junk ignored", "make_interval" not in conn.cur.executed[0][0])

print("== export needs_reply / overdue ==")

conn = install_db_stub(portal_conversations, [[]])
response = client.get("/api/v1/portal/conversations/export?needs_reply=overdue")
check("export 200", status(response) == 200, status(response))
check("export overdue params (1, 4, 500)", conn.cur.executed[0][1] == (1, 4, 500), conn.cur.executed[0][1])
check("export uses export_reply local", "make_interval(hours => %s)" in conn.cur.executed[0][0])

failures = summary("reply_overdue")
sys.exit(1 if failures else 0)
