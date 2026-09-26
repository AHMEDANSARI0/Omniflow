"""Tests for the growth pack: sentiment, churn, staffing, broadcast
suggestions, negotiation, listening and routing (all deterministic)."""
import sys

from flask import Flask

import portal_insights
import portal_listen
import portal_negotiation
import portal_routing
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_insights.bp)
app.register_blueprint(portal_negotiation.bp)
app.register_blueprint(portal_listen.bp)
app.register_blueprint(portal_routing.bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
for module in (portal_insights, portal_negotiation, portal_listen, portal_routing):
    PrincipalStub(module, principal=human)


def fresh(module, script):
    flag = {"portal_negotiation": "_NEGOTIATION_DDL_READY",
            "portal_listen": "_LISTEN_DDL_READY",
            "portal_routing": "_ROUTING_DDL_READY"}.get(module.__name__)
    if flag:
        setattr(module, flag, True)  # skip DDL executes in stubs
    return install_db_stub(module, script)

print("== sentiment ==")

result = portal_insights.analyze_sentiment("shukriya acha kaam kiya")
check("positive label", result["label"] == "positive" and result["score"] > 0,
      result)
result = portal_insights.analyze_sentiment("bahut kharab service, shikayat hai")
check("negative label", result["label"] == "negative"
      and "kharab" in result["negative"], result)
result = portal_insights.analyze_sentiment("order kab aay ga bhai")
check("neutral label", result["label"] == "neutral", result)
result = portal_insights.analyze_sentiment("acha lakin late")
check("mixed label", result["label"] == "mixed", result)
response = client.get("/api/v1/portal/insights/sentiment?text=shukriya")
check("sentiment endpoint", status(response) == 200
      and response.get_json()["label"] == "positive", status(response))
response = client.get("/api/v1/portal/insights/sentiment")
check("400 no text", status(response) == 400, status(response))

print("== churn ==")

ROWS = [{"contact_id": "92x", "name": "Ali", "chats": 3, "last_at": None}]
conn = install_db_stub(portal_insights, [ROWS])
portal_insights.portal_db.CONV_TABLE = "portal_conversations"
response = client.get("/api/v1/portal/insights/churn?days=30")
check("200 churn", status(response) == 200
      and response.get_json()["contacts"][0]["contact_id"] == "92x"
      and response.get_json()["days"] == 30, status(response))
check("churn sql window", "make_interval(days => %s)" in conn.cur.executed[0][0]
      and conn.cur.executed[0][1] == (1, 30), conn.cur.executed[0][1])
response = client.get("/api/v1/portal/insights/churn?days=999")
check("400 churn days", status(response) == 400, status(response))

print("== staffing ==")

HOURS = [{"hour": 9, "total": 4}, {"hour": 21, "total": 10},
         {"hour": 22, "total": 7}]
conn = install_db_stub(portal_insights, [HOURS])
response = client.get("/api/v1/portal/insights/staffing")
payload = response.get_json()
check("200 staffing", status(response) == 200
      and len(payload["hours"]) == 24, status(response))
check("peak detected", payload["peak_hour"] == 21
      and payload["peak_chats"] == 10, payload["peak_hour"])
check("suggested threshold", 21 in payload["suggested"]
      and 22 in payload["suggested"] and 9 not in payload["suggested"],
      payload["suggested"])
check("missing hours zeroed", payload["hours"][0]["chats"] == 0, "fill")
check("staffing join in-only", "m.direction = 'in'" in conn.cur.executed[0][0]
      and "28 days" in conn.cur.executed[0][0], "sql")

print("== broadcast suggestions ==")

conn = install_db_stub(portal_insights, [
    [{"hot": 5, "open_chats": 12, "total": 40}],
    [{"oid": "portal_optouts"}],
    [{"total": 3}],
])
response = client.get("/api/v1/portal/insights/broadcast-suggestions")
payload = response.get_json()
check("200 suggestions", status(response) == 200
      and len(payload["suggestions"]) == 3, status(response))
audiences = {s["audience"]: s["count"] for s in payload["suggestions"]}
check("hot count", audiences["hot"] == 5, audiences)
check("stale derived", audiences["stale"] == 28, audiences)
check("optouts excluded", audiences["all"] == 37, audiences)

print("== negotiation ==")

conn = fresh(portal_negotiation, [[]])
portal_negotiation.portal_db.ensure_tables = lambda: None
response = client.get("/api/v1/portal/negotiation/settings")
check("200 defaults", status(response) == 200
      and response.get_json()["settings"] == {
          "enabled": False, "floor_percent": 0, "max_percent": 25},
      status(response))

conn = fresh(portal_negotiation, [[], []])
response = client.put("/api/v1/portal/negotiation/settings",
                      json={"enabled": True, "floor_percent": 5,
                            "max_percent": 20})
check("200 save", status(response) == 200
      and response.get_json()["settings"]["max_percent"] == 20, status(response))
check("upsert sql", "ON CONFLICT (client_id)" in conn.cur.executed[0][0], "sql")
check("audit", conn.cur.executed[1][1][1] == "negotiation.settings",
      conn.cur.executed[1][1])

response = client.put("/api/v1/portal/negotiation/settings",
                      json={"floor_percent": 30, "max_percent": 10})
check("400 max < floor", status(response) == 400, status(response))
response = client.put("/api/v1/portal/negotiation/settings",
                      json={"floor_percent": 99})
check("400 range", status(response) == 400, status(response))

conn = fresh(portal_negotiation, [
    [{"enabled": True, "floor_percent": 0, "max_percent": 25}],
])
response = client.get("/api/v1/portal/negotiation/quote?ask=1500&price=2000")
payload = response.get_json()
check("quote accepts at exact max", status(response) == 200
      and payload["verdict"] == "accept" and payload["counter"] == 1500.0
      and payload["discount_percent"] == 25.0, payload)

conn = fresh(portal_negotiation, [
    [{"enabled": True, "floor_percent": 0, "max_percent": 25}],
])
response = client.get("/api/v1/portal/negotiation/quote?ask=1400&price=2000")
payload = response.get_json()
check("quote counters beyond max", payload["verdict"] == "counter"
      and payload["counter"] == 1500.0
      and payload["discount_percent"] == 30.0, payload)

conn = fresh(portal_negotiation, [
    [{"enabled": True, "floor_percent": 0, "max_percent": 25}],
])
response = client.get("/api/v1/portal/negotiation/quote?ask=1900&price=2000")
payload = response.get_json()
check("quote accepts small discount", payload["verdict"] == "accept"
      and payload["counter"] == 1900.0, payload)

conn = fresh(portal_negotiation, [
    [{"enabled": True, "floor_percent": 0, "max_percent": 25}],
])
response = client.get("/api/v1/portal/negotiation/quote?ask=2500&price=2000")
payload = response.get_json()
check("quote accepts over-ask", payload["verdict"] == "accept"
      and payload["discount_percent"] == 0.0, payload)

response = client.get("/api/v1/portal/negotiation/quote?ask=-5&price=10")
check("400 bad ask", status(response) == 400, status(response))

print("== listen ==")

conn = fresh(portal_listen, [
    [{"id": 1, "keyword": "franchise", "note": "", "created_at": None}],
])
response = client.get("/api/v1/portal/listen/rules")
check("200 rules", status(response) == 200
      and response.get_json()["rules"][0]["keyword"] == "franchise",
      status(response))

conn = fresh(portal_listen, [[{"total": 0}], [], [{"id": 7}], []])
response = client.post("/api/v1/portal/listen/rules",
                       json={"keyword": "Bulk Order", "note": "B2B"})
check("200 add keyword lowered", status(response) == 200
      and response.get_json()["rule"]["keyword"] == "bulk order",
      status(response))
check("rule cap counted", "COUNT(*)" in conn.cur.executed[0][0], "cap")
check("plan gate consulted", "portal_plan_settings" in
      conn.cur.executed[1][0], conn.cur.executed[1][0][:80])
check("upsert on keyword", "ON CONFLICT (client_id, keyword)" in
      conn.cur.executed[2][0], conn.cur.executed[2][0][:90])

conn = fresh(portal_listen, [[{"total": 20}]])
response = client.post("/api/v1/portal/listen/rules", json={"keyword": "x"})
check("400 cap reached", status(response) == 400, status(response))

conn = fresh(portal_listen, [[]])
response = client.post("/api/v1/portal/listen/rules", json={})
check("400 no keyword", status(response) == 400, status(response))

conn = fresh(portal_listen, [[{"keyword": "franchise"}], []])
response = client.delete("/api/v1/portal/listen/rules/3")
check("200 delete", status(response) == 200, status(response))

conn = fresh(portal_listen, [[]])
response = client.delete("/api/v1/portal/listen/rules/99")
check("404 unknown rule", status(response) == 404, status(response))

HITS = [{"id": 2, "conversation_id": 8, "contact_id": "92x",
         "snippet": "bulk order quote", "created_at": None,
         "keyword": "bulk order"}]
conn = fresh(portal_listen, [HITS])
response = client.get("/api/v1/portal/listen/hits")
check("200 hits join", status(response) == 200
      and response.get_json()["hits"][0]["keyword"] == "bulk order",
      status(response))
check("hits join sql", "JOIN portal_listen_rules" in conn.cur.executed[0][0],
      conn.cur.executed[0][0][:120])

conn = fresh(portal_listen, [
    [{"id": 4, "keyword": "franchise"}],
    [],
    [],
])
portal_listen.maybe_listen(1, 8, "92x", "Franchise chahiye?", conn)
inserts = [e for e in conn.cur.executed if "portal_listen_hits" in e[0]]
check("hook inserts hit", len(inserts) == 1
      and inserts[0][1][1] == 4 and inserts[0][1][2] == 8, inserts)
audits = [e for e in conn.cur.executed if "portal_action_log" in e[0]]
check("hook audits listen.hit", audits and audits[0][1][1] == "listen.hit",
      "audit")
check("snippet window", "franchise" in inserts[0][1][4], inserts[0][1][4])

conn = fresh(portal_listen, [
    [{"id": 4, "keyword": "zzz"}],
])
portal_listen.maybe_listen(1, 8, "92x", "nothing relevant", conn)
check("no match no insert", len(conn.cur.executed) == 1, conn.cur.executed)

print("== routing ==")

RULES = [{"id": 1, "match_text": "refund", "user_id": 55, "priority": 10}]
conn = fresh(portal_routing, [RULES])
response = client.get("/api/v1/portal/routing/rules")
check("200 rules ordered", status(response) == 200
      and response.get_json()["rules"][0]["user_id"] == 55
      and "ORDER BY priority ASC" in conn.cur.executed[0][0], status(response))

conn = fresh(portal_routing, [[{"total": 0}], [{"id": 9}], []])
response = client.post("/api/v1/portal/routing/rules",
                       json={"match": "wholesale", "user_id": 55,
                             "priority": 5})
check("200 add", status(response) == 200
      and response.get_json()["id"] == 9, status(response))
check("match lowered", conn.cur.executed[1][1][1] == "wholesale",
      conn.cur.executed[1][1])

response = client.post("/api/v1/portal/routing/rules",
                       json={"match": "x", "user_id": 0})
check("400 bad user", status(response) == 400, status(response))
response = client.post("/api/v1/portal/routing/rules",
                       json={"match": "x", "user_id": 5, "priority": 0})
check("400 bad priority", status(response) == 400, status(response))

conn = fresh(portal_routing, [[{"id": 1}], []])
response = client.delete("/api/v1/portal/routing/rules/1")
check("200 delete", status(response) == 200, status(response))

conn = fresh(portal_routing, [RULES, [], []])
portal_routing.portal_db.CONV_TABLE = "portal_conversations"
portal_routing.maybe_route(1, 42, "92x", "REFUND chahiye abhi", conn)
updates = [e for e in conn.cur.executed if "UPDATE" in e[0]]
check("route assigns first match", len(updates) == 1
      and updates[0][1] == (55, 42, 1), updates)
check("assign only when unassigned", "assigned_to IS NULL" in updates[0][0],
      updates[0][0][:140])
audits = [e for e in conn.cur.executed if "portal_action_log" in e[0]]
check("route audit", audits and audits[0][1][1] == "chat.routed", "audit")

conn = fresh(portal_routing, [RULES])
portal_routing.maybe_route(1, 42, "92x", "salam dost", conn)
check("no match no assign", len(conn.cur.executed) == 1, conn.cur.executed)

print("== auth ==")

PrincipalStub(portal_routing, principal=None)
response = client.get("/api/v1/portal/routing/rules")
check("401 unauth", status(response) == 401, status(response))
PrincipalStub(portal_routing, principal=human)

sys.exit(1 if summary("growth_pack") else 0)
