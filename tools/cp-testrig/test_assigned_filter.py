"""Tests for the assigned filter on the inbox list and export (Phase 31)."""
import sys

from flask import Flask

import portal_conversations
import test_lib
from test_lib import check, human_principal, install_db_stub, PrincipalStub, status, summary, portal_page_source

app = Flask(__name__)
app.register_blueprint(portal_conversations.bp)
client = app.test_client()
portal_conversations._STAR_COLUMN_READY = True

human = human_principal(client_id=1, user_id=11, email="ahmed@example.com")

print("== list assigned filter ==")

PrincipalStub(portal_conversations, principal=human)
conn = install_db_stub(portal_conversations, [[]])
response = client.get("/api/v1/portal/conversations?assigned=unassigned")
check("200 ok", status(response) == 200, status(response))
sql = conn.cur.executed[0][0]
check("unassigned where", "AND c.assigned_to IS NULL" in sql, sql[-160:])
check("unassigned params", conn.cur.executed[0][1] == (1, 50), conn.cur.executed[0][1])

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations?assigned=me")
sql = conn.cur.executed[0][0]
check("mine where", "AND c.assigned_to = %s" in sql, sql[-160:])
check("mine params", conn.cur.executed[0][1] == (1, "ahmed@example.com", 50), conn.cur.executed[0][1])

conn = install_db_stub(portal_conversations, [[]])
response = client.get("/api/v1/portal/conversations?assigned=junk")
sql = conn.cur.executed[0][0]
check("junk ignored", "assigned_to IS NULL" not in sql and "AND c.assigned_to = %s" not in sql)
check("junk keeps default order", "ORDER BY c.starred DESC, c.last_message_at DESC NULLS LAST" in sql)

print("== export assigned filter ==")

conn = install_db_stub(portal_conversations, [[]])
response = client.get("/api/v1/portal/conversations/export?assigned=me")
check("export 200", status(response) == 200, status(response))
sql = conn.cur.executed[0][0]
check("export mine where", "AND c.assigned_to = %s" in sql, sql[-160:])
check("export mine params", conn.cur.executed[0][1] == (1, "ahmed@example.com", 500), conn.cur.executed[0][1])

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations/export?assigned=unassigned")
check("export unassigned where", "AND c.assigned_to IS NULL" in conn.cur.executed[0][0])

print("== combined filters ==")

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations?assigned=me&needs_reply=overdue&sort=oldest")
sql = conn.cur.executed[0][0]
check("overdue + mine + oldest", "make_interval(hours => %s)" in sql and "c.starred DESC, c.last_message_at ASC NULLS LAST" in sql, sql[-200:])
check("combined params", conn.cur.executed[0][1] == (1, "ahmed@example.com", 4, 50), conn.cur.executed[0][1])

print("== structural ==")

lib_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("lib assigned part", '? "assigned=" + assignedFilter' in lib_src)
bff_src = open("/tmp/p13/Omniflow/app/api/omniflow/portal/conversations/route.ts").read()
check("bff assigned clamped", 'assignedRaw === "unassigned" || assignedRaw === "me"' in bff_src)
page_src = portal_page_source("conversations")
check("unassigned chip", 'assignedFilter === "unassigned" ? "" : "unassigned"' in page_src)
check("mine chip", 'assignedFilter === "me" ? "" : "me"' in page_src)
check("url seed", 'urlAssigned === "unassigned" || urlAssigned === "me"' in page_src)
check("export param", 'params.set("assigned", assignedRef.current)' in page_src)

failures = summary("assigned_filter")
sys.exit(1 if failures else 0)
