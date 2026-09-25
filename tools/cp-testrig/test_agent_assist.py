"""Tests for agent assist v0 (deterministic KB suggestions + hints)."""
import sys

from flask import Flask

import portal_conversations
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_conversations.bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
PrincipalStub(portal_conversations, principal=human)

URL = "/api/v1/portal/conversations/42/assist"

print("== tokens ==")

tokens = portal_conversations._assist_tokens("What is the refund status?")
check("stopwords removed", "what" not in tokens and "the" not in tokens, tokens)
check("content kept", {"refund", "status"} <= tokens, tokens)
check("short words dropped", "is" not in tokens, tokens)

print("== assist endpoint ==")

conn = install_db_stub(portal_conversations, [[]])
portal_conversations.portal_db.CONV_TABLE = "portal_conversations"
portal_conversations.portal_db.MSGS_TABLE = "portal_messages"
response = client.get(URL)
check("404 unknown conversation", status(response) == 404, status(response))

PROBE = [{"oid": "portal_kb_entries"}]
conn = install_db_stub(portal_conversations, [
    [{"contact_id": "92300@c.us"}],
    [{"body": "order #123 kab aay"}, {"body": "refund chahiye"}],
    PROBE,
    [
        {"id": 5, "question": "refund policy kya hai",
         "answer": "7 din ke andar refund ho jata hai."},
        {"id": 6, "question": "delivery time kitna hai",
         "answer": "2-3 din."},
    ],
    PROBE,
    [{"lang": "roman"}],
    PROBE,
    [{"contact_id": "tg:999"}],
])
portal_conversations.portal_db.CONV_TABLE = "portal_conversations"
portal_conversations.portal_db.MSGS_TABLE = "portal_messages"
response = client.get(URL)
payload = response.get_json()
check("200 assist", status(response) == 200, status(response))
check("intent refund", payload["intent"] == "refund", payload["intent"])
check("language hint", payload["language"] == "roman", payload)
check("linked hint", payload["linked"] == ["tg:999"], payload)
check("suggestion top", payload["suggestions"][0]["id"] == 5
      and "refund" in payload["suggestions"][0]["matched"],
      payload["suggestions"])
check("snippet trimmed", len(payload["suggestions"][0]["snippet"]) <= 160,
      payload["suggestions"][0]["snippet"])
check("based_on chronological", payload["based_on"].endswith("order #123 kab aay"),
      payload["based_on"])
check("conversation scoped", "id = %s AND client_id = %s"
      in conn.cur.executed[0][0]
      and conn.cur.executed[0][1] == (42, 1), conn.cur.executed[0][1])
check("inbound only latest 3", "direction = 'in'" in conn.cur.executed[1][0]
      and "LIMIT 3" in conn.cur.executed[1][0], "sql")
check("kb limited 200", "LIMIT 200" in conn.cur.executed[3][0], "sql")

conn = install_db_stub(portal_conversations, [
    [{"contact_id": "92300@c.us"}],
    [{"body": "salam"}],
    [],
    [],
    [],
])
response = client.get(URL)
payload = response.get_json()
check("no kb table degrades", status(response) == 200
      and payload["suggestions"] == [] and payload["language"] is None, payload)

conn = install_db_stub(portal_conversations, [
    [{"contact_id": "92300@c.us"}],
    [{"body": "price kitna hai delivery kab hai payment kaise hai tracking kahan"},
     {"body": "refund chahiye discount chahiye delivery kab hai"}],
    PROBE,
    [
        {"id": 1, "question": "delivery time", "answer": "a"},
        {"id": 2, "question": "delivery charges", "answer": "b"},
        {"id": 3, "question": "delivery updates", "answer": "c"},
        {"id": 4, "question": "refund policy", "answer": "d"},
    ],
    [],
    [],
])
response = client.get(URL)
payload = response.get_json()
check("suggestions capped at 2", len(payload["suggestions"]) == 2,
      payload["suggestions"])
check("best first", payload["suggestions"][0]["score"]
      >= payload["suggestions"][1]["score"], payload["suggestions"])

conn = install_db_stub(portal_conversations, [
    [{"contact_id": "92300@c.us"}],
    [],
    PROBE,
    [{"id": 8, "question": "nothing matching", "answer": "x"}],
    [],
    [],
])
response = client.get(URL)
payload = response.get_json()
check("no overlap no suggestions", payload["suggestions"] == [], payload)

PrincipalStub(portal_conversations, principal=None)
response = client.get(URL)
check("401 unauth", status(response) == 401, status(response))

sys.exit(1 if summary("agent_assist") else 0)
