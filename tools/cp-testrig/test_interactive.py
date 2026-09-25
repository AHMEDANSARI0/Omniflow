"""Tests for interactive WhatsApp messages: template validation against the
Cloud API limits, CRUD + audits, send_interactive queue payload, reply
normalization, and the web surface (BFF depths + card pins)."""
import json

from flask import Flask

import portal_interactive
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_interactive.bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
apikey = dict(human, via_api_key=True)
PrincipalStub(portal_interactive, principal=human)


def fresh(script):
    portal_interactive._INTERACTIVE_DDL_READY = True
    db = install_db_stub(portal_interactive, script)
    portal_interactive.portal_db.CONV_TABLE = "portal_conversations"
    portal_interactive.portal_db.CMD_TABLE = "portal_commands"
    return db


GOOD_BUTTONS = {
    "name": "Pay now", "kind": "buttons", "body": "Choose an option",
    "rows": [{"title": "Pay online"}, {"title": "Track order"},
             {"title": "Talk to us"}],
}

GOOD_LIST = {
    "name": "Help menu", "kind": "list", "header": "Help",
    "body": "Pick a topic", "footer": "OmniFlow",
    "list_label": "Open menu",
    "rows": [{"title": "Order status", "description": "Where is it?"},
             {"title": "Returns"}],
}

print("== validation ==")

clean, error = portal_interactive.validate_template(GOOD_BUTTONS)
check("buttons clean", error is None and clean["kind"] == "buttons"
      and clean["list_label"] == "" and len(clean["rows"]) == 3, error)
clean, error = portal_interactive.validate_template(GOOD_LIST)
check("list clean", error is None and clean["list_label"] == "Open menu"
      and clean["rows"][0]["description"] == "Where is it?", error)
check("list default label",
      portal_interactive.validate_template(
          {"name": "n", "kind": "list", "body": "b",
           "rows": [{"title": "a"}]})[0]["list_label"] == "Choose one", "-")
check("name required",
      portal_interactive.validate_template({"kind": "buttons", "body": "b",
                                            "rows": [{"title": "a"}]})
      == (None, "Template name is required."), "-")
check("kind invalid",
      portal_interactive.validate_template({"name": "n", "kind": "menu",
                                            "body": "b",
                                            "rows": [{"title": "a"}]})
      == (None, "kind must be buttons or list."), "-")
check("body required",
      portal_interactive.validate_template({"name": "n", "kind": "buttons",
                                            "rows": [{"title": "a"}]})
      == (None, "Body text is required."), "-")
check("body cap 1024",
      portal_interactive.validate_template(
          {"name": "n", "kind": "buttons", "body": "x" * 1025,
           "rows": [{"title": "a"}]})[1] == "Body is limited to 1024"
      " characters.", "-")
check("button cap 3",
      portal_interactive.validate_template(
          {"name": "n", "kind": "buttons", "body": "b",
           "rows": [{"title": "a"}, {"title": "b"}, {"title": "c"},
                    {"title": "d"}]})[1] == "Give 1 to 3 buttons.", "-")
check("button title 20",
      portal_interactive.validate_template(
          {"name": "n", "kind": "buttons", "body": "b",
           "rows": [{"title": "x" * 21}]})[1]
      == "Button titles are limited to 20 characters.", "-")
check("list cap 10",
      portal_interactive.validate_template(
          {"name": "n", "kind": "list", "body": "b",
           "rows": [{"title": "r%d" % i} for i in range(11)]})[1]
      == "Give 1 to 10 list options.", "-")
check("row title 24",
      portal_interactive.validate_template(
          {"name": "n", "kind": "list", "body": "b",
           "rows": [{"title": "x" * 25}]})[1]
      == "Option titles are limited to 24 characters.", "-")
check("row desc 72",
      portal_interactive.validate_template(
          {"name": "n", "kind": "list", "body": "b",
           "rows": [{"title": "a", "description": "x" * 73}]})[1]
      == "Option descriptions are limited to 72 characters.", "-")
check("dup titles",
      portal_interactive.validate_template(
          {"name": "n", "kind": "buttons", "body": "b",
           "rows": [{"title": "Same"}, {"title": "same"}]})[1]
      == "Option titles must be unique.", "-")

print("== payload build ==")

message = portal_interactive.build_interactive_payload(
    {"kind": "buttons", "body": "Choose", "header": "Hi", "footer": "OF",
     "rows": [{"title": "One"}, {"title": "Two"}]})
check("buttons shape", message["type"] == "interactive"
      and message["interactive"]["type"] == "button"
      and message["interactive"]["action"]["buttons"][1]["reply"]
      == {"id": "of_b2", "title": "Two"}
      and message["interactive"]["header"] == {"type": "text", "text": "Hi"},
      message)
message = portal_interactive.build_interactive_payload(
    {"kind": "list", "body": "Pick", "list_label": "Menu",
     "rows": [{"title": "A", "description": "first"}, {"title": "B"}]})
check("list shape", message["interactive"]["type"] == "list"
      and message["interactive"]["action"]["button"] == "Menu"
      and message["interactive"]["action"]["sections"][0]["rows"][0]
      == {"id": "of_r1", "title": "A", "description": "first"}, message)

print("== reply normalization ==")

check("button reply title",
      portal_interactive.interactive_body_override(
          {"type": "button_reply", "id": "of_b1", "title": "Pay online"}, "")
      == "Pay online", "-")
check("list reply id fallback",
      portal_interactive.interactive_body_override(
          {"type": "list_reply", "id": "of_r3"}, "")
      == "of_r3", "-")
check("wrong type none",
      portal_interactive.interactive_body_override(
          {"type": "text", "title": "x"}, "keep") is None, "-")
check("non dict none",
      portal_interactive.interactive_body_override("nope", "keep") is None, "-")

print("== crud ==")

conn = fresh([[{"id": 5, "name": "Pay now", "kind": "buttons",
                "header": "", "body": "Choose", "footer": "",
                "rows": [{"title": "Pay online"}], "list_label": "",
                "created_at": __import__("datetime").datetime(2026, 1, 1)}]])
response = client.get("/api/v1/portal/interactive/templates")
payload = response.get_json()
check("list 200 + rows", status(response) == 200
      and payload["templates"][0]["rows"][0]["title"] == "Pay online", payload)

conn = fresh([[{"id": 7, "name": "Pay now", "kind": "buttons",
                "header": "", "body": "Choose", "footer": "",
                "rows": [{"title": "Pay online"}], "list_label": "",
                "created_at": None}], []])
response = client.post("/api/v1/portal/interactive/templates",
                       json=GOOD_BUTTONS)
check("create 200", status(response) == 200, status(response))
ins_sql, ins_params = conn.cur.executed[0]
check("create insert", "INSERT INTO portal_interactive_templates" in ins_sql
      and ins_params[2] == "buttons"
      and json.loads(ins_params[6])[0]["title"] == "Pay online", ins_sql[:60])
check("create audit", conn.cur.executed[1][1][1] == "interactive.created",
      conn.cur.executed[1][1])

PrincipalStub(portal_interactive, principal=apikey)
conn = fresh([])
response = client.post("/api/v1/portal/interactive/templates",
                       json=GOOD_BUTTONS)
check("403 api-key create", status(response) == 403, status(response))
conn = fresh([[{"id": 9, "contact_id": "923001234567",
                "contact_name": "Ali"}]])
response = client.post("/api/v1/portal/interactive/send",
                       json={"conversation_id": 9, "template_id": 3})
check("403 api-key send", status(response) == 403, status(response))
PrincipalStub(portal_interactive, principal=human)

conn = fresh([[{"id": 5}], []])
response = client.put("/api/v1/portal/interactive/templates/5",
                      json=GOOD_LIST)
check("update 200", status(response) == 200
      and conn.cur.executed[1][1][1] == "interactive.updated", status(response))
conn = fresh([[]])
response = client.put("/api/v1/portal/interactive/templates/5", json=GOOD_LIST)
check("update 404", status(response) == 404, status(response))

conn = fresh([[{"id": 5}], []])
response = client.delete("/api/v1/portal/interactive/templates/5")
check("delete 200", status(response) == 200
      and conn.cur.executed[1][1][1] == "interactive.deleted", status(response))
conn = fresh([[]])
response = client.delete("/api/v1/portal/interactive/templates/5")
check("delete 404", status(response) == 404, status(response))

print("== send ==")

conn = fresh([[{"id": 9, "contact_id": "923001234567",
                "contact_name": "Ali"}],
              [{"id": 3, "name": "Help menu", "kind": "list",
                "header": "Help", "body": "Pick a topic", "footer": "OF",
                "rows": json.dumps([{"title": "Order status",
                                     "description": "Where is it?"},
                                    {"title": "Returns"}]),
                "list_label": "Open menu"}],
              [], []])
response = client.post("/api/v1/portal/interactive/send",
                       json={"conversation_id": 9, "template_id": 3})
payload = response.get_json()
check("send 200", status(response) == 200 and payload["kind"] == "list"
      and payload["action"] == "send_interactive", payload)
cmd_sql, cmd_params = conn.cur.executed[2]
check("cmd send_interactive", "send_interactive" in cmd_sql
      and cmd_params[1] == "whatsapp", cmd_sql[:80])
queued = json.loads(cmd_params[2])
check("cmd payload", queued["external_user_id"] == "923001234567"
      and queued["source"] == "interactive"
      and queued["interactive"]["interactive"]["action"]["button"] == "Open menu"
      and queued["interactive"]["interactive"]["action"]["sections"][0]["rows"][1]
      == {"id": "of_r2", "title": "Returns"}
      and queued["target_display_name"] == "Ali", queued)
check("send audit", conn.cur.executed[3][1][1] == "interactive.sent"
      and "Help menu" in conn.cur.executed[3][1][5], conn.cur.executed[3][1])

conn = fresh([[], []])
response = client.post("/api/v1/portal/interactive/send",
                       json={"conversation_id": 9, "template_id": 3})
check("404 conversation", status(response) == 404, status(response))

conn = fresh([[{"id": 9, "contact_id": "", "contact_name": None}], []])
response = client.post("/api/v1/portal/interactive/send",
                       json={"conversation_id": 9, "template_id": 3})
check("400 no contact", status(response) == 400, status(response))

conn = fresh([[{"id": 9, "contact_id": "923001234567", "contact_name": "Ali"}],
              [], []])
response = client.post("/api/v1/portal/interactive/send",
                       json={"conversation_id": 9, "template_id": 99})
check("404 template", status(response) == 404, status(response))

conn = fresh([RuntimeError("db down")])
response = client.get("/api/v1/portal/interactive/templates")
check("503 wrap", status(response) == 503, status(response))

print("== web shape ==")

PORTAL = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts", encoding="utf8").read()
for name in ("listInteractiveTemplates", "createInteractiveTemplate",
             "updateInteractiveTemplate", "deleteInteractiveTemplate",
             "sendInteractiveTemplate"):
    check("client " + name, "export async function " + name in PORTAL, name)
check("type InteractiveTemplate", "export interface InteractiveTemplate"
      in PORTAL, "type")

BFF6 = [
    "app/api/omniflow/portal/interactive/templates/route.ts",
    "app/api/omniflow/portal/interactive/send/route.ts",
]
for rel in BFF6:
    body = open("/tmp/p13/Omniflow/" + rel, encoding="utf8").read()
    check("bff 6-up " + rel.rsplit("/", 2)[-2],
          '"' + "../" * 6 + 'lib/' in body, rel)
BFF7 = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/interactive/templates/[id]/route.ts",
    encoding="utf8").read()
check("bff 7-up [id]", '"' + "../" * 7 + 'lib/' in BFF7, "[id]")

CARD = open("/tmp/p13/Omniflow/app/dashboard/(portal)/conversations/[id]/"
            "InteractiveCard.tsx", encoding="utf8").read()
THREAD = open("/tmp/p13/Omniflow/app/dashboard/(portal)/conversations/[id]/"
              "ThreadClient.tsx", encoding="utf8").read()
check("card builder labels", "Buttons (3)" in CARD and "List (10)" in CARD
      and "Save template" in CARD and "Interactive message" in CARD, "card")
check("card send flow", "/api/omniflow/portal/interactive/send" in CARD, "send")
check("thread renders card", 'import("./InteractiveCard")' in THREAD
      and "<InteractiveCard conversationId={Number(id)} />" in THREAD, "thread")

summary("interactive")
