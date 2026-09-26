"""Tests for revenue & pipeline pulse (deterministic, read-only)."""
import sys

from flask import Flask

import portal_revenue
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_revenue.bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
PrincipalStub(portal_revenue, principal=human)


def items(*specs):
    out = []
    for spec in specs:
        name, price = spec if isinstance(spec, tuple) else (spec, 100)
        out.append({"name": name, "qty": 1, "price": price})
    return out


def fresh(script):
    portal_revenue._REVENUE_DDL_READY = True
    conn = install_db_stub(portal_revenue, script)
    portal_revenue.portal_db.CONV_TABLE = "portal_conversations"
    portal_revenue.portal_db.MSGS_TABLE = "portal_messages"
    return conn


def link(contact, status, *specs):
    return {"contact_id": contact, "status": status, "items": items(*specs)}


print("== helpers ==")

check("item total commas", portal_revenue._item_total(
    items(("Shawl", "Rs 2,500"), ("Kurti", "1500"))) == 4000, "4000")
check("item total skips junk", portal_revenue._item_total(
    [{"name": "Kurti", "price": "ask"}, "junk", None,
     {"name": "Cap"}]) == 0, "0")
check("item total non-list", portal_revenue._item_total("x") == 0, "0")

print("== window stats ==")

stats = portal_revenue._window_stats([
    link("a", "paid", ("Kurti", 1000), ("Earrings", 500)),
    link("b", "paid", ("Kurti", 1500)),
    link("c", "cancelled", ("Cap", 300)),
])
check("window revenue", stats["revenue"] == 3000, stats)
check("window orders + aov", stats["orders"] == 2 and stats["aov"] == 1500,
      stats)
check("window cancelled rate", stats["cancelled"] == 1
      and stats["cancelled_rate"] == 33.3, stats)
empty = portal_revenue._window_stats([])
check("empty window", empty["revenue"] == 0 and empty["aov"] is None
      and empty["cancelled_rate"] is None, empty)

print("== delta + trend ==")

check("delta up", portal_revenue._delta_percent(1500, 1000) == 50, "50")
check("delta down", portal_revenue._delta_percent(500, 1000) == -50, "-50")
check("delta zero prior", portal_revenue._delta_percent(500, 0) is None,
      "none")
check("trend up ratio", portal_revenue._trend(13, 10) == "up", "1.3")
check("trend down ratio", portal_revenue._trend(7, 10) == "down", "0.7")
check("trend steady band", portal_revenue._trend(12, 10) == "steady"
      and portal_revenue._trend(8, 10) == "steady", "0.8-1.2")
check("trend from zero", portal_revenue._trend(3, 0) == "up"
      and portal_revenue._trend(0, 0) == "steady", "new item")

print("== summary endpoint ==")

conn = fresh([
    [{"oid": "portal_checkout_links"}],
    [link("92a", "paid", ("Kurti", "Rs 1,500")),
     link("92b", "paid", ("Kurti", "Rs 1,500")),
     link("92c", "cancelled", ("Cap", 300))],
    [link("92a", "paid", ("Scarf", 800))],
    [{"items": items(("Kurti", "Rs 1,500"))}, {"items": items(("Cap", 300))}],
    [{"contact_id": "92a", "total": 3}, {"contact_id": "92b", "total": 1},
     {"contact_id": "92d", "total": 1}],
    [{"oid": "portal_action_log"}],
    [{"hits": 2}],
])
response = client.get("/api/v1/portal/revenue/summary?days=30")
payload = response.get_json()
check("200 summary", status(response) == 200 and payload["days"] == 30,
      status(response))
check("summary revenue + delta", payload["revenue"] == 3000
      and payload["revenue_prior"] == 800
      and payload["delta_percent"] == 275, payload)
check("summary orders + aov", payload["orders"] == 2
      and payload["orders_prior"] == 1 and payload["aov"] == 1500, payload)
check("summary buyers new vs repeat", payload["new_buyers"] == 0
      and payload["repeat_buyers"] == 2, payload)
check("summary cancelled", payload["cancelled"] == 1
      and payload["cancelled_rate"] == 33.3, payload)
check("summary pipeline", payload["open_carts"] == 2
      and payload["pipeline_value"] == 1800, payload)
check("summary winback sent", payload["winback_sent"] == 2, payload)
check("summary 7 executes", len(conn.cur.executed) == 7,
      len(conn.cur.executed))

response = client.get("/api/v1/portal/revenue/summary?days=zzz")
check("400 bad days", status(response) == 400, status(response))
response = client.get("/api/v1/portal/revenue/summary?days=999")
check("400 days out of range", status(response) == 400, status(response))
conn = fresh([
    [{"oid": "portal_checkout_links"}], [], [],
    [], [], [], [],
])
response = client.get("/api/v1/portal/revenue/summary")
check("200 default days", response.get_json()["days"] == 30, "default")

PrincipalStub(portal_revenue, principal=None)
response = client.get("/api/v1/portal/revenue/summary")
check("401 unauth", status(response) == 401, status(response))
PrincipalStub(portal_revenue, principal=human)

print("== items endpoint ==")

conn = fresh([
    [{"oid": "portal_checkout_links"}],
    [link("92a", "paid", ("Kurti", "Rs 1,500"), ("Earrings", 500)),
     link("92b", "paid", ("Kurti", "Rs 1,500"), ("Kurti", "Rs 1,500")),
     link("92c", "cancelled", ("Cap", 300))],
    [link("92a", "paid", ("Kurti", 1000), ("Kurti", 1000),
          ("Kurti", 1000), ("Kurti", 1000))],
])
response = client.get("/api/v1/portal/revenue/items?days=30")
payload = response.get_json()
top = payload["items"][0]
check("200 items", status(response) == 200, status(response))
check("item top by revenue", top["name"] == "Kurti" and top["units"] == 3
      and top["revenue"] == 4500 and top["buyers"] == 2, payload)
check("item trend down", top["trend"] == "down"
      and top["units_prior"] == 4, top)
check("item cancelled excluded",
      all(entry["name"] != "Cap" for entry in payload["items"]), payload)
check("items 3 executes", len(conn.cur.executed) == 3,
      len(conn.cur.executed))

print("== missing tables degrade ==")

conn = fresh([[], [], [], [], [], []])
response = client.get("/api/v1/portal/revenue/summary?days=30")
payload = response.get_json()
check("missing links -> zeros", status(response) == 200
      and payload["revenue"] == 0 and payload["open_carts"] == 0
      and payload["winback_sent"] == 0, payload)

conn = fresh([[], [], []])
response = client.get("/api/v1/portal/revenue/items?days=30")
check("missing links -> empty items", status(response) == 200
      and response.get_json()["items"] == [], status(response))

sys.exit(1 if summary("revenue") else 0)
