"""Tests for load-older message paging (Phase 34)."""
import sys

from flask import Flask

import portal_conversations
import test_lib
from test_lib import check, human_principal, install_db_stub, PrincipalStub, status, summary, portal_thread_source

app = Flask(__name__)
app.register_blueprint(portal_conversations.bp)
client = app.test_client()
portal_conversations._STAR_COLUMN_READY = True

human = human_principal(client_id=1, user_id=11, email="ahmed@example.com")

CONV_ROW = {
    "id": 7,
    "channel": "whatsapp",
    "contact_id": "923001234567",
    "contact_name": "Ahmed",
    "status": "open",
    "last_message_at": None,
    "last_message_preview": "hi",
    "created_at": None,
    "unread": False,
    "needs_reply": False,
    "last_intent": "order",
    "lead_score": 60,
    "lead_temp": "warm",
    "assigned_to": None,
    "assignee_name": None,
}


def message_rows(count):
    return [{"id": i, "direction": "in", "body": "m" + str(i), "status": "received",
             "intent": None, "created_at": None} for i in range(1, count + 1)]


print("== detail has_more ==")

PrincipalStub(portal_conversations, principal=human)
conn = install_db_stub(portal_conversations, [[CONV_ROW], message_rows(2), [], []])
response = client.get("/api/v1/portal/conversations/7")
check("detail 200", status(response) == 200, status(response))
payload = response.get_json()
check("has_more false", payload.get("has_more") is False, payload.get("has_more"))
check("detail page params", conn.cur.executed[1][1] == (7, 201), conn.cur.executed[1][1])

conn = install_db_stub(portal_conversations, [[CONV_ROW], message_rows(201), [], []])
response = client.get("/api/v1/portal/conversations/7")
payload = response.get_json()
check("has_more true", payload.get("has_more") is True, payload.get("has_more"))
check("page trimmed to 200", len(payload["messages"]) == 200, len(payload["messages"]))
check("oldest last", payload["messages"][-1]["id"] == 1, payload["messages"][-1]["id"])

print("== messages page endpoint ==")

conn = install_db_stub(portal_conversations, [[{"ok": 1}], message_rows(3)])
response = client.get("/api/v1/portal/conversations/7/messages?before_id=50")
check("page 200", status(response) == 200, status(response))
payload = response.get_json()
check("page has_more false", payload.get("has_more") is False, payload.get("has_more"))
check("page 3 messages", len(payload["messages"]) == 3, len(payload["messages"]))
check("before clause", "AND id < %s" in conn.cur.executed[1][0], conn.cur.executed[1][0][-140:])
check("page params", conn.cur.executed[1][1] == (7, 50, 201), conn.cur.executed[1][1])
check("conv ownership checked", "client_id = %s" in conn.cur.executed[0][0])

conn = install_db_stub(portal_conversations, [[{"ok": 1}], message_rows(201)])
response = client.get("/api/v1/portal/conversations/7/messages")
payload = response.get_json()
check("no before clause", "AND id < %s" not in conn.cur.executed[1][0])
check("full page has_more", payload.get("has_more") is True and len(payload["messages"]) == 200)

conn = install_db_stub(portal_conversations, [[]])
response = client.get("/api/v1/portal/conversations/99/messages?before_id=5")
check("unknown conv 404", status(response) == 404, status(response))

conn = install_db_stub(portal_conversations, [[{"ok": 1}], message_rows(1)])
response = client.get("/api/v1/portal/conversations/7/messages?before_id=junk")
check("junk before_id treated as 0", "AND id < %s" not in conn.cur.executed[1][0] and status(response) == 200)

PrincipalStub(portal_conversations, principal=None)
conn = install_db_stub(portal_conversations, [])
response = client.get("/api/v1/portal/conversations/7/messages?before_id=5")
check("401 zero queries", status(response) == 401 and len(conn.cur.executed) == 0, status(response))

print("== structural ==")

lib_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("lib messages fn", "export async function getConversationMessages(" in lib_src)
check("lib has_more in detail", "hasMore: p.has_more === true," in lib_src)
check("lib shared normalizer", "function normalizeConversationMessages(" in lib_src)
bff_detail = open("/tmp/p13/Omniflow/app/api/omniflow/portal/conversations/[id]/route.ts").read()
check("bff detail forwards has_more", "has_more: result.hasMore" in bff_detail)
bff_msgs = open("/tmp/p13/Omniflow/app/api/omniflow/portal/conversations/[id]/messages/route.ts").read()
check("bff messages GET", "export async function GET(request: Request, context: RouteContext)" in bff_msgs)
check("bff before_id clamp", 'searchParams.get("before_id")' in bff_msgs)
page_src = portal_thread_source()
check("page load older button", "Load older messages" in page_src)
check("page prepends older", "[...older, ...current]" in page_src)
check("page has_more state", "setHasMore(payload.has_more === true)" in page_src)

failures = summary("load_older")
sys.exit(1 if failures else 0)
