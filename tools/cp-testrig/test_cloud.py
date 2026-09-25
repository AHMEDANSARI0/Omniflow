"""Tests for Cloud API template parity (991-1010): bridge->CP template sync
(replace-all snapshot), owner list, queued send_template with the thread row
+ audits, guards, and web pins (portal.ts, BFF depths, InteractiveCard
section, bridge dispatch + sync markers)."""
import json
import os

from flask import Flask

import portal_cloud
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_cloud.bp)
app.register_blueprint(portal_cloud.connector_bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
apikey = dict(human, via_api_key=True)
PrincipalStub(portal_cloud, principal=human)

CONV = {"id": 9, "contact_id": "923001234567", "contact_name": "Ali"}
TPL = {"id": 4, "name": "order_update", "language": "en",
       "status": "APPROVED", "category": "UTILITY"}


def fresh(script):
    portal_cloud._DDL_READY = True
    db = install_db_stub(portal_cloud, script)
    portal_cloud.portal_db.CMD_TABLE = "portal_connector_commands"
    portal_cloud.portal_db.MSGS_TABLE = "portal_messages"
    portal_cloud.portal_db.CONV_TABLE = "portal_conversations"
    return db


print("== connector sync ==")

os.environ["OMNIFLOW_SERVICE_KEY"] = "x"
response = client.post("/api/v1/connector/cloud-templates/sync",
                       json={"client_id": 1, "templates": []})
check("403 without key", status(response) == 403, status(response))

conn = fresh([[], [], [], []])
response = client.post(
    "/api/v1/connector/cloud-templates/sync",
    json={"client_id": 1, "templates": [
        {"name": "order_update", "language": "en", "status": "APPROVED",
         "category": "UTILITY"},
        {"name": "order_update", "language": "ur", "status": "APPROVED"},
        "junk",
        {"name": ""},
        {"name": "cod_confirm", "status": "PENDING"},
    ]},
    headers={"X-Omniflow-Key": "x"})
payload = response.get_json()
check("sync 200 dedupe", status(response) == 200 and payload["count"] == 2,
      payload)
del_sql, del_params = conn.cur.executed[0]
check("replace-all", "DELETE FROM portal_cloud_templates" in del_sql
      and del_params == (1,), del_sql[:60])
ins_sql, ins_params = conn.cur.executed[1]
check("insert first", "INSERT INTO portal_cloud_templates" in ins_sql
      and ins_params[1] == "order_update" and ins_params[2] == "en",
      ins_sql[:60])
check("audit synced", conn.cur.executed[3][1][1] == "cloud.synced"
      and "2 templates" in conn.cur.executed[3][1][5], conn.cur.executed[3][1])

conn = fresh([])
response = client.post("/api/v1/connector/cloud-templates/sync",
                       json={"templates": []},
                       headers={"X-Omniflow-Key": "x"})
check("400 client_id", status(response) == 400, status(response))

conn = fresh([RuntimeError("db down")])
response = client.post("/api/v1/connector/cloud-templates/sync",
                       json={"client_id": 1, "templates": []},
                       headers={"X-Omniflow-Key": "x"})
check("503 wrap sync", status(response) == 503, status(response))

print("== owner list ==")

conn = fresh([[TPL, {"id": 5, "name": "cod_confirm", "language": "ur",
                     "status": "PENDING", "category": "MARKETING"}]])
response = client.get("/api/v1/portal/cloud/templates")
payload = response.get_json()
check("list shape", status(response) == 200
      and payload["templates"][0]["name"] == "order_update"
      and payload["templates"][0]["status"] == "APPROVED"
      and len(payload["templates"]) == 2, payload)
check("approved first", "(status = 'APPROVED') DESC"
      in conn.cur.executed[0][0], conn.cur.executed[0][0][:120])

conn = fresh([RuntimeError("db down")])
response = client.get("/api/v1/portal/cloud/templates")
check("503 wrap list", status(response) == 503, status(response))

print("== send ==")

conn = fresh([])
response = client.post("/api/v1/portal/cloud/send", json={})
check("400 conversation", status(response) == 400
      and len(conn.cur.executed) == 0, status(response))

conn = fresh([])
response = client.post("/api/v1/portal/cloud/send",
                       json={"conversation_id": 9})
check("400 template", status(response) == 400, status(response))

conn = fresh([[]])
response = client.post("/api/v1/portal/cloud/send",
                       json={"conversation_id": 9,
                             "template_name": "order_update"})
check("404 conversation", status(response) == 404, status(response))

conn = fresh([[{"id": 9, "contact_id": "", "contact_name": ""}]])
response = client.post("/api/v1/portal/cloud/send",
                       json={"conversation_id": 9,
                             "template_name": "order_update"})
check("400 no contact", status(response) == 400, status(response))

conn = fresh([[CONV], [], [], [], []])
response = client.post("/api/v1/portal/cloud/send",
                       json={"conversation_id": 9,
                             "template_name": "order_update",
                             "language_code": "ur",
                             "parameters": ["Ali", "Kurti", ""]})
payload = response.get_json()
check("send 200", status(response) == 200 and payload["queued"] is True
      and payload["template"] == "order_update", payload)
queue_sql, queue_params = conn.cur.executed[1]
check("queued send_template", "'send_template'" in queue_sql
      and "portal_connector_commands" in queue_sql, queue_sql[:80])
command = json.loads(queue_params[2])
check("payload shape", command["external_user_id"] == "923001234567"
      and command["template_name"] == "order_update"
      and command["language_code"] == "ur"
      and command["parameters"] == ["Ali", "Kurti"]
      and command["source"] == "cloud_template", command)
msg_sql, msg_params = conn.cur.executed[2]
check("thread row", "INSERT INTO portal_messages" in msg_sql
      and "'out'" in msg_sql and "'Cloud API template'" in msg_sql,
      msg_sql[:90])
check("preview", "(template) order_update" in msg_params[2]
      and msg_params[0] == 9, msg_params)
check("conv touch", "SET last_message_preview" in conn.cur.executed[3][0],
      conn.cur.executed[3][0][:60])
check("audit sent", conn.cur.executed[4][1][1] == "cloud.sent"
      and "order_update" in conn.cur.executed[4][1][5]
      and "(ur)" in conn.cur.executed[4][1][5], conn.cur.executed[4][1])

# dict parameters accepted, blanks dropped
conn = fresh([[CONV], [], [], [], []])
response = client.post("/api/v1/portal/cloud/send",
                       json={"conversation_id": 9,
                             "template_name": "t",
                             "parameters": [{"value": "A"}, {"text": "B"}]})
check("dict params", status(response) == 200, status(response))
command = json.loads(conn.cur.executed[1][1][2])
check("dict values", command["parameters"] == ["A", "B"], command)

# default language + cap 10 params
conn = fresh([[CONV], [], [], [], []])
response = client.post("/api/v1/portal/cloud/send",
                       json={"conversation_id": 9, "template_name": "t",
                             "parameters": [str(i) for i in range(14)]})
command = json.loads(conn.cur.executed[1][1][2])
check("default lang + cap", command["language_code"] == "en"
      and len(command["parameters"]) == 10, command)

PrincipalStub(portal_cloud, principal=apikey)
conn = fresh([[CONV]])
response = client.post("/api/v1/portal/cloud/send",
                       json={"conversation_id": 9,
                             "template_name": "order_update"})
check("403 api-key send", status(response) == 403, status(response))
PrincipalStub(portal_cloud, principal=human)

conn = fresh([RuntimeError("db down")])
response = client.post("/api/v1/portal/cloud/send",
                       json={"conversation_id": 9,
                             "template_name": "order_update"})
check("503 wrap send", status(response) == 503, status(response))

print("== web + bridge shape ==")

PORTAL = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts", encoding="utf8").read()
for name in ("getCloudTemplates", "sendCloudTemplate"):
    check("client " + name, "export async function " + name in PORTAL, name)

for rel, up in [
    ("app/api/omniflow/portal/cloud/templates/route.ts", 6),
    ("app/api/omniflow/portal/cloud/send/route.ts", 6),
]:
    body = open("/tmp/p13/Omniflow/" + rel, encoding="utf8").read()
    check("bff " + rel.rsplit("/", 2)[-2], '"' + "../" * up + 'lib/' in body
          and "export async function" in body, rel)

CARD = open("/tmp/p13/Omniflow/app/dashboard/(portal)/conversations/[id]/"
            "InteractiveCard.tsx", encoding="utf8").read()
check("card cloud section", "Cloud API templates" in CARD
      and "/api/omniflow/portal/cloud/send" in CARD
      and "/api/omniflow/portal/cloud/templates" in CARD, "cloud section")

BRIDGE = open("/tmp/p13/src/control_plane_bridge.py",
              encoding="utf8").read()
check("bridge dispatch", 'elif action == "send_template":' in BRIDGE
      and "send_template_message(" in BRIDGE, "dispatch")
check("bridge sync", "def sync_message_templates(" in BRIDGE
      and "/message_templates?limit=200" in BRIDGE
      and "/api/v1/connector/cloud-templates/sync" in BRIDGE, "sync")
check("bridge throttle", "_last_template_sync" in BRIDGE
      and "import time" in BRIDGE, "throttle")

summary("cloud")
