"""216-220: "Add to series" from the conversation thread (website-only; reuses the
existing enrollments POST endpoint)."""
import os

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")

from flask import Flask

import portal_sequences, test_lib
from test_lib import check, human_principal, install_db_stub, summary, PrincipalStub

PAGE = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/conversations/[id]/AddToSequenceCard.tsx",
    encoding="utf8",
).read()
THREAD = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/conversations/[id]/ThreadClient.tsx",
    encoding="utf8",
).read()
BFF = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/sequences/[id]/enrollments/route.ts",
    encoding="utf8",
).read()
SRC = open("portal_sequences.py", encoding="utf8").read()

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

print("== reused enroll endpoint contract ==")

conn = fresh([[{"contact_name": "Ali", "contact_id": "92300@c.us"}],
              [{"contact_id": "92300@c.us"}], []])
response = client.post(
    "/api/v1/portal/sequences/5/enrollments",
    json={"contacts": ["92300@c.us"]},
)
check("single jid enrolls", response.status_code == 200
      and response.get_json().get("enrolled") == 1, response.get_json())
insert = next(e for e in conn.cur.executed
              if "INSERT INTO" in e[0] and "portal_sequence_enrollments" in e[0])
check("name rides conv join", "c.contact_name" in insert[0], "join")
check("jid carried", insert[1][4] == ["92300@c.us"], insert[1])
check("dedupe protected", "NOT EXISTS" in insert[0], "dedupe")

conn = fresh([[]])
response = client.post("/api/v1/portal/sequences/5/enrollments",
                       json={"contacts": ["92300@c.us"]})
check("404 unknown sequence", response.status_code == 404, response.status_code)

conn = fresh([[{"id": 5}]])
response = client.post("/api/v1/portal/sequences/5/enrollments",
                       json={"contacts": []})
check("400 no contacts", response.status_code == 400, response.status_code)

print("== card component ==")

check("client component", PAGE.startswith('"use client"'), "header")
check("props", "{ contactId }: { contactId: string | null }" in PAGE, "props")
check("loads sequences", '"/api/omniflow/portal/sequences"' in PAGE, "fetch")
check("enabled filter", "row.enabled === true" in PAGE, "filter")
check("hidden when none", "options.length === 0) return null" in PAGE, "hidden")
check("enrolls via BFF", "/enrollments" in PAGE and "method: \"POST\"" in PAGE, "post")
check("sends bare jid", "contacts: [contactId]" in PAGE, "body")
check("duplicate note", "Already in a series" in PAGE, "note")
check("success note", "Step 1 lands per the series' first delay." in PAGE, "success")
check("disabled hint", "is the series turned on?" in PAGE, "400 note")
check("busy label", "Adding..." in PAGE, "busy")
check("alive guard", "let alive = true" in PAGE, "stale guard")

print("== thread integration ==")

check("dynamic import", 'dynamic(() => import("./AddToSequenceCard"))' in THREAD, "import")
check("rendered after CustomerCard", THREAD.index("<CustomerCard")
      < THREAD.index("<AddToSequenceCard"), "order")
check("guarded like siblings", "!expired && !notFound && (\n        <AddToSequenceCard" in
      THREAD, "guard")
check("passes contact id", "contactId={conversation?.contactId ?? null}" in
      THREAD, "props")

print("== BFF passthrough intact ==")

check("enrollments POST exists", "export async function POST(" in BFF, "post")
check("forwards cleaned", "enrollSequenceContacts(accessToken, sequenceId, cleaned)" in
      BFF, "forward")

summary("add_to_series")
