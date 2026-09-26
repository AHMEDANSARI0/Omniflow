"""Tests for the payment gateway module: settings CRUD (masked secrets,
owner-only writes), JazzCash HMAC vector, public pay form build, signed
callback applying the payment to the link (auto-paid flip)."""
import hashlib
import hmac

from flask import Flask

import portal_payments
import portal_ratelimit
import portal_checkout
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_payments.bp)
app.register_blueprint(portal_payments.public_bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
agent = dict(human, role="agent")
PrincipalStub(portal_payments, principal=human)
PrincipalStub(portal_checkout, principal=human)


def fresh(script):
    portal_payments._SETTINGS_DDL_READY = True
    portal_payments._INTENTS_DDL_READY = True
    portal_checkout._CHECKOUT_DDL_READY = True
    portal_ratelimit._DDL_READY = True
    db = install_db_stub(portal_payments, script)
    db.CONV_TABLE = "portal_conversations"
    db.CMD_TABLE = "portal_commands"
    return db


print("== hash ==")

check("jazzcash hmac vector",
      portal_payments.jazzcash_hash("testsalt123", {
          "pp_Version": "1.1", "pp_TxnType": "MWALLET",
          "pp_MerchantID": "M123", "pp_Amount": "50000",
          "pp_Description": "Order payment"})
      == "D6C54E3A647D6B85D220416AC709231A0E92446FAD2F2FACBF525B2B73441944",
      "vector")
check("empty fields skipped", portal_payments.jazzcash_hash("k", {
      "a": "1", "b": ""}) == portal_payments.jazzcash_hash("k", {"a": "1"}),
      "skip")

print("== settings ==")

conn = fresh([[], []])
response = client.get("/api/v1/portal/payments/settings")
payload = response.get_json()
check("defaults", payload["settings"]["provider"] == "jazzcash"
      and payload["settings"]["enabled"] is False
      and payload["settings"]["configured"] is False, payload)

conn = fresh([[], []])
response = client.put("/api/v1/portal/payments/settings", json={
    "provider": "jazzcash", "enabled": True, "sandbox": True,
    "merchant_id": "MC12345", "password": "secret", "salt": "salty"})
check("200 save", status(response) == 200, status(response))
ins_sql, ins_params = conn.cur.executed[0]
check("upsert", "ON CONFLICT (client_id) DO UPDATE" in ins_sql, ins_sql[:80])
check("saves secrets", ins_params[4] == "MC12345"
      and ins_params[6] == "salty", ins_params[4:7])

PrincipalStub(portal_payments, principal=agent)
PrincipalStub(portal_checkout, principal=agent)
response = client.put("/api/v1/portal/payments/settings", json={"enabled": True})
check("403 agent settings", status(response) == 403, status(response))
PrincipalStub(portal_payments, principal=human)
PrincipalStub(portal_checkout, principal=human)

print("== configured ==")

JC = {"provider": "jazzcash", "enabled": True, "sandbox": True,
      "merchant_id": "MC12345", "password": "pw", "salt": "salty",
      "store_id": ""}
check("configured jazzcash", portal_payments._configured(JC) is True, "-")
check("not configured no salt",
      portal_payments._configured(dict(JC, salt="")) is False, "-")
check("not configured disabled",
      portal_payments._configured(dict(JC, enabled=False)) is False, "-")
check("easypaisa needs store",
      portal_payments._configured(dict(JC, provider="easypaisa")) is False,
      "-")

print("== public pay ==")

LINK = {"id": 9, "client_id": 1, "contact_id": "92x", "title": "T",
        "total": 1000, "paid_amount": 300, "status": "open",
        "expires_at": None}

conn = fresh([[LINK], [], [], []])
with app.test_request_context():
    response = client.get("/api/v1/public/checkout/tok/pay")
check("400 when off", status(response) == 400
      and b"Online payment is off" in response.data, status(response))

conn = fresh([[LINK], [JC], [], []])
response = client.get("/api/v1/public/checkout/tok/pay")
check("200 form", status(response) == 200
      and b"sandbox.jazzcash.com.pk" in response.data
      and b"pp_SecureHash" in response.data, status(response))
check("due only (70000 paisa)", b'value="70000"' in response.data
      or "70000" in response.get_data(as_text=True), "amount")

conn = fresh([[dict(LINK, status="paid")], [JC], [], []])
response = client.get("/api/v1/public/checkout/tok/pay")
check("400 nothing to pay", status(response) == 400
      and b"Nothing to pay" in response.data, status(response))

print("== callback ==")

INTENT = {"id": 3, "client_id": 1, "link_id": 9, "amount": 700,
          "status": "pending", "provider": "jazzcash"}
ok_form = {"pp_RResponseCode": "000", "pp_TxnRefNo": "T20260920001",
           "pp_RResponseMessage": "OK"}
ok_form["pp_SecureHash"] = portal_payments.jazzcash_hash("salty", ok_form)

conn = fresh([[{"count": 5}], [INTENT], [JC], [{"id": 3}],
              [{"paid_amount": 1000, "total": 1000}], []])
with app.test_request_context():
    response = client.post(
        "/api/v1/public/payments/callback/" + "tok" * 8,
        data=ok_form)
check("200 paid", status(response) == 200
      and b"Payment received" in response.data, status(response))
upd_sql, upd_params = conn.cur.executed[3]
check("intent marked paid", "status = 'paid'" in upd_sql
      and upd_params[0] == "T20260920001", upd_params)
link_sql, link_params = conn.cur.executed[4]
check("link credited", "paid_amount = COALESCE(paid_amount, 0) + %s"
      in link_sql and link_params[0] == 700, link_params[:2])
check("gateway audit", conn.cur.executed[5][1][1] == "payment.gateway_paid",
      conn.cur.executed[5][1])

bad = dict(ok_form, pp_SecureHash="DEADBEEF")
conn = fresh([[{"count": 5}], [INTENT], [JC], [], [], []])
response = client.post("/api/v1/public/payments/callback/tok", data=bad)
check("400 bad hash", status(response) == 400
      and b"Verification failed" in response.data, status(response))

conn = fresh([[{"count": 5}], [dict(INTENT, status="paid")], [JC], [], [], []])
response = client.post("/api/v1/public/payments/callback/tok", data=ok_form)
check("200 already paid", b"Already paid" in response.data, "-")

conn = fresh([[{"count": 5}], [], []])
response = client.post("/api/v1/public/payments/callback/tok", data=ok_form)
check("404 unknown intent", status(response) == 404, status(response))

print("== easypaisa form ==")

EP = dict(JC, provider="easypaisa", store_id="STORE1", salt="")
conn = fresh([[LINK], [EP], [], []])
response = client.get("/api/v1/public/checkout/tok/pay")
check("easypaisa form", status(response) == 200
      and b"easypaystg.easypaisa.com.pk" in response.data
      and b"STORE1" in response.data, status(response))

summary("payments")
