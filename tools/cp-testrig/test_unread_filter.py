"""Tests for the unread filter chip on the inbox list and export (Phase 37)."""
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

print("== list unread filter ==")

PrincipalStub(portal_conversations, principal=human)
conn = install_db_stub(portal_conversations, [[]])
response = client.get("/api/v1/portal/conversations?unread=1")
check("200 ok", status(response) == 200, status(response))
sql = conn.cur.executed[0][0]
check("unread where", "AND EXISTS (SELECT 1 FROM portal_messages nb WHERE nb.conversation_id = c.id" in sql, sql[-200:])
check("unread compares last_read_at", "nb.created_at > COALESCE(c.last_read_at, TO_TIMESTAMP(0))" in sql)
check("no extra params", conn.cur.executed[0][1] == (1, 50), conn.cur.executed[0][1])

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations?unread=0")
check("unread=0 ignored", "portal_messages nb" not in conn.cur.executed[0][0])

print("== export unread filter ==")

conn = install_db_stub(portal_conversations, [[]])
response = client.get("/api/v1/portal/conversations/export?unread=1")
check("export 200", status(response) == 200, status(response))
check("export unread where", "portal_messages nb" in conn.cur.executed[0][0])
check("export params kept", conn.cur.executed[0][1] == (1, 500), conn.cur.executed[0][1])

print("== combined ==")

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations?unread=1&days=7&needs_reply=1")
sql = conn.cur.executed[0][0]
check("unread + days + needs_reply", "portal_messages nb" in sql and "make_interval(days" in sql and "nr.conversation_id" in sql, sql[-220:])
check("combined params", conn.cur.executed[0][1] == (1, 7, 50), conn.cur.executed[0][1])

print("== structural ==")

lib_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("lib unread part", 'const unreadPart = unreadFilter === "1" ? "unread=1" : "";' in lib_src)
bff_src = open("/tmp/p13/Omniflow/app/api/omniflow/portal/conversations/route.ts").read()
check("bff unread clamped", 'url.searchParams.get("unread") === "1"' in bff_src)
page_src = portal_page_source("conversations")
check("page unread chip", "Unread\n        </button>" in page_src)
check("page violet active", 'unreadFilter === "1"' in page_src)
check("page export param", 'params.set("unread", unreadRef.current)' in page_src)
check("page url seed", 'urlFilters.get("unread") === "1"' in page_src)

failures = summary("unread_filter")
sys.exit(1 if failures else 0)
