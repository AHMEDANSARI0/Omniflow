"""Tests for inbox Load-more pagination (Phase 42)."""
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

print("== page param ==")

PrincipalStub(portal_conversations, principal=human)
conn = install_db_stub(portal_conversations, [[]])
response = client.get("/api/v1/portal/conversations?page=2")
check("200 ok", status(response) == 200, status(response))
sql = conn.cur.executed[0][0]
check("offset clause", " OFFSET %s" in sql, sql[-160:])
check("page2 params", conn.cur.executed[0][1] == (1, 50, 50), conn.cur.executed[0][1])

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations?page=3")
check("page3 offset 100", conn.cur.executed[0][1] == (1, 50, 100), conn.cur.executed[0][1])

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations")
check("page1 no offset", " OFFSET %s" not in conn.cur.executed[0][0])
check("page1 params", conn.cur.executed[0][1] == (1, 50), conn.cur.executed[0][1])

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations?page=junk")
check("junk page no offset", " OFFSET %s" not in conn.cur.executed[0][0])

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations/export?page=2")
check("export ignores page", " OFFSET %s" not in conn.cur.executed[0][0])
check("export params unchanged", conn.cur.executed[0][1] == (1, 500), conn.cur.executed[0][1])

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations?page=2&days=7")
sql = conn.cur.executed[0][0]
check("offset after limit order", sql.index("OFFSET %s") > sql.index("LIMIT %s"), sql[-120:])
check("combined params", conn.cur.executed[0][1] == (1, 7, 50, 50), conn.cur.executed[0][1])

print("== structural ==")

lib_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("lib page part", 'page >= 2 && page <= 100 ? "page=" + Math.floor(page)' in lib_src)
bff_src = open("/tmp/p13/Omniflow/app/api/omniflow/portal/conversations/route.ts").read()
check("bff page clamp", "pageNumber >= 2 && pageNumber <= 100" in bff_src)
page_src = portal_page_source("conversations")
check("page load more button", "Load more" in page_src)
check("page append dedupe", "incoming.filter((item) => !seen.has(item.id))" in page_src)
check("page filter reset", "pageRef.current = 1;" in page_src)

failures = summary("pagination")
sys.exit(1 if failures else 0)
