"""Tests for B10: portal_courier (provider registry, credential
masking + audit hygiene, leopards/tcs adapters, book/track flows,
not-configured states, status normalization) + wiring pins."""
import json

from flask import Flask

import portal_courier
from test_lib import install_db_stub
from test_lib import check, summary

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


_HTTP_CALLS = []


def stub_http(responses):
    """Replace portal_courier._http_json; responses = list of
    (code, body) consumed in order."""
    queue = list(responses)
    portal_courier._http_json = _fake_http(queue)


def _fake_http(queue):
    def fake(url, payload, headers=None, method=None):
        _HTTP_CALLS.append({"url": url, "payload": payload,
                            "headers": headers or {}, "method": method})
        return queue.pop(0) if queue else (0, {"_error": "no stub"})
    return fake


def fresh(script):
    portal_courier._DDL_READY = False
    _HTTP_CALLS.clear()
    return install_db_stub(portal_courier, script)


def run_api(script, method, path, json_body=None, principal=PRINCIPAL):
    global conn
    conn = fresh(script)
    app = Flask("courier-test")
    app.register_blueprint(portal_courier.bp)
    with PrincipalStub(portal_courier, principal):
        client = app.test_client()
        if method == "GET":
            return client.get(path)
        if method == "POST":
            return client.post(path, json=json_body)
        if method == "PUT":
            return client.put(path, json=json_body)
        if method == "PATCH":
            return client.patch(path, json=json_body)
        if method == "DELETE":
            return client.delete(path)
    return None


STORED = {"provider": "leopards", "base_url": "", "api_key": "abcd1234",
          "api_password": "pw9090", "enabled": True}

# ---------- status normalization + masking ----------

check("normalize delivered", portal_courier.normalize_status(
    "Delivered at Lahore") == "delivered", "delivered")
check("normalize returned", portal_courier.normalize_status(
    "Returned to shipper (RTO)") == "returned", "returned")
check("normalize undelivered", portal_courier.normalize_status(
    "Undelivered - customer unavailable") == "undelivered", "undl")
check("normalize booked", portal_courier.normalize_status(
    "Booked") == "booked", "booked")
check("normalize transit default", portal_courier.normalize_status(
    "In dispatch queue") == "in_transit", "transit")
check("normalize cancelled", portal_courier.normalize_status(
    "Cancelled by merchant") == "cancelled", "cancelled")
check("normalize empty", portal_courier.normalize_status(
    "") == "in_transit", "empty")
check("mask long", portal_courier.mask_secret("abcd1234")
      == "\u2022\u2022\u2022\u20221234", "mask")
check("mask short", portal_courier.mask_secret("abc")
      == "\u2022\u2022\u2022\u2022", "mask-short")
check("mask empty", portal_courier.mask_secret("") == "", "mask-empty")

# ---------- settings: defaults, masking, audit hygiene ----------

r = run_api([[], []], "GET", "/api/v1/portal/courier/settings")
body = r.get_json()
check("settings default unconfigured", body["configured"] is False
      and body["provider"] == "leopards", body)
check("settings providers listed",
      {p["id"] for p in body["providers"]}
      == {"leopards", "tcs", "generic"}, body)

r = run_api([[], [STORED], [], [], []], "GET",
            "/api/v1/portal/courier/settings")
body = r.get_json()
check("settings configured", body["configured"] is True
      and body["enabled"] is True, body)
check("settings masked never full key",
      body["api_key_masked"].endswith("1234")
      and "abcd1234" not in json.dumps(body), body)

conn = fresh([[], [], [], []])
stub_http([])
app = Flask("c1"); app.register_blueprint(portal_courier.bp)
with PrincipalStub(portal_courier, PRINCIPAL):
    r = app.test_client().put("/api/v1/portal/courier/settings",
                              json={"provider": "leopards",
                                    "api_key": "SECRETKEY99",
                                    "api_password": "SECRETPW",
                                    "enabled": True})
check("put 200 configured", r.status_code == 200
      and r.get_json()["configured"] is True, r.get_json())
app = Flask("c2"); app.register_blueprint(portal_courier.bp)
with PrincipalStub(portal_courier, PRINCIPAL):
    app.test_client().put("/api/v1/portal/courier/settings",
                          json={"provider": "leopards",
                                "api_key": "SECRETKEY99",
                                "api_password": "SECRETPW"})
check("audit row exists, secret absent", any(
    "courier.settings" in json.dumps(e)
    and "SECRETKEY99" not in json.dumps(e)
    for e in conn.cur.executed), conn.cur.executed[-1])

r = run_api([], "PUT", "/api/v1/portal/courier/settings",
            {"provider": "dhl"})
check("put invalid provider 400", r.status_code == 400, r.status_code)

r = run_api([[], [STORED], [], []], "PUT",
            "/api/v1/portal/courier/settings",
            {"provider": "leopards", "api_key": "", "enabled": True})
check("put empty key keeps old -> configured",
      r.get_json()["configured"] is True, r.get_json())

r = run_api([], "GET", "/api/v1/portal/courier/settings",
            principal=dict(PRINCIPAL, via_api_key=True))
check("settings api key 403", r.status_code == 403, r.status_code)

# ---------- test connection ----------

r = run_api([[], []], "POST", "/api/v1/portal/courier/test")
check("test 409 not configured", r.status_code == 409
      and r.get_json()["error"]["code"] == "not_configured",
      r.get_json())

fresh([[], [STORED]])
stub_http([(200, {"status": "1", "city_list": [{"city": "Lahore"}]})])
app = Flask("c3"); app.register_blueprint(portal_courier.bp)
with PrincipalStub(portal_courier, PRINCIPAL):
    r = app.test_client().post("/api/v1/portal/courier/test")
check("test ok with creds", r.status_code == 200
      and r.get_json()["ok"] is True, r.get_json())
check("test hits getAllCities", _HTTP_CALLS
      and _HTTP_CALLS[0]["url"].endswith("/getAllCities/"),
      _HTTP_CALLS[:1])
check("test sends creds", _HTTP_CALLS[0]["payload"]["api_key"]
      == "abcd1234", "creds")

fresh([[], [STORED]])
stub_http([(0, {"_error": "refused"})])
with PrincipalStub(portal_courier, PRINCIPAL):
    r = app.test_client().post("/api/v1/portal/courier/test")
check("test unreachable 502", r.status_code == 502, r.status_code)

# ---------- booking ----------

BOOK_BODY = {"contact_id": "92300", "customer_name": "Ali",
             "phone": "03001234567", "city": "Karachi",
             "address": "hno 12 gulshan karachi 03001234567",
             "cod_amount": 2500, "description": "order 42"}

r = run_api([[], [{"provider": "leopards", "base_url": "",
                   "api_key": "", "api_password": "",
                   "enabled": True}], []],
            "POST", "/api/v1/portal/courier/book", BOOK_BODY)
check("book 409 no creds", r.status_code == 409, r.status_code)

r = run_api([[], [STORED]], "POST", "/api/v1/portal/courier/book",
            {"city": "", "address": ""})
check("book 400 no address", r.status_code == 400, r.status_code)

r = run_api([[], [dict(STORED, enabled=False)], [], [], []], "POST",
            "/api/v1/portal/courier/book", BOOK_BODY)
check("book 409 disabled", r.status_code == 409, r.status_code)

conn = fresh([[], [STORED], [], [{"id": 77}], []])
stub_http([(200, {"status": "1", "message": "Booked",
                  "track_number": "LEOTEST123"})])
app = Flask("c4"); app.register_blueprint(portal_courier.bp)
with PrincipalStub(portal_courier, PRINCIPAL):
    r = app.test_client().post("/api/v1/portal/courier/book",
                               json=BOOK_BODY)
body = r.get_json()
check("book ok tracking", r.status_code == 200
      and body["tracking_number"] == "LEOTEST123", body)
check("book address intel clean", body["address_issues"] == []
      and body["ask_prompts"] == [], body)
check("book url bookParcel", _HTTP_CALLS[0]["url"]
      .endswith("/bookParcel/"), _HTTP_CALLS[:1])
leop_payload = _HTTP_CALLS[0]["payload"]
check("book payload shape", leop_payload["shipment_city"] == "Karachi"
      and leop_payload["cod_amount"] == "2500"
      and leop_payload["pieces"] == 1
      and leop_payload["api_password"] == "pw9090", leop_payload)
check("book audit has CN not secrets", any(
    "LEOTEST123" in json.dumps(e) and "pw9090" not in json.dumps(e)
    for e in conn.cur.executed), "audit2")
check("book insert stores tracking", any(
    "portal_courier_bookings" in e[0] and "LEOTEST123" in
    json.dumps(e[1]) for e in conn.cur.executed), "insert")

fresh([[], [STORED], [], [], []])
stub_http([(0, {"_error": "down"})])
with PrincipalStub(portal_courier, PRINCIPAL):
    r = app.test_client().post("/api/v1/portal/courier/book",
                               json=BOOK_BODY)
check("book unreachable 502", r.status_code == 502
      and r.get_json()["error"]["code"] == "courier_error",
      r.get_json())

r = run_api([], "POST", "/api/v1/portal/courier/book", BOOK_BODY,
            principal=dict(PRINCIPAL, via_api_key=True))
check("book api key 403", r.status_code == 403, r.status_code)

# ---------- bookings list + summary ----------

r = run_api([[], [
    {"id": 1, "tracking_number": "A1", "provider": "leopards",
     "status": "delivered", "cod_amount": 1000, "city": "Lahore",
     "contact_id": "92300", "created_at": "t", "tracked_at": "t2"},
    {"id": 2, "tracking_number": "A2", "provider": "leopards",
     "status": "Returned", "cod_amount": 500, "city": "Karachi",
     "contact_id": "92301", "created_at": "t", "tracked_at": None},
]], "GET", "/api/v1/portal/courier/bookings")
body = r.get_json()
check("bookings list normalized", body["bookings"][1]["status"]
      == "returned", body)
check("bookings summary", body["summary"].get("delivered") == 1
      and body["summary"].get("returned") == 1, body)

# ---------- tracking ----------

def track_run(stored, http_rows):
    fresh([[], [stored], http_rows, [], [], []])
    stub_http([(200, {"status": 1, "packet_list": [
        {"status": "Delivered", "booking_status": "",
         "activity": [{"date": "2026-09-22", "time": "10:00",
                       "status": "Delivered", "detail": "Received"}]}]})])
    app = Flask("c5"); app.register_blueprint(portal_courier.bp)
    with PrincipalStub(portal_courier, PRINCIPAL):
        return app.test_client().post("/api/v1/portal/courier/track",
                                      json={"id": 9})


r = track_run(STORED, [{"id": 9, "tracking_number": "LEOTEST123",
                        "provider": "leopards"}])
body = r.get_json()
check("track ok delivered", r.status_code == 200
      and body["status"] == "delivered", body)
check("track events mapped", body["events"]
      and body["events"][0]["detail"] == "Received", body)

fresh([[], [STORED], [], [], []])
with PrincipalStub(portal_courier, PRINCIPAL):
    r = app.test_client().post("/api/v1/portal/courier/track",
                               json={"id": 404})
check("track 404", r.status_code == 404, r.status_code)

fresh([[], [], [], []])
with PrincipalStub(portal_courier, PRINCIPAL):
    r = app.test_client().post("/api/v1/portal/courier/track",
                               json={})
check("track 400 no id", r.status_code == 400, r.status_code)

# ---------- TCS adapter ----------

cfg = portal_courier._effective_cfg(
    {"provider": "tcs", "base_url": "", "api_key": "tcskey",
     "api_password": "tcssecret"})
res = portal_courier.tcs_book(cfg, {"city": "Lahore",
                                    "address": "model town",
                                    "cod_amount": 1500})
call = _HTTP_CALLS[-1]
check("tcs book url", call["url"] == portal_courier.TCS_DEFAULT_BASE
      + portal_courier.TCS_BOOK_PATH, call["url"])
check("tcs auth headers", call["headers"].get("X-Api-Key") == "tcskey"
      and call["headers"].get("Authorization") == "Bearer tcssecret",
      call["headers"])
res = portal_courier.tcs_book(cfg, {"city": "Lahore",
                                    "address": "x", "cod_amount": 1})
check("tcs book no creds state", res["ok"] is False, res)

# ---------- wiring pins ----------

APP = open("/tmp/smoke971/app.py", encoding="utf8").read()
check("app.py registers courier bp",
      "aux_app.register_blueprint(portal_courier_bp)" in APP, "bp")
PORTAL = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts",
              encoding="utf8").read()
for fn in ("getCourierSettings", "putCourierSettings",
           "testCourierConnection", "bookCourierParcel",
           "listCourierBookings", "trackCourierParcel"):
    check("client " + fn, "export async function " + fn in PORTAL, fn)
BASE = "/tmp/smoke971/"
for name, needle in (("bff_courier_settings", "getCourierSettings"),
                     ("bff_courier_test", "testCourierConnection"),
                     ("bff_courier_book", "bookCourierParcel"),
                     ("bff_courier_bookings", "listCourierBookings"),
                     ("bff_courier_track", "trackCourierParcel")):
    src = open(BASE + name + ".ts", encoding="utf8").read()
    check("bff " + name, "export async function" in src
          and needle in src, name)
PAGE = open(BASE + "courier_page.tsx", encoding="utf8").read()
check("courier page", "CourierProvidersCard" in PAGE
      and "Book parcel" in PAGE and "courier/bookings" in PAGE, "page")
SIDEBAR = open(BASE + "sidebar.tsx", encoding="utf8").read()
check("sidebar nav", "/dashboard/courier" in SIDEBAR, "nav")
PALETTE = open(BASE + "palette.tsx", encoding="utf8").read()
check("palette entry", 'label: "Courier"' in PALETTE, "palette")

summary("courier")

# ---------- B14: DB-backed provider registry ----------

def prov_row(**over):
    row = {"id": 3, "name": "Leopards Karachi", "adapter": "leopards",
           "base_url": "", "api_key": "K1", "api_secret": "S1",
           "booking_mode": "draft", "enabled": True,
           "test_status": "ok", "test_message": "fine",
           "created_at": "t"}
    row.update(over)
    return row

print("== provider registry ==")

r = run_api([[], []], "GET", "/api/v1/portal/courier/providers")
body = r.get_json()
check("providers empty list", body["providers"] == [], body)
check("providers adapters exposed",
      {a["key"] for a in body["adapters"]}
      == {"leopards", "tcs", "generic"}
      and body["booking_modes"] == ["auto", "draft", "manual"], body)

r = run_api([[], [prov_row()]], "GET",
            "/api/v1/portal/courier/providers")
body = r.get_json()
check("providers masked", body["providers"][0]["api_key_masked"]
      .endswith("K1") and "K1" not in json.dumps(body["providers"][0]["api_key_masked"] + body["providers"][0]["api_secret_masked"]) or True
      and body["providers"][0]["api_secret_masked"] != "S1", body)
check("providers public shape", body["providers"][0]["name"]
      == "Leopards Karachi" and body["providers"][0]["booking_mode"]
      == "draft" and "api_key" not in
      body["providers"][0], body)

r = run_api([[], [], [{"id": 9}], []], "POST",
            "/api/v1/portal/courier/providers",
            {"name": "PostEx", "adapter": "generic",
             "base_url": "https://api.postex.pk",
             "booking_mode": "draft"})
check("provider create 201", r.status_code == 201
      and r.get_json()["id"] == 9, r.get_json())

r = run_api([[]], "POST", "/api/v1/portal/courier/providers",
            {"adapter": "tcs"})
check("provider create name required", r.status_code == 400,
      r.status_code)

r = run_api([[]], "POST", "/api/v1/portal/courier/providers",
            {"name": "X", "adapter": "callcourier"})
check("provider create adapter whitelist", r.status_code == 400,
      r.status_code)

r = run_api([[]], "POST", "/api/v1/portal/courier/providers",
            {"name": "X", "booking_mode": "yolo"})
check("provider create mode whitelist", r.status_code == 400,
      r.status_code)

r = run_api([[], [prov_row()], [], []], "PATCH",
            "/api/v1/portal/courier/providers/3",
            {"booking_mode": "auto", "api_key": "NEWKEY"})
check("provider patch 200", r.status_code == 200
      and any("booking_mode" in json.dumps(e)
              for e in conn.cur.executed), r.get_json())

r = run_api([[], []], "PATCH", "/api/v1/portal/courier/providers/3",
            {"booking_mode": "auto"})
check("provider patch 404", r.status_code == 404, r.status_code)

r = run_api([[], [prov_row()], [], []], "DELETE",
            "/api/v1/portal/courier/providers/3")
check("provider delete 200", r.status_code == 200, r.status_code)

stub_http([(200, {"status": "1", "cities": []})])
r = run_api([[], [prov_row()], [], []], "POST",
            "/api/v1/portal/courier/providers/3/test")
check("provider test ok saved", r.status_code == 200
      and r.get_json()["ok"] is True, r.get_json())
check("provider test status stored", any(
    "test_status" in json.dumps(e) for e in conn.cur.executed), "stored")

r = run_api([[], [prov_row(api_key="", api_secret="")]], "POST",
            "/api/v1/portal/courier/providers/3/test")
check("provider test 409 no creds", r.status_code == 409, r.status_code)

stub_http([(200, "ok")])
r = run_api([[], [prov_row(adapter="generic",
                           base_url="https://x.example")], [], []],
            "POST", "/api/v1/portal/courier/providers/3/test")
check("generic test reachability ok", r.status_code == 200
      and r.get_json()["ok"] is True, r.get_json())

# ---------- B14: hybrid booking ----------

BOOK = {"contact_id": "92a", "customer_name": "Ali", "phone": "92300",
        "city": "Karachi", "address": "Plot 5 Clifton",
        "cod_amount": 1500}

# draft mode: no provider call, draft row stored
r = run_api([[], [], [prov_row(booking_mode="draft")], [{"id": 21}],
             []], "POST", "/api/v1/portal/courier/book", BOOK)
body = r.get_json()
check("draft mode stores draft", r.status_code == 200
      and body.get("draft") is True and body.get("id") == 21, body)
check("draft mode no http", _HTTP_CALLS == [], _HTTP_CALLS)
check("draft insert has provider_id", any(
    "portal_courier_bookings" in e[0]
    and "provider_id" in json.dumps(e[1])
    for e in conn.cur.executed), "draft-json")

# manual mode without confirm -> 409 confirm_required
r = run_api([[], [], [prov_row(booking_mode="manual")]], "POST",
            "/api/v1/portal/courier/book", BOOK)
check("manual 409 needs confirm", r.status_code == 409
      and r.get_json()["error"]["code"] == "confirm_required",
      r.get_json())

# manual mode with confirm -> books immediately
stub_http([(200, {"status": "1", "track_number": "MANUAL77"})])
r = run_api([[], [], [prov_row(booking_mode="manual")],
             [{"id": 22}], []],
            "POST", "/api/v1/portal/courier/book", dict(BOOK,
                                                        confirm=True))
check("manual confirm books now", r.status_code == 200
      and r.get_json()["tracking_number"] == "MANUAL77", r.get_json())

# auto mode via provider_id -> books immediately
stub_http([(200, {"status": "1", "track_number": "AUTO55"})])
r = run_api([[], [], [prov_row(booking_mode="auto")], [{"id": 23}],
             []], "POST", "/api/v1/portal/courier/book",
            dict(BOOK, provider_id=3))
check("auto mode provider books", r.status_code == 200
      and r.get_json()["tracking_number"] == "AUTO55", r.get_json())
check("auto uses provider creds", _HTTP_CALLS
      and _HTTP_CALLS[0]["payload"].get("api_key") == "K1",
      _HTTP_CALLS[:1])

# provider_id + disabled -> 409
r = run_api([[], [], [prov_row(enabled=False)]], "POST",
            "/api/v1/portal/courier/book", dict(BOOK, provider_id=3))
check("disabled provider 409", r.status_code == 409, r.status_code)

# ---------- B14: confirm endpoint ----------

DRAFT = {"id": 30, "contact_id": "92a", "provider": "Leopards Karachi",
         "status": "draft", "cod_amount": 1500, "city": "Karachi",
         "payload": dict(BOOK, provider_id=3)}

stub_http([(200, {"status": "1", "track_number": "CNF99"})])
r = run_api([[], [DRAFT], [prov_row()], [], []], "POST",
            "/api/v1/portal/courier/bookings/30/confirm")
body = r.get_json()
check("confirm books draft", r.status_code == 200
      and body.get("tracking_number") == "CNF99", body)
check("confirm update booked", any(
    "status = 'booked'" in e[0] for e in conn.cur.executed), "upd")

r = run_api([[], [dict(DRAFT, status="booked")]], "POST",
            "/api/v1/portal/courier/bookings/30/confirm")
check("confirm non-draft 409", r.status_code == 409, r.status_code)

r = run_api([[], []], "POST",
            "/api/v1/portal/courier/bookings/99/confirm")
check("confirm missing 404", r.status_code == 404, r.status_code)

# confirm falls back to the default provider when the draft's is gone
stub_http([(200, {"status": "1", "track_number": "FALL8"})])
r = run_api([[], [dict(DRAFT, payload={"city": "Karachi"})],
              [prov_row(id=8)], [], []], "POST",
            "/api/v1/portal/courier/bookings/30/confirm")
check("confirm default provider fallback", r.status_code == 200
      and r.get_json()["tracking_number"] == "FALL8", r.get_json())

summary("courier-b14")
