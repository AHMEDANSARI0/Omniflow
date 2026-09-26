"""221-235 Sequences Pro part 2: per-step only-if-idle conditions + step log + stats."""
import os

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")

from flask import Flask

import portal_sequences, test_lib
from test_lib import check, human_principal, install_db_stub, summary, PrincipalStub

SRC = open("portal_sequences.py", encoding="utf8").read()

DDL = [[], [], [], [], [], [], [], [], [], []]


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

print("== step validation (only_if_idle_hours) ==")

conn = fresh([[{"id": 5, "name": "W", "enabled": False, "created_at": None,
                "trigger_keyword": None}], [], [], []])
response = client.post("/api/v1/portal/sequences", json={
    "name": "W",
    "steps": [
        {"delay_hours": 0, "body": "Hi", "only_if_idle_hours": 24},
        {"delay_hours": 24, "body": "Again"},
    ],
})
check("200 with condition", response.status_code == 200, response.status_code)
inserts = [e for e in conn.cur.executed if "portal_sequence_steps" in e[0]
           and "INSERT INTO" in e[0]]
check("both steps inserted", len(inserts) == 2, len(inserts))
check("insert carries idle", "only_if_idle_hours" in inserts[0][0], "col")
check("idle value kept", inserts[0][1][5] == 24, inserts[0][1])
check("missing idle is null", inserts[1][1][5] is None, inserts[1][1])

conn = fresh([[]])
response = client.post("/api/v1/portal/sequences", json={
    "name": "W", "steps": [{"delay_hours": 0, "body": "Hi", "only_if_idle_hours": 0}]})
check("400 idle 0", response.status_code == 400, response.status_code)
conn = fresh([[]])
response = client.post("/api/v1/portal/sequences", json={
    "name": "W", "steps": [{"delay_hours": 0, "body": "Hi", "only_if_idle_hours": 169}]})
check("400 idle 169", response.status_code == 400, response.status_code)
conn = fresh([[]])
response = client.post("/api/v1/portal/sequences", json={
    "name": "W", "steps": [{"delay_hours": 0, "body": "Hi", "only_if_idle_hours": "abc"}]})
check("400 idle junk", response.status_code == 400, response.status_code)

print("== delivery: idle skip ==")

DUE = [{"id": 8, "sequence_id": 5, "current_step": 0, "conversation_id": 42,
        "contact_id": "92300@c.us", "contact_name": "Ali"}]
portal_sequences._SEQ_DDL_READY = True
conn = install_db_stub(portal_sequences, [DUE,
    [{"step_no": 1, "delay_hours": 2, "body": "Welcome!", "only_if_idle_hours": 24},
     {"step_no": 2, "delay_hours": 24, "body": "Bye", "only_if_idle_hours": None}],
    [{"id": 1}], [], []])
portal_sequences.portal_db.CMD_TABLE = "portal_connector_commands"
result = portal_sequences.deliver_due_sequence_steps(conn.cur, 1, conn)
check("skip does not count as sent", result == 0, result)
check("idle check ran", "portal_messages" in conn.cur.executed[2][0]
      and "direction = 'in'" in conn.cur.executed[2][0],
      conn.cur.executed[2][0][:70])
check("idle window param", conn.cur.executed[2][1][2] == 24, conn.cur.executed[2][1])
check("conversation param", conn.cur.executed[2][1][1] == 42, conn.cur.executed[2][1])
cmds = [e for e in conn.cur.executed if "portal_connector_commands" in e[0]]
check("no command queued", len(cmds) == 0, len(cmds))
logs = [e for e in conn.cur.executed if "portal_sequence_step_log" in e[0]]
check("skip logged", len(logs) == 1 and logs[0][1][4] == "skipped", logs)
check("step advanced anyway", any("UPDATE" in e[0] for e in conn.cur.executed), "adv")
check("commit on skip", conn.committed, "commit")

print("== delivery: normal send logs 'sent' ==")

conn = install_db_stub(portal_sequences, [DUE,
    [{"step_no": 1, "delay_hours": 2, "body": "Welcome!", "only_if_idle_hours": None},
     {"step_no": 2, "delay_hours": 24, "body": "Bye", "only_if_idle_hours": None}],
    [], [], []])
portal_sequences.portal_db.CMD_TABLE = "portal_connector_commands"
result = portal_sequences.deliver_due_sequence_steps(conn.cur, 1, conn)
check("sent one", result == 1, result)
cmds = [e for e in conn.cur.executed if "portal_connector_commands" in e[0]]
check("command queued", len(cmds) == 1, len(cmds))
logs = [e for e in conn.cur.executed if "portal_sequence_step_log" in e[0]]
check("sent logged", len(logs) == 1 and logs[0][1][4] == "sent", logs)
check("log params", logs[0][1][:4] == (1, 5, 8, 1), logs[0][1])
check("no idle query", not any("portal_messages" in e[0] for e in conn.cur.executed),
      "no msgs")

print("== stats endpoint ==")

conn = fresh([[]])
response = client.get("/api/v1/portal/sequences/5/stats")
check("404 unknown", response.status_code == 404, response.status_code)

conn = fresh([[{"id": 5}],
              [{"step_no": 1, "sent": 9, "skipped": 3},
               {"step_no": 2, "sent": 4, "skipped": 0}]])
response = client.get("/api/v1/portal/sequences/5/stats")
payload = response.get_json()
check("200 stats", response.status_code == 200, response.status_code)
check("funnel shape", payload["steps"][0] == {"step_no": 1, "sent": 9, "skipped": 3},
      payload)
check("filter counts sql", "COUNT(*) FILTER (WHERE action = 'sent')" in SRC
      and "COUNT(*) FILTER (WHERE action = 'skipped')" in SRC, "filter")
check("stats scoped", "client_id = %s AND sequence_id = %s" in
      SRC.split("def sequence_stats")[1][:1200], "scope")

check("step log ddl", "portal_sequence_step_log" in
      SRC.split("STEP_LOG_TABLE = ")[1][:1200], "ddl")
check("idx on log", "idx_sequence_step_log" in SRC, "idx")

summary("step_conditions")
