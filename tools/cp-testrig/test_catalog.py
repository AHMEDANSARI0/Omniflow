"""Tests for the saved catalog (971-970 batch): CRUD validation, dedupe,
cap, audits, guards, 503 wrap, and web pins (BFF depths + UI wiring)."""
import os

from flask import Flask

import portal_catalog
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_catalog.bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
apikey = dict(human, via_api_key=True)
PrincipalStub(portal_catalog, principal=human)

ROW = {"id": 5, "kind": "product", "name": "Lawn 3-piece",
       "price_text": "Rs 2,500", "notes": "summer", "is_active": True,
       "created_at": None}


def fresh(script):
    portal_catalog._DDL_READY = True
    return install_db_stub(portal_catalog, script)


print("== validation ==")

clean, err = portal_catalog.validate_catalog_item(
    {"name": " Suit ", "kind": "SERVICE", "price_text": " Rs 4,000 ",
     "notes": "x", "is_active": False})
check("clean trims", err is None and clean == {
    "name": "Suit", "kind": "service", "price_text": "Rs 4,000",
    "notes": "x", "is_active": False, "price": 0.0, "stock": 0,
    "image_url": "", "brand_id": None}, clean)
check("defaults", portal_catalog.validate_catalog_item({"name": "A"})[0]
      == {"name": "A", "kind": "product", "price_text": "", "notes": "",
          "is_active": True, "price": 0.0, "stock": 0,
          "image_url": "", "brand_id": None}, "-")
check("brand passthrough",
      portal_catalog.validate_catalog_item(
          {"name": "A", "brand_id": "7"})[0]["brand_id"] == 7
      and portal_catalog.validate_catalog_item(
          {"name": "A", "brand_id": "junk"})[0]["brand_id"] is None
      and portal_catalog.validate_catalog_item(
          {"name": "A", "brand_id": -2})[0]["brand_id"] is None, "-")
check("name required", portal_catalog.validate_catalog_item({"name": "  "})[1]
      == "Item name is required.", "-")
check("name too long",
      portal_catalog.validate_catalog_item({"name": "x" * 121})[1]
      == "Item name must be 120 characters or fewer.", "-")
check("bad kind", portal_catalog.validate_catalog_item(
    {"name": "A", "kind": "bundle"})[1] == "kind must be product or service.", "-")
check("price_text cap", portal_catalog.validate_catalog_item(
    {"name": "A", "price_text": "x" * 41})[1]
      == "Price text must be 40 characters or fewer.", "-")
check("notes cap", portal_catalog.validate_catalog_item(
    {"name": "A", "notes": "x" * 161})[1]
      == "Notes must be 160 characters or fewer.", "-")
check("is_active bool", portal_catalog.validate_catalog_item(
    {"name": "A", "is_active": "yes"})[1] == "is_active must be true or false.", "-")
check("payload object", portal_catalog.validate_catalog_item("junk")[1]
      == "item (object) is required.", "-")

print("== create ==")

conn = fresh([[], [{"n": 3}], [ROW], []])
response = client.post("/api/v1/portal/catalog",
                       json={"item": {"name": "Lawn 3-piece",
                                      "price_text": "Rs 2,500"}})
payload = response.get_json()
check("create 200", status(response) == 200 and payload["item"]["id"] == 5
      and payload["item"]["kind"] == "product", payload)
dup_sql, dup_params = conn.cur.executed[0]
check("dup check", "lower(name) = lower(%s)" in dup_sql
      and dup_params[1] == "Lawn 3-piece", dup_sql[:60])
ins_sql, ins_params = conn.cur.executed[2]
check("insert", "INSERT INTO portal_catalog" in ins_sql
      and ins_params[1] == "Lawn 3-piece" and ins_params[5] is True, ins_sql[:50])
check("audit", conn.cur.executed[3][1][1] == "catalog.created"
      and "Lawn" in conn.cur.executed[3][1][5], conn.cur.executed[3][1])

conn = fresh([[{"id": 9}]])
response = client.post("/api/v1/portal/catalog",
                       json={"item": {"name": "lawn 3-PIECE"}})
check("409 dup", status(response) == 409, status(response))

conn = fresh([[], [{"n": 200}]])
response = client.post("/api/v1/portal/catalog",
                       json={"item": {"name": "One more"}})
check("400 cap", status(response) == 400
      and "200" in response.get_json()["error"]["message"], status(response))

conn = fresh([])
response = client.post("/api/v1/portal/catalog", json={"item": {"name": ""}})
check("400 invalid, zero queries", status(response) == 400
      and len(conn.cur.executed) == 0, len(conn.cur.executed))

PrincipalStub(portal_catalog, principal=apikey)
conn = fresh([[]])
response = client.post("/api/v1/portal/catalog",
                       json={"item": {"name": "X"}})
check("403 api-key create", status(response) == 403, status(response))
PrincipalStub(portal_catalog, principal=human)

print("== list ==")

conn = fresh([[ROW]])
response = client.get("/api/v1/portal/catalog")
payload = response.get_json()
check("list shape", status(response) == 200
      and payload["items"][0]["name"] == "Lawn 3-piece"
      and payload["items"][0]["price_text"] == "Rs 2,500"
      and payload["items"][0]["is_active"] is True, payload)
check("list order active-first", "ORDER BY is_active DESC, "
      in conn.cur.executed[0][0]
      and "LEFT JOIN portal_brands" in conn.cur.executed[0][0]
      and "brand_name" in conn.cur.executed[0][0],
      conn.cur.executed[0][0][:150])

conn = fresh([RuntimeError("db down")])
response = client.get("/api/v1/portal/catalog")
check("503 wrap list", status(response) == 503, status(response))

print("== update ==")

conn = fresh([[ROW], [], [dict(ROW, name="Lawn 2-piece")], []])
response = client.put("/api/v1/portal/catalog/5",
                      json={"item": {"name": "Lawn 2-piece"}})
check("update 200", status(response) == 200
      and response.get_json()["item"]["name"] == "Lawn 2-piece",
      response.get_json())
upd_sql, upd_params = conn.cur.executed[2]
check("update sql", "UPDATE portal_catalog" in upd_sql
      and upd_params[0] == "Lawn 2-piece" and upd_params[9] == 5
      and "brand_id = %s" in upd_sql,
      upd_params[:10])
check("audit updated", conn.cur.executed[3][1][1] == "catalog.updated",
      conn.cur.executed[3][1])

conn = fresh([[]])
response = client.put("/api/v1/portal/catalog/77",
                      json={"item": {"name": "X"}})
check("404 update", status(response) == 404, status(response))

conn = fresh([[ROW], [{"id": 8}]])
response = client.put("/api/v1/portal/catalog/5",
                      json={"item": {"name": "Other name"}})
check("409 rename clash", status(response) == 409, status(response))

PrincipalStub(portal_catalog, principal=apikey)
conn = fresh([[ROW]])
response = client.put("/api/v1/portal/catalog/5",
                      json={"item": {"name": "X"}})
check("403 api-key update", status(response) == 403, status(response))
PrincipalStub(portal_catalog, principal=human)

print("== delete ==")

conn = fresh([[{"id": 5}], []])
response = client.delete("/api/v1/portal/catalog/5")
check("delete 200", status(response) == 200
      and response.get_json()["ok"] is True, status(response))
check("audit removed", conn.cur.executed[1][1][1] == "catalog.removed",
      conn.cur.executed[1][1])

conn = fresh([[]])
response = client.delete("/api/v1/portal/catalog/77")
check("404 delete", status(response) == 404, status(response))

PrincipalStub(portal_catalog, principal=apikey)
conn = fresh([[{"id": 5}]])
response = client.delete("/api/v1/portal/catalog/5")
check("403 api-key delete", status(response) == 403, status(response))
PrincipalStub(portal_catalog, principal=human)

conn = fresh([RuntimeError("db down")])
response = client.post("/api/v1/portal/catalog",
                       json={"item": {"name": "X"}})
check("503 wrap create", status(response) == 503, status(response))

print("== web shape ==")

PORTAL = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts", encoding="utf8").read()
for name in ("getCatalog", "createCatalogItem", "updateCatalogItem",
             "deleteCatalogItem"):
    check("client " + name, "export async function " + name in PORTAL, name)

BFF_LIST = open("/tmp/p13/Omniflow/app/api/omniflow/portal/catalog/route.ts",
                encoding="utf8").read()
check("catalog bff depth", '"../../../../../lib/' in BFF_LIST, "depth5")
check("catalog bff handlers", "export async function GET" in BFF_LIST
      and "export async function POST" in BFF_LIST, "handlers")
BFF_ID = open("/tmp/p13/Omniflow/app/api/omniflow/portal/catalog/[id]/route.ts",
              encoding="utf8").read()
check("catalog id bff", "export async function PUT" in BFF_ID
      and "export async function DELETE" in BFF_ID
      and '"../../../../../../lib/' in BFF_ID, "id bff")

SETTINGS = open("/tmp/p13/Omniflow/app/dashboard/(portal)/settings/page.tsx",
                encoding="utf8").read()
check("settings catalog card", 'import CatalogCard from "./CatalogCard";'
      in SETTINGS and "<CatalogCard />" in SETTINGS, "wiring")
CARD = open("/tmp/p13/Omniflow/app/dashboard/(portal)/settings/CatalogCard.tsx",
            encoding="utf8").read()
check("catalog card", "Saved catalog" in CARD
      and "/api/omniflow/portal/catalog" in CARD
      and "Add item" in CARD and "Delete" in CARD, "card")

GROWTH = open("/tmp/p13/Omniflow/app/dashboard/(portal)/growth/page.tsx",
              encoding="utf8").read()
check("growth picker", "From saved catalog" in GROWTH
      and "addCatalogRow" in GROWTH, "picker")

summary("catalog")
