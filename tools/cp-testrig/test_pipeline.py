"""266-280 part 1: CRM pipeline - board columns, stage moves, segments stage filter."""
import os

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")

from flask import Flask

import portal_pipeline, portal_segments, test_lib
from test_lib import check, human_principal, install_db_stub, summary, PrincipalStub

SRC = open("portal_pipeline.py", encoding="utf8").read()
SEG_SRC = open("portal_segments.py", encoding="utf8").read()

ROWS_A = [
    {"stage": "new", "contact_id": "92300a", "name": "Ali",
     "lead_temp": "hot", "chats": 3, "last_at": None},
    {"stage": "won", "contact_id": "92300b", "name": "Sara",
     "lead_temp": "warm", "chats": 1, "last_at": None},
    {"stage": "bogus", "contact_id": "92300c", "name": "Bad",
     "lead_temp": "cold", "chats": 1, "last_at": None},
]


def fresh(script, client_id=1):
    portal_pipeline._PIPE_DDL_READY = False
    conn = install_db_stub(portal_pipeline, script, client_id=client_id)
    return conn


app = Flask(__name__)
app.register_blueprint(portal_pipeline.bp)
client = app.test_client()
human = human_principal(client_id=1, user_id=11, email="ahmed@example.com")
PrincipalStub(portal_pipeline, principal=human)

print("== module pins ==")

check("VALID_STAGE tuple",
      '("new", "interested", "negotiating", "won", "lost")' in SRC, "stages")
check("DDL unique pair", "UNIQUE (client_id, contact_id)" in SRC, "unique")
check("board coalesce", "COALESCE(s.stage, 'new')" in SRC, "coalesce")
check("board left join", "LEFT JOIN" in SRC, "join")
check("board group by contact", "GROUP BY c.contact_id" in SRC, "group")
check("board limit param", "LIMIT %s" in SRC, "limit")
check("board limit 400", "BOARD_LIMIT = 400" in SRC, "400")
check("column cap 50", "COLUMN_CAP = 50" in SRC, "50")
check("cap guard", "len(columns[stage]) < COLUMN_CAP" in SRC, "cap")
check("upsert conflict", "ON CONFLICT (client_id, contact_id)" in SRC, "upsert")
check("upsert update", "DO UPDATE SET stage = EXCLUDED.stage" in SRC, "upd")
check("new deletes row", "DELETE FROM" in SRC, "delete")
check("audit action", '"pipeline.stage_changed"' in SRC, "audit")
check("human guard", "ensure_human_principal(principal)" in SRC, "human")
check("contact cap", "MAX_CONTACT = 100" in SRC, "cap100")

print("== board ==")

conn = fresh([[], ROWS_A])
response = client.get("/api/v1/portal/pipeline")
check("board 200", response.status_code == 200, response.status_code)
stages = (response.get_json() or {}).get("stages") or []
check("five columns",
      [c.get("stage") for c in stages] ==
      ["new", "interested", "negotiating", "won", "lost"], "order")
by_stage = {c["stage"]: c for c in stages}
check("counts new", by_stage["new"]["count"] == 2, by_stage["new"]["count"])
check("bogus counts as new", by_stage["new"]["count"] == 2, "fallback")
check("won has sara",
      by_stage["won"]["contacts"][0]["contact_id"] == "92300b", "sara")
check("contact fields",
      by_stage["won"]["contacts"][0]["chats"] == 1 and
      by_stage["won"]["contacts"][0]["lead_temp"] == "warm", "fields")
check("empty column count",
      by_stage["interested"]["count"] == 0 and
      by_stage["interested"]["contacts"] == [], "empty")
board_sql = conn.cur.executed[1][0] if len(conn.cur.executed) > 1 else ""
check("board scoped", "c.client_id = %s" in board_sql, "scope")

print("== stage moves ==")

conn = fresh([[], [], []])
response = client.post("/api/v1/portal/pipeline/stage",
                       json={"contact": "92300a", "stage": "negotiating"})
check("move 200", response.status_code == 200, response.status_code)
check("move payload", response.get_json().get("ok") is True, "ok")
upsert_sql = conn.cur.executed[1][0]
check("upsert used", "ON CONFLICT" in upsert_sql, "sql")
audit_sql, audit_params = conn.cur.executed[2]
check("audit written", audit_params[1] == "pipeline.stage_changed", "audit")
check("audit note has stage",
      "negotiating" in str(audit_params[5]), "note")
check("commit", conn.committed is True, "commit")

conn = fresh([[], [], []])
response = client.post("/api/v1/portal/pipeline/stage",
                       json={"contact": "92300a", "stage": "new"})
check("back to new 200", response.status_code == 200, response.status_code)
check("delete used", "DELETE FROM" in conn.cur.executed[1][0], "sql")

conn = fresh([])
response = client.post("/api/v1/portal/pipeline/stage",
                       json={"contact": "92300a", "stage": "rich"})
check("400 unknown stage", response.status_code == 400, response.status_code)

conn = fresh([])
response = client.post("/api/v1/portal/pipeline/stage",
                       json={"contact": "  ", "stage": "won"})
check("400 blank contact", response.status_code == 400, response.status_code)

conn = fresh([])
response = client.post("/api/v1/portal/pipeline/stage",
                       json={"contact": "92300a"})
check("400 missing stage", response.status_code == 400, response.status_code)

conn = fresh([[], [], []])
response = client.post("/api/v1/portal/pipeline/stage",
                       json={"contact": "92x" * 40, "stage": "won"})
check("long contact trimmed", response.status_code == 200, response.status_code)
check("contact capped",
      len(str(conn.cur.executed[1][1][1])) <= 100, "cap")

print("== scoping + auth ==")

p7 = human_principal(client_id=7, user_id=11, email="z@example.com")
PrincipalStub(portal_pipeline, principal=p7)
conn = fresh([[], [], []])
response = client.post("/api/v1/portal/pipeline/stage",
                       json={"contact": "92300a", "stage": "won"})
check("client 7 used", conn.cur.executed[1][1][0] == 7, "scope")
PrincipalStub(portal_pipeline, principal=human)

PrincipalStub(portal_pipeline, principal=None)
conn = fresh([])
check("board 401",
      client.get("/api/v1/portal/pipeline").status_code == 401, "401")
check("move 401",
      client.post("/api/v1/portal/pipeline/stage",
                  json={"contact": "92300a", "stage": "won"}).status_code == 401,
      "401")
PrincipalStub(portal_pipeline, principal=human)

conn = fresh([Exception("boom")])
check("board 503",
      client.get("/api/v1/portal/pipeline").status_code == 503, "503")

print("== segments stage filter ==")

check("segments imports pipeline", "import portal_pipeline" in SEG_SRC, "import")
check("segments validates stage",
      "value not in portal_pipeline.VALID_STAGE" in SEG_SRC, "validate")
check("segments probe", 'cur.execute("SELECT to_regclass(%s)"' in SEG_SRC, "probe")
check("segments join", "LEFT JOIN" in SEG_SRC, "join")
check("segments coalesce", "AND COALESCE(s.stage, 'new') = %s" in SEG_SRC, "where")

portal_segments._SEG_DDL_READY = True
seg_conn = install_db_stub(portal_segments, [
    [{"to_regclass": "portal_contact_stage"}],
    [{"contact_id": "92300a", "name": "Ali", "last_at": None, "chats": 2}],
])
seg_cur = seg_conn.cur
from portal_segments import _member_rows
rows = _member_rows(seg_cur, 1, {"stage": "won"}, 50)
check("stage members 1", len(rows) == 1, len(rows))
probe_sql = seg_cur.executed[0][0]
check("probe fired", "to_regclass" in probe_sql, "probe")
member_sql = seg_cur.executed[1][0]
check("member join staged", "LEFT JOIN" in member_sql and "COALESCE" in member_sql,
      "sql")
check("stage param passed",
      seg_cur.executed[1][1][1] == "won", "param")

portal_segments._SEG_DDL_READY = True
seg_conn = install_db_stub(portal_segments, [
    [{"to_regclass": None}],
])
rows = _member_rows(seg_conn.cur, 1, {"stage": "won"}, 50)
check("missing table empty", rows == [], "safe")

summary("pipeline")
