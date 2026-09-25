"""Tests for V2 B16: catalog sync (Woo/Shopify adapters, upsert
idempotence, masked creds, fail-graceful pull) + link-level
advance-COD splits (advance_due / cod_balance + create wiring)."""
import json

from flask import Flask

import portal_catalog
import portal_checkout
from test_lib import check, install_db_stub, summary

PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}


class PrincipalStub:
    def __init__(self, module, principal):
        self.module = module
        self.principal = principal

    def __enter__(self):
        self.orig = self.module.authenticate_portal_request
        self.module.authenticate_portal_request = lambda: self.principal
        self.module.PortalAuthUnavailable = Exception
        return self

    def __exit__(self, *a):
        self.module.authenticate_portal_request = self.orig


def make_app(module):
    app = Flask("b16")
    app.register_blueprint(module.bp)
    return app


def run(module, script, method, path, json_body=None,
        principal=PRINCIPAL, ddl_flag="_DDL_READY"):
    setattr(module, ddl_flag, False)
    conn = install_db_stub(module, script)
    app = make_app(module)
    with PrincipalStub(module, principal):
        client = app.test_client()
        if method == "GET":
            return client.get(path), conn
        if method == "POST":
            return client.post(path, json=json_body), conn
        if method == "PUT":
            return client.put(path, json=json_body), conn
    return None, conn


print("== catalog validate + public ==")

clean, err = portal_catalog.validate_catalog_item(
    {"name": "Kurti", "price": 2499.555, "stock": "12",
     "image_url": "https://x/y.jpg "})
check("validate numeric extras", err is None and clean["price"] == 2499.55
      and clean["stock"] == 12 and clean["image_url"]
      == "https://x/y.jpg", clean)
clean, err = portal_catalog.validate_catalog_item(
    {"name": "X", "price": "bogus", "stock": None})
check("validate junk falls back to zero", err is None
      and clean["price"] == 0.0 and clean["stock"] == 0, clean)
clean, err = portal_catalog.validate_catalog_item(
    {"name": "X", "price": 99999999})
check("validate clamps huge price", clean["price"] == 10000000.0, clean)

row = {"id": 1, "kind": "product", "name": "K", "price_text": "Rs 2500",
       "notes": "", "is_active": True, "price": 2500.0, "stock": 7,
       "image_url": "https://x/y.jpg", "source": "woo",
       "synced_at": None, "created_at": None}
pub = portal_catalog._public(row)
check("public exposes sync fields", pub["source"] == "woo"
      and pub["stock"] == 7 and pub["price"] == 2500.0, pub)

print("== woo + shopify adapters ==")

_WOO_PAGE = [{"id": 11, "name": "Kurti", "price": "2499.00",
              "stock_quantity": 5,
              "images": [{"src": "https://s/k.jpg"}]},
             {"id": 12, "name": "Shawl", "price": "990.50",
              "stock_quantity": None, "images": []}]
_SHOPIFY_PAGE = {"products": [
    {"id": 77, "title": "Ajrak", "variants": [{"price": "1500.00",
                                               "inventory_quantity": 3}],
     "image": {"src": "https://s/a.jpg"}},
    {"id": 78, "title": "Cap", "variants": [], "image": None},
]}

orig_http = portal_catalog._sync_http_json
try:
    portal_catalog._sync_http_json = lambda url, headers: list(_WOO_PAGE)
    settings = {"base_url": "https://store.example",
                "api_key": "ck", "api_secret": "cs"}
    products = portal_catalog._fetch_woo_products(settings)
    check("woo maps products", len(products) == 2
          and products[0]["external_id"] == "11"
          and products[0]["price"] == "2499.00"
          and products[0]["image_url"] == "https://s/k.jpg", products)
    check("woo None stock -> 0", products[1]["stock"] == 0, products[1])

    calls = []
    def fake_shopify(url, headers):
        calls.append((url, headers))
        return dict(_SHOPIFY_PAGE)
    portal_catalog._sync_http_json = fake_shopify
    products = portal_catalog._fetch_shopify_products(settings)
    check("shopify maps products", len(products) == 2
          and products[0]["name"] == "Ajrak"
          and products[0]["stock"] == 3, products[:1])
    check("shopify empty variants -> 0 price",
          products[1]["price"] == "0" and products[1]["stock"] == 0,
          products[1])
    check("shopify auth header", calls[0][1]
          == {"X-Shopify-Access-Token": "ck"}, calls[:1])
    check("shopify one page (short batch stops)",
          len(calls) == 1, calls)
finally:
    portal_catalog._sync_http_json = orig_http

print("== sync settings endpoints ==")

r, conn = run(portal_catalog, [[], []], "GET",
              "/api/v1/portal/catalog/sync/settings")
body = r.get_json()
check("sync settings default", r.status_code == 200
      and body["source"] == "" and body["last_sync_count"] == 0, body)

r, conn = run(portal_catalog, [[], [], [], []], "PUT",
              "/api/v1/portal/catalog/sync/settings",
              {"source": "woo", "base_url": "https://store.example",
               "api_key": "SECRETKEY1", "api_secret": "SECRETSEC1"})
check("sync settings save 200", r.status_code == 200, r.get_json())
executed = json.dumps(conn.cur.executed)
check("sync settings stores creds", "SECRETKEY1" in executed
      and "SECRETSEC1" in executed, "stored")
check("sync settings audited", "catalog.sync.config" in executed,
      "audit")

r, conn = run(portal_catalog, [[]], "PUT",
              "/api/v1/portal/catalog/sync/settings",
              {"source": "magento", "base_url": "https://x"})
check("sync source whitelist", r.status_code == 400, r.status_code)

r, conn = run(portal_catalog, [[]], "PUT",
              "/api/v1/portal/catalog/sync/settings",
              {"source": "woo", "base_url": "ftp://x"})
check("sync base_url scheme check", r.status_code == 400, r.status_code)

r, conn = run(portal_catalog, [], "PUT",
              "/api/v1/portal/catalog/sync/settings",
              {"source": "woo", "base_url": "https://x"},
              principal=dict(PRINCIPAL, via_api_key=True))
check("sync settings api key 403", r.status_code == 403, r.status_code)

print("== sync-now ==")

r, conn = run(portal_catalog, [[], []], "POST",
              "/api/v1/portal/catalog/sync")
check("sync not configured 409", r.status_code == 409, r.status_code)

portal_catalog._sync_http_json = lambda url, headers: list(_WOO_PAGE)
# slot order: sync DDL, settings, catalog DDL x6 (incl. brand column),
# lookup, insert, stats update, audit
r, conn = run(portal_catalog,
              [[],
               [{"source": "woo", "base_url": "https://s",
                 "api_key": "ck", "api_secret": "cs", "last_sync_at": None,
                 "last_sync_count": 0}],
               [], [], [], [], [], [],
               [], [], [], [], [], []],
              "POST", "/api/v1/portal/catalog/sync")
body = r.get_json()
check("sync imports new", r.status_code == 200
      and body["imported"] == 2 and body["updated"] == 0, body)
check("sync upsert by external_id", any(
    "external_id" in e[0] and "SELECT id" in e[0]
    for e in conn.cur.executed), "lookup")
check("sync stores stats + audit", any(
    "last_sync_count" in e[0] for e in conn.cur.executed)
    and any("catalog.synced" in json.dumps(e)
            for e in conn.cur.executed), "stats")

r, conn = run(portal_catalog, [], "POST",
              "/api/v1/portal/catalog/sync",
              principal=dict(PRINCIPAL, via_api_key=True))
check("sync api key 403", r.status_code == 403, r.status_code)

orig_http = portal_catalog._sync_http_json
try:
    def boom(url, headers):
        raise ValueError("connection refused")
    portal_catalog._sync_http_json = boom
    r, conn = run(portal_catalog,
                  [[],
                   [{"source": "woo", "base_url": "https://s",
                     "api_key": "ck", "api_secret": "cs",
                     "last_sync_at": None, "last_sync_count": 0}]],
                  "POST", "/api/v1/portal/catalog/sync")
    check("sync pull fail 502", r.status_code == 502
          and r.get_json()["error"]["code"] == "sync_failed",
          r.get_json())
finally:
    portal_catalog._sync_http_json = orig_http

print("== advance-COD splits ==")

link_row = {"id": 5, "token": "t", "contact_id": "c", "title": "Order",
            "items": [], "total": 2000.0, "status": "open",
            "paid_amount": 0.0, "advance_percent": 40,
            "discount": 0, "coupon_code": "", "coupon_discount": 0,
            "courier": "", "tracking_number": "", "created_at": None,
            "expires_at": None, "view_count": 0}
pub = portal_checkout._public(link_row)
check("advance split math", pub["advance_percent"] == 40
      and pub["advance_due"] == 800.0 and pub["cod_balance"] == 1200.0,
      {"a": pub["advance_due"], "c": pub["cod_balance"]})
check("due unaffected by split", pub["due"] == 2000.0, pub["due"])

link_row["paid_amount"] = 800.0
pub = portal_checkout._public(link_row)
check("advance follows payments", pub["advance_due"] == 480.0
      and pub["cod_balance"] == 720.0,
      {"a": pub["advance_due"], "c": pub["cod_balance"]})

link_row["advance_percent"] = 0
pub = portal_checkout._public(link_row)
check("no advance -> zero split", pub["advance_due"] == 0.0
      and pub["cod_balance"] == 0.0, pub)

# create wiring: advance_percent rides the INSERT
portal_checkout._CHECKOUT_DDL_READY = False
conn = install_db_stub(portal_checkout, [[], [], [], [], [], []])
app = Flask("b16c")
app.register_blueprint(portal_checkout.bp)
with PrincipalStub(portal_checkout, PRINCIPAL):
    client = app.test_client()
    resp = client.post("/api/v1/portal/checkout/links", json={
        "contact_id": "92a", "title": "Order",
        "items": [{"name": "K", "qty": 1, "price": 2000}],
        "advance_percent": 40,
    })
body = resp.get_json()
check("create with advance 200", resp.status_code == 200
      and body.get("ok") is True, body)
inserts = [e for e in conn.cur.executed
           if "INSERT INTO" in e[0] and "advance_percent" in e[0]]
check("create insert carries advance", len(inserts) == 1
      and "40" in json.dumps(inserts[0][1]), inserts)

with PrincipalStub(portal_checkout, PRINCIPAL):
    conn = install_db_stub(portal_checkout, [[], [], [], []])
    client = app.test_client()
    resp = client.post("/api/v1/portal/checkout/links", json={
        "contact_id": "92a", "title": "Order",
        "items": [{"name": "K", "qty": 1, "price": 10}],
        "advance_percent": 95,
    })
check("advance percent clamp 400", resp.status_code == 400,
      resp.status_code)

summary("b16")
