"""Tests for the inbox sort selector (Phase 30, starred order since Phase 39)."""
import os
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

print("== list sort ==")

stub = PrincipalStub(portal_conversations, principal=human)
conn = install_db_stub(portal_conversations, [[]])
response = client.get("/api/v1/portal/conversations?sort=oldest")
check("200 ok", status(response) == 200, status(response))
sql = conn.cur.executed[0][0]
check("oldest order", "ORDER BY c.starred DESC, c.last_message_at ASC NULLS LAST, c.id ASC" in sql, sql[-180:])
check("default params kept", conn.cur.executed[0][1] == (1, 50), conn.cur.executed[0][1])

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations")
sql = conn.cur.executed[0][0]
check("default stays newest", "ORDER BY c.starred DESC, c.last_message_at DESC NULLS LAST, c.id DESC" in sql, sql[-180:])

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations?sort=junk")
sql = conn.cur.executed[0][0]
check("junk sort falls back", "ORDER BY c.starred DESC, c.last_message_at DESC NULLS LAST" in sql)
check("no asc anywhere", "c.last_message_at ASC NULLS LAST" not in sql)
stub.restore()

print("== export sort ==")

stub = PrincipalStub(portal_conversations, principal=human)
conn = install_db_stub(portal_conversations, [[]])
response = client.get("/api/v1/portal/conversations/export?sort=oldest")
check("export 200", status(response) == 200, status(response))
sql = conn.cur.executed[0][0]
check("export oldest order", "ORDER BY c.starred DESC, c.last_message_at ASC NULLS LAST" in sql, sql[-180:])
check("export params kept", conn.cur.executed[0][1] == (1, 500), conn.cur.executed[0][1])

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations/export")
check("export default newest", "ORDER BY c.starred DESC, c.last_message_at DESC NULLS LAST" in conn.cur.executed[0][0])
stub.restore()

print("== combined filters ==")

stub = PrincipalStub(portal_conversations, principal=human)
conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations?sort=oldest&needs_reply=overdue&status=open")
sql = conn.cur.executed[0][0]
check("overdue + oldest together", "c.last_message_at ASC NULLS LAST" in sql and "make_interval(hours => %s)" in sql, sql[-200:])
check("combined params (client, open, 4, 50)", conn.cur.executed[0][1] == (1, "open", 4, 50), conn.cur.executed[0][1])
stub.restore()

print("== structural ==")

lib_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("lib sort param", 'sortOrder === "oldest" ? "sort=oldest" : ""' in lib_src)
bff_src = open("/tmp/p13/Omniflow/app/api/omniflow/portal/conversations/route.ts").read()
check("bff sort clamped", 'sortRaw === "oldest" ? "oldest" : ""' in bff_src)
page_src = portal_page_source("conversations")
check("inbox chip", "Oldest first" in page_src)
check("inbox url seed", '(urlFilters.get("sort") || "") === "oldest"' in page_src)
check("inbox export param", 'params.set("sort", "oldest")' in page_src)

failures = summary("inbox_sort")
sys.exit(1 if failures else 0)
