"""Master-upgrade engine 7: the Action Engine v1.

Covers portal_actions: the declared registry (risk levels, required
args), execute() for LOW/MEDIUM actions (direct run + audit), the
HIGH-risk approval gate (approval created, nothing executed), the
approval resolution loop (approved = real run + action-request done;
rejected = customer hold message), and the portal API (catalog,
execute 200/400/401/503) plus the web pins (app registrations,
approvals.decide -> resolve seam).
"""
import json

from flask import Flask

import portal_actions
import portal_approvals
from test_lib import install_db_stub
from test_lib import check, summary
from test_lib import PrincipalStub


class Principal:
    def __init__(self, module, principal=None, exc=None):
        self.stub = PrincipalStub(module, principal, exc)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.stub.restore()
        return False


PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}

app = Flask(__name__)
app.register_blueprint(portal_actions.bp)
client = app.test_client()

CONFIG_ROW = [{"approval_number": "9230012345678",
               "auto_expire_hours": 24}]
STATUS_ROW = [{"phone": "92 300 999 8888"}]


def share_stub(conn):
    """One FakeConn backing BOTH modules' portal_db (single slot stream)."""
    conn = install_db_stub(portal_approvals, [])
    portal_actions.portal_db = portal_approvals.portal_db
    return conn


print("== registry ==")

cat = {item["action"]: item for item in portal_actions.catalog()}
check("catalog has 15 actions", len(cat) == 15, len(cat))
check("risks declared",
      cat["read_customer_memory"]["risk"] == "low"
      and cat["add_customer_note"]["risk"] == "medium"
      and cat["request_refund"]["risk"] == "high", "risk")
check("required args", cat["create_checkout_link"]["required"]
      == ["contact_id", "items"], "required")

print("== execute: LOW/MEDIUM run directly ==")

_orig_memory = portal_actions.ACTIONS["read_customer_memory"]["run"]
try:
    portal_actions.ACTIONS["read_customer_memory"]["run"] = (
        lambda cur, cid, args: {
            "memory": [{"content": "Prefers black hoodie"}]})
    conn = install_db_stub(portal_actions, [
        [],                                # audit INSERT
    ])
    out = portal_actions.execute(conn.cursor(), 1, "owner@test",
                                 "read_customer_memory",
                                 {"contact_id": "x@c.us"})
    check("low executed", out["status"] == "executed"
          and out["risk"] == "low"
          and out["result"]["memory"][0]["content"].startswith("Prefers"),
          out)
    check("audited", any("portal_action_log" in sql
                         for sql, _p in conn.cur.executed), "audit")
finally:
    portal_actions.ACTIONS["read_customer_memory"]["run"] = _orig_memory

conn = install_db_stub(portal_actions, [
    [{"token": "tok123", "total": 150}],   # link INSERT RETURNING
    [],                                    # audit
])
out = portal_actions.execute(conn.cursor(), 1, "owner@test",
                             "create_checkout_link", {
                                 "contact_id": "x@c.us",
                                 "items": [{"name": "Hoodie",
                                            "qty": 1, "price": 150}],
                             })
check("medium checkout executed", out["status"] == "executed"
      and out["result"]["token"] == "tok123", out)
insert = next((p for sql, p in conn.cur.executed
               if "portal_checkout_links" in sql), None)
# params carry the freshly generated token; the scripted stub returns
# "tok123" as the row, so compare shape + the executed params.
check("link inserted", insert is not None
      and out["result"]["token"] == "tok123"
      and len(str(insert[2])) > 10, insert)

print("== execute: agent permission envelope ==")

import portal_agents  # noqa: E402

DENY = {"id": 7, "name": "Support Pro", "allowed_actions": ["add_customer_note"],
        "max_risk": "medium", "can_auto_reply": True}
conn = install_db_stub(portal_actions, [[]])          # audit action.denied
out = portal_actions.execute(conn.cursor(), 1, "workflow:3",
                             "create_checkout_link", {
                                 "contact_id": "x@c.us",
                                 "items": [{"name": "H", "qty": 1,
                                            "price": 10}]},
                             conversation_id=77, agent=DENY)
check("action outside allowed_actions -> denied, audited",
      out["status"] == "denied" and out["reason"] == "action_not_allowed"
      and out["agent_id"] == 7
      and "action.denied" in str(conn.cur.executed[0][1])
      and not any("portal_checkout_links" in sql
                  for sql, _p in conn.cur.executed), out)
RISK = {"id": 8, "name": "Ops", "allowed_actions": None, "max_risk": "low"}
conn = install_db_stub(portal_actions, [[]])
out = portal_actions.execute(conn.cursor(), 1, "workflow:3",
                             "add_customer_note",
                             {"contact_id": "x@c.us", "content": "n"},
                             agent=RISK)
check("action above max_risk -> denied", out["status"] == "denied"
      and out["reason"] == "risk_above_max", out)
check("permits(): no agent = allowed; matrix",
      portal_agents.permits(None, "anything", "high") == (True, "")
      and portal_agents.permits(DENY, "add_customer_note", "medium")[0]
      and not portal_agents.permits(DENY, "add_customer_note", "high")[0]
      and portal_agents.permits({"allowed_actions": [], "max_risk": "high"},
                                "read_order", "low")
      == (False, "action_not_allowed"), "matrix")
_orig_note = portal_actions.ACTIONS["add_customer_note"]["run"]
try:
    portal_actions.ACTIONS["add_customer_note"]["run"] = (
        lambda cur, cid, args: {"ok": True})
    conn = install_db_stub(portal_actions, [[]])       # audit
    out = portal_actions.execute(conn.cursor(), 1, "workflow:3",
                                 "add_customer_note",
                                 {"contact_id": "x@c.us", "content": "n"},
                                 agent=DENY)
    check("permitted action executes normally", out["status"] == "executed"
          and out["risk"] == "medium", out)
finally:
    portal_actions.ACTIONS["add_customer_note"]["run"] = _orig_note

print("== execute: HIGH -> approval, nothing runs ==")

conn = share_stub(install_db_stub(portal_actions, []))
conn = install_db_stub(portal_approvals, [
    [], [], [],                            # lazy DDL
    [],                                    # dup pending SELECT
    CONFIG_ROW,                            # config
    [{"id": 91}],                          # INSERT approval RETURNING
    CONFIG_ROW,                            # approver config
    STATUS_ROW,                            # connector phone
    [],                                    # owner WhatsApp queued
    [],                                    # audit
])
portal_actions.portal_db = portal_approvals.portal_db
out = portal_actions.execute(conn.cursor(), 1, "ai-agent", "request_refund",
                             {"conversation_id": 77,
                              "contact_id": "923008887777@c.us",
                              "customer_query": "refund chahiye"})
check("high gated", out["status"] == "approval_required"
      and out["refCode"].startswith("AP-"), out)
check("no action_request yet",
      not any("portal_action_requests" in sql
              for sql, _p in conn.cur.executed), "deferred")

print("== resolve_approval: approved runs, rejected holds ==")

conn = install_db_stub(portal_approvals, [
    [{"contact_id": "923008887777@c.us"}],  # conversation contact SELECT
    [{"id": 701}],                          # action_request INSERT RETURNING
    [],                                     # done UPDATE
    [],                                     # audit
])
portal_actions.portal_db = portal_approvals.portal_db
portal_actions.resolve_approval(conn.cursor(), 1, {
    "context_json": json.dumps({
        "action": "request_refund",
        "args": {"conversation_id": 77,
                 "contact_id": "923008887777@c.us"},
    }),
}, approved=True)
done = next((p for sql, p in conn.cur.executed
             if "UPDATE portal_action_requests" in sql), None)
check("approved -> request done", done is not None and done[0] == 701,
      done)

conn = install_db_stub(portal_approvals, [
    [],                                    # hold message queued
])
portal_actions.portal_db = portal_approvals.portal_db
portal_actions.resolve_approval(conn.cursor(), 1, {
    "context_json": json.dumps({
        "action": "request_refund",
        "args": {"contact_id": "923008887777@c.us"},
    }),
}, approved=False)
send = next((p for sql, p in conn.cur.executed
             if "portal_connector_commands" in sql), None)
check("rejected -> hold message", send is not None
      and "process nahi ho saki" in json.loads(send[1])["body"],
      json.loads(send[1])["body"] if send else None)

print("== portal API ==")

with Principal(portal_actions, principal=None):
    check("catalog 401", client.get(
        "/api/v1/portal/actions").status_code == 401, 401)
    check("execute 401", client.post(
        "/api/v1/portal/actions/execute",
        json={"action": "read_customer_memory",
              "args": {"contact_id": "x"}}).status_code == 401, 401)

with Principal(portal_actions, PRINCIPAL):
    r = client.get("/api/v1/portal/actions")
    check("catalog 200", r.status_code == 200
          and len(r.get_json()["actions"]) == 15, r.get_json())

    conn = install_db_stub(portal_actions, [])
    r = client.post("/api/v1/portal/actions/execute",
                    json={"action": "no_such_action", "args": {}})
    check("unknown 400", r.status_code == 400, r.status_code)

    conn = install_db_stub(portal_actions, [])
    r = client.post("/api/v1/portal/actions/execute",
                    json={"action": "add_customer_note",
                          "args": {"contact_id": "x"}})
    check("missing args 400", r.status_code == 400, r.status_code)

    _orig = portal_actions.ACTIONS["add_customer_note"]["run"]
    portal_actions.ACTIONS["add_customer_note"]["run"] = (
        lambda cur, cid, args: {"memoryId": 9})
    try:
        conn = install_db_stub(portal_actions, [
            [],                            # audit
        ])
        r = client.post("/api/v1/portal/actions/execute",
                        json={"action": "add_customer_note",
                              "args": {"contact_id": "x@c.us",
                                       "content": "Prefers COD"}})
        check("execute 200", r.status_code == 200
              and r.get_json()["status"] == "executed", r.get_json())
    finally:
        portal_actions.ACTIONS["add_customer_note"]["run"] = _orig

portal_actions.PortalAuthUnavailable = Exception
with Principal(portal_actions, exc=Exception("db down")):
    r = client.get("/api/v1/portal/actions")
    check("auth down 503", r.status_code == 503, r.status_code)
del portal_actions.PortalAuthUnavailable

print("== web pins ==")

RIG13 = "/tmp/p13/Omniflow/"
APPROVALS = open(RIG13 + "omniflow-backend-patch/portal_approvals.py",
                 encoding="utf8").read()
check("decide -> resolve seam",
      "portal_actions.resolve_approval" in APPROVALS, "seam")
APP = open(RIG13 + "omniflow-backend-patch/app.py", encoding="utf8").read()
check("blueprints", "portal_actions_bp" in APP
      and APP.index("register_blueprint(portal_approvals_bp)")
      < APP.index("register_blueprint(portal_actions_bp)"), "app")

summary("actions")
