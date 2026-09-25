"""221-235 Sequences Pro part 1: reply-aware auto-pause."""
import os

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")

from flask import Flask

import portal_sequences, test_lib
from test_lib import check, human_principal, install_db_stub, summary, PrincipalStub

SRC = open("portal_sequences.py", encoding="utf8").read()
CONN = open("connector_api.py", encoding="utf8").read()

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

print("== maybe_auto_pause_replies ==")

portal_sequences._SEQ_DDL_READY = True
conn = install_db_stub(portal_sequences, [[{"id": 1}, {"id": 2}], []])
count = portal_sequences.maybe_auto_pause_replies(1, 77, conn)
check("returns paused count", count == 2, count)
upd = conn.cur.executed[0]
check("update with from join", "UPDATE" in upd[0] and " FROM " in upd[0], upd[0][:60])
check("conversation scoped", "e.conversation_id = %s" in upd[0], "scope")
check("only active", "e.status = 'active'" in upd[0], "active")
check("two-minute grace", "e.enrolled_at < NOW() - interval '2 minutes'" in upd[0],
      "grace")
check("needs enabled series", "s.enabled IS TRUE" in upd[0], "enabled")
check("needs pause_on_reply", "s.pause_on_reply IS TRUE" in upd[0], "flag")
check("params conv", upd[1] == (1, 77), upd[1])
check("audit logged", conn.cur.executed[1][1][1] == "sequence.auto_paused",
      conn.cur.executed[1][1])
check("system actor", conn.cur.executed[1][1][2] == "system", "actor")
check("conversation in audit", conn.cur.executed[1][1][4] == 77, "conv")
check("committed", conn.committed, "commit")

conn = install_db_stub(portal_sequences, [[]])
count = portal_sequences.maybe_auto_pause_replies(1, 77, conn)
check("zero rows no-op", count == 0, count)
check("no audit when zero", len(conn.cur.executed) == 1, len(conn.cur.executed))
check("no commit when zero", not conn.committed, "commit")

print("== pause_on_reply endpoint ==")

conn = fresh([[{"id": 5, "name": "W", "enabled": False, "created_at": None,
                "trigger_keyword": None}], []])
response = client.put("/api/v1/portal/sequences/5",
                      json={"pause_on_reply": False})
check("200 toggle off", response.status_code == 200, response.status_code)
upd = conn.cur.executed[10]
check("update carries flag", "pause_on_reply = %s" in upd[0], upd[0][:60])
check("flag param false", upd[1][0] is False, upd[1])

conn = fresh([[]])
response = client.put("/api/v1/portal/sequences/5",
                      json={"pause_on_reply": "yes"})
check("400 non-bool", response.status_code == 400, response.status_code)

print("== list exposes flag + keyword columns ==")

check("list select fixed", "trigger_keyword, pause_on_reply FROM" in SRC
      if "trigger_keyword, pause_on_reply FROM" in SRC else
      "trigger_keyword,\n                    pause_on_reply" in SRC
      or ('created_at, trigger_keyword' in SRC), "select")
check("public exposes flag", '"pause_on_reply": row.get("pause_on_reply") is not False' in SRC,
      "public")

print("== connector hook ==")

check("hook call present", "maybe_auto_pause_replies(" in CONN, "call")
check("after keyword hook", CONN.index("maybe_enroll_keyword(")
      < CONN.index("maybe_auto_pause_replies("), "order")
seg = CONN.split("maybe_auto_pause_replies(")[1][:200]
check("hook gets conn", "conn," in seg, "args")

summary("auto_pause")
