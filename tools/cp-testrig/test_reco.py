"""Tests for product recommendations v0 (deterministic, read-only)."""
import sys

from flask import Flask

import portal_reco
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_reco.bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
PrincipalStub(portal_reco, principal=human)


def items(*names):
    return [{"name": n, "qty": 1, "price": 100} for n in names]


def fresh(script):
    portal_reco._RECO_DDL_READY = True
    conn = install_db_stub(portal_reco, script)
    portal_reco.portal_db.CONV_TABLE = "portal_conversations"
    portal_reco.portal_db.MSGS_TABLE = "portal_messages"
    return conn


CAT = [{"name": "Kurti", "price_text": "1500", "notes": "cotton", "kind": "product"},
       {"name": "Earrings", "price_text": "500", "notes": "", "kind": "product"},
       {"name": "Chai set", "price_text": "900", "notes": "", "kind": "product"}]

print("== helpers ==")

check("items_of defensive", portal_reco._items_of(None) == []
      and portal_reco._items_of("x") == [], "guard")
check("items_of extracts", [i["name"] for i in portal_reco._items_of(
    [{"name": "Kurti", "qty": 2, "price": 10}, {"bogus": 1}])] == ["Kurti"], "extract")

print("== signal: repeat purchase ==")

conn = fresh([
    [{"oid": "portal_catalog"}], CAT,                      # catalog probe+rows
    [{"oid": "portal_checkout_links"}], [{"items": items("Earrings")}],   # paid
    [{"oid": "portal_checkout_links"}], [],                # open
    [{"oid": "portal_checkout_links"}],                    # all paid (below)
    [{"contact_id": "other1", "items": items("Earrings", "Kurti")}],
    [],                                                    # inbound bodies
])
result = portal_reco.build_suggestions(conn.cur, 1, "92x")
names = [s["name"] for s in result["suggestions"]]
check("copurchase from sibling item", "Kurti" in names and "Earrings" not in names,
      names)
check("copurchase reason", "Goes well with earrings"
      in [r for s in result["suggestions"] if s["name"] == "Kurti"
          for r in s["reasons"]],
      result["suggestions"])
check("signals counted", result["signals"]["paid_items"] == 1
      and result["signals"]["catalog_items"] == 3, result["signals"])

print("== signal: chat mention ==")

conn = fresh([
    [{"oid": "portal_catalog"}], CAT,
    [{"oid": "portal_checkout_links"}], [],
    [{"oid": "portal_checkout_links"}], [],
    [{"oid": "portal_checkout_links"}], [],
    [{"body": "kurti ka rate kya hai?"}, {"body": "KURTI sizes bata do"}],
])
result = portal_reco.build_suggestions(conn.cur, 1, "92x")
top = result["suggestions"][0] if result["suggestions"] else {}
check("mention ranks first", top.get("name") == "Kurti"
      and "Asked about it in chat" in top.get("reasons", []), top)
check("mention scored", top.get("score", 0) >= portal_reco.WEIGHT_MENTION,
      top.get("score"))

conn = fresh([
    [{"oid": "portal_catalog"}], [{"name": "Pao", "price_text": "50",
                                   "notes": "", "kind": "product"}],
    [{"oid": "portal_checkout_links"}], [],
    [{"oid": "portal_checkout_links"}], [],
    [{"oid": "portal_checkout_links"}], [],
    [{"body": "pao chahiye please"}],
])
result = portal_reco.build_suggestions(conn.cur, 1, "92x")
check("sub-4-char names never mention-match", result["suggestions"] == [],
      result["suggestions"])

print("== signal: bestseller fallback ==")

conn = fresh([
    [{"oid": "portal_catalog"}], CAT,
    [{"oid": "portal_checkout_links"}], [],
    [{"oid": "portal_checkout_links"}], [],
    [{"oid": "portal_checkout_links"}],
    [{"contact_id": "other1", "items": items("Earrings", "Chai set")},
     {"contact_id": "other2", "items": items("Chai set")}],
    [],
])
result = portal_reco.build_suggestions(conn.cur, 1, "92x")
names = [s["name"] for s in result["suggestions"]]
check("bestseller appears", "Chai set" in names, names)
check("bestseller reason", "Popular with your customers"
      in [r for s in result["suggestions"] if s["name"] == "Chai set"
          for r in s["reasons"]], result["suggestions"])
check("single-order item not bestseller", "Earrings" not in names, names)

print("== open-link exclusion + cap ==")

conn = fresh([
    [{"oid": "portal_catalog"}],
    [{"name": "Kurti", "price_text": "1500", "notes": "", "kind": "product"},
     {"name": "Shawl", "price_text": "2000", "notes": "", "kind": "product"},
     {"name": "Dupatta", "price_text": "800", "notes": "", "kind": "product"},
     {"name": "Cap", "price_text": "300", "notes": "", "kind": "product"},
     {"name": "Socks", "price_text": "200", "notes": "", "kind": "product"},
     {"name": "Belt", "price_text": "400", "notes": "", "kind": "product"}],
    [{"oid": "portal_checkout_links"}], [],
    [{"oid": "portal_checkout_links"}], [{"items": items("Kurti")}],
    [{"oid": "portal_checkout_links"}],
    [{"contact_id": "o1", "items": items("Shawl", "Dupatta", "Cap", "Socks",
                                         "Belt", "Kurti")}],
    [{"contact_id": "o2", "items": items("Shawl", "Dupatta", "Cap", "Socks",
                                         "Belt")}],
    [{"contact_id": "o3", "items": items("Shawl", "Dupatta", "Cap", "Socks",
                                         "Belt")}],
    [],
])
result = portal_reco.build_suggestions(conn.cur, 1, "92x")
names = [s["name"] for s in result["suggestions"]]
check("open item excluded", "Kurti" not in names, names)
check("capped at 5", len(result["suggestions"]) <= 5, len(names))

print("== endpoints ==")

conn = fresh([
    [{"oid": "portal_catalog"}], CAT,
    [{"oid": "portal_checkout_links"}], [],
    [{"oid": "portal_checkout_links"}], [],
    [{"oid": "portal_checkout_links"}], [],
    [],
])
response = client.get("/api/v1/portal/reco/suggest?contact=92x")
check("200 suggest", status(response) == 200
      and response.get_json()["contact_id"] == "92x"
      and isinstance(response.get_json()["suggestions"], list), status(response))
check("9 executes", len(conn.cur.executed) == 9, len(conn.cur.executed))

response = client.get("/api/v1/portal/reco/suggest")
check("400 no contact", status(response) == 400, status(response))

conn = fresh([[{"contact_id": "92x", "contact_name": "Ali"}],
              [], [], [], [], []])
portal_reco.portal_db.CONV_TABLE = "portal_conversations"
response = client.get("/api/v1/portal/reco/surface?conversation_id=42")
payload = response.get_json()
check("200 surface", status(response) == 200
      and payload["contact_name"] == "Ali"
      and payload["conversation_id"] == 42, status(response))
check("surface conv lookup", conn.cur.executed[0][1] == (42, 1),
      conn.cur.executed[0][1])

conn = fresh([[]])
response = client.get("/api/v1/portal/reco/surface?conversation_id=99")
check("404 surface unknown", status(response) == 404, status(response))

response = client.get("/api/v1/portal/reco/surface?conversation_id=abc")
check("400 surface bad id", status(response) == 400, status(response))

LINKS = [
    {"contact_id": "92a", "items": items("Kurti", "Kurti")},
    {"contact_id": "92b", "items": items("Kurti", "Earrings")},
]
conn = fresh([[{"oid": "portal_catalog"}], CAT,
              [{"oid": "portal_checkout_links"}], LINKS])
response = client.get("/api/v1/portal/reco/report")
payload = response.get_json()
check("200 report", status(response) == 200
      and payload["bestsellers"][0]["name"] == "Kurti"
      and payload["bestsellers"][0]["orders"] == 3, status(response))
check("report counts", payload["paid_links"] == 2 and payload["buyers"] == 2
      and payload["catalog_items"] == 3, payload)

PrincipalStub(portal_reco, principal=None)
response = client.get("/api/v1/portal/reco/suggest?contact=x")
check("401 unauth", status(response) == 401, status(response))
PrincipalStub(portal_reco, principal=human)

print("== missing tables degrade ==")

conn = fresh([
    [],  # catalog probe -> missing
    [],  # paid probe
    [],  # open probe
    [],  # all-paid probe
    [],  # inbound bodies
])
result = portal_reco.build_suggestions(conn.cur, 1, "92x")
check("all missing -> empty", result["suggestions"] == []
      and result["signals"]["catalog_items"] == 0, result)

sys.exit(1 if summary("reco") else 0)
