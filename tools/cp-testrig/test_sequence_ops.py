"""Tests for manual sequence enrollment + cancel (Phases 176-180)."""
import sys

from flask import Flask

import portal_sequences
import test_lib
from test_lib import (check, human_principal, install_db_stub, PrincipalStub,
                      status, summary)


app = Flask(__name__)
app.register_blueprint(portal_sequences.bp)
client = app.test_client()
human = human_principal(client_id=1, user_id=11, email="ahmed@example.com")
PrincipalStub(portal_sequences, principal=human)

DDL = [[], [], [], [], [], [], [], [], [], []]  # 4 CREATE + ALTER tk + settings + ALTER por + ALTER oii + step_log + idx


def fresh(script):
    portal_sequences._SEQ_DDL_READY = False
    conn = install_db_stub(portal_sequences, DDL + script)
    portal_sequences.portal_db.CMD_TABLE = "portal_connector_commands"
    return conn


print("== contact normalization ==")

nc = portal_sequences._normalize_contact
check("plus format", nc("+92 300 1234567") == "923001234567@c.us", nc("+92 300 1234567"))
check("dashes stripped", nc("92300-123-4567") == "923001234567@c.us", nc("92300-123-4567"))
check("jid kept", nc("923001234567@c.us") == "923001234567@c.us", nc("923001234567@c.us"))
check("bare digits", nc("923001234567") == "923001234567@c.us", nc("923001234567"))
check("empty is blank", nc("") == "" and nc(None) == "", "blank")
check("parens stripped", nc("(+92) 300 123") == "92300123@c.us", nc("(+92) 300 123"))

print("== manual enroll endpoint ==")

conn = fresh([[{"id": 5}],
              [{"contact_id": "923001234567@c.us"}, {"contact_id": "923004444444@c.us"}],
              []])
response = client.post("/api/v1/portal/sequences/5/enrollments",
                       json={"contacts": ["+92 300 1234567", "923004444444@c.us", "oops"]})
check("200 enroll", status(response) == 200, status(response))
check("enrolled count", response.get_json()["enrolled"] == 2, response.get_json())
check("skipped reported", response.get_json()["skipped"] == ["oops@c.us"],
      response.get_json())
check("insert uses conversation join", "ANY(%s)" in conn.cur.executed[11][0],
      conn.cur.executed[11][0][:60])
check("dedupe guarded", "NOT EXISTS" in conn.cur.executed[11][0], "not exists")
check("first step delay", "st.step_no = 1" in conn.cur.executed[11][0], "step 1")
check("audit logged", conn.cur.executed[12][1][1] == "sequence.enrolled_manually",
      conn.cur.executed[12][1])
check("enroll commits", conn.committed is True, conn.committed)

conn = fresh([[{"id": 5}], [{"contact_id": "923001234567@c.us"}], []])
response = client.post("/api/v1/portal/sequences/5/enrollments",
                       json={"contacts": ["923001234567", "923001234567"]})
check("duplicate input deduped", response.get_json()["enrolled"] == 1
      and response.get_json()["skipped"] == [], response.get_json())

response = client.post("/api/v1/portal/sequences/5/enrollments", json={"contacts": []})
check("400 no contacts", status(response) == 400, status(response))
response = client.post("/api/v1/portal/sequences/5/enrollments", json={"contacts": "x"})
check("400 bad type", status(response) == 400, status(response))

conn = fresh([[]])
response = client.post("/api/v1/portal/sequences/9/enrollments",
                       json={"contacts": ["923001234567"]})
check("404 foreign sequence", status(response) == 404, status(response))

print("== cancel endpoint ==")

conn = fresh([[{"id": 5}], [{"id": 3}], []])
response = client.delete("/api/v1/portal/sequences/5/enrollments/3")
check("200 cancel", status(response) == 200, status(response))
check("cancel sets status", "SET status = 'cancelled'" in conn.cur.executed[11][0],
      conn.cur.executed[11][0][:60])
check("cancel only active", "AND status = 'active'" in conn.cur.executed[11][0], "active")
check("cancel audit", conn.cur.executed[12][1][1] == "sequence.enrollment_cancelled",
      conn.cur.executed[12][1])

conn = fresh([[{"id": 5}], []])
response = client.delete("/api/v1/portal/sequences/5/enrollments/9")
check("404 unknown enrollment", status(response) == 404, status(response))

conn = fresh([[]])
response = client.delete("/api/v1/portal/sequences/8/enrollments/3")
check("404 foreign sequence", status(response) == 404, status(response))

print("== cancelled enrollments never deliver ==")

src = open("/tmp/p13/OmniFlow-Control-Plane/portal_sequences.py").read()
check("deliver filters active", "e.status = 'active'" in src, "active filter")
conn = fresh([[], []])
result = portal_sequences.deliver_due_sequence_steps(conn.cur, 1, conn)
check("empty due delivers none", result == 0, result)

print("== portal clients ==")

lib_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("enroll client", "export async function enrollSequenceContacts(" in lib_src, "client")
check("cancel client", "export async function cancelSequenceEnrollment(" in lib_src, "client")
check("enroll result type", 'kind: "ok"; enrolled: number; skipped: string[]' in lib_src, "type")
check("enroll posts contacts", "JSON.stringify({ contacts })" in lib_src, "body")

print("== bff routes ==")

enroll_bff = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/sequences/[id]/enrollments/route.ts"
).read()
check("bff post handler", "export async function POST(" in enroll_bff, "POST")
check("bff get kept", "export async function GET(" in enroll_bff, "GET")
check("bff depth", "../../../../../../../lib/omniflow/control-plane" in enroll_bff, "7 ups")
check("bff caps 50", ".slice(0, 50)" in enroll_bff, "cap")

cancel_bff = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/sequences/[id]/enrollments/[eid]/route.ts"
).read()
check("cancel bff delete", "export async function DELETE(" in cancel_bff, "DELETE")
check("cancel bff depth", "../../../../../../../../lib/omniflow/portal" in cancel_bff, "8 ups")
check("cancel bff 404", 'code: "not_found"' in cancel_bff, "404")

print("== sequences page ==")

page_src = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/sequences/page.tsx"
).read()
check("add people button", "Add people" in page_src, "button")
check("dialog textarea", "One number per line" in page_src, "dialog")
check("submit posts enroll", "/enrollments" in page_src and 'method: "POST"' in page_src, "submit")
check("cancel button in log", "cancelEnrollment(row.id, enrollment.id)" in page_src, "cancel")
check("skipped note shown", "skipped (no chat yet)" in page_src, "note")
check("done enrollments keep no cancel",
      'enrollment.status === "active" ? (' in page_src, "active only")

summary("sequence_ops")
