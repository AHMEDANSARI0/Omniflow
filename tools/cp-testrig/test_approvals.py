"""Master-upgrade D3: the approvals engine.

Covers portal_approvals end to end on stubs: create_approval (dup
guard, ref code, owner WhatsApp command queued with the 1/0 instructions),
maybe_request keyword detection (refund / cancel / discount, in only),
maybe_decide (owner-only 1/0, single-pending decide, code pick with
multiple pending, hint message, rowcount guard, wrong sender ignored),
the portal APIs (list with lazy expiry, decide 200/401/404, config
GET/PUT with the owner-role check) and the web surface pins (connector
hook order, BFF routes, portal.ts helpers, sidebar + page).
"""
import json

from flask import Flask

import portal_approvals
from test_lib import FakeConn, FakeCur
from test_lib import install_db_stub
from test_lib import check, summary
from test_lib import PrincipalStub
from test_lib import neutralize_action_ledger
import portal_actions  # noqa: E402

neutralize_action_ledger(portal_actions)


class Principal:
    """CM wrapper — test_lib's PrincipalStub has no __enter__."""

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

CONFIG_ROW = [{"approval_number": "9230012345678",
               "auto_expire_hours": 24}]
STATUS_ROW = [{"phone": "92 300 999 8888"}]

app = Flask(__name__)
app.register_blueprint(portal_approvals.bp)
client = app.test_client()


def _sender_queue_params(conn):
    for sql, params in conn.cur.executed:
        if "portal_connector_commands" in sql:
            return params
    return None


print("== create_approval: dup guard, ref, owner WhatsApp ==")

conn = install_db_stub(portal_approvals, [
    [], [], [],                              # lazy DDL x3
    [],                                      # dup pending SELECT -> none
    CONFIG_ROW,                              # load config
    [{"id": 55}],                            # INSERT approval RETURNING id
    CONFIG_ROW,                              # approver: config again
    STATUS_ROW,                              # approver: connector phone
    [],                                      # queue owner WhatsApp send
    [],                                      # audit
])
made = portal_approvals.create_approval(
    conn.cursor(), 1, 77, "923008887777@c.us", "Ahmed Raza",
    "refund", "Refund request — owner ki tasdeeq chahiye",
    "Mera order kharab aya hai, refund chahiye",
    {"detected_from": "inbound_message"})
check("create returns row", made is not None and made["id"] == 55
      and made["ref_code"].startswith("AP-"), made)
send_params = _sender_queue_params(conn)
check("owner whatsapp queued", send_params is not None
      and json.loads(send_params[1])["external_user_id"]
      == "9230012345678@c.us", send_params)
check("whatsapp body has 1/0 + ref",
      "1 = approve" in json.loads(send_params[1])["body"]
      and made["ref_code"] in json.loads(send_params[1])["body"],
      json.loads(send_params[1])["body"])
check("audit written", any("portal_action_log" in sql
                           for sql, _p in conn.cur.executed), "audit")

conn = install_db_stub(portal_approvals, [
    [], [], [],                              # lazy DDL
    [{"id": 9, "ref_code": "AP-AAAA"}],      # dup pending exists
])
dup = portal_approvals.create_approval(
    conn.cursor(), 1, 77, "923008887777@c.us", "Ahmed", "refund",
    "dup", "x", None)
check("duplicate pending skipped", dup is None, dup)

print("== maybe_request: keyword producer ==")

conn = install_db_stub(portal_approvals, [])
check("plain message ignored",
      portal_approvals.maybe_request(
          1, 77, "923008887777@c.us", "Ahmed",
          "Salam, ye hoodie kis size me hai?", "in", conn) is False,
      "plain")
conn = install_db_stub(portal_approvals, [])
check("outbound ignored",
      portal_approvals.maybe_request(
          1, 77, "923008887777@c.us", "Ahmed", "refund chahiye",
          "out", conn) is False, "out")

conn = install_db_stub(portal_approvals, [
    [], [], [],
    [],
    CONFIG_ROW,
    [{"id": 56}],
    CONFIG_ROW,
    STATUS_ROW,
    [],
    [],
])
check("refund request creates approval",
      portal_approvals.maybe_request(
          1, 77, "923008887777@c.us", "Ahmed",
          "Bhai mera order kharab aya hai refund chahiye", "in",
          conn) is True, "refund")

print("== maybe_decide: the WhatsApp 1/0 loop ==")

conn = install_db_stub(portal_approvals, [])
check("non-decision ignored",
      portal_approvals.maybe_decide(
          1, 77, "9230012345678@c.us", "salam", "in", conn) is False,
      "salam")

conn = install_db_stub(portal_approvals, [CONFIG_ROW, STATUS_ROW])
check("stranger 1 ignored",
      portal_approvals.maybe_decide(
          1, 77, "923005555555@c.us", "1", "in", conn) is False,
      "stranger")

# self-chat number also allowed
conn = install_db_stub(portal_approvals, [
    [{"approval_number": "", "auto_expire_hours": 24}],  # no configured owner
    STATUS_ROW,                              # connector self number
    [{"id": 55, "ref_code": "AP-AB12"}],     # one pending
    1,                                       # UPDATE decided
    [{"id": 55, "ref_code": "AP-AB12", "context_json": None}],  # resolve seam
    [], [],                                  # SAVEPOINT / RELEASE (resolver)
    [],                                      # outcome UPDATE
    [],                                      # audit
    [],                                      # confirmation send
])
check("self-chat 1 approves",
      portal_approvals.maybe_decide(
          1, 77, "923009998888@c.us", "1", "in", conn) is True,
      "self")
update = next((p for sql, p in conn.cur.executed
               if "UPDATE portal_approvals" in sql), None)
check("approve update params", update is not None
      and update[0] == "approved" and update[1] == "923009998888"
      and update[2] == "whatsapp", update)

# multiple pending, no code -> hint
conn = install_db_stub(portal_approvals, [
    CONFIG_ROW, STATUS_ROW,
    [{"id": 55, "ref_code": "AP-AB12"},
     {"id": 56, "ref_code": "AP-CD34"}],
    [],                                      # hint send
])
check("multiple pending asks for code",
      portal_approvals.maybe_decide(
          1, 77, "9230012345678@c.us", "1", "in", conn) is True,
      "hint")
hint_params = _sender_queue_params(conn)
check("hint names the code",
      "AP-AB12" in json.loads(hint_params[1])["body"],
      json.loads(hint_params[1])["body"])

# code pick decides the right row
conn = install_db_stub(portal_approvals, [
    CONFIG_ROW, STATUS_ROW,
    [{"id": 55, "ref_code": "AP-AB12"},
     {"id": 56, "ref_code": "AP-CD34"}],
    1,                                       # UPDATE decided
    [{"id": 56, "ref_code": "AP-CD34", "context_json": None}],  # seam
    [], [],                                  # SAVEPOINT / RELEASE (resolver)
    [],                                      # outcome UPDATE
    [],                                      # audit
    [],                                      # confirmation
])
check("code picks the row",
      portal_approvals.maybe_decide(
          1, 77, "9230012345678@c.us", "0 AP-CD34", "in", conn) is True,
      "code")
update = next((p for sql, p in conn.cur.executed
               if "UPDATE portal_approvals" in sql), None)
check("coded reject hits id 56", update is not None
      and update[0] == "rejected" and update[6] == 56, update)

# already decided / lost race -> claimed with a clear reply
conn = install_db_stub(portal_approvals, [
    CONFIG_ROW, STATUS_ROW,
    [{"id": 55, "ref_code": "AP-AB12"}],
    0,                                       # UPDATE hits nothing
    [],                                      # "already decide" send
])
check("lost race still claimed",
      portal_approvals.maybe_decide(
          1, 77, "9230012345678@c.us", "1", "in", conn) is True,
      "race")

print("== portal API ==")

with Principal(portal_approvals, principal=None):
    check("list 401", client.get(
        "/api/v1/portal/approvals").status_code == 401, 401)

with Principal(portal_approvals, PRINCIPAL):
    conn = install_db_stub(portal_approvals, [
        [], [], [],              # DDL
        [],                      # lazy expire UPDATE
        [{"id": 55, "conversation_id": 77, "contact_id": "923008887777@c.us",
          "contact_name": "Ahmed Raza", "action": "refund",
          "summary": "Refund request", "customer_query": "refund chahiye",
          "context_json": "{}", "status": "pending", "source": "ai",
          "ref_code": "AP-AB12", "decided_by": None, "decided_via": None,
          "decided_at": None, "expires_at": None,
          "created_at": None}],
    ])
    r = client.get("/api/v1/portal/approvals")
    body = r.get_json()
    check("list 200 + mapped", r.status_code == 200
          and body["approvals"][0]["refCode"] == "AP-AB12"
          and body["approvals"][0]["contactName"] == "Ahmed Raza", body)

    conn = install_db_stub(portal_approvals, [
        [], [], [],              # DDL
        [{"id": 55, "ref_code": "AP-AB12", "status": "pending",
          "source": "ai", "action": "refund", "context_json": "{}"}],
        1,                       # UPDATE decided
        [{"id": 55, "ref_code": "AP-AB12", "status": "approved",
          "source": "ai", "action": "refund", "context_json": "{}"}],
        [], [],                  # SAVEPOINT / RELEASE (resolver)
        [],                      # outcome UPDATE
        [],                      # audit
    ])
    r = client.post("/api/v1/portal/approvals/55/decide",
                    json={"decision": "approve"})
    check("decide 200", r.status_code == 200
          and r.get_json()["status"] == "approved"
          and r.get_json()["outcome"] == "recorded", r.get_json())

    conn = install_db_stub(portal_approvals, [
        [], [], [],
        [],                      # pending SELECT -> none
    ])
    r = client.post("/api/v1/portal/approvals/99/decide",
                    json={"decision": "approve"})
    check("decide unknown 404", r.status_code == 404, r.status_code)

    r = client.post("/api/v1/portal/approvals/55/decide",
                    json={"decision": "maybe"})
    check("decide bad decision 400", r.status_code == 400, r.status_code)

    conn = install_db_stub(portal_approvals, [
        [], [], [],
        CONFIG_ROW,              # _load_config
        CONFIG_ROW,              # _approver_digits config again
        STATUS_ROW,              # connector phone
    ])
    r = client.get("/api/v1/portal/approvals/config")
    body = r.get_json()
    check("config get", r.status_code == 200
          and body["selfChatAvailable"] is True
          and body["autoExpireHours"] == 24, body)

    conn = install_db_stub(portal_approvals, [
        [], [], [],
        [], [],                  # snapshot hook: SAVEPOINT + table DDL
        [{"data_hash": "x", "recent": True}],  # grouped -> no new snapshot
        [],                      # RELEASE
        [],                      # config upsert
        [],                      # audit
    ])
    r = client.put("/api/v1/portal/approvals/config",
                   json={"approvalNumber": "92300 123-4567",
                         "autoExpireHours": 48})
    check("config put 200", r.status_code == 200, r.get_json())
    upsert = next((p for sql, p in conn.cur.executed
                   if "INSERT INTO portal_approvals_config" in sql), None)
    check("config digits normalized", upsert is not None
          and upsert[1] == "923001234567", upsert)

TEAM = dict(PRINCIPAL, role="member")
with Principal(portal_approvals, TEAM):
    r = client.put("/api/v1/portal/approvals/config",
                   json={"approvalNumber": "9230012345678"})
    check("config put member 403", r.status_code == 403, r.status_code)

portal_approvals.PortalAuthUnavailable = Exception
with Principal(portal_approvals, exc=Exception("db down")):
    r = client.get("/api/v1/portal/approvals")
    check("list auth down 503", r.status_code == 503, r.status_code)
del portal_approvals.PortalAuthUnavailable

print("== web surface ==")

RIG13 = "/tmp/p13/Omniflow/"

CONNECTOR = open(RIG13 + "omniflow-backend-patch/connector_api.py",
                 encoding="utf8").read()
check("connector claims approvals first",
      CONNECTOR.index('claimed_by = "approvals"')
      < CONNECTOR.index('claimed_by = "away"'), "order")
check("connector side-effect hook",
      "portal_approvals.maybe_request" in CONNECTOR, "hook")

SIDEBAR = open(RIG13 + "app/dashboard/components/DashSidebar.tsx",
               encoding="utf8").read()
SIDEBAR += "\n" + open(RIG13 + "app/dashboard/components/portalNav.ts",
               encoding="utf8").read()  # §246 nav entries live in portalNav.ts
check("sidebar entry", 'label: "Approvals"' in SIDEBAR
      and "/dashboard/approvals" in SIDEBAR, "sidebar")

import os
check("approvals page shipped", os.path.exists(
    RIG13 + "app/dashboard/(portal)/approvals/page.tsx"), "page")
check("bff routes shipped", all(os.path.exists(RIG13 + path) for path in (
    "app/api/omniflow/portal/approvals/route.ts",
    "app/api/omniflow/portal/approvals/config/route.ts",
    "app/api/omniflow/portal/approvals/[id]/decide/route.ts")), "bff")

PORTAL = open(RIG13 + "lib/omniflow/portal.ts", encoding="utf8").read()
check("portal.ts helpers", "export async function listApprovals" in PORTAL
      and "export async function decideApproval" in PORTAL
      and "export async function saveApprovalsConfig" in PORTAL, "helpers")

summary("approvals")
