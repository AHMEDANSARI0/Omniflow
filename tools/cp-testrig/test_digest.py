"""Tests for the owner daily digest: settings CRUD, tick materializer
(hour + date guards, metrics, WhatsApp queue), app registration and
connector wiring."""
import io as _io
import json
import sys

from flask import Flask

import portal_digest
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_digest.bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
PrincipalStub(portal_digest, principal=human)


def fresh(script):
    portal_digest.DDL_READY = True
    db = install_db_stub(portal_digest, script)
    db.CONV_TABLE = "portal_conversations"
    db.CMD_TABLE = "portal_commands"
    return db


ON_ROW = {"owner_contact": "92300", "enabled": True, "hour": 9,
          "last_sent_date": None}

print("== constants ==")

check("digest table", portal_digest.DIGEST_TABLE == "portal_digest_settings",
      portal_digest.DIGEST_TABLE)
check("hour bounds", (portal_digest.MIN_HOUR, portal_digest.MAX_HOUR,
                      portal_digest.DEFAULT_HOUR) == (6, 21, 9),
      (portal_digest.MIN_HOUR, portal_digest.MAX_HOUR,
       portal_digest.DEFAULT_HOUR))

print("== ddl ==")

conn = fresh([[]])
portal_digest.DDL_READY = False
portal_digest._ensure_tables(conn)
check("ddl", "portal_digest_settings" in conn.cur.executed[0][0]
      and "last_sent_date DATE" in conn.cur.executed[0][0],
      conn.cur.executed[0][0][:90])
check("ddl probe-once", portal_digest.DDL_READY is True, portal_digest.DDL_READY)

print("== load settings ==")

conn = fresh([[{"owner_contact": "92x", "enabled": True, "hour": 9999,
                "last_sent_date": "2026-09-16"}]])
out = portal_digest._load_settings(conn.cur, 1)
check("junk hour -> default", out["hour"] == 9, out)
check("values kept", out["owner_contact"] == "92x"
      and out["enabled"] is True, out)
conn = fresh([[]])
out = portal_digest._load_settings(conn.cur, 1)
check("defaults off", out == {"owner_contact": "", "enabled": False,
                              "hour": 9, "last_sent_date": ""}, out)

print("== settings api ==")

conn = fresh([[dict(ON_ROW)]])
response = client.get("/api/v1/portal/digest/settings")
payload = response.get_json()
check("200 get", status(response) == 200 and payload["ok"] is True,
      status(response))
check("get values", payload["settings"]["enabled"] is True
      and payload["settings"]["owner_contact"] == "92300"
      and payload["settings"]["hour"] == 9, payload["settings"])

response = client.put("/api/v1/portal/digest/settings",
                      json={"settings": {"enabled": True}})
check("400 contact required", status(response) == 400, status(response))
response = client.put("/api/v1/portal/digest/settings", json={
    "settings": {"enabled": True, "owner_contact": "92x", "hour": 30}})
check("400 hour bound", status(response) == 400, status(response))

conn = fresh([[], []])
response = client.put("/api/v1/portal/digest/settings", json={
    "settings": {"enabled": True, "owner_contact": "923001234567",
                 "hour": 8}})
check("200 put", status(response) == 200, status(response))
check("put params", conn.cur.executed[0][1] == (1, "923001234567", True, 8),
      conn.cur.executed[0][1])
check("put upsert", "ON CONFLICT (client_id) DO UPDATE"
      in conn.cur.executed[0][0], conn.cur.executed[0][0][:80])
check("put audit", conn.cur.executed[1][1][1] == "digest.settings",
      conn.cur.executed[1][1])

response = client.put("/api/v1/portal/digest/settings", json={
    "settings": {"enabled": False, "hour": 3}})
check("400 bad hour even when off", status(response) == 400,
      status(response))
conn = fresh([[], []])
response = client.put("/api/v1/portal/digest/settings", json={
    "settings": {"enabled": False}})
check("put off defaults hour", status(response) == 200
      and conn.cur.executed[0][1][3] == 9, conn.cur.executed[0][1])

print("== materialize guards ==")

conn = fresh([[{"owner_contact": "92x", "enabled": False, "hour": 9,
                "last_sent_date": None}]])
check("disabled -> 0", portal_digest.materialize_due_digest(
    conn.cur, 1, conn) == 0, "off")
check("no queries after off", len(conn.cur.executed) == 1,
      len(conn.cur.executed))

conn = fresh([[{"owner_contact": "", "enabled": True, "hour": 9,
                "last_sent_date": None}]])
check("blank contact -> 0", portal_digest.materialize_due_digest(
    conn.cur, 1, conn) == 0, "blank")

conn = fresh([[{"owner_contact": "92x", "enabled": True, "hour": 9,
                "last_sent_date": "2026-09-16"}],
              [{"h": 8}], [{"d": "2026-09-17"}]])
check("early hour -> 0", portal_digest.materialize_due_digest(
    conn.cur, 1, conn) == 0, "hour")

conn = fresh([[{"owner_contact": "92x", "enabled": True, "hour": 9,
                "last_sent_date": "2026-09-17"}],
              [{"h": 10}], [{"d": "2026-09-17"}]])
check("already sent today -> 0", portal_digest.materialize_due_digest(
    conn.cur, 1, conn) == 0, "date")

print("== materialize send ==")

conn = fresh([[dict(ON_ROW)],
              [{"h": 10}], [{"d": "2026-09-17"}],
              [{"n": 3, "amount": 4500.0}],
              [{"n": 2}],
              [{"oid": "portal_return_requests"}], [{"n": 1}],
              [], [], []])
sent = portal_digest.materialize_due_digest(conn.cur, 1, conn)
check("sent 1 + committed", sent == 1 and conn.committed is True,
      (sent, conn.committed))
cmd_sql, cmd_params = conn.cur.executed[7]
payload = json.loads(cmd_params[2])
check("digest body", payload["source"] == "owner_digest"
      and "3 order(s) paid today (Rs 4500)" in payload["body"]
      and "2 cart(s) still open" in payload["body"]
      and "1 return(s) today" in payload["body"], payload["body"])
check("digest to owner", payload["external_user_id"] == "92300", payload)
check("digest audit", conn.cur.executed[8][1][1] == "digest.sent",
      conn.cur.executed[8][1])
check("date guard updated", "last_sent_date = CURRENT_DATE"
      in conn.cur.executed[9][0], conn.cur.executed[9][0][:60])

conn = fresh([[dict(ON_ROW, last_sent_date=None)],
              [{"h": 10}], [{"d": "2026-09-17"}],
              [{"n": 0, "amount": 0}],
              [{"n": 0}],
              [{"oid": "portal_return_requests"}], [],
              [], [], []])
sent = portal_digest.materialize_due_digest(conn.cur, 1, conn)
check("quiet day still sends", sent == 1, sent)
payload = json.loads(conn.cur.executed[7][1][2])
check("zero metrics body", "0 order(s) paid" in payload["body"], payload["body"])

conn = fresh([[dict(ON_ROW)],
              [{"h": 10}], [{"d": "2026-09-17"}],
              [], [], [], [], [], [], []])
sent = portal_digest.materialize_due_digest(conn.cur, 1, conn)
check("exhausted metric stubs -> zeros, still sends", sent == 1, sent)

print("== wiring ==")

connector = _io.open("connector_api.py", encoding="utf8").read()
check("connector tick wired", "materialize_due_digest" in connector
      and "portal_digest" in connector, "connector_api.py")
app_src = _io.open("app.py", encoding="utf8").read()
check("app registration", "from portal_digest import bp as portal_digest_bp"
      in app_src
      and "aux_app.register_blueprint(portal_digest_bp)" in app_src, "app.py")

summary("digest")
