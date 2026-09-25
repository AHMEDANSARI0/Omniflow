"""Tests for star and pin conversations (Phase 39)."""
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

print("== star toggle ==")

portal_conversations._STAR_COLUMN_READY = True
PrincipalStub(portal_conversations, principal=human)
conn = install_db_stub(portal_conversations, [[{"starred": True}], []])
response = client.post("/api/v1/portal/conversations/7/star")
check("star on 200", status(response) == 200, status(response))
check("star response", response.get_json() == {"ok": True, "starred": True}, response.get_json())
check("toggle sql", "SET starred = NOT COALESCE(starred, FALSE)" in conn.cur.executed[0][0], conn.cur.executed[0][0][-140:])
check("toggle params", conn.cur.executed[0][1] == (7, 1), conn.cur.executed[0][1])
check("audit logged", "portal_action_log" in conn.cur.executed[1][0] and conn.cur.executed[1][1][1] == "conversation.star_toggled", conn.cur.executed[1][1])
check("log has conversation id", conn.cur.executed[1][1][4] == 7, conn.cur.executed[1][1])

conn = install_db_stub(portal_conversations, [[{"starred": False}], []])
response = client.post("/api/v1/portal/conversations/7/star")
check("star off response", response.get_json() == {"ok": True, "starred": False}, response.get_json())

conn = install_db_stub(portal_conversations, [[]])
response = client.post("/api/v1/portal/conversations/99/star")
check("unknown conv 404", status(response) == 404, status(response))

PrincipalStub(portal_conversations, principal=None)
conn = install_db_stub(portal_conversations, [])
response = client.post("/api/v1/portal/conversations/7/star")
check("401 zero queries", status(response) == 401 and len(conn.cur.executed) == 0, status(response))

print("== lazy migration runs once ==")

portal_conversations._STAR_COLUMN_READY = False
PrincipalStub(portal_conversations, principal=human)
conn = install_db_stub(portal_conversations, [[], []])
client.get("/api/v1/portal/conversations?starred=1")
check("alter is first query", conn.cur.executed[0][0].startswith("ALTER TABLE"), conn.cur.executed[0][0][:40])
check("alter is only once", sum(1 for sql, _ in conn.cur.executed if sql.startswith("ALTER TABLE")) == 1, len(conn.cur.executed))
portal_conversations._STAR_COLUMN_READY = True

print("== list starred filter + order ==")

PrincipalStub(portal_conversations, principal=human)
conn = install_db_stub(portal_conversations, [[]])
response = client.get("/api/v1/portal/conversations?starred=1")
check("200 ok", status(response) == 200, status(response))
sql = conn.cur.executed[0][0]
check("starred where", "AND c.starred = TRUE" in sql, sql[-160:])
check("starred first order", "ORDER BY c.starred DESC, c.last_message_at DESC NULLS LAST" in sql, sql[-180:])
check("no extra params", conn.cur.executed[0][1] == (1, 50), conn.cur.executed[0][1])
check("select has starred", "c.starred," in sql)

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations?starred=0")
check("starred=0 ignored", "AND c.starred = TRUE" not in conn.cur.executed[0][0])

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations/export?starred=1")
check("export starred where", "AND c.starred = TRUE" in conn.cur.executed[0][0])
check("export starred order", "ORDER BY c.starred DESC" in conn.cur.executed[0][0])

print("== structural ==")

lib_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("lib star fn", "export async function toggleConversationStar(" in lib_src)
check("lib starred in type", "starred: boolean;" in lib_src)
check("lib starred normalize", "starred: p.starred === true," in lib_src)
check("lib starred part", 'const starredPart = starredFilter === "1" ? "starred=1" : "";' in lib_src)
bff_src = open("/tmp/p13/Omniflow/app/api/omniflow/portal/conversations/route.ts").read()
check("bff starred clamp", 'url.searchParams.get("starred") === "1"' in bff_src)
star_bff = open("/tmp/p13/Omniflow/app/api/omniflow/portal/conversations/[id]/star/route.ts").read()
check("star bff route exists", "toggleConversationStar(accessToken, conversationId)" in star_bff)
page_src = portal_page_source("conversations")
check("page star button", "Toggle star" in page_src)
check("page starred chip", 'starredFilter === "1" ? "" : "1"' in page_src)
check("page optimistic toggle", "starred: !item.starred" in page_src)
check("page export param", 'params.set("starred", starredRef.current)' in page_src)

failures = summary("star_pins")
sys.exit(1 if failures else 0)
