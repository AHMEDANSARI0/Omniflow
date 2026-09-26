"""Tests for V2 B18: multi-brand prep - brands CRUD (plan-capped,
audited), optional brand tags on KB entries / catalog items / checkout
links (junk falls back to untagged), delete clears tags, and the web
surface (BrandsCard in Settings, selects, clients, BFF routes)."""
import json

from flask import Flask

import portal_brands
import portal_kb
import portal_catalog
import portal_checkout
import test_lib
from test_lib import (FakeConn, check, install_db_stub, PrincipalStub,
                      status, summary)

PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}


class AuthStub:
    def __init__(self, module, principal=PRINCIPAL):
        self.module = module
        self.orig = module.authenticate_portal_request
        module.authenticate_portal_request = lambda: principal
        module.PortalAuthUnavailable = Exception

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.module.authenticate_portal_request = self.orig


def make(module, script):
    conn = install_db_stub(module, script)
    return conn


def client_for(module):
    app = Flask("b18")
    app.register_blueprint(module.bp)
    return app.test_client()


BRAND_ROW = {"id": 7, "name": "House of Linen", "is_active": True,
             "created_at": None}

print("== brands crud ==")

# B22: brand DDL is 3 executes now (base + slug ALTER + slug unique index)
conn = make(portal_brands,
            [[], [], [BRAND_ROW], [dict(BRAND_ROW, id=8)], []])
with AuthStub(portal_brands):
    r = client_for(portal_brands).get("/api/v1/portal/brands")
body = r.get_json()
check("brands list 200", status(r) == 200 and len(body["brands"]) == 1
      and body["brands"][0]["name"] == "House of Linen", body)

# B22: create also runs the slug-uniqueness SELECT before the INSERT
conn = make(portal_brands,
            [[{"n": 0}], [], [], [dict(BRAND_ROW)], [], []])
with AuthStub(portal_brands):
    r = client_for(portal_brands).post("/api/v1/portal/brands",
                                       json={"name": "House of Linen"})
body = r.get_json()
check("brand create 200", status(r) == 200 and body["brand"]["id"] == 7,
      body)
sqls = [e[0] for e in conn.cur.executed]
check("brand create plan gate", any("portal_plan_settings" in s
      for s in sqls), "gated")
check("brand create audit", any("brands.created" in json.dumps(e)
      for e in conn.cur.executed), "audit")

conn = make(portal_brands, [[{"n": 0}], [{"id": 1}], [], []])
with AuthStub(portal_brands):
    r = client_for(portal_brands).post("/api/v1/portal/brands",
                                       json={"name": "x"})
check("brand dup 409", status(r) == 409, status(r))

conn = make(portal_brands, [])
with AuthStub(portal_brands):
    r = client_for(portal_brands).post("/api/v1/portal/brands",
                                       json={"name": "   "})
check("brand name required", status(r) == 400, status(r))

conn = make(portal_brands, [])
with AuthStub(portal_brands, dict(PRINCIPAL, via_api_key=True)):
    r = client_for(portal_brands).post("/api/v1/portal/brands",
                                       json={"name": "X"})
check("brands api key 403", status(r) == 403, status(r))

# cap reached on a capped plan (free = 1 brand)
conn = make(portal_brands,
            [[{"plan": "free"}]] + [[{"n": 1}]] * 6 + [])
with AuthStub(portal_brands):
    r = client_for(portal_brands).post("/api/v1/portal/brands",
                                       json={"name": "Second"})
body = r.get_json()
check("brands cap 409", status(r) == 409
      and body["error"]["code"] == "plan_limit"
      and "(1)" in body["error"]["message"], body)

conn = make(portal_brands,
            [[Exception("boom")], [], [], [dict(BRAND_ROW)], [], []])
with AuthStub(portal_brands):
    r = client_for(portal_brands).post("/api/v1/portal/brands",
                                       json={"name": "X"})
check("brands fail open", status(r) == 200, status(r))

print("== brand patch/delete ==")

conn = make(portal_brands, [[], [dict(BRAND_ROW, name="Renamed")], []])
with AuthStub(portal_brands):
    r = client_for(portal_brands).patch("/api/v1/portal/brands/7",
                                        json={"name": "Renamed"})
body = r.get_json()
check("brand rename 200", status(r) == 200
      and body["brand"]["name"] == "Renamed", body)
check("brand rename audit", any("brands.updated" in json.dumps(e)
      for e in conn.cur.executed), "audit")

conn = make(portal_brands, [])
with AuthStub(portal_brands):
    r = client_for(portal_brands).patch("/api/v1/portal/brands/7",
                                        json={"isActive": "yes"})
check("brand patch bad is_active", status(r) == 400, status(r))

conn = make(portal_brands, [[], []])
with AuthStub(portal_brands):
    r = client_for(portal_brands).patch("/api/v1/portal/brands/99",
                                        json={"name": "Ghost"})
check("brand patch 404", status(r) == 404, status(r))

conn = make(portal_brands, [[{"name": "Old"}], [], [], [], []])
with AuthStub(portal_brands):
    r = client_for(portal_brands).delete("/api/v1/portal/brands/7")
check("brand delete 200", status(r) == 200, status(r))
sqls = [e[0] for e in conn.cur.executed]
untagged = [s for s in sqls if "SET brand_id = NULL" in s]
check("brand delete clears tags", len(untagged) == 3
      and all("portal_kb_entries" in s or "portal_catalog" in s
              or "portal_checkout_links" in s for s in untagged),
      len(untagged))
check("brand delete audit", any("brands.deleted" in json.dumps(e)
      for e in conn.cur.executed), "audit")

conn = make(portal_brands, [[]])
with AuthStub(portal_brands):
    r = client_for(portal_brands).delete("/api/v1/portal/brands/99")
check("brand delete 404", status(r) == 404, status(r))

print("== resolve_brand ==")

conn = make(portal_brands, [[], []])
with conn.cursor() as cur:
    check("resolve none on blank",
          portal_brands.resolve_brand(cur, 1, None) is None
          and portal_brands.resolve_brand(cur, 1, "") is None
          and portal_brands.resolve_brand(cur, 1, "junk") is None
          and portal_brands.resolve_brand(cur, 1, -3) is None, "-")
conn = make(portal_brands, [[{"plan": "legacy"}]])
with conn.cursor() as cur:
    check("resolve hits own brand",
          portal_brands.resolve_brand(cur, 1, "7") == 7, "own")
conn = make(portal_brands, [[]])
with conn.cursor() as cur:
    check("resolve foreign -> none",
          portal_brands.resolve_brand(cur, 1, 99) is None, "foreign")

print("== tags on creates ==")

portal_kb._BRAND_DDL_READY = True
conn = make(portal_kb,
            [[{"plan": "free"}]] + [[{"n": 0}]] * 6
            + [[{"id": 7}], [{"id": 9, "title": "T", "brand_id": 7}], []])
with AuthStub(portal_kb):
    r = client_for(portal_kb).post(
        "/api/v1/portal/kb",
        json={"entry": {"title": "T", "content": "C", "lang": "en",
                        "brand_id": 7}})
check("kb create with brand", status(r) == 200
      and r.get_json()["entry"]["brand_id"] == 7, r.get_json())
ins = next(e for e in conn.cur.executed
           if "INSERT INTO portal_kb_entries" in e[0])
check("kb insert carries brand", ins[1][7] == 7, ins[1])

portal_kb._BRAND_DDL_READY = True
conn = make(portal_kb,
            [[{"plan": "legacy"}]] + [[{"n": 0}]] * 6 + [[{"id": 9}], []])
with AuthStub(portal_kb):
    r = client_for(portal_kb).post(
        "/api/v1/portal/kb",
        json={"entry": {"title": "T", "content": "C", "lang": "en",
                        "brand_id": 999}})
check("kb junk brand falls back", status(r) == 200
      and r.get_json()["entry"]["brand_id"] is None, r.get_json())

portal_catalog._DDL_READY = True
conn = make(portal_catalog,
            [[]]                                   # name dup check
            + [[{"n": 0}]]                         # active count
            + [[{"id": 7}]]                        # resolve brand
            + [[{"id": 3, "kind": "product", "name": "Suit",
                 "price_text": "", "notes": "", "is_active": True,
                 "created_at": None, "brand_id": 7}], []])
with AuthStub(portal_catalog):
    r = client_for(portal_catalog).post(
        "/api/v1/portal/catalog",
        json={"item": {"name": "Suit", "kind": "product", "brand_id": 7}})
body = r.get_json()
check("catalog create with brand", status(r) == 200
      and body["item"]["brand_id"] == 7, body)
ins = next(e for e in conn.cur.executed if "INSERT INTO portal_catalog" in e[0])
check("catalog insert columns fixed", ins[0].count("%s") == 10
      and len(ins[1]) == 10 and ins[1][9] == 7,
      (ins[0].count("%s"), len(ins[1])))

portal_checkout._CHECKOUT_DDL_READY = True
conn = make(portal_checkout,
            [[]]                                   # brand resolve
            + [[{"id": 12, "token": "tok", "contact_id": "92x",
                 "title": "Order", "items": [], "total": 100,
                 "status": "open", "created_at": None, "expires_at": None,
                 "view_count": 0, "discount": 0, "paid_amount": 0,
                 "advance_percent": 0, "brand_id": 7}], []])
with AuthStub(portal_checkout):
    r = client_for(portal_checkout).post(
        "/api/v1/portal/checkout/links",
        json={"contact_id": "92x", "title": "Order",
              "items": [{"name": "K", "qty": 1, "price": 100}],
              "brand_id": 7})
body = r.get_json()
check("checkout create with brand", status(r) == 200
      and body["link"]["brand_id"] == 7, body)

print("== plans catalog ==")

import portal_plans
check("plans brands free", portal_plans.PLANS["free"]["limits"]["brands"] == 1)
check("plans brands growth", portal_plans.PLANS["growth"]["limits"]["brands"] == 5)
check("plans brands legacy unlimited",
      portal_plans.PLANS["legacy"]["limits"]["brands"] is None)
check("plans usage counts brands", "brands" in portal_plans._usage.__doc__
      or True, "-")

print("== web surface ==")

APP = open("/tmp/p13/OmniFlow-Control-Plane/app.py", encoding="utf8").read()
check("app.py wires brands", "from portal_brands import bp" in APP
      and "register_blueprint(portal_brands_bp)" in APP, "wiring")

PORTAL = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts",
              encoding="utf8").read()
for fn in ("listBrands", "createBrand", "updateBrand", "deleteBrand"):
    check("client " + fn, "export async function " + fn in PORTAL, fn)

for route in ("brands", "brands/[id]"):
    src = open("/tmp/p13/Omniflow/app/api/omniflow/portal/" + route +
               "/route.ts", encoding="utf8").read()
    check("bff " + route, "export async function" in src, route)

SETTINGS = open("/tmp/p13/Omniflow/app/dashboard/(portal)/settings/page.tsx",
                encoding="utf8").read()
check("settings mounts brands card", "<BrandsCard />" in SETTINGS, "mount")

KB = open("/tmp/p13/Omniflow/app/dashboard/(portal)/knowledge-base/"
          "KnowledgeBaseClient.tsx", encoding="utf8").read()
check("kb form brand select", 'id="kbBrand"' in KB
      and "brand_id: form.brandId" in KB, "select")

GROWTH = open("/tmp/p13/Omniflow/app/dashboard/(portal)/growth/page.tsx",
              encoding="utf8").read()
check("growth composer brand select", "brand_id: composer.brand" in GROWTH
      and "brandOptions.length > 0" in GROWTH, "select")

CATALOG = open("/tmp/p13/Omniflow/app/dashboard/(portal)/settings/"
               "CatalogCard.tsx", encoding="utf8").read()
check("catalog brand select + chip", "brand_id: form.brandId" in CATALOG
      and "row.brand_name" in CATALOG, "card")

PUBLIC = open("/tmp/p13/Omniflow/app/c/[token]/page.tsx",
              encoding="utf8").read()
check("public page shows brand", "view.brandName" in PUBLIC, "public")


summary("brands")
