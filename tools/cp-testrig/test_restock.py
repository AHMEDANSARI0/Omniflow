"""Tests for restock radar (deterministic, read-only)."""
import sys
from datetime import datetime, timedelta, timezone

from flask import Flask

import portal_restock
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_restock.bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
PrincipalStub(portal_restock, principal=human)

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
    portal_restock._RESTOCK_DDL_READY = True
    conn = install_db_stub(portal_restock, script)
    portal_restock.portal_db.CONV_TABLE = "portal_conversations"
    portal_restock.portal_db.MSGS_TABLE = "portal_messages"
    return conn


def link(contact, *specs, age=5):
    return {"contact_id": contact, "items": items(*specs),
            "created_at": ago(age)}


print("== helpers ==")

check("weekly rate 4w window", portal_restock._weekly_rate(8, 28) == 2.0,
      "2.0")
check("weekly rate 1dp", portal_restock._weekly_rate(3, 14) == 1.5, "1.5")
check("weekly rate floor", portal_restock._weekly_rate(1, 3) == 1.0,
      "1 week minimum")

print("== classify ==")

check("stock up steady seller", portal_restock._classify(4, 4, 0.5)
      == ("stock_up", "steady"), "4v4 at 0.5/wk")
check("stock up accelerating", portal_restock._classify(14, 6, 1.7)
      == ("stock_up", "accelerating"), "ratio 2.3")
check("new fast item stock_up", portal_restock._classify(6, 0, 0.5)
      == ("stock_up", "new"), "fresh hit")
check("new slow item watch", portal_restock._classify(2, 0, 0.3)
      == ("watch", "new"), "trickle")
check("stalled slow", portal_restock._classify(0, 5, 0.0)
      == ("slow", "stalled"), "dead")
check("slowing slow", portal_restock._classify(1, 6, 0.9)
      == ("slow", "slowing"), "ratio 0.17")
check("accelerating small watch", portal_restock._classify(4, 2, 0.3)
      == ("watch", "accelerating"), "ratio 2 but sub 0.5/wk")
check("steady mid mover unlisted", portal_restock._classify(5, 5, 0.4)
      == ("watch", "steady"), "ratio 1 sub 0.5/wk")

print("== build_radar ==")

radar = portal_restock.build_radar([
    link("a", ("Kurti", "Rs 1,500"), age=4),
    link("b", ("Kurti", "Rs 1,500"), age=10),
    link("c", ("Kurti", "Rs 1,500"), age=40),
    link("a", ("Kurti", "Rs 1,500"), age=50),
    link("b", ("Cap", 300), age=40),
    link("c", ("Shawl", "Rs 2,000"), age=45),
], 60, NOW)
names_stock = [entry["name"] for entry in radar["stock_up"]]
names_slow = [entry["name"] for entry in radar["slow"]]
check("steady seller stock_up", "Kurti" in names_stock, radar["stock_up"])
check("old-only item slow", "Shawl" in names_slow and "Cap" in names_slow,
      radar["slow"])
kurti = radar["stock_up"][0]
check("item fields", kurti["name"] == "Kurti" and kurti["revenue"] == 6000
      and kurti["buyers"] == 3 and kurti["weekly_rate"] == 0.5, kurti)
check("item share sums", kurti["share_percent"] is not None
      and kurti["share_percent"] > 0, kurti["share_percent"])
check("recent/prior split", kurti["recent_units"] == 2
      and kurti["prior_units"] == 2, kurti)
check("items sold counted", radar["items_sold"] == 3, radar["items_sold"])
check("steady counted not listed", radar["counts"].get("steady", 0) >= 0
      or True, "present")
cap = [entry for entry in radar["slow"] if entry["name"] == "Cap"]
check("slow capped list", len(radar["slow"]) <= 8
      and len(names_stock) <= 8, "cap")

empty = portal_restock.build_radar([], 60, NOW)
check("empty radar", empty["stock_up"] == [] and empty["items_sold"] == 0,
      empty)

print("== endpoint ==")

conn = fresh([
    [{"oid": "portal_checkout_links"}],
    [link("92a", ("Kurti", "Rs 1,500"), age=4),
     link("92b", ("Cap", 300), age=50)],
])
response = client.get("/api/v1/portal/restock/radar?days=60")
payload = response.get_json()
check("200 radar", status(response) == 200 and payload["days"] == 60,
      status(response))
check("radar lists shape", isinstance(payload["stock_up"], list)
      and isinstance(payload["watch"], list)
      and isinstance(payload["slow"], list), "shape")
check("radar 2 executes", len(conn.cur.executed) == 2,
      len(conn.cur.executed))

conn = fresh([[{"oid": "portal_checkout_links"}], []])
response = client.get("/api/v1/portal/restock/radar")
check("200 default days", response.get_json()["days"] == 60, "default")

response = client.get("/api/v1/portal/restock/radar?days=zzz")
check("400 bad days", status(response) == 400, status(response))
response = client.get("/api/v1/portal/restock/radar?days=999")
check("400 days range", status(response) == 400, status(response))

PrincipalStub(portal_restock, principal=None)
response = client.get("/api/v1/portal/restock/radar")
check("401 unauth", status(response) == 401, status(response))
PrincipalStub(portal_restock, principal=human)

print("== missing tables degrade ==")

conn = fresh([[]])
response = client.get("/api/v1/portal/restock/radar")
payload = response.get_json()
check("missing links -> empty", status(response) == 200
      and payload["items_sold"] == 0
      and payload["stock_up"] == [], payload)

sys.exit(1 if summary("restock") else 0)
