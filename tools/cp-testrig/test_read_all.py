"""Tests for mark-all-read (Phase 44)."""
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
URL = "/api/v1/portal/conversations/read-all"

print("== read all ==")

PrincipalStub(portal_conversations, principal=human)
conn = install_db_stub(portal_conversations, [[{"id": 7}, {"id": 8}, {"id": 9}], []])
response = client.post(URL)
check("200 ok", status(response) == 200, status(response))
check("updated count", response.get_json() == {"ok": True, "updated": 3}, response.get_json())
sql = conn.cur.executed[0][0]
check("update sql", "SET last_read_at = NOW()" in sql and "status = 'open'" in sql, sql[-160:])
check("params (client)", conn.cur.executed[0][1] == (1,), conn.cur.executed[0][1])
check("audit logged", "portal_action_log" in conn.cur.executed[1][0] and conn.cur.executed[1][1][1] == "conversation.read_all", conn.cur.executed[1][1])
check("log has no conversation id", conn.cur.executed[1][1][4] is None)

conn = install_db_stub(portal_conversations, [[], []])
response = client.post(URL)
check("zero rows ok", status(response) == 200 and response.get_json() == {"ok": True, "updated": 0}, response.get_json())

PrincipalStub(portal_conversations, principal=None)
conn = install_db_stub(portal_conversations, [])
response = client.post(URL)
check("401 zero queries", status(response) == 401 and len(conn.cur.executed) == 0, status(response))

print("== structural ==")

lib_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("lib read-all fn", "export async function markAllConversationsRead(" in lib_src)
check("lib read-all path", '"api/v1/portal/conversations/read-all"' in lib_src)
bff_src = open("/tmp/p13/Omniflow/app/api/omniflow/portal/conversations/read-all/route.ts").read()
check("bff read-all route", "markAllConversationsRead(accessToken)" in bff_src)
page_src = portal_page_source("conversations")
check("page markAllRead fn", "async function markAllRead()" in page_src)
check("page mark all button", "Mark all read" in page_src)
check("page gated on unread", "bulkBusy || !chipCounts.unread" in page_src)

failures = summary("read_all")
sys.exit(1 if failures else 0)
