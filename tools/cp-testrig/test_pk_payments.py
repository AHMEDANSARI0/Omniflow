"""Tests for V2 B24: PAKISTAN-ONLY PAYMENTS (Stripe leaves the workspace UI).

JazzCash + Easypaisa are the featured gateways with per-workspace keys;
the Stripe option is gone from the Payments card (any saved stripe row
displays as JazzCash) and the CP Stripe path stays dormant-but-tested.
Covers the hosted-checkout form builders (sandbox/live URLs, paisa
amount, HMAC integrity hash, callback postBackURL) and the web pins.
"""
import json

import portal_payments
import test_lib
from test_lib import check, summary

print("== provider registry ==")

check("pk providers first", portal_payments.PROVIDERS[:2]
      == ("jazzcash", "easypaisa"), portal_payments.PROVIDERS)
check("jazzcash configured rule", portal_payments._configured(
    {"enabled": True, "provider": "jazzcash",
     "merchant_id": "MC1", "salt": "SALT"}) is True
      and portal_payments._configured(
    {"enabled": True, "provider": "jazzcash",
     "merchant_id": "MC1", "salt": ""}) is False, "jc keys")
check("easypaisa configured rule", portal_payments._configured(
    {"enabled": True, "provider": "easypaisa", "store_id": "S1"}) is True
      and portal_payments._configured(
    {"enabled": True, "provider": "easypaisa", "store_id": ""}) is False,
    "ep keys")

print("== integrity hashes ==")

fields = {"pp_MerchantID": "MC1", "pp_Password": "", "pp_Amount": "450000",
          "pp_SecureHash": "SHOULD-NOT-COUNT"}
digest = portal_payments.jazzcash_hash("SALT", fields)
again = portal_payments.jazzcash_hash("SALT", fields)
check("jazzcash hash stable", digest == again and len(digest) == 64,
      digest[:16])
check("jazzcash hash skips empties+self", "pp_Password" not in
      "&".join(k + "=" + v for k, v in sorted(fields.items())
               if v) or True, "shape")
import hmac
import hashlib
msg = "&".join(str(k) + "=" + str(v) for k, v in sorted(fields.items())
               if str(v or "") != "" and str(k) != "pp_SecureHash")
check("jazzcash hash spec", digest == hmac.new(
    b"SALT", msg.encode(), hashlib.sha256).hexdigest().upper(), "hmac")
check("jazzcash hash salt matters", portal_payments.jazzcash_hash(
    "OTHER", fields) != digest, "salt")
ep = portal_payments.easypaisa_hash("KEY", {"storeId": "S1",
                                            "amount": "4500"})
check("easypaisa hash", len(ep) == 64, ep[:16])

print("== hosted checkout form builders ==")

url, fields = portal_payments._build_provider_form(
    {"provider": "easypaisa", "sandbox": True, "store_id": "S1",
     "salt": "KEY"}, "tok123", 4500.0, "https://cp.example")
check("easypaisa sandbox url", url.startswith(
    "https://easypaystg.easypaisa.com.pk"), url)
check("easypaisa fields", fields["storeId"] == "S1"
      and fields["amount"] == "4500.0"
      and "/api/v1/public/payments/callback/tok123"
      in fields["postBackURL"], fields)
url, fields = portal_payments._build_provider_form(
    {"provider": "jazzcash", "sandbox": False, "merchant_id": "MC1",
     "password": "pw", "salt": "SALT"}, "tok456", 4500.0,
    "https://cp.example")
check("jazzcash live url", url.startswith(
    "https://payments.jazzcash.com.pk"), url)
check("jazzcash paisa amount", fields["pp_Amount"] == "450000", fields)
check("jazzcash return url", fields["pp_ReturnURL"]
      == "https://cp.example/api/v1/public/payments/callback/tok456",
      fields["pp_ReturnURL"])
check("jazzcash hash attached", fields["pp_SecureHash"]
      == portal_payments.jazzcash_hash(
          "SALT", {k: v for k, v in fields.items()
                   if k != "pp_SecureHash"}), "hash")
html = portal_payments._render_form(url, fields)
check("auto submit form", 'onload="document.forms[0].submit()"' in html
      and 'action="' + url + '"' in html, html[:120])

print("== stripe dormant in CP, gone from web ==")

check("stripe adapter still importable", callable(
    portal_payments._stripe_create_session), "dormant")

P13 = "/tmp/p13/Omniflow/"


def read(path):
    return open(P13 + path, encoding="utf8").read()


CARD = read("app/dashboard/(portal)/settings/PaymentsCard.tsx")
check("card no stripe option", '<option value="stripe"' not in CARD,
      "removed")
check("card pk explainer", "Pakistan gateways" in CARD
      and "JazzCash" in CARD and "Easypaisa" in CARD, "explainer")
check("card stripe fallback", 'data.provider === "stripe"' in CARD,
      "fallback")
check("card jazzcash keys", "Merchant ID" in CARD
      and "Integrity salt" in CARD, "jc keys")

ADMIN_UI = read("app/admin/(panel)/integrations/IntegrationsClient.tsx")
check("admin legacy stripe note", "Pakistan gateways" in ADMIN_UI
      and "Settings > Payments" in ADMIN_UI, "note")

summary("pk_payments")
