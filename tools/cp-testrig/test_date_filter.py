"""Tests for the activity-window filter on the inbox list and export (Phase 36)."""
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

print("== list days filter ==")

PrincipalStub(portal_conversations, principal=human)
conn = install_db_stub(portal_conversations, [[]])
response = client.get("/api/v1/portal/conversations?days=7")
check("200 ok", status(response) == 200, status(response))
sql = conn.cur.executed[0][0]
check("days where", "AND c.last_message_at >= NOW() - make_interval(days => %s)" in sql, sql[-160:])
check("days params", conn.cur.executed[0][1] == (1, 7, 50), conn.cur.executed[0][1])

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations?days=1")
check("24h params", conn.cur.executed[0][1] == (1, 1, 50), conn.cur.executed[0][1])

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations?days=junk")
check("junk ignored", "make_interval(days" not in conn.cur.executed[0][0])
check("junk keeps default params", conn.cur.executed[0][1] == (1, 50), conn.cur.executed[0][1])

print("== export days filter ==")

conn = install_db_stub(portal_conversations, [[]])
response = client.get("/api/v1/portal/conversations/export?days=30")
check("export 200", status(response) == 200, status(response))
check("export days where", "make_interval(days => %s)" in conn.cur.executed[0][0])
check("export days params", conn.cur.executed[0][1] == (1, 30, 500), conn.cur.executed[0][1])

print("== combined ==")

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations?days=7&assigned=me&sort=oldest")
sql = conn.cur.executed[0][0]
check("days + mine + oldest", "make_interval(days" in sql and "ASC NULLS LAST" in sql, sql[-200:])
check("combined params", conn.cur.executed[0][1] == (1, "ahmed@example.com", 7, 50), conn.cur.executed[0][1])

print("== structural ==")

lib_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("lib days part", 'const daysPart = daysFilter ? "days=" + encodeURIComponent(daysFilter) : "";' in lib_src)
bff_src = open("/tmp/p13/Omniflow/app/api/omniflow/portal/conversations/route.ts").read()
check("bff days clamped", 'daysRaw === "1" || daysRaw === "7" || daysRaw === "30"' in bff_src)
page_src = portal_page_source("conversations")
check("page select", '<option value="">Any time</option>' in page_src)
check("page 7 days option", '<option value="7">Last 7 days</option>' in page_src)
check("page export param", 'params.set("days", daysRef.current)' in page_src)
check("page url seed", 'urlDays === "1" || urlDays === "7" || urlDays === "30"' in page_src)

failures = summary("date_filter")
sys.exit(1 if failures else 0)
