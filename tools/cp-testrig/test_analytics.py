"""Tests for commerce analytics: per-customer orders/spend/tiers and
product-wise aggregation over PAID links only."""
from datetime import datetime, timezone

from flask import Flask

import portal_analytics
import portal_checkout
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_analytics.bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
PrincipalStub(portal_analytics, principal=human)


def fresh(rows):
    portal_checkout._CHECKOUT_DDL_READY = True
    db = install_db_stub(portal_analytics, [rows])
    db.CONV_TABLE = "portal_conversations"
    db.CMD_TABLE = "portal_commands"
    return db


def fresh2(rows, lang_rows):
    """991-1010: customer-analytics runs a second (language) query."""
    portal_checkout._CHECKOUT_DDL_READY = True
    db = install_db_stub(portal_analytics, [rows, lang_rows])
    db.CONV_TABLE = "portal_conversations"
    db.CMD_TABLE = "portal_commands"
    return db


def link(contact, total, items, status="paid",
         created=datetime(2026, 9, 19, 10, 0, tzinfo=timezone.utc)):
    return {"id": 1, "contact_id": contact, "title": "T", "items": items,
            "total": total, "paid_amount": 0, "discount": 0,
            "status": status, "created_at": created}


print("== tiers ==")

# 991-1010: customer-analytics gains a language-distribution query
# (slot 2) - one row per detected language, count DESC.
fresh2([link("92a", 5000, [])],
       [{"lang": "ur", "n": 12}, {"lang": "roman", "n": 7}])
response = client.get("/api/v1/portal/insights/customer-analytics")
payload = response.get_json()
check("200 customers", status(response) == 200
      and payload["customers"][0]["tier"] == "new"
      and payload["repeat_share"] == 0, payload.get("tiers"))
check("languages payload", payload["languages"] == [
      {"lang": "ur", "count": 12}, {"lang": "roman", "count": 7}],
      payload.get("languages"))

fresh2([link("92a", 5000, []), link("92a", 7000, []),
        link("92b", 30000, []), link("92c", 100, [])], [])
payload = client.get("/api/v1/portal/insights/customer-analytics").get_json()
by = {c["contact_id"]: c for c in payload["customers"]}
check("repeat tier", by["92a"]["tier"] == "repeat"
      and by["92a"]["orders"] == 2 and by["92a"]["spend"] == 12000
      and by["92a"]["avg_order"] == 6000, by.get("92a"))
check("vip by spend", by["92b"]["tier"] == "vip", by.get("92b"))
check("vip by orders", by["92c"]["tier"] == "new", by.get("92c"))
check("tiers summary", payload["tiers"] == {"new": 1, "repeat": 1, "vip": 1},
      payload["tiers"])
check("repeat share", payload["repeat_share"] == 0.67,
      payload["repeat_share"])
check("sorted by spend", payload["customers"][0]["contact_id"] == "92b",
      payload["customers"][0])

fresh2([link("92a", 5000, [], created=datetime(
            2026, 9, 1, 10, 0, tzinfo=timezone.utc)),
        link("92a", 7000, [], created=datetime(
            2026, 9, 19, 10, 0, tzinfo=timezone.utc))], [])
payload = client.get("/api/v1/portal/insights/customer-analytics").get_json()
check("last order max", payload["customers"][0]["last_order"].startswith(
      "2026-09-19"), payload["customers"][0]["last_order"])

fresh([])
payload = client.get("/api/v1/portal/insights/customer-analytics").get_json()
check("paid only", payload["customers"] == [], payload["customers"])

print("== products ==")

ITEMS_A = [{"name": "Kurti", "qty": 2, "price": 1000},
           {"name": "Shawl", "qty": 1, "price": 1500}]
ITEMS_B = [{"name": "Kurti", "qty": 1, "price": 1000}]
fresh([link("92a", 3500, ITEMS_A), link("92b", 1000, ITEMS_B)])
payload = client.get("/api/v1/portal/insights/product-analytics").get_json()
prods = {p["name"]: p for p in payload["products"]}
check("product agg", prods["Kurti"]["qty_sold"] == 3
      and prods["Kurti"]["revenue"] == 3000 and prods["Kurti"]["orders"] == 2,
      prods.get("Kurti"))
check("product single", prods["Shawl"]["revenue"] == 1500
      and prods["Shawl"]["orders"] == 1, prods.get("Shawl"))
check("sorted by revenue", payload["products"][0]["name"] == "Kurti",
      payload["products"][0])

print("== params + errors ==")

fresh([])
payload = client.get(
    "/api/v1/portal/insights/customer-analytics?days=90").get_json()
check("days parsed", payload["days"] == 90, payload.get("days"))
fresh([])
payload = client.get(
    "/api/v1/portal/insights/customer-analytics?days=bogus").get_json()
check("days default 30", payload["days"] == 30, payload.get("days"))

fresh([RuntimeError("db down")])
response = client.get("/api/v1/portal/insights/customer-analytics")
check("503 on failure", status(response) == 503, status(response))

summary("analytics")


print("== operations aggregate (B14) ==")

# 11 scripted result sets, in query order: chats.new, chats.open,
# chats.total, messages.received, messages.sent, orders(n+revenue),
# deliveries.bookings, by_status, recovery.open, recovery.resolved,
# csat(avg+n).
_ops = install_db_stub(portal_analytics, [
    [{"n": 5}],            # chats new
    [{"n": 2}],            # chats open
    [{"n": 9}],            # chats total
    [{"n": 40}],           # messages received
    [{"n": 33}],           # messages sent
    [{"n": 3, "revenue": 7500.5}],   # paid orders
    [{"n": 3}],            # bookings
    [{"status": "booked", "n": 2}, {"status": "delivered", "n": 1}],
    [{"n": 1}],            # recovery open
    [{"n": 4}],            # recovery resolved
    [{"avg_score": 4.456, "n": 6}],  # csat
])
_ops.CONV_TABLE = "portal_conversations"
_ops.MSGS_TABLE = "portal_messages"
_ops.CSAT_TABLE = "portal_csat_requests"
payload = client.get("/api/v1/portal/insights/operations").get_json()
ops = payload.get("operations", {})
check("operations chats", ops.get("chats") == {"new": 5, "open": 2,
                                               "total": 9}, ops.get("chats"))
check("operations messages", ops.get("messages")
      == {"received": 40, "sent": 33}, ops.get("messages"))
check("operations orders", ops.get("orders") == {"paid": 3,
                                                 "revenue": 7500.5},
      ops.get("orders"))
check("operations deliveries", ops.get("deliveries", {}).get("bookings")
      == 3 and ops.get("deliveries", {}).get("by_status", {})
      .get("delivered") == 1, ops.get("deliveries"))
check("operations recovery", ops.get("recovery") == {"open": 1,
                                                     "resolved": 4},
      ops.get("recovery"))
check("operations csat rounded", ops.get("csat") == {"answers": 6,
                                                     "avg_score": 4.46},
      ops.get("csat"))
check("operations days default", payload.get("days") == 30,
      payload.get("days"))
check("operations queried bookings+csat tables", any(
    "portal_courier_bookings" in e[0] for e in _ops.cur.executed)
    and any("portal_csat_requests" in e[0]
            for e in _ops.cur.executed), "tables")

# days clamp: bogus -> 30, huge -> 365
_zero = [[{"n": 0}], [{"n": 0}], [{"n": 0}], [{"n": 0}], [{"n": 0}],
         [{"n": 0, "revenue": 0}], [{"n": 0}], [], [{"n": 0}],
         [{"n": 0}], [{"avg_score": None, "n": 0}]]
_ops2 = install_db_stub(portal_analytics, list(_zero))
_ops2.CONV_TABLE = "portal_conversations"
_ops2.MSGS_TABLE = "portal_messages"
_ops2.CSAT_TABLE = "portal_csat_requests"
p2 = client.get("/api/v1/portal/insights/operations?days=bogus").get_json()
check("operations days bogus", p2.get("days") == 30, p2.get("days"))
_ops3 = install_db_stub(portal_analytics, list(_zero))
_ops3.CONV_TABLE = "portal_conversations"
_ops3.MSGS_TABLE = "portal_messages"
_ops3.CSAT_TABLE = "portal_csat_requests"
p3 = client.get("/api/v1/portal/insights/operations?days=9999").get_json()
check("operations days clamp", p3.get("days") == 365, p3.get("days"))
check("operations empty csat", p3.get("operations", {}).get("csat")
      == {"answers": 0, "avg_score": None},
      p3.get("operations", {}).get("csat"))

# api-key principals read analytics like the other insight endpoints
PrincipalStub(portal_analytics, principal=dict(human, via_api_key=True))
_ops4 = install_db_stub(portal_analytics, list(_zero))
_ops4.CONV_TABLE = "portal_conversations"
_ops4.MSGS_TABLE = "portal_messages"
_ops4.CSAT_TABLE = "portal_csat_requests"
resp = client.get("/api/v1/portal/insights/operations")
check("operations api key 200", status(resp) == 200, status(resp))
PrincipalStub(portal_analytics, principal=None)
resp = client.get("/api/v1/portal/insights/operations")
check("operations anon 401", status(resp) == 401, status(resp))
PrincipalStub(portal_analytics, principal=human)

summary("operations")
