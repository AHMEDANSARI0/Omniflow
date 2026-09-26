"""Security pack for B2: public-surface rate limits (429s), checkout
enumeration/replay/attack pins, and coupon double-apply protection."""
from flask import Flask

import portal_changes
import portal_checkout
import portal_coupons
import portal_payments
import portal_ratelimit
import test_lib
from test_lib import check, install_db_stub, status, summary

portal_ratelimit._DDL_READY = True
portal_checkout._CHECKOUT_DDL_READY = True
portal_coupons._DDL_READY = True
portal_changes._DDL_READY = True
portal_payments._SETTINGS_DDL_READY = True
portal_payments._INTENTS_DDL_READY = True

app = Flask(__name__)
app.register_blueprint(portal_checkout.bp)
app.register_blueprint(portal_checkout.public_bp)
app.register_blueprint(portal_coupons.public_bp)
app.register_blueprint(portal_changes.public_bp)
app.register_blueprint(portal_payments.public_bp)
client = app.test_client()

print("== checkout view guards ==")

# unknown token: rate slot consumed first, then the link lookup -> 404
conn = install_db_stub(portal_checkout, [[{"count": 1}], [], []])
response = client.get("/api/v1/public/checkout/unknowntoken")
check("unknown token 404", status(response) == 404, status(response))
rate_sql = conn.cur.executed[0][0]
check("rate checked first", "portal_rate_limits" in rate_sql, rate_sql[:50])
check("bucket per token", "unknowntoken"
      in str(conn.cur.executed[0][1]), conn.cur.executed[0][1])

# over-limit token: 429 before any link query
conn = install_db_stub(portal_checkout, [[{"count": 999}]])
response = client.get("/api/v1/public/checkout/unknowntoken")
check("checkout 429", status(response) == 429
      and response.get_json()["error"]["code"] == "rate_limited",
      status(response))
check("no link query on 429", len(conn.cur.executed) == 1,
      len(conn.cur.executed))

# rate limiter down -> checkout still works (fail-open): DDL error slot
conn = install_db_stub(portal_checkout, [RuntimeError("no table"), [], []])
response = client.get("/api/v1/public/checkout/unknowntoken")
check("fail-open still 404", status(response) == 404, status(response))

print("== coupon apply guards ==")

conn = install_db_stub(portal_coupons, [[{"count": 999}]])
response = client.post("/api/v1/public/checkout/linenothing/coupon",
                       json={"code": "EID25"})
check("coupon 429", status(response) == 429
      and response.get_json()["error"]["code"] == "rate_limited",
      status(response))

conn = install_db_stub(portal_coupons, [[{"count": 1}], []])
response = client.post("/api/v1/public/checkout/linenothing/coupon",
                       json={})
check("coupon bad request 400", status(response) == 400, status(response))

print("== change request guards ==")

conn = install_db_stub(portal_changes, [[{"count": 999}]])
response = client.post("/api/v1/public/checkout/linenothing/change-request",
                       json={"kind": "address", "address_text": "x"})
check("change 429", status(response) == 429
      and response.get_json()["error"]["code"] == "rate_limited",
      status(response))

conn = install_db_stub(portal_changes, [[{"count": 1}], []])
response = client.post("/api/v1/public/checkout/linenothing/change-request",
                       json={"kind": "weird"})
check("change bad kind 400", status(response) == 400, status(response))

print("== payments callback guards ==")

conn = install_db_stub(portal_payments, [[{"count": 999}], [], [], []])
response = client.post("/api/v1/public/payments/callback/nope",
                       data={"status": "paid"})
check("paycb 429", status(response) == 429
      and response.get_json()["error"]["code"] == "rate_limited",
      status(response))

print("== static attack-pack pins ==")

CO = open("/tmp/smoke971/portal_checkout.py", encoding="utf8").read()
CU = open("/tmp/smoke971/portal_coupons.py", encoding="utf8").read()
CH = open("/tmp/smoke971/portal_changes.py", encoding="utf8").read()
PA = open("/tmp/smoke971/portal_payments.py", encoding="utf8").read()
RA = open("/tmp/smoke971/portal_ratelimit.py", encoding="utf8").read()

check("totals server-side", "total = " in CO or "round(" in CO, "recompute")
check("coupon revert on remove", "GREATEST(used_count" in CU, "revert")
check("change one-open-per-kind", "status = 'pending'" in CH, "unique gate")
check("callback validates intent", "SELECT id, client_id, link_id, amount,"
      " status," in PA, "intent load")
check("no token enumeration hint", "not valid" in CO or "not_found" in CO,
      "404 shape")
check("window prune", "make_interval(hours => 1)" in RA, "prune")
check("env tunable", "OF_RATE_" in RA, "env")

check("ingest guard", "ingest:" in open("/tmp/smoke971/connector_api.py",
      encoding="utf8").read(), "ingest bucket")

summary("security")
