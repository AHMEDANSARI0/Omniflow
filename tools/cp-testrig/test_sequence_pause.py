"""211-215: per-enrollment pause/resume + bulk pause-all/resume-all."""
import os

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")

from flask import Flask

import portal_sequences, test_lib
from test_lib import check, human_principal, install_db_stub, summary, PrincipalStub

SRC = open("portal_sequences.py", encoding="utf8").read()
PORTAL_TS = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts", encoding="utf8").read()
PAUSE = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/sequences/[id]/enrollments/"
    "[eid]/pause/route.ts", encoding="utf8").read()
PAUSE_ALL = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/sequences/[id]/enrollments/"
    "pause-all/route.ts", encoding="utf8").read()
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

print("== pause / resume single ==")

conn = fresh([[]])
response = client.post("/api/v1/portal/sequences/5/enrollments/9/pause")
check("404 pause unknown", response.status_code == 404, response.status_code)

conn = fresh([[{"contact_name": "Ali"}], []])
response = client.post("/api/v1/portal/sequences/5/enrollments/9/pause")
check("200 pause", response.status_code == 200
      and response.get_json() == {"ok": True}, response.status_code)
upd = conn.cur.executed[10]
check("pause sql", "SET status = 'paused'" in upd[0], upd[0][:60])
check("pause scoped", upd[1] == (9, 1, 5), upd[1])
check("pause only active", "AND status = 'active'" in upd[0], "guard")
check("pause audit", conn.cur.executed[11][1][1] == "sequence.enrollment_paused",
      conn.cur.executed[11][1])
check("audit names contact", "Ali" in str(conn.cur.executed[11][1]), "name")
check("commit", conn.committed, "commit")

conn = fresh([[{"contact_name": "Ali"}], []])
response = client.post("/api/v1/portal/sequences/5/enrollments/9/resume")
check("200 resume", response.status_code == 200, response.status_code)
upd = conn.cur.executed[10]
check("resume sql", "SET status = 'active'" in upd[0]
      and "AND status = 'paused'" in upd[0], "resume guard")
check("resume audit", conn.cur.executed[11][1][1] == "sequence.enrollment_resumed",
      conn.cur.executed[11][1])

PrincipalStub(portal_sequences, principal=None)
conn = fresh([[]])
response = client.post("/api/v1/portal/sequences/5/enrollments/9/pause")
check("401 unauth pause", response.status_code == 401, response.status_code)
PrincipalStub(portal_sequences, principal=human)

print("== bulk pause-all / resume-all ==")

conn = fresh([[]])
response = client.post("/api/v1/portal/sequences/5/enrollments/pause-all")
check("200 zero paused", response.get_json() == {"ok": True, "paused": 0},
      response.get_json())
check("no audit when zero", len(conn.cur.executed) == 11, len(conn.cur.executed))

conn = fresh([[{"id": 1}, {"id": 2}, {"id": 3}], []])
response = client.post("/api/v1/portal/sequences/5/enrollments/pause-all")
check("200 bulk paused", response.get_json() == {"ok": True, "paused": 3},
      response.get_json())
check("bulk scoped no id", "WHERE client_id = %s AND sequence_id = %s"
      in conn.cur.executed[10][0], conn.cur.executed[10][0][:80])
check("bulk audit", conn.cur.executed[11][1][1] == "sequence.enrollments_paused"
      and "3 enrollment" in str(conn.cur.executed[11][1]), conn.cur.executed[11][1])

conn = fresh([[{"id": 4}], []])
response = client.post("/api/v1/portal/sequences/5/enrollments/resume-all")
check("200 resumed", response.get_json() == {"ok": True, "resumed": 1},
      response.get_json())
check("resume-all filter", "AND status = 'paused'" in conn.cur.executed[10][0], "filter")

check("delivery skips paused", "e.status = 'active'" in
      SRC.split("def deliver_due_sequence_steps")[1][:900], "delivery")

print("== portal clients ==")

check("pause client", "export async function pauseSequenceEnrollment(" in PORTAL_TS, "fn")
check("resume client", "export async function resumeSequenceEnrollment(" in PORTAL_TS, "fn")
check("bulk clients", "export async function pauseAllEnrollments(" in PORTAL_TS
      and "export async function resumeAllEnrollments(" in PORTAL_TS, "bulk")
check("pause POST url", '"/pause"' in PORTAL_TS.split(
    "pauseSequenceEnrollment(")[1][:700], "url")
check("resume POST url", '"/resume"' in PORTAL_TS.split(
    "resumeSequenceEnrollment(")[1][:700], "url")
check("bulk urls", "/enrollments/pause-all" in PORTAL_TS
      and "/enrollments/resume-all" in PORTAL_TS, "bulk urls")
check("bulk count mapping", "count: typeof count === \"number\" ? count : 0" in PORTAL_TS,
      "count")
check("404 mapping", 'if (response.status === 404) return { kind: "not_found" };' in
      PORTAL_TS.split("pauseSequenceEnrollment(")[1][:700], "404")

print("== BFF routes ==")

check("single 9 ups", '"../../../../../../../../../lib/omniflow/portal"' in PAUSE, "depth")
check("bulk 8 ups", '"../../../../../../../../lib/omniflow/portal"' in PAUSE_ALL, "depth")
check("single params", "params: Promise<{ id: string; eid: string }>" in PAUSE, "params")
check("single forwards", "pauseSequenceEnrollment(accessToken, sequenceId, enrollmentId)"
      in PAUSE, "forward")
check("bulk forwards", "pauseAllEnrollments(accessToken, sequenceId)" in PAUSE_ALL,
      "forward")
check("bulk key", "paused: result.count" in PAUSE_ALL, "key")

print("== page ==")

check("pause button", 'void setEnrollmentState(row.id, enrollment.id, "pause")' in PAGE,
      "pause")
check("resume button", 'void setEnrollmentState(row.id, enrollment.id, "resume")' in PAGE,
      "resume")
check("paused status text", '"paused"' in PAGE, "status")
check("bulk buttons", 'void bulkEnrollments(row.id, "pause-all")' in PAGE
      and 'void bulkEnrollments(row.id, "resume-all")' in PAGE, "bulk")
check("refreshLog helper", "const refreshLog = useCallback" in PAGE, "helper")
check("cancel uses refreshLog", "void refreshLog(sequenceId);" in
      PAGE.split("const cancelEnrollment")[1][:600], "cancel fix")
check("refreshLog no toggle", PAGE.split("const refreshLog")[1][:400].find("setOpenLog") == -1,
      "no toggle")

summary("sequence_pause")
