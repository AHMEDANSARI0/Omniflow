"""196-200: sequence steps edit endpoint + portal edit/copy/templates."""
import os

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")

from flask import Flask

import portal_sequences, test_lib
from test_lib import check, human_principal, install_db_stub, summary, PrincipalStub

SRC = open("portal_sequences.py", encoding="utf8").read()
PORTAL_TS = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts", encoding="utf8").read()
BFF = open("/tmp/p13/Omniflow/app/api/omniflow/portal/sequences/[id]/steps/route.ts",
           encoding="utf8").read()
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

print("== PUT /sequences/<id>/steps ==")

conn = fresh([[]])
response = client.put("/api/v1/portal/sequences/9/steps", json={"steps": []})
check("404 unknown sequence", response.status_code == 404, response.status_code)

conn = fresh([[{"id": 7}], []])
response = client.put("/api/v1/portal/sequences/9/steps", json={"steps": []})
check("400 empty steps", response.status_code == 400, response.status_code)
check("rollback on invalid", conn.rolled_back, "rollback")

conn = fresh([[{"id": 7}], [], [], [], [], []])
response = client.put(
    "/api/v1/portal/sequences/9/steps",
    json={"steps": [{"delay_hours": 2, "body": "Hi {name}"}, {"body": "Bye"}]},
)
check("200 on valid edit", response.status_code == 200 and response.get_json() == {"ok": True},
      response.status_code)
check("delete fired", "DELETE FROM" in conn.cur.executed[11][0]
      and "portal_sequence_steps" in conn.cur.executed[11][0], conn.cur.executed[11][0][:40])
check("delete client-scoped", conn.cur.executed[11][1] == (1, 9), conn.cur.executed[11][1])
check("inserts replace steps", "INSERT INTO" in conn.cur.executed[12][0]
      and "INSERT INTO" in conn.cur.executed[13][0], "inserts")
check("step bodies carried", "Hi {name}" in str(conn.cur.executed[12][1])
      and "Bye" in str(conn.cur.executed[13][1]), "bodies")
check("commit on success", conn.committed and not conn.rolled_back, "commit")
check("audit steps_updated", conn.cur.executed[14][1][1] == "sequence.steps_updated",
      conn.cur.executed[14][1] if len(conn.cur.executed) > 9 else "missing")
check("audit counts steps", "2 step" in str(conn.cur.executed[14][1]), "count")

conn = fresh([[{"id": 7}], [], [], [], [], []])
response = client.put(
    "/api/v1/portal/sequences/9/steps",
    json={"steps": [{"delay_hours": 999, "body": "Nope"}]},
)
check("400 delay over 168h", response.status_code == 400, response.status_code)

PrincipalStub(portal_sequences, principal=None)
conn = fresh([[]])
response = client.put("/api/v1/portal/sequences/9/steps", json={"steps": [{"body": "x"}]})
check("401 unauth", response.status_code == 401, response.status_code)
PrincipalStub(portal_sequences, principal=human)

check("delivery adapts to edits", "step_no > %s" in SRC
      and "status = 'completed'" in SRC, "delivery law intact")
check("endpoint before delete", SRC.index("replace_sequence_steps")
      < SRC.index("def delete_sequence"), "order")

print("== portal clients ==")

check("client exists", "export async function updateSequenceSteps(" in PORTAL_TS, "fn")
check("client PUT + steps URL", 'method: "PUT"' in PORTAL_TS
      and '"/steps"' in PORTAL_TS.split("updateSequenceSteps(")[1][:800], "put")
check("client before deleteSequence", PORTAL_TS.index("updateSequenceSteps(")
      < PORTAL_TS.index("export async function deleteSequence("), "order")

print("== BFF route ==")

check("7 ups import", '"../../../../../../../lib/omniflow/portal"' in BFF, "depth")
check("PUT export", "export async function PUT(" in BFF, "put")
check("promise params", "params: Promise<{ id: string }>" in BFF, "params")
check("forwards via client", "updateSequenceSteps(accessToken, sequenceId, steps)" in BFF,
      "call")
check("drops blank steps", "step.body.trim().length > 0" in BFF, "filter")
check("empty steps 400", "At least one step with text is required." in BFF, "400")

print("== page ==")

check("Edit button", 'onClick={() => openEdit(row)}' in PAGE, "button")
check("edit states", "editOpenFor" in PAGE and "editDraft" in PAGE
      and "editBusy" in PAGE, "states")
check("save PUTs steps", '"/steps"' in PAGE.split("const saveEdit")[1][:1200]
      and '"PUT"' in PAGE.split("const saveEdit")[1][:1200], "put")
check("save as copy", "Save as copy" in PAGE
      and 'row.name + " copy"' in PAGE, "copy")
check("copy carries no keyword", "trigger_keyword" not in
      PAGE.split("const saveEdit")[1][:1200], "no keyword on copy")
check("edit validation note", "Fill every step's message." in PAGE, "note")
check("add step capped at 5", "editDraft.length < 5" in PAGE, "cap")
check("templates block", "Start from:" in PAGE and "applyTemplate" in PAGE, "chips")
check("4 templates", all(label in PAGE for label in
      ["Welcome flow", "Order follow-up", "Reorder nudge", "Review request"]), "labels")
check("reorder template pins keyword", 'keyword: "reorder"' in PAGE, "keyword")
check("template note", "Template loaded" in PAGE, "note")
check("edit safety hint", "continue with the new steps" in PAGE, "hint")

summary("sequence_edit")
