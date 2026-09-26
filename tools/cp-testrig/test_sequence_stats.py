"""201-205: completion stats on the list + enrollment CSV export."""
import os

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")

from flask import Flask

import portal_sequences, test_lib
from test_lib import check, human_principal, install_db_stub, summary, PrincipalStub

SRC = open("portal_sequences.py", encoding="utf8").read()
PORTAL_TS = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts", encoding="utf8").read()
BFF = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/sequences/[id]/enrollments/"
    "export/route.ts", encoding="utf8"
).read()
PAGE = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/sequences/page.tsx", encoding="utf8"
).read()

DDL = [[], [], [], [], [], [], [], [], [], []]  # 4 CREATE + ALTER tk + settings + ALTER por + ALTER oii + step_log + idx


def fresh(script):
    portal_sequences._SEQ_DDL_READY = False
    conn = install_db_stub(portal_sequences, DDL + script)
    portal_sequences.portal_db.CMD_TABLE = "portal_connector_commands"
    return conn


app = Flask(__name__)
app.register_blueprint(portal_sequences.bp)
client = app.test_client()
human = human_principal(client_id=1, user_id=11, email="ahmed@example.com")
PrincipalStub(portal_sequences, principal=human)

print("== completed stats on list ==")

conn = fresh([
    [{"id": 5, "name": "W", "enabled": True, "created_at": None,
      "trigger_keyword": "catalog"}],
    [{"step_no": 1, "delay_hours": 0, "body": "Hi", "only_if_idle_hours": None}],
    [{"total": 3}],
    [{"total": 7}],
])
response = client.get("/api/v1/portal/sequences")
payload = response.get_json()
seq = payload["sequences"][0]
check("200 list", response.status_code == 200, response.status_code)
check("active count", seq["active_enrollments"] == 3, seq)
check("completed count", seq["completed_enrollments"] == 7, seq)
check("completed query ran", "status = 'completed'" in conn.cur.executed[13][0],
      conn.cur.executed[13][0][:60])
check("scoped by sequence", conn.cur.executed[13][1] == (1, 5), conn.cur.executed[13][1])
check("default zero on create", '"completed_enrollments": 0' in
      SRC.split("def create_sequence")[1].split("def ")[0]
      or "_sequence_public(created, [], 0)" in SRC, "create call")

print("== CSV export endpoint ==")

conn = fresh([[]])
response = client.get("/api/v1/portal/sequences/9/enrollments/export")
check("404 unknown sequence", response.status_code == 404, response.status_code)

conn = fresh([
    [{"id": 5, "name": "W"}],
    [
        {"contact_name": "Ali, Sr", "contact_id": "92300@c.us",
         "status": "completed", "current_step": 2,
         "enrolled_at": None},
        {"contact_name": "Sana", "contact_id": "92301@c.us",
         "status": "active", "current_step": 1,
         "enrolled_at": None},
    ],
])
response = client.get("/api/v1/portal/sequences/5/enrollments/export")
check("200 export", response.status_code == 200, response.status_code)
check("csv mimetype", "text/csv" in response.mimetype, response.mimetype)
check("attachment name", "sequence-5-enrollments.csv" in
      response.headers.get("Content-Disposition", ""), response.headers.get("Content-Disposition"))
body = response.get_data(as_text=True)
check("header row", "contact_name,contact_id,status,current_step,enrolled_at" in body,
      body[:80])
check("rows exported", "92300@c.us" in body and "Sana" in body, body[:200])
check("quotes csv-safe", '"Ali, Sr"' in body, body[:120])
check("export limited 2000", "LIMIT 2000" in SRC.split("export_sequence_enrollments")[1]
      [:2000], "limit")
check("export client-scoped", "client_id = %s AND sequence_id = %s" in
      SRC.split("export_sequence_enrollments")[1][:2000], "scope")

PrincipalStub(portal_sequences, principal=None)
conn = fresh([[]])
response = client.get("/api/v1/portal/sequences/5/enrollments/export")
check("401 unauth export", response.status_code == 401, response.status_code)
PrincipalStub(portal_sequences, principal=human)

print("== portal clients ==")

check("client exists", "export async function exportEnrollmentsCsv(" in PORTAL_TS, "fn")
seg = PORTAL_TS.split("exportEnrollmentsCsv(")[1][:700]
check("client URL", "/enrollments/export" in seg, "url")
check("client 404 mapping", 'return { kind: "not_found" };' in seg, "not_found")
check("client returns csv", 'kind: "ok"; csv' in PORTAL_TS, "type")
check("SequenceRow field", "completedEnrollments: number;" in PORTAL_TS, "field")
check("list maps completed", "completed_enrollments" in
      PORTAL_TS.split("listSequences(")[1][:2600], "mapping")

print("== BFF route ==")

check("8 ups import", '"../../../../../../../../lib/omniflow/portal"' in BFF, "depth")
check("GET + params", "export async function GET(" in BFF
      and "params: Promise<{ id: string }>" in BFF, "signature")
check("not_found 404", 'result.kind === "not_found"' in BFF, "404")
check("csv disposition", "sequence-\" + String(sequenceId) + \"-enrollments.csv" in BFF,
      "disposition")
check("csv content type", "text/csv; charset=utf-8" in BFF, "mime")
check("bad id 400", "bad_request" in BFF, "400")

print("== page ==")

check("interface field", "completedEnrollments: number;" in PAGE, "field")
check("done in subtitle", "done" in
      PAGE.split("row.activeEnrollments} active")[1][:120], "subtitle")
check("people header", "People in {row.name}" in PAGE, "header")
check("export anchor", '"/api/omniflow/portal/sequences/" +' in PAGE
      and "/enrollments/export" in PAGE, "anchor")
check("export link styled brand", "text-brand transition hover:text-brand" in PAGE,
      "style")

summary("sequence_stats")
