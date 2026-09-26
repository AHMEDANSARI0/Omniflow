"""Tests for fraud heuristics (deterministic risk scoring)."""
import sys

from flask import Flask

import portal_fraud
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_fraud.bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
PrincipalStub(portal_fraud, principal=human)


def fresh(script):
    portal_fraud._FRAUD_DDL_READY = False
    conn = install_db_stub(portal_fraud, script)
    portal_fraud.portal_db.CONV_TABLE = "portal_conversations"
    return conn


PROBE_COD = [{"found": "portal_cod_requests"}]
PROBE_ACT = [{"found": "portal_action_requests"}]

print("== score_contact ==")

conn = fresh([PROBE_COD, [{"total": 1}], PROBE_ACT, [{"total": 0}], [{"total": 3}]])
scored = portal_fraud.score_contact(conn.cur, 1, "92300@c.us")
check("single decline watch-band", scored["score"] == 25 and scored["level"] == "clear",
      scored)
check("reason recorded", scored["reasons"] == ["One COD order declined"], scored)

conn = fresh([PROBE_COD, [{"total": 2}], PROBE_ACT, [{"total": 1}], [{"total": 1}]])
scored = portal_fraud.score_contact(conn.cur, 1, "92300@c.us")
check("repeat decline + refund + new = high",
      scored["score"] == 70 and scored["level"] == "high", scored)
check("reasons stacked", len(scored["reasons"]) == 3, scored["reasons"])
check("decline reason", scored["reasons"][0] == "Multiple COD orders declined",
      scored["reasons"])

conn = fresh([PROBE_COD, [{"total": 0}], PROBE_ACT, [{"total": 2}], [{"total": 9}]])
scored = portal_fraud.score_contact(conn.cur, 1, "x")
check("two refunds capped", scored["score"] == 30 and scored["level"] == "watch",
      scored)

conn = fresh([[], [], []])
scored = portal_fraud.score_contact(conn.cur, 1, "x")
check("missing tables degrade to clear", scored == {
    "score": 0, "level": "clear", "reasons": [], "declined": 0,
    "refunds": 0, "chats": 0}, scored)

conn = fresh([])
check("blank contact short-circuits", portal_fraud.score_contact(
    conn.cur, 1, "")["level"] == "clear" and len(conn.cur.executed) == 0,
    conn.cur.executed)

print("== score endpoint ==")

conn = fresh([
    [{"found": "portal_fraud_flags"}],
    PROBE_COD, [{"total": 0}], PROBE_ACT, [{"total": 0}], [{"total": 5}],
])
response = client.get("/api/v1/portal/fraud/score?contact=92300@c.us")
check("200 clear no flag write", status(response) == 200
      and response.get_json()["level"] == "clear"
      and len(conn.cur.executed) == 6, status(response))

conn = fresh([
    [{"found": "portal_fraud_flags"}],
    PROBE_COD, [{"total": 2}], PROBE_ACT, [{"total": 1}], [{"total": 1}],
    [{"found": "portal_fraud_flags"}],
    [],
    [],
])
response = client.get("/api/v1/portal/fraud/score?contact=92300@c.us")
check("200 high persists flag", status(response) == 200
      and response.get_json()["score"] == 70, status(response))
check("flag upsert sql", "ON CONFLICT (client_id, contact_id) DO UPDATE"
      in conn.cur.executed[6][0], conn.cur.executed[6][0][:80])
check("flag audit", conn.cur.executed[7][1][1] == "fraud.flagged",
      conn.cur.executed[7][1])

response = client.get("/api/v1/portal/fraud/score")
check("400 no contact", status(response) == 400, status(response))

PrincipalStub(portal_fraud, principal=None)
response = client.get("/api/v1/portal/fraud/score?contact=x")
check("401 unauth", status(response) == 401, status(response))
PrincipalStub(portal_fraud, principal=human)

print("== flags endpoint ==")

ROWS = [{"contact_id": "92300@c.us", "score": 70, "level": "high",
         "reasons": "Multiple COD orders declined", "updated_at": None}]
conn = fresh([[{"found": "portal_fraud_flags"}], ROWS])
response = client.get("/api/v1/portal/fraud/flags")
check("200 flags", status(response) == 200
      and response.get_json()["flags"][0]["contact_id"] == "92300@c.us"
      and response.get_json()["flags"][0]["score"] == 70, status(response))
check("flags scoped + ordered", "client_id = %s" in conn.cur.executed[1][0]
      and "ORDER BY updated_at DESC" in conn.cur.executed[1][0], "sql")

print("== on_cod_declined hook ==")

conn = fresh([PROBE_COD, [{"total": 2}], PROBE_ACT, [{"total": 0}], [{"total": 1}],
              [{"found": "portal_fraud_flags"}], [], []])
portal_fraud.on_cod_declined(conn.cur, 1, "92300@c.us")
kinds = [e[0] for e in conn.cur.executed]
check("hook persists on watch+", any("portal_fraud_flags" in s and "INSERT" in s
      for s in kinds), kinds)
check("hook audits", any("portal_action_log" in s for s in kinds), kinds)

conn = fresh([])
portal_fraud.on_cod_declined(conn.cur, 1, "x")
check("hook never raises on empty stub", len(conn.cur.executed) <= 1, "quiet")

conn = fresh([])
portal_fraud.on_cod_declined(conn.cur, 1, "")
check("hook ignores blank contact", len(conn.cur.executed) == 0, "quiet")

print("== ddl ==")

portal_fraud._FRAUD_DDL_READY = False
conn2 = install_db_stub(portal_fraud, [[]])
portal_fraud._ensure_fraud_tables(conn2)
ddl = conn2.cur.executed[0][0]
check("flags table unique", "portal_fraud_flags" in ddl
      and "UNIQUE (client_id, contact_id)" in ddl, ddl[:120])

sys.exit(1 if summary("fraud") else 0)
