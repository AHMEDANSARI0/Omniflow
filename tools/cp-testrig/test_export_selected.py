"""Tests for export-selected by ids (Phase 43)."""
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

print("== export ids ==")

PrincipalStub(portal_conversations, principal=human)
conn = install_db_stub(portal_conversations, [[]])
response = client.get("/api/v1/portal/conversations/export?ids=7,8,9")
check("200 ok", status(response) == 200, status(response))
sql = conn.cur.executed[0][0]
check("ids where", "AND c.id = ANY(%s)" in sql, sql[-160:])
check("ids params", conn.cur.executed[0][1] == (1, [7, 8, 9], 500), conn.cur.executed[0][1])

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations/export?ids=7,7,x,0,-3,12")
check("junk dropped + deduped", conn.cur.executed[0][1] == (1, [7, 12], 500), conn.cur.executed[0][1])

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations/export?ids=")
check("empty ids no clause", "AND c.id = ANY(%s)" not in conn.cur.executed[0][0])
check("empty ids default params", conn.cur.executed[0][1] == (1, 500), conn.cur.executed[0][1])

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations/export?ids=" + ",".join(str(i) for i in range(1, 121)))
check("ids capped at 100", len(conn.cur.executed[0][1][1]) == 100, len(conn.cur.executed[0][1][1]))

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations/export?ids=7&assigned=me")
sql = conn.cur.executed[0][0]
check("ids + mine combined", "AND c.id = ANY(%s)" in sql and "AND c.assigned_to = %s" in sql)
check("combined params", conn.cur.executed[0][1] == (1, "ahmed@example.com", [7], 500), conn.cur.executed[0][1])

conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/conversations?ids=7")
check("list ignores ids", "AND c.id = ANY(%s)" not in conn.cur.executed[0][0])

print("== structural ==")

lib_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("lib ids in filters", "ids?: number[];" in lib_src)
check("lib ids part", '"ids=" + filters.ids.slice(0, 100).join(",")' in lib_src)
bff_src = open("/tmp/p13/Omniflow/app/api/omniflow/portal/conversations/export/route.ts").read()
check("bff parses ids", 'url.searchParams.get("ids")' in bff_src)
check("bff forwards ids", "ids: ids.length ? ids : undefined," in bff_src)
page_src = portal_page_source("conversations")
check("page optional ids param", "async function exportCsv(selectedIds?: number[]) {" in page_src)
check("page export selected button", "Export selected" in page_src)
check("page ids param set", 'params.set("ids", selectedIds.join(","))' in page_src)
check("page selected filename", "omniflow-conversations-selected.csv" in page_src)

failures = summary("export_selected")
sys.exit(1 if failures else 0)
