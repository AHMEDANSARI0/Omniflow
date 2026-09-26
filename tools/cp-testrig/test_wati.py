"""Tests for the WATI provider integration: settings validation + masking,
approved-template sync (filtered snapshot), direct template send with the
outbound thread row + audits, guards, 503 wrap, and web pins."""
import json

from flask import Flask

import portal_wati
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_wati.bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
apikey = dict(human, via_api_key=True)
PrincipalStub(portal_wati, principal=human)


def fresh(script):
    portal_wati._WATI_DDL_READY = True
    db = install_db_stub(portal_wati, script)
    portal_wati.portal_db.CONV_TABLE = "portal_conversations"
    portal_wati.portal_db.MSGS_TABLE = "portal_messages"
    return db


SETTINGS_ROW = {"enabled": True, "base_url": "https://live-mt-server.wati.io/12345",
                "api_token": "eyJsecrettoken123456"}

print("== validation ==")

clean, error = portal_wati.validate_wati_settings(
    {"enabled": True, "base_url": "https://x.wati.io/", "api_token": "tok12345678"})
check("clean", error is None and clean["base_url"] == "https://x.wati.io"
      and clean["enabled"] is True, error)
check("disabled needs no url",
      portal_wati.validate_wati_settings({"enabled": False, "base_url": "",
                                          "api_token": ""})[1] is None, "-")
check("enabled needs url",
      portal_wati.validate_wati_settings({"enabled": True, "base_url": "",
                                          "api_token": "tok12345678"})[1]
      == "Base URL must start with http:// or https://.", "-")
check("enabled needs scheme",
      portal_wati.validate_wati_settings({"enabled": True,
                                          "base_url": "x.wati.io",
                                          "api_token": "tok12345678"})[1]
      == "Base URL must start with http:// or https://.", "-")
check("enabled needs token",
      portal_wati.validate_wati_settings({"enabled": True,
                                          "base_url": "https://x.wati.io",
                                          "api_token": "short"})[1]
      == "Paste the WATI API token (at least 8 characters).", "-")
check("enabled bool",
      portal_wati.validate_wati_settings({"enabled": "yes"})[1]
      == "enabled must be true or false.", "-")

print("== masking ==")

public = portal_wati._settings_public(SETTINGS_ROW)
check("token masked", public["tokenMasked"] == "****3456"
      and public["configured"] is True and public["enabled"] is True, public)
check("empty token", portal_wati._settings_public(
      {"enabled": False, "base_url": "", "api_token": ""})["tokenMasked"]
      == "", "-")

print("== settings endpoints ==")

conn = fresh([[]])
response = client.get("/api/v1/portal/wati/settings")
check("get defaults", status(response) == 200
      and response.get_json()["settings"]["enabled"] is False, status(response))

conn = fresh([[], []])
response = client.put("/api/v1/portal/wati/settings", json={
    "enabled": True, "base_url": "https://x.wati.io",
    "api_token": "tok12345678"})
check("put 200", status(response) == 200, status(response))
ins_sql, ins_params = conn.cur.executed[0]
check("upsert", "ON CONFLICT (client_id) DO UPDATE" in ins_sql
      and ins_params[1] == "https://x.wati.io"
      and ins_params[2] == "tok12345678", ins_sql[:60])
check("audit", conn.cur.executed[1][1][1] == "wati.settings",
      conn.cur.executed[1][1])

PrincipalStub(portal_wati, principal=apikey)
conn = fresh([[]])
response = client.put("/api/v1/portal/wati/settings",
                      json={"enabled": False})
check("403 api-key", status(response) == 403, status(response))
PrincipalStub(portal_wati, principal=human)

conn = fresh([])
response = client.put("/api/v1/portal/wati/settings",
                      json={"enabled": "yes"})
check("400 invalid", status(response) == 400, status(response))

print("== sync ==")

orig_fetch = portal_wati._fetch_wati_templates


def fake_fetch(base_url, token):
    assert base_url == "https://live-mt-server.wati.io/12345"
    return [
        {"name": "order_update", "status": "APPROVED", "variables": []},
        {"name": "pending_one", "status": "PENDING", "variables": []},
        {"name": "order_update", "status": "APPROVED", "variables": []},
        {"name": "cod_confirm", "status": "Approved", "variables": ["1"]},
        "junk",
    ]


portal_wati._fetch_wati_templates = fake_fetch
conn = fresh([[SETTINGS_ROW], [], [], [], []])
response = client.post("/api/v1/portal/wati/sync")
payload = response.get_json()
check("sync 200", status(response) == 200 and payload["count"] == 2, payload)
del_sql, del_params = conn.cur.executed[1]
check("replace-all", "DELETE FROM portal_wati_templates" in del_sql, del_sql[:50])
ins_sql, ins_params = conn.cur.executed[2]
check("insert approved", "INSERT INTO portal_wati_templates" in ins_sql
      and ins_params[1] == "order_update", ins_sql[:50])
check("audit synced", conn.cur.executed[4][1][1] == "wati.synced"
      and "2 approved" in conn.cur.executed[4][1][5], conn.cur.executed[4][1])

conn = fresh([[dict(SETTINGS_ROW, enabled=False)]])
response = client.post("/api/v1/portal/wati/sync")
check("sync needs enabled", status(response) == 400, status(response))
portal_wati._fetch_wati_templates = orig_fetch

print("== templates ==")

conn = fresh([[{"name": "order_update", "data": json.dumps({"variables": []})},
               {"name": "cod_confirm",
                "data": json.dumps({"variables": ["1"]})}]])
response = client.get("/api/v1/portal/wati/templates")
payload = response.get_json()
check("list shape", status(response) == 200
      and sorted(t["name"] for t in payload["templates"])
      == ["cod_confirm", "order_update"], payload)

print("== send ==")

orig_send = portal_wati._send_wati_template


def fake_send(base_url, token, number, template_name, parameters):
    assert number == "923001234567"
    assert template_name == "order_update"
    assert parameters == [{"name": "1", "value": "Ali"}]
    return True


portal_wati._send_wati_template = fake_send
conn = fresh([[SETTINGS_ROW],
              [{"id": 9, "contact_id": "923001234567",
                "contact_name": "Ali", "channel": "whatsapp"}],
              [{"id": 3}],
              [], [], []])
response = client.post("/api/v1/portal/wati/send", json={
    "conversation_id": 9, "template_name": "order_update",
    "parameters": [{"name": "1", "value": "Ali"}]})
payload = response.get_json()
check("send 200", status(response) == 200
      and payload["template"] == "order_update", payload)
msg_sql, msg_params = conn.cur.executed[3]
check("outbound row", "INSERT INTO portal_messages" in msg_sql
      and "'out'" in msg_sql
      and "'WATI template'" in msg_sql, msg_sql[:90])
check("preview", "(template) order_update" in msg_params[2]
      and msg_params[0] == 9, msg_params)
upd_sql, upd_params = conn.cur.executed[4]
check("conv touch", "SET last_message_preview" in upd_sql
      and upd_params[1] == 9, upd_sql[:60])
check("audit sent", conn.cur.executed[5][1][1] == "wati.sent"
      and "order_update" in conn.cur.executed[5][1][5],
      conn.cur.executed[5][1])

# string params (positional UI)
portal_wati._send_wati_template = lambda b, t, n, name, p: p == [
    {"name": "1", "value": "A"}, {"name": "2", "value": "B"}]
conn = fresh([[SETTINGS_ROW],
              [{"id": 9, "contact_id": "923001234567",
                "contact_name": "Ali", "channel": "whatsapp"}],
              [{"id": 3}], [], [], []])
response = client.post("/api/v1/portal/wati/send", json={
    "conversation_id": 9, "template_name": "order_update",
    "parameters": ["A", "B"]})
check("positional params", status(response) == 200, status(response))

# rejected send
portal_wati._send_wati_template = lambda b, t, n, name, p: False
conn = fresh([[SETTINGS_ROW],
              [{"id": 9, "contact_id": "923001234567",
                "contact_name": "Ali", "channel": "whatsapp"}],
              [{"id": 3}]])
response = client.post("/api/v1/portal/wati/send", json={
    "conversation_id": 9, "template_name": "order_update", "parameters": []})
check("502 rejected", status(response) == 502, status(response))
portal_wati._send_wati_template = fake_send

conn = fresh([[SETTINGS_ROW], [], []])
response = client.post("/api/v1/portal/wati/send", json={
    "conversation_id": 9, "template_name": "order_update"})
check("404 conversation", status(response) == 404, status(response))

conn = fresh([[SETTINGS_ROW],
              [{"id": 9, "contact_id": "923001234567",
                "contact_name": "Ali", "channel": "whatsapp"}],
              []])
response = client.post("/api/v1/portal/wati/send", json={
    "conversation_id": 9, "template_name": "nope"})
check("404 template not approved", status(response) == 404, status(response))

conn = fresh([[dict(SETTINGS_ROW, enabled=False)],
              [{"id": 9, "contact_id": "923001234567",
                "contact_name": "Ali", "channel": "whatsapp"}], []])
response = client.post("/api/v1/portal/wati/send", json={
    "conversation_id": 9, "template_name": "order_update"})
check("400 disabled", status(response) == 400, status(response))

PrincipalStub(portal_wati, principal=apikey)
conn = fresh([[SETTINGS_ROW]])
response = client.post("/api/v1/portal/wati/send", json={
    "conversation_id": 9, "template_name": "order_update"})
check("403 api-key send", status(response) == 403, status(response))
PrincipalStub(portal_wati, principal=human)

conn = fresh([RuntimeError("db down")])
response = client.get("/api/v1/portal/wati/templates")
check("503 wrap", status(response) == 503, status(response))

print("== web shape ==")

PORTAL = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts", encoding="utf8").read()
for name in ("getWatiSettings", "saveWatiSettings", "syncWatiTemplates",
             "listWatiTemplates", "sendWatiTemplate"):
    check("client " + name, "export async function " + name in PORTAL, name)

for rel, up in [
    ("app/api/omniflow/portal/wati/settings/route.ts", 6),
    ("app/api/omniflow/portal/wati/sync/route.ts", 6),
    ("app/api/omniflow/portal/wati/templates/route.ts", 6),
    ("app/api/omniflow/portal/wati/send/route.ts", 6),
]:
    body = open("/tmp/p13/Omniflow/" + rel, encoding="utf8").read()
    check("bff " + rel.rsplit("/", 2)[-2], '"' + "../" * up + 'lib/' in body, rel)

CARD = open("/tmp/p13/Omniflow/app/dashboard/(portal)/conversations/[id]/"
            "InteractiveCard.tsx", encoding="utf8").read()
check("card wati section", "WATI templates" in CARD
      and "/api/omniflow/portal/wati/send" in CARD
      and "/api/omniflow/portal/wati/templates" in CARD, "wati section")
SETTINGS = open("/tmp/p13/Omniflow/app/dashboard/(portal)/settings/page.tsx",
                encoding="utf8").read()
check("settings wati card", 'import WatiCard from "./WatiCard";' in SETTINGS
      and "<WatiCard />" in SETTINGS, "card")
WATICARD = open("/tmp/p13/Omniflow/app/dashboard/(portal)/settings/"
                "WatiCard.tsx", encoding="utf8").read()
check("wati card config", "Sync approved templates" in WATICARD
      and "wati/settings" in WATICARD and "wati/sync" in WATICARD, "config")

summary("wati")
