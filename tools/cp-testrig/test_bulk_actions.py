"""Tests for bulk close, reopen and assign on the conversations list (Phase 33)."""
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
URL = "/api/v1/portal/conversations/bulk"

print("== bulk close / reopen ==")

PrincipalStub(portal_conversations, principal=human)
conn = install_db_stub(portal_conversations, [[{"id": 7}, {"id": 8}], []])
response = client.post(URL, json={"action": "close", "ids": [7, 8]})
check("close 200", status(response) == 200, status(response))
check("close updated", response.get_json() == {"ok": True, "updated": 2}, response.get_json())
check("close sql", "SET status = %s" in conn.cur.executed[0][0] and "id = ANY(%s)" in conn.cur.executed[0][0])
check("close params", conn.cur.executed[0][1] == ("closed", 1, [7, 8]), conn.cur.executed[0][1])
check("audit log written", "portal_action_log" in conn.cur.executed[1][0])
check("log action name", conn.cur.executed[1][1][1] == "conversation.bulk_close", conn.cur.executed[1][1])
check("log has no conversation id", conn.cur.executed[1][1][4] is None, conn.cur.executed[1][1])

conn = install_db_stub(portal_conversations, [[{"id": 7}], []])
client.post(URL, json={"action": "reopen", "ids": [7]})
check("reopen params", conn.cur.executed[0][1] == ("open", 1, [7]), conn.cur.executed[0][1])

print("== bulk assign / unassign ==")

conn = install_db_stub(portal_conversations, [[{"ok": 1}], [{"id": 7}], []])
response = client.post(URL, json={"action": "assign", "ids": [7], "assignee_email": "Team@Example.com"})
check("assign 200", status(response) == 200, status(response))
check("member checked first", "team_members" in conn.cur.executed[0][0] and "status = 'active'" in conn.cur.executed[0][0])
check("member params lowered", conn.cur.executed[0][1] == (1, "team@example.com"), conn.cur.executed[0][1])
check("assign sql", "SET assigned_to = %s" in conn.cur.executed[1][0])
check("assign params", conn.cur.executed[1][1] == ("team@example.com", 1, [7]), conn.cur.executed[1][1])

conn = install_db_stub(portal_conversations, [[]])
response = client.post(URL, json={"action": "assign", "ids": [7], "assignee_email": "ghost@example.com"})
check("unknown member 404", status(response) == 404 and response.get_json()["error"]["code"] == "assignee_not_found", status(response))
check("no update ran", len(conn.cur.executed) == 1, len(conn.cur.executed))

conn = install_db_stub(portal_conversations, [[{"id": 7}], []])
response = client.post(URL, json={"action": "unassign", "ids": [7]})
check("unassign 200", status(response) == 200, status(response))
check("unassign sql", "SET assigned_to = NULL" in conn.cur.executed[0][0])
check("unassign params", conn.cur.executed[0][1] == (1, [7]), conn.cur.executed[0][1])

print("== validation ==")

conn = install_db_stub(portal_conversations, [])
response = client.post(URL, json={"action": "delete", "ids": [7]})
check("bad action 400", status(response) == 400)
check("bad action no queries", len(conn.cur.executed) == 0)

response = client.post(URL, json={"action": "close", "ids": "7"})
check("ids must be list", status(response) == 400)

conn = install_db_stub(portal_conversations, [[{"id": 7}, {"id": 8}], []])
response = client.post(URL, json={"action": "close", "ids": [0, -1, "x", 7, 7, 8]})
check("junk filtered", status(response) == 200 and conn.cur.executed[0][1][2] == [7, 8], conn.cur.executed[0][1] if conn.cur.executed else None)

response = client.post(URL, json={"action": "close", "ids": [0, -5]})
check("no valid ids 400", status(response) == 400)

response = client.post(URL, json={"action": "assign", "ids": [7]})
check("assign without email 400", status(response) == 400)

conn = install_db_stub(portal_conversations, [[{"id": i} for i in range(50)], []])
client.post(URL, json={"action": "close", "ids": list(range(1, 61))})
check("ids capped at 50", len(conn.cur.executed[0][1][2]) == 50, len(conn.cur.executed[0][1][2]))

print("== auth ==")

PrincipalStub(portal_conversations, principal=None)
conn = install_db_stub(portal_conversations, [])
response = client.post(URL, json={"action": "close", "ids": [7]})
check("401 without session", status(response) == 401, status(response))
check("401 zero queries", len(conn.cur.executed) == 0, len(conn.cur.executed))

print("== structural ==")

lib_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("lib bulk fn", "export async function bulkConversations(" in lib_src)
check("lib bulk path", '"api/v1/portal/conversations/bulk"' in lib_src)
bff_src = open("/tmp/p13/Omniflow/app/api/omniflow/portal/conversations/route.ts").read()
check("bff has POST", "export async function POST(request: Request)" in bff_src)
check("bff forwards bulk", "bulkConversations(accessToken, action, ids, assigneeEmail)" in bff_src)
page_src = portal_page_source("conversations")
check("page bulk bar", "{selectedIds.length > 0 && (" in page_src)
check("page checkboxes", "checked={selectedIds.includes(item.id)}" in page_src)
check("page assign select", '<option value="">Assign to...</option>' in page_src)
check("page bulk actions wired", 'void bulkAction("close")' in page_src and 'void bulkAction("unassign")' in page_src)

failures = summary("bulk_actions")
sys.exit(1 if failures else 0)
