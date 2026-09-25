"""251-265: Customer 360 — one endpoint aggregating a contact's whole history."""
import os

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")

from flask import Flask

import portal_conversations, test_lib
from test_lib import check, human_principal, install_db_stub, summary, PrincipalStub


def fresh(script):
    conn = install_db_stub(portal_conversations, script)
    portal_conversations.portal_db.NOTES_TABLE = "portal_conversation_notes"
    portal_conversations.portal_db.CONV_TAGS_TABLE = "portal_conversation_tags"
    portal_conversations.portal_db.CONV_TABLE = "portal_conversations"
    return conn


app = Flask(__name__)
app.register_blueprint(portal_conversations.bp)
client = app.test_client()
human = human_principal(client_id=1, user_id=11, email="ahmed@example.com")
PrincipalStub(portal_conversations, principal=human)

print("== validation ==")

conn = fresh([])
response = client.get("/api/v1/portal/customers/profile")
check("400 no contact", response.status_code == 400, response.status_code)

print("== full aggregation ==")

# slots: 1 summary + 2 conversations + 3 tags + 4 regclass(cod) + 5 cod rows
#        + 6 regclass(seq) + 7 seq rows + 8 notes
conn = fresh([
    [{"chats": 3, "open_chats": 1, "name": "Ali Khan", "has_hot": True,
      "max_lead_score": 90, "first_at": None, "last_at": None}],
    [{"id": 11, "status": "open", "channel": "whatsapp", "created_at": None,
      "last_message_at": None}],
    [{"tag": "VIP"}],
    [{"oid": "portal_cod_requests"}],
    [{"id": 3, "status": "confirmed", "created_at": None, "answered_at": None}],
    [{"oid": "portal_sequences"}],
    [{"name": "Welcome flow", "status": "active", "current_step": 1,
      "enrolled_at": None}],
    [{"body": "Prefers evening calls", "author_email": "ahmed@example.com",
      "created_at": None}],
    [{"oid": "portal_contact_lang"}],
    [{"lang": "roman"}],
    [{"oid": "portal_contact_identities"}],
    [{"contact_id": "tg:999"}],
    [{"oid": "portal_action_requests"}],
    [{"id": 4, "kind": "refund_request", "status": "pending", "note": "",
      "created_at": None}],
])
response = client.get("/api/v1/portal/customers/profile?contact=92300@c.us")
payload = response.get_json()
check("200 profile", response.status_code == 200, response.status_code)
check("identity", payload["contact_id"] == "92300@c.us"
      and payload["name"] == "Ali Khan", payload)
check("lead hot", payload["lead_temp"] == "hot", payload["lead_temp"])
check("counts", payload["chats"] == 3 and payload["open_chats"] == 1, payload)
check("tags deduped", payload["tags"] == ["VIP"], payload["tags"])
check("conversations", payload["conversations"][0]["id"] == 11
      and payload["conversations"][0]["status"] == "open", payload["conversations"])
check("cod included", payload["cod_requests"][0]["status"] == "confirmed",
      payload["cod_requests"])
check("sequences included", payload["sequences"][0]["name"] == "Welcome flow"
      and payload["sequences"][0]["current_step"] == 1, payload["sequences"])
check("notes included", payload["notes"][0]["body"] == "Prefers evening calls",
      payload["notes"])
check("language included", payload["language"] == "roman", payload["language"])
check("linked excludes self", payload["linked_channels"] == ["tg:999"],
      payload["linked_channels"])
check("actions included", payload["actions"][0]["kind"] == "refund_request"
      and payload["actions"][0]["status"] == "pending", payload["actions"])

sqls = [e[0] for e in conn.cur.executed]
check("summary scoped", "client_id = %s AND contact_id = %s" in sqls[0], "scope")
check("convs limited 20", "LIMIT 20" in sqls[1], "limit")
check("tags distinct", "DISTINCT ct.tag" in sqls[2], "distinct")
check("regclass guards", "to_regclass" in sqls[3] and "to_regclass" in sqls[5],
      "guards")
check("regclass new tables", "to_regclass" in sqls[8]
      and "to_regclass" in sqls[10] and "to_regclass" in sqls[12], "guards")
check("cod scoped by contact", "contact_id = %s" in sqls[4], "scope")
check("seq joined to names", "JOIN" in sqls[6] and "s.id = e.sequence_id" in sqls[6],
      "join")
check("notes joined via conv", "conv.id = n.conversation_id" in sqls[7], "join")
check("warm fallback", "max_score >= WARM_LEAD_SCORE" in
      open("portal_conversations.py", encoding="utf8").read()
      .split("def customer_profile")[1], "warm")

print("== missing optional tables degrade gracefully ==")

conn = fresh([
    [{"chats": 0, "open_chats": 0, "name": "", "has_hot": None,
      "max_lead_score": None, "first_at": None, "last_at": None}],
    [],
    [],
    [{"oid": None}],
    [{"oid": None}],
    [{"oid": None}],
    [],
    [{"oid": None}],
    [],
    [{"oid": None}],
    [],
])
response = client.get("/api/v1/portal/customers/profile?contact=92300@c.us")
payload = response.get_json()
check("200 without optional tables", response.status_code == 200, response.status_code)
check("empty cod", payload["cod_requests"] == [], payload["cod_requests"])
check("empty sequences", payload["sequences"] == [], payload["sequences"])
check("cold default", payload["lead_temp"] == "cold", payload["lead_temp"])
check("no conversations", payload["conversations"] == [], payload["conversations"])
check("language null degrade", payload["language"] is None, payload["language"])
check("linked empty degrade", payload["linked_channels"] == [],
      payload["linked_channels"])
check("actions empty degrade", payload["actions"] == [], payload["actions"])

PrincipalStub(portal_conversations, principal=None)
conn = fresh([])
response = client.get("/api/v1/portal/customers/profile?contact=92300@c.us")
check("401 unauth", response.status_code == 401, response.status_code)
PrincipalStub(portal_conversations, principal=human)

check("endpoint after customers list", open("portal_conversations.py", encoding="utf8")
      .read().rfind("def list_customers")
      < open("portal_conversations.py", encoding="utf8").read()
      .rfind("def customer_profile"), "order")

summary("customer_360")
