"""Tests for keyword-triggered sequences (Phases 191-195)."""
import sys

from flask import Flask

import connector_api
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


print("== keyword normalization ==")

nk = portal_sequences._normalize_keyword
check("upper to lower", nk("  CATALOG ") == "catalog", nk("  CATALOG "))
check("spaces collapse", nk("Get   Offer") == "get offer", nk("Get   Offer"))
check("blank is none", nk("") is None and nk(None) is None, "blank")
check("capped at 32", len(nk("x" * 40)) == 32, "cap")

print("== create + update with keyword ==")

conn = fresh([[{"id": 5, "name": "W", "enabled": False, "created_at": None,
                "trigger_keyword": "catalog"}],
              [{"step_no": 1, "delay_hours": 0, "body": "Hi"}], [], []])
response = client.post("/api/v1/portal/sequences", json={
    "name": "W", "steps": [{"delay_hours": 0, "body": "Hi {name}"}],
    "trigger_keyword": "  CATALOG "})
check("200 create with keyword", status(response) == 200, status(response))
alter = [e[0] for e in conn.cur.executed if "ALTER TABLE" in e[0]]
check("lazy alter fired", len(alter) == 3, alter)
check("add column if not exists", bool(alter)
      and "ADD COLUMN IF NOT EXISTS" in alter[0], "idempotent")
check("insert carries keyword", "trigger_keyword" in conn.cur.executed[10][0]
      and "catalog" in str(conn.cur.executed[10][1]), "insert")

conn = fresh([[{"id": 5, "name": "W", "enabled": False, "created_at": None,
                "trigger_keyword": None}], []])
response = client.put("/api/v1/portal/sequences/5",
                      json={"trigger_keyword": "  OFFER "})
check("200 update keyword", status(response) == 200, status(response))
check("update sets keyword", "trigger_keyword = %s" in conn.cur.executed[10][0]
      and "offer" in str(conn.cur.executed[10][1]), conn.cur.executed[10][1])

conn = fresh([[{"id": 5, "name": "W", "enabled": False, "created_at": None,
                "trigger_keyword": "offer"}], [], []])
response = client.put("/api/v1/portal/sequences/5",
                      json={"trigger_keyword": ""})
check("200 clear keyword", status(response) == 200, status(response))
check("clear writes null", "trigger_keyword = %s" in conn.cur.executed[10][0]
      and conn.cur.executed[10][1][0] is None, conn.cur.executed[10][1])

print("== keyword hook ==")

portal_sequences._SEQ_DDL_READY = True
conn = install_db_stub(portal_sequences, [[{"id": 8}], []])
portal_sequences.portal_db.CMD_TABLE = "portal_connector_commands"
portal_sequences.maybe_enroll_keyword(
    1, 9, "92300@c.us", "Ali", "  CATALOG ", conn)
check("insert fired", "INSERT INTO" in conn.cur.executed[0][0]
      and "portal_sequence_enrollments" in conn.cur.executed[0][0], "insert")
check("matches keyword column", "s.trigger_keyword = %s" in conn.cur.executed[0][0],
      "match")
check("no message-count guard", "COUNT(*)" not in conn.cur.executed[0][0], "any age")
check("dedupe guarded", "NOT EXISTS" in conn.cur.executed[0][0], "not exists")
check("step 1 delay", "st.step_no = 1" in conn.cur.executed[0][0], "step 1")
check("keyword audit", conn.cur.executed[1][1][1] == "sequence.enrolled_keyword",
      conn.cur.executed[1][1])
check("audit names keyword", "catalog" in str(conn.cur.executed[1][1]), "name")

conn = fresh([[], [], [], [], [], []])
portal_sequences.maybe_enroll_keyword(1, 9, "92300@c.us", "Ali", "   ", conn)
check("blank body no-op", not any(
    "INSERT INTO" in e[0] and "portal_sequence_enrollments" in e[0]
    for e in conn.cur.executed), "no insert")

print("== connector hook ==")

conn_src = open("/tmp/p13/OmniFlow-Control-Plane/connector_api.py").read()
check("connector calls hook", "portal_sequences.maybe_enroll_keyword(" in conn_src,
      "call")
check("hook after new-contact", conn_src.index("maybe_enroll_new_contact(")
      < conn_src.index("maybe_enroll_keyword("), "order")
check("hook gets body", 'item["body"]' in conn_src.split("maybe_enroll_keyword(")[1][:400],
      "body arg")

print("== portal clients ==")

lib_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("row type", "triggerKeyword: string | null;" in lib_src, "type")
check("list maps keyword", 'typeof row.trigger_keyword === "string"' in lib_src, "map")
check("create accepts keyword", "triggerKeyword?: string | null" in lib_src, "create")
check("create sends snake", "trigger_keyword: triggerKeyword" in lib_src, "wire")
check("update sends snake", "wire.trigger_keyword = changes.triggerKeyword ?? null" in lib_src, "wire")

print("== sequences page ==")

page_src = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/sequences/page.tsx"
).read()
check("create keyword input", "Trigger keyword (optional), e.g. CATALOG" in page_src,
      "input")
check("keyword chip", "row.triggerKeyword ? (" in page_src, "chip")
check("trigger button", "Trigger" in page_src and "openTrigger(row)" in page_src, "button")
check("trigger dialog", "Keyword trigger for" in page_src, "dialog")
check("save puts triggerKeyword", "triggerKeyword: triggerDraft.trim()" in page_src, "put")
check("clear hint", "Leave empty to turn the trigger off." in page_src, "hint")
check("keyword state seeded", "const [keyword, setKeyword] = useState" in page_src, "state")

summary("keyword_triggers")
