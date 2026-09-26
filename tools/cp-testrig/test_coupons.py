"""Tests for coupon codes (971-990 batch): owner CRUD validation, public
apply/remove math (percent + fixed, previous-coupon revert, usage counting),
guards, 503 wrap, and web pins."""
import datetime

from flask import Flask

import portal_coupons
import portal_ratelimit
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_coupons.bp)
app.register_blueprint(portal_coupons.public_bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
apikey = dict(human, via_api_key=True)
PrincipalStub(portal_coupons, principal=human)

COUPON = {"id": 2, "code": "EID25", "kind": "percent", "value": 25,
          "min_total": 0, "usage_limit": 100, "used_count": 3,
          "expires_at": None, "is_active": True}
LINK_PLAIN = {"id": 3, "client_id": 1, "total": 1000.0, "coupon_code": "",
              "coupon_discount": 0, "status": "open", "expires_at": None}
LINK_WITH_OLD = dict(LINK_PLAIN, total=800.0, coupon_code="OLD",
                     coupon_discount=100.0)


def fresh(script):
    portal_coupons._DDL_READY = True
    portal_ratelimit._DDL_READY = True
    return install_db_stub(portal_coupons, script)


print("== validation ==")

clean, err = portal_coupons.validate_coupon(
    {"code": " eid25 ", "kind": "percent", "value": 25})
check("clean uppercases", err is None and clean["code"] == "EID25", clean)
check("code regex", portal_coupons.validate_coupon(
    {"code": "AB", "kind": "fixed", "value": 5})[1]
      == "Code must be 3-24 letters or numbers.", "-")
check("code punctuation", portal_coupons.validate_coupon(
    {"code": "EID-25", "kind": "fixed", "value": 5})[1] is not None, "-")
check("kind", portal_coupons.validate_coupon(
    {"code": "EID25", "kind": "half", "value": 5})[1]
      == "kind must be percent or fixed.", "-")
check("percent range", "Percent must be between 1 and 90."
      in (portal_coupons.validate_coupon(
          {"code": "EID25", "kind": "percent", "value": 95})[1] or ""), "-")
check("fixed floor", portal_coupons.validate_coupon(
    {"code": "E", "kind": "fixed", "value": 0.2})[1] is not None, "-")
check("bool value", portal_coupons.validate_coupon(
    {"code": "EID25", "kind": "fixed", "value": True})[1]
      == "value must be a number.", "-")
check("min_total", portal_coupons.validate_coupon(
    {"code": "E", "kind": "fixed", "value": 5, "min_total": -1})[1]
      is not None, "-")
check("usage_limit whole", portal_coupons.validate_coupon(
    {"code": "E", "kind": "fixed", "value": 5, "usage_limit": "5"})[1]
      is not None, "-")
check("expiry range", portal_coupons.validate_coupon(
    {"code": "E", "kind": "fixed", "value": 5, "expires_in_days": 400})[1]
      is not None, "-")

print("== owner CRUD ==")

conn = fresh([[], [dict(COUPON)], []])
response = client.post("/api/v1/portal/coupons",
                       json={"code": "eid25", "kind": "percent", "value": 25,
                             "min_total": 0, "usage_limit": 100})
payload = response.get_json()
check("create 200", status(response) == 200
      and payload["coupon"]["code"] == "EID25", payload)
ins_sql, ins_params = conn.cur.executed[1]
check("insert", "INSERT INTO portal_coupons" in ins_sql
      and ins_params[1] == "EID25" and ins_params[2] == "percent"
      and ins_params[3] == 25, ins_sql[:60])
check("audit created", conn.cur.executed[2][1][1] == "coupon.created"
      and "EID25" in conn.cur.executed[2][1][5], conn.cur.executed[2][1])

conn = fresh([[{"id": 9}]])
response = client.post("/api/v1/portal/coupons",
                       json={"code": "EID25", "kind": "percent", "value": 25})
check("409 dup", status(response) == 409, status(response))

conn = fresh([[COUPON]])
response = client.get("/api/v1/portal/coupons")
payload = response.get_json()
check("list shape", status(response) == 200
      and payload["coupons"][0]["minTotal"] == 0
      and payload["coupons"][0]["usageLimit"] == 100
      and payload["coupons"][0]["isActive"] is True, payload)

conn = fresh([[dict(COUPON, is_active=False)], []])
response = client.patch("/api/v1/portal/coupons/2",
                        json={"is_active": False})
check("patch 200", status(response) == 200
      and response.get_json()["coupon"]["isActive"] is False, status(response))
check("audit updated", conn.cur.executed[1][1][1] == "coupon.updated",
      conn.cur.executed[1][1])

conn = fresh([[]])
response = client.patch("/api/v1/portal/coupons/2", json={"is_active": False})
check("404 patch", status(response) == 404, status(response))

conn = fresh([])
response = client.patch("/api/v1/portal/coupons/2", json={"is_active": "yes"})
check("400 patch bool", status(response) == 400, status(response))

conn = fresh([[{"id": 2, "code": "EID25"}], []])
response = client.delete("/api/v1/portal/coupons/2")
check("delete 200", status(response) == 200, status(response))
check("audit removed", conn.cur.executed[1][1][1] == "coupon.removed",
      conn.cur.executed[1][1])

conn = fresh([[]])
response = client.delete("/api/v1/portal/coupons/77")
check("404 delete", status(response) == 404, status(response))

PrincipalStub(portal_coupons, principal=apikey)
conn = fresh([[COUPON]])
response = client.post("/api/v1/portal/coupons",
                       json={"code": "EID25", "kind": "percent", "value": 25})
check("403 api-key create", status(response) == 403, status(response))
response = client.delete("/api/v1/portal/coupons/2")
check("403 api-key delete", status(response) == 403, status(response))
PrincipalStub(portal_coupons, principal=human)

conn = fresh([RuntimeError("db down")])
response = client.get("/api/v1/portal/coupons")
check("503 wrap list", status(response) == 503, status(response))

print("== public apply: percent ==")

conn = fresh([[{"count": 5}], [LINK_PLAIN], [COUPON], [{"id": 3}], [], []])
response = client.post("/api/v1/public/checkout/tok123456/coupon",
                       json={"code": "eid25"})
payload = response.get_json()
check("percent applied", status(response) == 200 and payload
      == {"ok": True, "code": "EID25", "discount": 250.0, "total": 750.0},
      payload)
upd_sql, upd_params = conn.cur.executed[3]
check("link updated", "SET total = %s, coupon_code = %s" in upd_sql
      and upd_params == (750.0, "EID25", 250.0, 3), upd_params)
used_sql, used_params = conn.cur.executed[4]
check("usage counted", "SET used_count = used_count + 1" in used_sql
      and used_params == (2,), used_sql[:60])
check("audit applied", conn.cur.executed[5][1][1] == "coupon.applied"
      and conn.cur.executed[5][1][2] == "customer", conn.cur.executed[5][1])

print("== public apply: fixed + previous revert ==")

conn = fresh([[{"count": 5}], [LINK_WITH_OLD],
              [dict(COUPON, code="FLAT200", kind="fixed", value=200)],
              [{"id": 9}], [], [{"id": 3}], [], []])
response = client.post("/api/v1/public/checkout/tok123456/coupon",
                       json={"code": "FLAT200"})
payload = response.get_json()
check("fixed applied on restored base", status(response) == 200
      and payload["total"] == 700.0 and payload["discount"] == 200.0, payload)
old_sel = conn.cur.executed[3][0]
check("old coupon looked up", "code = %s" in old_sel, old_sel[:70])
dec_sql = conn.cur.executed[4][0]
check("old usage decremented", "GREATEST(used_count - 1, 0)" in dec_sql,
      dec_sql[:60])
check("replaced code", conn.cur.executed[5][1][1] == "FLAT200",
      conn.cur.executed[5][1])

print("== public apply: rejections leave the old coupon alone ==")

conn = fresh([[{"count": 5}], [LINK_WITH_OLD], [dict(COUPON, is_active=False)]])
response = client.post("/api/v1/public/checkout/tok123456/coupon",
                       json={"code": "EID25"})
check("400 inactive", status(response) == 400, status(response))
check("no revert writes", len(conn.cur.executed) == 3, len(conn.cur.executed))

conn = fresh([[{"count": 5}], [LINK_PLAIN], [dict(COUPON, min_total=1500)]])
response = client.post("/api/v1/public/checkout/tok123456/coupon",
                       json={"code": "EID25"})
check("400 min spend", status(response) == 400
      and "1500" in response.get_json()["error"]["message"], status(response))

conn = fresh([[{"count": 5}], [LINK_PLAIN], [dict(COUPON, used_count=100)]])
response = client.post("/api/v1/public/checkout/tok123456/coupon",
                       json={"code": "EID25"})
check("400 usage limit", status(response) == 400
      and "usage limit" in response.get_json()["error"]["message"],
      status(response))

conn = fresh([[{"count": 5}], [LINK_PLAIN],
              [dict(COUPON,
                    expires_at=datetime.datetime(2020, 1, 1,
                                                 tzinfo=datetime.timezone.utc))]])
response = client.post("/api/v1/public/checkout/tok123456/coupon",
                       json={"code": "EID25"})
check("400 expired", status(response) == 400
      and "expired" in response.get_json()["error"]["message"], status(response))

conn = fresh([[{"count": 5}], [LINK_PLAIN], []])
response = client.post("/api/v1/public/checkout/tok123456/coupon",
                       json={"code": "NOPE1"})
check("404 unknown code", status(response) == 404, status(response))

conn = fresh([[{"count": 5}], []])
response = client.post("/api/v1/public/checkout/tokbad/coupon",
                       json={"code": "EID25"})
check("404 bad token", status(response) == 404, status(response))

conn = fresh([[{"count": 5}], [dict(LINK_PLAIN, status="paid")], [COUPON]])
response = client.post("/api/v1/public/checkout/tok123456/coupon",
                       json={"code": "EID25"})
check("400 closed link", status(response) == 400, status(response))

conn = fresh([])
response = client.post("/api/v1/public/checkout/tok/coupon",
                       json={"code": "  "})
check("400 empty code", status(response) == 400, status(response))

print("== public remove ==")

conn = fresh([[LINK_WITH_OLD], [{"id": 9}], [], [{"id": 3}], [], []])
response = client.delete("/api/v1/public/checkout/tok123456/coupon")
payload = response.get_json()
check("remove 200", status(response) == 200 and payload["total"] == 900.0,
      payload)
rm_sql, rm_params = conn.cur.executed[3]
check("restore sql", "coupon_code = ''" in rm_sql
      and rm_params == (900.0, 3), rm_params)

conn = fresh([[LINK_PLAIN]])
response = client.delete("/api/v1/public/checkout/tok123456/coupon")
check("404 nothing applied", status(response) == 404, status(response))

conn = fresh([RuntimeError("db down")])
response = client.delete("/api/v1/public/checkout/tok/coupon")
check("503 wrap remove", status(response) == 503, status(response))

print("== web shape ==")

PORTAL = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts", encoding="utf8").read()
for name in ("listCoupons", "createCoupon", "setCouponActive", "deleteCoupon",
             "applyPublicCoupon", "removePublicCoupon"):
    check("client " + name, "export async function " + name in PORTAL, name)
check("public coupon paths", '"/coupon"' in PORTAL, "path")

CARD = open("/tmp/p13/Omniflow/app/dashboard/(portal)/settings/CouponsCard.tsx",
            encoding="utf8").read()
check("coupons card", "Coupon codes" in CARD
      and "/api/omniflow/portal/coupons" in CARD
      and "Create coupon" in CARD and "Pause" in CARD, "card")
SETTINGS = open("/tmp/p13/Omniflow/app/dashboard/(portal)/settings/page.tsx",
                encoding="utf8").read()
check("settings wiring", "<CouponsCard />" in SETTINGS
      and "<CatalogCard />" in SETTINGS, "wiring")

BFF = open("/tmp/p13/Omniflow/app/api/omniflow/portal/coupons/route.ts",
           encoding="utf8").read()
check("coupons bff", "export async function GET" in BFF
      and "export async function POST" in BFF
      and '"../../../../../lib/' in BFF, "bff5")
BFF_ID = open("/tmp/p13/Omniflow/app/api/omniflow/portal/coupons/[id]/route.ts",
              encoding="utf8").read()
check("coupons id bff", "export async function PATCH" in BFF_ID
      and "export async function DELETE" in BFF_ID
      and '"../../../../../../lib/' in BFF_ID, "bff6")
BFF_PUB = open("/tmp/p13/Omniflow/app/api/omniflow/public/checkout/[token]/coupon/route.ts",
               encoding="utf8").read()
check("public coupon bff", '"../../../../../../../lib/' in BFF_PUB
      and "export async function POST" in BFF_PUB
      and "export async function DELETE" in BFF_PUB, "bff7")

PAGE = open("/tmp/p13/Omniflow/app/c/[token]/page.tsx", encoding="utf8").read()
check("public coupon row", "view.couponCode" in PAGE
      and "couponDiscount" in PAGE, "row")
SERVE = open("/tmp/p13/Omniflow/app/c/[token]/SelfServe.tsx",
             encoding="utf8").read()
check("selfserve coupon", "Have a coupon code?" in SERVE
      and "/coupon" in SERVE and "Remove coupon" in SERVE, "coupon ui")

summary("coupons")
