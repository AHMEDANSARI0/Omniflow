"""Tests for the single-pass counts rewrite (Phases 115-116)."""
import sys

from flask import Flask

import portal_conversations
import portal_db
import test_lib
from test_lib import check, human_principal, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_conversations.bp)
client = app.test_client()
portal_conversations._STAR_COLUMN_READY = True

human = human_principal(client_id=1, user_id=11, email="ahmed@example.com")

print("== counts rewrite ==")

PrincipalStub(portal_conversations, principal=human)
conv_row = {
    "id": 5, "channel": "whatsapp", "contact_id": "92300@c.us",
    "contact_name": "Ali", "status": "open", "last_message_at": None,
    "last_message_preview": "hi", "created_at": None, "starred": False,
    "unread": False, "needs_reply": False, "lead_temp": "warm",
    "lead_score": 50, "assigned_to": None, "assignee_name": None,
}
counts_row = {"needs_reply": 2, "overdue": 1, "unassigned": 3, "unread": 4}
conn = install_db_stub(portal_conversations, [[conv_row], [], [counts_row]])
response = client.get("/api/v1/portal/conversations?include=counts")
check("200 with counts", status(response) == 200 and response.get_json()["counts"]["needs_reply"] == 2, status(response))

sql = conn.cur.executed[2][0]
check("single pass cte", "WITH recent AS (" in sql, sql[:80])
check("one messages reference", sql.count("portal_messages") == 1, sql.count("portal_messages"))
check("left join agg", "LEFT JOIN recent ON recent.conversation_id = c.id" in sql)
check("no correlated nr pass", " nr WHERE" not in sql)
check("no correlated od pass", " od WHERE" not in sql)
check("no correlated nb pass", " nb WHERE" not in sql)
check("hours window kept", "make_interval(hours => %s)" in sql)
check("unread semantics kept", "recent.last_in_at > COALESCE(c.last_read_at, TO_TIMESTAMP(0))" in sql)
params = conn.cur.executed[2][1]
check("params order (client, hours, client)", params == (1, portal_conversations.OVERDUE_HOURS, 1), params)

print("== structural ==")
src = open("/tmp/p13/OmniFlow-Control-Plane/portal_conversations.py").read()
check("lazy index added", "idx_portal_messages_conv_dir" in src)
check("index once per process", src.count("idx_portal_messages_conv_dir") == 1)
check("star migration intact", "ADD COLUMN IF NOT EXISTS starred" in src)

failures = summary("counts_perf")
sys.exit(1 if failures else 0)
