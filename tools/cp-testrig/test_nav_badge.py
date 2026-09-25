"""Tests for the server-computed unread badge (Phase 35)."""
import sys

from flask import Flask

import portal_conversations
import test_lib
from test_lib import check, human_principal, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_conversations.bp)
client = app.test_client()
portal_conversations._STAR_COLUMN_READY = True

human = human_principal(client_id=1, user_id=11, email="ahmed@example.com")

print("== counts include unread ==")

PrincipalStub(portal_conversations, principal=human)
conn = install_db_stub(portal_conversations, [[], [{"needs_reply": 2, "overdue": 1, "unassigned": 3, "unread": 12}]])
response = client.get("/api/v1/portal/conversations?include=counts&limit=1")
check("200 ok", status(response) == 200, status(response))
payload = response.get_json()
check("unread in counts", payload.get("counts", {}).get("unread") == 12, payload.get("counts"))
sql = conn.cur.executed[1][0]
check("unread filter sql", "AS unread" in sql and "recent.last_in_at > COALESCE(c.last_read_at, TO_TIMESTAMP(0))" in sql, sql[-200:])
check("unread over open only", "c.status = 'open'" in sql)
check("params unchanged", conn.cur.executed[1][1] == (1, 4, 1), conn.cur.executed[1][1])

print("== structural ==")

sidebar_src = open("/tmp/p13/Omniflow/app/dashboard/components/DashSidebar.tsx").read()
check("sidebar polls counts", "useUnreadCount()" in sidebar_src and "include=counts" not in sidebar_src)
check("sidebar reads server count", "const unreadCount = useUnreadCount();" in sidebar_src)
check("sidebar no longer counts client-side", "conversation.unread === true" not in sidebar_src)
lib_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("lib counts type has unread", "unread: number;" in lib_src)
check("lib parses unread", "unread: Number(record.unread) || 0," in lib_src)
check("lib limit part", '"limit=" + Math.floor(limit)' in lib_src)
bff_src = open("/tmp/p13/Omniflow/app/api/omniflow/portal/conversations/route.ts").read()
check("bff parses limit", "const limitFilter =" in bff_src)
check("bff forwards limit", "true,\n      limitFilter" in bff_src)

failures = summary("nav_badge")
sys.exit(1 if failures else 0)
