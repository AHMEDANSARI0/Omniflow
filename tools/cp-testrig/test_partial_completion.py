"""Tests for the partials batch: workspace/contact language, identity
linking, action requests, detect_language, ingest language hook and the
repeat-gap auto-escalation."""
import sys

from flask import Flask

import portal_contacts
import portal_growth
import test_lib
from test_lib import check, human_principal, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_contacts.bp)
client = app.test_client()

human = human_principal(client_id=1, user_id=11, email="ahmed@example.com")
PrincipalStub(portal_contacts, principal=human)


def fresh(script):
    portal_contacts._CONTACTS_DDL_READY = False
    return install_db_stub(portal_contacts, script)


CREATES = [[], [], [], []]  # 4 lazy CREATE TABLE executes

print("== detect_language ==")

check("urdu script", portal_contacts.detect_language("آپ کیسے ہیں؟") == "ur", "ur")
check("roman markers", portal_contacts.detect_language(
    "aap ko kitna chahiye") == "roman", "roman")
check("single marker stays en", portal_contacts.detect_language(
    "theek hai") == "en" or portal_contacts.detect_language(
    "theek hai") == "roman", "note")
check("english", portal_contacts.detect_language("Where is my order?") == "en", "en")
check("empty en", portal_contacts.detect_language("") == "en", "en")

print("== workspace language ==")

conn = fresh(CREATES + [[]])
response = client.get("/api/v1/portal/workspace/language")
check("200 default auto", status(response) == 200
      and response.get_json()["reply_language"] == "auto", status(response))

conn = fresh(CREATES + [[{"reply_language": "roman"}]])
response = client.get("/api/v1/portal/workspace/language")
check("200 saved value", response.get_json()["reply_language"] == "roman", "v")

response = client.put("/api/v1/portal/workspace/language", json={"language": "klingon"})
check("400 bad language", status(response) == 400, status(response))

conn = fresh(CREATES + [[], []])
response = client.put("/api/v1/portal/workspace/language", json={"language": "ur"})
check("200 save", status(response) == 200
      and response.get_json()["reply_language"] == "ur", status(response))
check("upsert sql", "ON CONFLICT (client_id)" in conn.cur.executed[4][0],
      conn.cur.executed[4][0][:90])
check("audit language", conn.cur.executed[5][1][1] == "workspace.language",
      conn.cur.executed[5][1])

print("== contact language ==")

response = client.get("/api/v1/portal/contacts/language")
check("400 no contact", status(response) == 400, status(response))

conn = fresh(CREATES + [[]])
response = client.get("/api/v1/portal/contacts/language?contact=92300@c.us")
check("200 null default", status(response) == 200
      and response.get_json()["lang"] is None, status(response))

conn = fresh(CREATES + [[{"lang": "ur", "updated_at": None}]])
response = client.get("/api/v1/portal/contacts/language?contact=92300@c.us")
check("200 stored", response.get_json()["lang"] == "ur", "v")

response = client.post("/api/v1/portal/contacts/language", json={"contact": "x"})
check("400 missing lang", status(response) == 400, status(response))

conn = fresh(CREATES + [[], []])
response = client.post("/api/v1/portal/contacts/language",
                       json={"contact": "92300@c.us", "lang": "auto"})
check("200 auto deletes", status(response) == 200, status(response))
check("delete sql", "DELETE FROM portal_contact_lang" in conn.cur.executed[4][0],
      conn.cur.executed[4][0][:90])
check("delete params", conn.cur.executed[4][1] == (1, "92300@c.us"),
      conn.cur.executed[4][1])

conn = fresh(CREATES + [[], []])
response = client.post("/api/v1/portal/contacts/language",
                       json={"contact": "92300@c.us", "lang": "ur"})
check("200 set", status(response) == 200 and response.get_json()["lang"] == "ur",
      status(response))
check("upsert sql", "DO UPDATE SET lang = EXCLUDED.lang"
      in conn.cur.executed[4][0], conn.cur.executed[4][0][:90])
check("contact audit", conn.cur.executed[5][1][1] == "contact.language",
      conn.cur.executed[5][1])

conn = fresh([])
response = client.post("/api/v1/portal/contacts/language/detect",
                       json={"text": "kya hal hai aap ka"})
check("200 detect", status(response) == 200, status(response))

response = client.post("/api/v1/portal/contacts/language/detect", json={})
check("400 no text", status(response) == 400, status(response))

print("== identity linking ==")

response = client.post("/api/v1/portal/contacts/link",
                       json={"contact_a": "aaa", "contact_b": "aaa"})
check("400 same contact", status(response) == 400, status(response))

conn = fresh(CREATES + [[], []])
response = client.post("/api/v1/portal/contacts/link",
                       json={"contact_a": "bbb", "contact_b": "aaa"})
check("200 link", status(response) == 200
      and response.get_json()["identity_key"] == "id:aaa-bbb", status(response))
check("pair insert", "VALUES (%s, 'whatsapp', %s, %s), (%s, 'whatsapp', %s, %s)"
      in conn.cur.executed[4][0], conn.cur.executed[4][0][:120])
check("pair params", conn.cur.executed[4][1][1] == "bbb"
      and conn.cur.executed[4][1][4] == "aaa"
      and conn.cur.executed[4][1][2] == "id:aaa-bbb", conn.cur.executed[4][1])
check("link audit", conn.cur.executed[5][1][1] == "contact.linked",
      conn.cur.executed[5][1])

conn = fresh(CREATES + [[{"contact_id": "aaa"}, {"contact_id": "92300@c.us"}]])
response = client.get("/api/v1/portal/contacts/identities?contact=92300@c.us")
check("200 linked excludes self", status(response) == 200
      and response.get_json()["linked"] == ["aaa"], status(response))

print("== action requests ==")

conn = fresh(CREATES + [[]])
response = client.post("/api/v1/portal/conversations/9/actions",
                       json={"kind": "refund_request"})
check("404 unknown conversation", status(response) == 404, status(response))

response = client.post("/api/v1/portal/conversations/9/actions",
                       json={"kind": "fire"})
check("400 bad kind", status(response) == 400, status(response))

conn = fresh(CREATES + [[{"contact_id": "92x"}], [{"id": 77}], []])
response = client.post("/api/v1/portal/conversations/9/actions",
                       json={"kind": "refund_request", "note": "damaged"})
check("200 created", status(response) == 200
      and response.get_json() == {"ok": True, "id": 77, "kind": "refund_request",
                                  "status": "pending"}, status(response))
check("conv lookup params", conn.cur.executed[4][1] == (9, 1),
      conn.cur.executed[4][1])
check("insert params", conn.cur.executed[5][1][3] == "refund_request"
      and conn.cur.executed[5][1][5] == "ahmed@example.com",
      conn.cur.executed[5][1])
check("action audit", conn.cur.executed[6][1][1] == "action.requested",
      conn.cur.executed[6][1])

conn = fresh(CREATES + [[]])
response = client.get("/api/v1/portal/contacts/actions?contact=92x&status=pending")
check("200 list", status(response) == 200
      and response.get_json()["actions"] == [], status(response))
check("filters in sql", "contact_id = %s" in conn.cur.executed[4][0]
      and "status = %s" in conn.cur.executed[4][0]
      and conn.cur.executed[4][1] == (1, "92x", "pending"),
      conn.cur.executed[4][1])
check("list capped 20", "LIMIT 20" in conn.cur.executed[4][0], "sql")

response = client.patch("/api/v1/portal/contacts/actions/7",
                        json={"status": "maybe"})
check("400 bad status", status(response) == 400, status(response))

conn = fresh(CREATES + [[]])
response = client.patch("/api/v1/portal/contacts/actions/7",
                        json={"status": "done"})
check("404 unknown action", status(response) == 404, status(response))

conn = fresh(CREATES + [[{"contact_id": "92x", "kind": "refund_request"}], []])
response = client.patch("/api/v1/portal/contacts/actions/7",
                        json={"status": "done"})
check("200 resolve", status(response) == 200
      and response.get_json()["status"] == "done", status(response))
check("resolve params", conn.cur.executed[4][1] == ("done", 7, 1),
      conn.cur.executed[4][1])
check("resolve audit", conn.cur.executed[5][1][1] == "action.resolved",
      conn.cur.executed[5][1])

print("== ingest language hook ==")

import portal_db as _db_holder

conn = install_db_stub(portal_contacts, [
    [{"lang": "ur"}],
])
portal_contacts.maybe_detect_language(1, "92300@c.us", "kya haal hai", conn)
check("existing lang skips insert", len(conn.cur.executed) == 1, conn.cur.executed)

conn = install_db_stub(portal_contacts, [
    [],
    [],
])
portal_contacts.maybe_detect_language(1, "92300@c.us", "آپ کیسے ہیں", conn)
check("insert on first sight", "ON CONFLICT (client_id, contact_id) DO NOTHING"
      in conn.cur.executed[1][0], conn.cur.executed[1][0][:100])
check("detected lang stored", conn.cur.executed[1][1][2] == "ur",
      conn.cur.executed[1][1])

conn = install_db_stub(portal_contacts, [])
portal_contacts.maybe_detect_language(1, "", "hello", conn)
check("blank contact no-op", len(conn.cur.executed) == 0, conn.cur.executed)

print("== repeat-gap auto escalation ==")

gconn = install_db_stub(portal_growth, [
    [{"auto_reply": True}],
    [],
    [{"total": 2}],
    [{"to_regclass": "portal_team_members"}],
    [{"user_id": 55}],
    [],
    [],
])
portal_growth.record_kb_gap(1, 9, "92x", "Ali", "kya price hai bhai", "general",
                            gconn)
kinds = [e[0] for e in gconn.cur.executed]
check("gap insert with count", any("RETURNING (SELECT COUNT(*)" in s for s in kinds),
      "sql")
check("team probe fired", any("to_regclass" in s for s in kinds), "probe")
check("assign executed", any("assigned_to" in s for s in kinds), "assign")
assign = [e for e in gconn.cur.executed if "assigned_to" in e[0]][0]
check("assign params", assign[1] == (55, 9, 1), assign[1])
escalation_audit = [e for e in gconn.cur.executed if "portal_action_log" in e[0]]
check("escalation audit", escalation_audit
      and escalation_audit[0][1][1] == "bot.escalated", "audit")

gconn = install_db_stub(portal_growth, [
    [{"auto_reply": True}],
    [],
    [{"total": 1}],
])
portal_growth.record_kb_gap(1, 9, "92x", "Ali", "delivery kab?", "shipping", gconn)
check("single gap no escalation", not any("assigned_to" in e[0]
      for e in gconn.cur.executed), "quiet")

gconn = install_db_stub(portal_growth, [
    [{"auto_reply": False}],
])
portal_growth.record_kb_gap(1, 9, "92x", "Ali", "anything", "general", gconn)
check("autoreply off skips", len(gconn.cur.executed) == 1, gconn.cur.executed)

print("== auth ==")

PrincipalStub(portal_contacts, principal=None)
response = client.get("/api/v1/portal/workspace/language")
check("401 unauth", status(response) == 401, status(response))
response = client.put("/api/v1/portal/workspace/language", json={"language": "ur"})
check("401 on write too", status(response) == 401, status(response))
response = client.post("/api/v1/portal/contacts/link",
                       json={"contact_a": "a", "contact_b": "b"})
check("401 link unauth", status(response) == 401, status(response))
PrincipalStub(portal_contacts, principal=human)

conn = fresh(CREATES + [[], []])
response = client.put("/api/v1/portal/workspace/language", json={"language": "ur"})
check("200 after restore", status(response) == 200, status(response))

sys.exit(1 if summary("partial_completion") else 0)
