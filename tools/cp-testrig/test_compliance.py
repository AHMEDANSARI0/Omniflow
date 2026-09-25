"""Tests for compliance flags (STOP/opt-out handling)."""
import sys

from flask import Flask

import portal_compliance
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_compliance.bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
PrincipalStub(portal_compliance, principal=human)


def fresh(script):
    portal_compliance._COMPLIANCE_DDL_READY = False
    return install_db_stub(portal_compliance, script)


print("== STOP regex ==")

for text in ("stop", "STOP", "please stop", "band karo", "BAND KAR DO",
             "unsubscribe", "no more messages", "koi message nahi",
             "Plz STOP kar do"):
    check("matches: " + text, bool(portal_compliance.STOP_RE.search(text)), text)
for text in ("stopwatch", "stopped delivery?", "whatsap", "bandobast"):
    check("rejects: " + text, not portal_compliance.STOP_RE.search(text), text)

print("== maybe_opt_out hook ==")

conn = fresh([[], []])
portal_compliance.maybe_opt_out(1, "92300@c.us", "band karo please", conn)
check("insert on stop", "INSERT INTO portal_optouts" in conn.cur.executed[0][0]
      and "ON CONFLICT (client_id, contact_id) DO NOTHING"
      in conn.cur.executed[0][0], conn.cur.executed[0][0][:100])
check("insert params", conn.cur.executed[0][1] == (1, "92300@c.us")
      and "'customer'" in conn.cur.executed[0][0], conn.cur.executed[0])
check("audit optout", conn.cur.executed[1][1][1] == "compliance.optout",
      conn.cur.executed[1][1])

conn = fresh([])
portal_compliance.maybe_opt_out(1, "92300@c.us", "kya rate hai?", conn)
check("normal message no-op", len(conn.cur.executed) == 0, conn.cur.executed)

conn = fresh([])
portal_compliance.maybe_opt_out(1, "92300@c.us", "", conn)
check("blank text no-op", len(conn.cur.executed) == 0, conn.cur.executed)

print("== optouts endpoints ==")

ROWS = [{"contact_id": "92300@c.us", "reason": "customer", "created_at": None}]
conn = fresh([[{"found": "portal_optouts"}], ROWS])
response = client.get("/api/v1/portal/compliance/optouts")
check("200 list", status(response) == 200
      and response.get_json()["optouts"][0]["contact_id"] == "92300@c.us",
      status(response))

conn = fresh([[{"found": "portal_optouts"}], []])
response = client.get("/api/v1/portal/compliance/optouts?q=923")
check("search filter", "ILIKE %s" in conn.cur.executed[1][0]
      and conn.cur.executed[1][1][-1] == "%923%", conn.cur.executed[1][1])
check("200 empty", status(response) == 200
      and response.get_json()["optouts"] == [], status(response))

response = client.post("/api/v1/portal/compliance/optouts", json={"contact": ""})
check("400 no contact", status(response) == 400, status(response))
response = client.post("/api/v1/portal/compliance/optouts",
                       json={"contact": "x", "reason": "bogus"})
check("400 bad reason", status(response) == 400, status(response))

conn = fresh([[{"found": "portal_optouts"}], [], []])
response = client.post("/api/v1/portal/compliance/optouts",
                       json={"contact": "92300@c.us", "reason": "merchant"})
check("200 add", status(response) == 200
      and response.get_json()["ok"] is True, status(response))
check("upsert sql", "ON CONFLICT (client_id, contact_id)"
      in conn.cur.executed[1][0], conn.cur.executed[1][0][:100])
check("manual audit", conn.cur.executed[2][1][1] == "compliance.optout_manual",
      conn.cur.executed[2][1])

response = client.delete("/api/v1/portal/compliance/optouts")
check("400 delete no contact", status(response) == 400, status(response))

conn = fresh([[{"found": "portal_optouts"}], []])
response = client.delete("/api/v1/portal/compliance/optouts?contact=92300@c.us")
check("404 unknown", status(response) == 404, status(response))

conn = fresh([[{"found": "portal_optouts"}], [{"contact_id": "92300@c.us"}], []])
response = client.delete("/api/v1/portal/compliance/optouts?contact=92300@c.us")
check("200 remove", status(response) == 200
      and response.get_json()["ok"] is True, status(response))
check("delete returning", "RETURNING contact_id" in conn.cur.executed[1][0],
      conn.cur.executed[1][0][:100])
check("resubscribe audit", conn.cur.executed[2][1][1] == "compliance.resubscribed",
      conn.cur.executed[2][1])

PrincipalStub(portal_compliance, principal=None)
response = client.get("/api/v1/portal/compliance/optouts")
check("401 unauth", status(response) == 401, status(response))
PrincipalStub(portal_compliance, principal=human)
conn = fresh([[{"found": "portal_optouts"}], [], []])
response = client.post("/api/v1/portal/compliance/optouts",
                       json={"contact": "x"})
check("200 after restore", status(response) == 200, status(response))

PrincipalStub(portal_compliance, principal={
    "session_id": "s", "user_id": None, "client_id": 1, "role": "key",
    "email": "k@ofk", "display_name": "Key", "via_api_key": True})
response = client.post("/api/v1/portal/compliance/optouts",
                       json={"contact": "x"})
check("403 api-key blocked", status(response) == 403, status(response))

print("== send guard (portal_growth._send_command) ==")

import json as _json
import portal_growth
import portal_db as real_db_stub_holder

conn = fresh([])
growth_db = portal_growth.portal_db
growth_db.ensure_tables = lambda: None
growth_db._conn = lambda: conn
growth_db._q = lambda ident: ident
conn2 = fresh([[]])
growth_conn = conn2


class _G:
    pass


# Minimal stub: capture the INSERT executed by _send_command.
captured = []


class _Cur:
    def __init__(self):
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class _FakeDB:
    CONV_TABLE = "portal_conversations"
    CMD_TABLE = "portal_connector_commands"
    TEAM_TABLE = "portal_team_members"

    @staticmethod
    def _q(ident):
        return ident

    @staticmethod
    def rows(cur):
        if cur.description is None:
            return []
        keys = [d[0] for d in cur.description]
        return [dict(zip(keys, row)) for row in cur.fetchall()]

    @staticmethod
    def log_action(cur, client_id, action, actor_kind="customer_user",
                   actor_user_id=None, conversation_id=None, note=""):
        cur.execute("INSERT INTO portal_action_log (...)", (client_id, action))


cur = _Cur()
orig_db = portal_growth.portal_db
portal_growth.portal_db = _FakeDB
portal_growth._send_command(cur, 1, "92300@c.us", "Ali", "Hi", "cod_confirm")
guarded = cur.executed[0]
check("guarded send sql", "NOT EXISTS (SELECT 1 FROM portal_optouts"
      in guarded[0] and "SELECT %s, %s, 'send_message'" in guarded[0],
      guarded[0][:160])
check("send params", guarded[1][0] == 1 and guarded[1][1] == "whatsapp"
      and _json.loads(guarded[1][2])["external_user_id"] == "92300@c.us",
      guarded[1])
check("guard params scoped", guarded[1][3] == 1 and guarded[1][4] == "92300@c.us",
      guarded[1])

cur = _Cur()
portal_growth._send_command(cur, 1, "tg:424242", "TG User", "Hello", "sequence")
check("telegram channel derived", cur.executed[0][1][1] == "telegram",
      cur.executed[0][1])
portal_growth.portal_db = orig_db

sys.exit(1 if summary("compliance") else 0)
