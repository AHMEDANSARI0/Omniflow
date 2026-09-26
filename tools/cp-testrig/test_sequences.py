"""Tests for auto-sequences (Phases 156-160)."""
import sys

from flask import Flask

import connector_api
import portal_sequences
import test_lib
from test_lib import check, human_principal, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_sequences.bp)
app.register_blueprint(connector_api.bp)
client = app.test_client()

human = human_principal(client_id=1, user_id=11, email="ahmed@example.com")
PrincipalStub(portal_sequences, principal=human)

DDL = [[], [], [], [], [], [], [], [], [], []]  # 4 CREATE + ALTER tk + settings + ALTER por + ALTER oii + step_log + idx


def fresh(script):
    portal_sequences._SEQ_DDL_READY = False
    conn = install_db_stub(portal_sequences, DDL + script)
    portal_sequences.portal_db.CMD_TABLE = "portal_connector_commands"
    return conn


print("== validation ==")

conn = fresh([])
cur = conn.cur
cur._script = [[{"id": 1}]] * 6
count = portal_sequences._parse_steps(
    [{"delay_hours": 0, "body": "Welcome {name}!"}, {"delay_hours": 24, "body": "How is it?"}],
    1, 1, cur,
)
check("valid steps count", count == 2, count)
check("steps inserted", any("INSERT INTO" in e[0] and "portal_sequence_steps" in e[0]
                            for e in cur.executed))
check("reject empty body", portal_sequences._parse_steps([{"delay_hours": 1, "body": ""}], 1, 1, cur) is None)
check("reject bad delay", portal_sequences._parse_steps([{"delay_hours": 999, "body": "x"}], 1, 1, cur) is None)
check("reject too many", portal_sequences._parse_steps([{"body": "x"}] * 6, 1, 1, cur) is None)

print("== CRUD ==")

SEQ_ROW = {"id": 5, "name": "Welcome", "enabled": True, "created_at": None}
conn = fresh([[SEQ_ROW], [{"step_no": 1, "delay_hours": 0, "body": "Hi!", "only_if_idle_hours": None}],
             [{"total": 3}], [{"total": 1}]])
response = client.get("/api/v1/portal/sequences")
check("200 list", status(response) == 200
      and response.get_json()["sequences"][0]["id"] == 5, status(response))
check("steps + counts mapped", response.get_json()["sequences"][0]["steps"][0]["body"] == "Hi!"
      and response.get_json()["sequences"][0]["active_enrollments"] == 3,
      response.get_json()["sequences"][0])
check("completed mapped", response.get_json()["sequences"][0]["completed_enrollments"] == 1,
      response.get_json()["sequences"][0])

conn = fresh([[{"id": 5, "name": "Welcome", "enabled": False, "created_at": None}], [], []])
response = client.post("/api/v1/portal/sequences",
                       json={"name": "Welcome", "steps": [{"delay_hours": 0, "body": "Hi {name}"}]})
check("200 create", status(response) == 200, status(response))
check("create audit", conn.cur.executed[12][1][1] == "sequence.created", conn.cur.executed[12][1])

conn = fresh([[], []])
response = client.post("/api/v1/portal/sequences", json={"name": "X", "steps": []})
check("400 no steps", status(response) == 400, status(response))

conn = fresh([[{"id": 5}]])
response = client.put("/api/v1/portal/sequences/5", json={"enabled": False})
check("200 update", status(response) == 200, status(response))

conn = fresh([[]])
response = client.put("/api/v1/portal/sequences/99", json={"enabled": True})
check("404 update unknown", status(response) == 404, status(response))

conn = fresh([[], [], [{"id": 5}]])
response = client.delete("/api/v1/portal/sequences/5")
check("200 delete", status(response) == 200, status(response))

conn = fresh([[{"1": 1}], []])
response = client.get("/api/v1/portal/sequences/5/enrollments")
check("200 enrollments", status(response) == 200
      and response.get_json()["enrollments"] == [], status(response))

conn = fresh([[]])
response = client.get("/api/v1/portal/sequences/77/enrollments")
check("404 foreign sequence", status(response) == 404, status(response))

print("== enrollment hook ==")

ENROLLED = [{"id": 8, "sequence_id": 5}]
portal_sequences._SEQ_DDL_READY = True
conn = install_db_stub(portal_sequences,
    [[{"id": 5, "enabled": True, "created_at": None}], [], [{"id": 8}], []])
portal_sequences.portal_db.CMD_TABLE = "portal_connector_commands"
portal_sequences.maybe_enroll_new_contact(1, 9, "92300@c.us", "Ali", conn)
inserts = [e for e in conn.cur.executed if "INSERT INTO" in e[0]
           and "portal_sequence_enrollments" in e[0]]
check("enroll insert fired", len(inserts) == 1, len(inserts))
check("new-contact guard in sql", "m WHERE m.conversation_id = %s) <= 1" in inserts[0][0])
check("enroll audit", any(e[1] and e[1][1] == "sequence.enrolled" for e in conn.cur.executed))

print("== delivery ==")

DUE = [{"id": 8, "sequence_id": 5, "current_step": 0, "conversation_id": 42,
        "contact_id": "92300@c.us", "contact_name": "Ali Khan"}]
conn = fresh([DUE, [{"step_no": 1, "delay_hours": 2, "body": "Welcome {name}!", "only_if_idle_hours": None},
                      {"step_no": 2, "delay_hours": 24, "body": "Bye", "only_if_idle_hours": None}], [], [], []])
result = portal_sequences.deliver_due_sequence_steps(conn.cur, 1, conn)
check("sent one", result == 1, result)
cmds = [e for e in conn.cur.executed if "INSERT INTO" in e[0]
        and "portal_connector_commands" in e[0]]
check("command queued", len(cmds) == 1, len(cmds))
import json as _json
payload = cmds[0][1][2]
if isinstance(payload, str):
    payload = _json.loads(payload)
check("personalized", payload.get("body") == "Welcome Ali!", payload)
check("source sequence", payload.get("source") == "sequence", payload)
update = [e for e in conn.cur.executed if "UPDATE" in e[0]][0]
check("advanced + next delay", "next_at = NOW() + make_interval(hours => %s)" in update[0]
      and update[1][0] == 1 and update[1][1] == 24, update[1])
check("committed", conn.committed is True)

LAST = [{"id": 8, "sequence_id": 5, "current_step": 1, "conversation_id": 42,
         "contact_id": "92300@c.us", "contact_name": "Ali"}]
conn = fresh([LAST, [{"step_no": 2, "delay_hours": 24, "body": "Bye", "only_if_idle_hours": None}], [], [], []])
result = portal_sequences.deliver_due_sequence_steps(conn.cur, 1, conn)
check("final step completes", result == 1, result)
update = [e for e in conn.cur.executed if "UPDATE" in e[0]][0]
check("status completed", "status = 'completed'" in update[0], update[0])

conn = fresh([[{"id": 8, "sequence_id": 5, "current_step": 5,
                "contact_id": "92300@c.us", "contact_name": "Ali"}], []])
result = portal_sequences.deliver_due_sequence_steps(conn.cur, 1, conn)
check("no steps -> completed without send", result == 0, result)

conn = fresh([[]])
result = portal_sequences.deliver_due_sequence_steps(conn.cur, 1, conn)
check("empty due quiet", result == 0, result)

print("== structural ==")
app_src = open("/tmp/p13/OmniFlow-Control-Plane/app.py").read()
check("app registers sequences", "register_blueprint(portal_sequences_bp)" in app_src)
conn_src = open("/tmp/p13/OmniFlow-Control-Plane/connector_api.py").read()
check("top import present", "\nimport portal_sequences\n" in conn_src)
check("ingest hook last", conn_src.index("maybe_enroll_new_contact(") > conn_src.index("maybe_cod_flow("))
check("poll hook last", conn_src.index("deliver_due_sequence_steps(") > conn_src.index("deliver_pending_webhooks("))
module_src = open("/tmp/p13/OmniFlow-Control-Plane/portal_sequences.py").read()
check("unique enrollment constraint", "uq_sequence_enrollment" in module_src)
check("new contact rule", ") <= 1" in module_src)
lib_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("lib clients", "export async function listSequences(" in lib_src
      and "export async function deleteSequence(" in lib_src)
bff1 = open("/tmp/p13/Omniflow/app/api/omniflow/portal/sequences/route.ts").read()
bff2 = open("/tmp/p13/Omniflow/app/api/omniflow/portal/sequences/[id]/route.ts").read()
bff3 = open("/tmp/p13/Omniflow/app/api/omniflow/portal/sequences/[id]/enrollments/route.ts").read()
check("bff depths", bff1.count("../") == 15 and bff2.count("../") == 18
      and bff3.count("../") == 21, (bff1.count("../"), bff2.count("../"), bff3.count("../")))
page_src = open("/tmp/p13/Omniflow/app/dashboard/(portal)/sequences/page.tsx").read()
check("page step builder", "Add step" in page_src and "168" in page_src)
check("page people log", "People" in page_src)
nav_src = open("/tmp/p13/Omniflow/app/dashboard/components/DashSidebar.tsx").read()
check("nav item", 'href: "/dashboard/sequences"' in nav_src)

failures = summary("sequences")
sys.exit(1 if failures else 0)
