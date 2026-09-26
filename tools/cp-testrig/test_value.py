"""Tests for customer value / CLV lite (deterministic, read-only)."""
import sys
from datetime import datetime, timedelta, timezone

from flask import Flask

import portal_value
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_value.bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
PrincipalStub(portal_value, principal=human)

NOW = datetime.now(timezone.utc)


def ago(days):
    return (NOW - timedelta(days=days)).isoformat()


def items(*specs):
    out = []
    for spec in specs:
        name, price = spec if isinstance(spec, tuple) else (spec, 100)
        out.append({"name": name, "qty": 1, "price": price})
    return out


def fresh(script):
    portal_value._VALUE_DDL_READY = True
    conn = install_db_stub(portal_value, script)
    portal_value.portal_db.CONV_TABLE = "portal_conversations"
    portal_value.portal_db.MSGS_TABLE = "portal_messages"
    return conn


def row(contact, *specs, age=5):
    return {"contact_id": contact, "items": items(*specs),
            "created_at": ago(age)}


print("== helpers ==")

check("median gap odd", portal_value._median_gap_days([
      NOW - timedelta(days=30), NOW - timedelta(days=20),
      NOW - timedelta(days=10)]) == 10, "10")
check("median gap even", portal_value._median_gap_days([
      NOW - timedelta(days=40), NOW - timedelta(days=30),
      NOW - timedelta(days=20), NOW - timedelta(days=10)]) == 10, "10")
check("median gap single", portal_value._median_gap_days(
      [NOW - timedelta(days=5)]) is None, "none")

print("== tiers ==")

check("new tier", portal_value._tier(1, 5) == "new", "1 order")
check("repeat tier", portal_value._tier(2, 5) == "repeat", "2 orders")
check("loyal tier", portal_value._tier(5, 5) == "loyal", "5 orders")
check("lapsed overrides", portal_value._tier(5, 90) == "lapsed", "gone")
check("never ordered not lapsed", portal_value._tier(0, None) == "new",
      "no orders")

print("== value_of ==")

block = portal_value.value_of([
    row("c1", ("Kurti", "Rs 1,500"), ("Earrings", 500), age=10),
    row("c1", ("Kurti", "Rs 1,500"), age=40),
    row("c1", ("Cap", 300), age=70),
], NOW)
check("value totals", block["total_spent"] == 3800 and block["orders"] == 3
      and block["units"] == 4, block)
check("value avg", block["avg_order"] == 1267, block["avg_order"])
check("value top item", block["top_item"] == "Kurti"
      and block["top_item_units"] == 2, block["top_item"])
check("value recency", block["first_order_days"] == 70
      and block["last_order_days"] == 10, block)
check("value median gap", block["median_gap_days"] == 30, block)
check("value tier loyal", block["tier"] == "loyal", block["tier"])

empty = portal_value.value_of([], NOW)
check("value empty", empty["total_spent"] == 0 and empty["orders"] == 0
      and empty["tier"] == "new" and empty["avg_order"] is None, empty)

print("== summary endpoint ==")

conn = fresh([
    [{"oid": "portal_checkout_links"}],
    [row("92a", ("Kurti", "Rs 1,500"), age=10),
     row("92b", ("Cap", 300), age=40)],
])
response = client.get("/api/v1/portal/value/summary?contact=92a")
payload = response.get_json()
check("200 summary", status(response) == 200
      and payload["contact_id"] == "92a", status(response))
check("summary filtered", payload["total_spent"] == 1500
      and payload["orders"] == 1 and payload["tier"] == "new", payload)
check("summary 2 executes", len(conn.cur.executed) == 2,
      len(conn.cur.executed))

response = client.get("/api/v1/portal/value/summary")
check("400 no contact", status(response) == 400, status(response))

conn = fresh([[{"oid": "portal_checkout_links"}], []])
response = client.get("/api/v1/portal/value/summary?contact=" + "a" * 300)
check("contact capped", len(response.get_json()["contact_id"]) == 100, "cap")

PrincipalStub(portal_value, principal=None)
response = client.get("/api/v1/portal/value/summary?contact=x")
check("401 unauth", status(response) == 401, status(response))
PrincipalStub(portal_value, principal=human)

print("== top endpoint ==")

conn = fresh([
    [{"oid": "portal_checkout_links"}],
    [row("92a", ("Kurti", "Rs 1,500"), ("Kurti", "Rs 1,500"), age=8),
     row("92b", ("Shawl", "Rs 2,500"), age=70),
     row("92a", ("Scarf", 800), age=30)],
    [{"contact_id": "92a", "name": "Ali"},
     {"contact_id": "92b", "name": "Bilal"}],
])
response = client.get("/api/v1/portal/value/top?limit=5")
payload = response.get_json()
check("200 top", status(response) == 200 and payload["scored"] == 2,
      status(response))
check("top ranked by spend", payload["customers"][0]["contact_id"] == "92a"
      and payload["customers"][0]["total_spent"] == 3800
      and payload["customers"][0]["name"] == "Ali", payload["customers"])
check("top tiers", payload["customers"][0]["tier"] == "repeat"
      and payload["customers"][1]["tier"] == "lapsed", payload["customers"])
check("top 3 executes", len(conn.cur.executed) == 3,
      len(conn.cur.executed))

response = client.get("/api/v1/portal/value/top?limit=zzz")
check("400 bad limit", status(response) == 400, status(response))

conn = fresh([[{"oid": "portal_checkout_links"}], [], []])
response = client.get("/api/v1/portal/value/top")
check("top empty", response.get_json()["customers"] == []
      and response.get_json()["scored"] == 0, "empty")

print("== missing tables degrade ==")

conn = fresh([[]])
response = client.get("/api/v1/portal/value/summary?contact=92a")
payload = response.get_json()
check("missing links -> zeros", status(response) == 200
      and payload["total_spent"] == 0 and payload["tier"] == "new", payload)

sys.exit(1 if summary("value") else 0)
