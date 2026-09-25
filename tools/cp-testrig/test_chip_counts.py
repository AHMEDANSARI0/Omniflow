"""Tests for the include=counts payload (Phase 32 + Phase 35 unread)."""
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
    "needs_reply": True,
    "last_intent": "order",
    "lead_score": 60,
    "lead_temp": "warm",
    "assigned_to": None,
    "assignee_name": None,
}

print("== counts payload ==")

PrincipalStub(portal_conversations, principal=human)
conn = install_db_stub(portal_conversations, [[], [{"needs_reply": 3, "overdue": 1, "unassigned": 2, "unread": 9}]])
response = client.get("/api/v1/portal/conversations?include=counts")
check("200 ok", status(response) == 200, status(response))
payload = response.get_json()
check("counts key", payload.get("counts") == {"needs_reply": 3, "overdue": 1, "unassigned": 2, "unread": 9}, payload.get("counts"))
sql = conn.cur.executed[1][0]
check("counts sql aggregates", "COUNT(*) FILTER" in sql and "AS needs_reply" in sql and "AS overdue" in sql and "AS unassigned" in sql, sql[:120])
check("counts sql unread filter", "recent.last_in_at > COALESCE(c.last_read_at, TO_TIMESTAMP(0))) AS unread" in sql)
check("counts sql open only", "c.status = 'open'" in sql)
check("counts sql overdue window", "make_interval(hours => %s)" in sql)
check("counts params (client, sla, client)", conn.cur.executed[1][1] == (1, 4, 1), conn.cur.executed[1][1])
check("list query untouched", "COUNT(*) FILTER" not in conn.cur.executed[0][0])

conn = install_db_stub(portal_conversations, [[], []])
response = client.get("/api/v1/portal/conversations?include=counts")
check("empty counts row -> zeros", response.get_json().get("counts") == {"needs_reply": 0, "overdue": 0, "unassigned": 0, "unread": 0})

conn = install_db_stub(portal_conversations, [[], Exception("db down")])
response = client.get("/api/v1/portal/conversations?include=counts")
check("counts failure -> zeros + 200", status(response) == 200 and response.get_json().get("counts") == {"needs_reply": 0, "overdue": 0, "unassigned": 0, "unread": 0}, status(response))

print("== without include ==")

conn = install_db_stub(portal_conversations, [[]])
response = client.get("/api/v1/portal/conversations")
payload = response.get_json()
check("single query", len(conn.cur.executed) == 1, len(conn.cur.executed))
check("no counts key", "counts" not in payload, payload.keys())

print("== conversation row shape ==")

conn = install_db_stub(portal_conversations, [[CONV_ROW], [], [{"needs_reply": 5, "overdue": 0, "unassigned": 1, "unread": 4}]])
response = client.get("/api/v1/portal/conversations?include=counts")
payload = response.get_json()
check("conversation kept", payload["conversations"][0]["id"] == 7)
check("counts beside conversations", payload["counts"]["needs_reply"] == 5, payload.get("counts"))

print("== structural ==")

lib_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("lib chip counts type", "export type ConversationChipCounts" in lib_src)
check("lib include param", '"include=counts,vip"' in lib_src)
check("lib returns counts", "return { conversations, counts };" in lib_src)
bff_src = open("/tmp/p13/Omniflow/app/api/omniflow/portal/conversations/route.ts").read()
check("bff asks for counts", "assignedFilter,\n      true" in bff_src)
check("bff forwards counts", "counts: result.counts" in bff_src)
page_src = portal_page_source("conversations")
check("page counts state", "setChipCounts({" in page_src)
check("needs reply badge", "{chipCounts.needsReply > 0 && (" in page_src)
check("overdue badge", "{chipCounts.overdue > 0 && (" in page_src)
check("unassigned badge", "{chipCounts.unassigned > 0 && (" in page_src)

failures = summary("chip_counts")
sys.exit(1 if failures else 0)
