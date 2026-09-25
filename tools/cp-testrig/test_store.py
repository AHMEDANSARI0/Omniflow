"""Tests for the B22 multi-brand storefront: brand slugs, the public
store page payload, the public order flow (checkout link + WhatsApp
queue + audit + rate limit), PATCH slug, and the web surfaces."""
import json

from flask import Flask

import portal_brands
import portal_growth
import test_lib
from test_lib import PrincipalStub, check, install_db_stub, summary

PRINCIPAL = {"client_id": 1, "role": "owner", "user_id": 9,
             "kind": "human", "via_api_key": False}

app = Flask(__name__)
app.register_blueprint(portal_brands.bp)
app.register_blueprint(portal_brands.store_bp)
client = app.test_client()

portal_growth._send_command = lambda *a, **k: SEND_LOG.append(a)
SEND_LOG = []

print("== slug helpers ==")

check("slugify basic", portal_brands.slugify("Studio A") == "studio-a",
      portal_brands.slugify("Studio A"))
check("slugify junk", portal_brands.slugify("  Ali !! & Co  ")
      == "ali-co", portal_brands.slugify("  Ali !! & Co  "))
check("slugify empty", portal_brands.slugify("") == "brand", "brand")
check("clean slug", portal_brands._clean_slug("Studio-A!")
      == "studio-a", "clean")
check("normalize contact",
      portal_brands._normalize_contact("92 300-1234567")
      == "923001234567@c.us", "jid")
check("normalize plus", portal_brands._normalize_contact("+923001234567")
      == "923001234567@c.us", "jid")
check("normalize jid passthrough",
      portal_brands._normalize_contact("923001234567@s.whatsapp.net")
      == "923001234567@s.whatsapp.net", "passthrough")
check("normalize junk", portal_brands._normalize_contact("abc") == "", "")

print("== ddl: slug column ==")

conn = install_db_stub(portal_brands, [[], [], []])
portal_brands._DDL_READY = False
with conn.cursor() as cur:
    portal_brands._ensure_ddl(cur)
executed = [e[0] for e in conn.cur.executed]
check("ddl base table", "CREATE TABLE IF NOT EXISTS portal_brands"
      in executed[0], executed[0])
check("ddl slug column", any("ADD COLUMN IF NOT EXISTS slug" in sql
                             for sql in executed), "alter")
check("ddl slug unique", any("portal_brands_slug_idx" in sql
                             and "UNIQUE" in sql for sql in executed),
      "index")

print("== create/list carry slug ==")

portal_brands._DDL_READY = True
conn = install_db_stub(portal_brands, [
    [{"n": 0}], [], [],
    [{"id": 3, "name": "Studio A", "slug": "studio-a",
      "is_active": True, "created_at": "now"}], []])
PrincipalStub(portal_brands, principal=PRINCIPAL)
r = client.post("/api/v1/portal/brands", json={"name": "Studio A"})
body = r.get_json()
check("create ok", r.status_code == 200 and body["ok"] is True, body)
check("create slug", body["brand"]["slug"] == "studio-a", body)
check("create insert has slug", any(
    "(client_id, name, slug)" in json.dumps(e)
    for e in conn.cur.executed), "insert")
conn = install_db_stub(portal_brands, [
    [{"id": 3, "name": "Studio A", "slug": "studio-a",
      "is_active": True, "created_at": "now"}]])
r = client.get("/api/v1/portal/brands")
body = r.get_json()
check("list slug", body["brands"][0]["slug"] == "studio-a", body)

print("== PATCH slug ==")

PrincipalStub(portal_brands, principal=PRINCIPAL)
conn = install_db_stub(portal_brands, [
    [], [{"id": 3, "name": "Studio A", "slug": "studio-b",
              "is_active": True, "created_at": "now"}], []])
r = client.patch("/api/v1/portal/brands/3", json={"slug": "Studio B!"})
body = r.get_json()
check("patch slug cleaned", r.status_code == 200
      and body["brand"]["slug"] == "studio-b", body)
conn = install_db_stub(portal_brands, [[{"n": 1}], []])
r = client.patch("/api/v1/portal/brands/3", json={"slug": "taken"})
check("patch slug taken 409", r.status_code == 409, r.status_code)
r = client.patch("/api/v1/portal/brands/3", json={"slug": "!!!"})
check("patch slug junk 400", r.status_code == 400, r.status_code)

print("== public store GET ==")

PrincipalStub(portal_brands, principal=None)
conn = install_db_stub(portal_brands, [[]])
r = client.get("/api/v1/public/store/studio-a")
check("store 404 missing", r.status_code == 404, r.status_code)

conn = install_db_stub(portal_brands, [
    [{"id": 3, "client_id": 1, "name": "Studio A", "slug": "studio-a"}],
    [{"id": 7, "kind": "product", "name": "Lawn Suit",
      "price_text": "Rs 4,500", "notes": "3 piece", "price": 4500,
      "stock": 5, "image_url": "https://x/i.jpg"}]])
r = client.get("/api/v1/public/store/studio-a")
body = r.get_json()
check("store 200", r.status_code == 200, r.status_code)
check("store brand", body["brand"]["name"] == "Studio A"
      and body["brand"]["slug"] == "studio-a", body)
check("store items", body["items"][0]["name"] == "Lawn Suit"
      and body["items"][0]["price"] == 4500
      and body["items"][0]["image_url"] == "https://x/i.jpg", body)
check("store items query active-only", any(
    "c.is_active IS TRUE" in json.dumps(e)
    for e in conn.cur.executed), "filter")
store_item_q = [e for e in conn.cur.executed
                if "c.brand_id = %s" in e[0]]
check("store items query params", len(store_item_q) == 1
      and store_item_q[0][1] == (1, 3), store_item_q)
r = client.get("/api/v1/public/store/!!!")
check("store junk slug 404", r.status_code == 404, r.status_code)

print("== public order ==")

PrincipalStub(portal_brands, principal=None)
r = client.post("/api/v1/public/store/studio-a/order",
                json={"phone": "abc", "item_id": 7})
check("order bad phone 400", r.status_code == 400, r.status_code)
r = client.post("/api/v1/public/store/studio-a/order",
                json={"phone": "923001234567", "item_id": 0})
check("order no item 400", r.status_code == 400, r.status_code)

SEND_LOG.clear()
import portal_ratelimit
portal_ratelimit._DDL_READY = True
conn = install_db_stub(portal_brands, [
    [{"count": 1}],  # rate limit upsert RETURNING count
    [],              # rate limit prune DELETE
    [{"id": 3, "client_id": 1, "name": "Studio A"}],
    [{"id": 7, "name": "Lawn Suit", "price_text": "Rs 4,500",
      "price": 4500}],
    [{"id": 11}],
    [],  # audit
    [],  # send command conn (no queries)
])
r = client.post("/api/v1/public/store/studio-a/order",
                json={"phone": "923001234567", "name": "Ali",
                      "item_id": 7})
body = r.get_json()
check("order ok", r.status_code == 200 and body["ok"] is True, body)
check("order link url", "/c/" in body["url"], body)
check("order whatsapp queued", SEND_LOG
      and SEND_LOG[0][2] == "923001234567@c.us"
      and "Lawn Suit" in SEND_LOG[0][4], SEND_LOG)
check("order link tagged", any("brand_id" in json.dumps(e)
                               for e in conn.cur.executed), "tagged")
check("order audit", any("store.order" in json.dumps(e)
                         for e in conn.cur.executed), "audit")

conn = install_db_stub(portal_brands, [[{"count": 4}], [], []])
r = client.post("/api/v1/public/store/studio-a/order",
                json={"phone": "923001234567", "item_id": 7})
check("order rate limited", r.status_code == 429, r.status_code)

conn = install_db_stub(portal_brands, [[{"count": 1}], [], [], []])
r = client.post("/api/v1/public/store/missing/order",
                json={"phone": "923001234567", "item_id": 7})
check("order store missing 404", r.status_code == 404, r.status_code)

print("== app wiring ==")

APP = open("./app.py", encoding="utf8").read()
check("app imports store bp",
      "from portal_brands import store_bp as portal_brands_store_bp" in APP,
      "imp")
check("app registers store bp",
      "register_blueprint(portal_brands_store_bp)" in APP, "reg")

print("== website surface (vs /tmp/p13) ==")

P13 = "/tmp/p13/Omniflow/"


def read(path):
    return open(P13 + path, encoding="utf8").read()


PORTAL = read("lib/omniflow/portal.ts")
for fn in ("getPublicStore", "orderFromStore"):
    check("client " + fn, "export async function " + fn in PORTAL, fn)
check("brand slug type", "slug: string | null;" in PORTAL, "type")

STORE_PAGE = read("app/store/[slug]/page.tsx")
check("store page", "getPublicStore" in STORE_PAGE
      and "store.brand.name" in STORE_PAGE
      and "Store not found" in STORE_PAGE, "page")
ORDER_FORM = read("app/store/[slug]/StoreOrder.tsx")
check("store order form", "Order on WhatsApp" in ORDER_FORM
      and "/order" in ORDER_FORM, "form")

BFF_STORE = read("app/api/omniflow/public/store/[slug]/route.ts")
check("store bff", "getPublicStore" in BFF_STORE
      and '"../../../../../../lib/omniflow/portal"' in BFF_STORE, "7 ups")
BFF_ORDER = read("app/api/omniflow/public/store/[slug]/order/route.ts")
check("order bff", "orderFromStore" in BFF_ORDER
      and '"../../../../../../../lib/omniflow/portal"' in BFF_ORDER, "7 ups")

CARDS = read("app/dashboard/(portal)/settings/BrandsCard.tsx")
check("brands store link", '"/store/" + brand.slug' in CARDS, "link")

summary("store")
