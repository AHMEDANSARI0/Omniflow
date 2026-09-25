"""UI/contract tests for batches 811-890: money guard, payment gateway,
analytics depth, data safety. Reads the website tree and pins clients,
BFF depths and the new UI strings."""
import os
import sys

import test_lib
from test_lib import check, summary

SITE = "/tmp/p13/Omniflow/"


def read(rel):
    return open(SITE + rel, encoding="utf8").read()


PORTAL = read("lib/omniflow/portal.ts")
GROWTH = read("app/dashboard/(portal)/growth/page.tsx")
PUBLIC = read("app/c/[token]/page.tsx")
PAYGATE = read("app/c/[token]/PayGate.tsx")
SETTINGS = read("app/dashboard/(portal)/settings/page.tsx")
PAY_CARD = read("app/dashboard/(portal)/settings/PaymentsCard.tsx")
SAFE_CARD = read("app/dashboard/(portal)/settings/DataSafetyCard.tsx")

print("== portal.ts clients (811-890) ==")
for name in ("getPaymentSettings", "savePaymentSettings", "getPublicPayInfo",
             "fetchPublicPayHtml", "getCustomerAnalytics",
             "getProductAnalytics", "getRetention", "saveRetention",
             "runRetention", "fetchDataExport"):
    check("client " + name, "export async function " + name in PORTAL, name)
for name in ("PaymentSettings", "CustomerAnalyticsEntry",
             "ProductAnalyticsEntry", "RetentionSettings"):
    check("type " + name, ("export interface " + name in PORTAL)
          or ("export type " + name in PORTAL), name)
check("advance forbidden status", 'if (response.status === 403) return "forbidden";'
      in PORTAL, "403 map")
check("advance union forbidden", '| "forbidden"' in PORTAL, "union")

print("== BFF depths ==")
BFF6 = [
    "app/api/omniflow/portal/payments/settings/route.ts",
    "app/api/omniflow/portal/insights/customer-analytics/route.ts",
    "app/api/omniflow/portal/insights/product-analytics/route.ts",
    "app/api/omniflow/portal/data/retention/route.ts",
    "app/api/omniflow/portal/data/export/route.ts",
]
for rel in BFF6:
    body = read(rel)
    check("bff 6-up " + rel.rsplit("/", 2)[-2], "../../../../../../lib/" in body, rel)
PAY_STREAM = read("app/api/omniflow/public/checkout/[token]/pay/route.ts")
check("pay stream 7-up", "../../../../../../../lib/" in PAY_STREAM, "pay")
RUN_ROUTE = read("app/api/omniflow/portal/data/retention/run/route.ts")
check("run route 7-up", "../../../../../../../lib/" in RUN_ROUTE, "run")

print("== page pins ==")
check("growth insights card", 'title="Customer insights"' in GROWTH, "card")
check("growth products card", 'title="Top products"' in GROWTH, "card")
check("growth advance note", "advanceNote" in GROWTH, "note")
check("public pay button",
      "/api/omniflow/public/checkout/" in PAYGATE
      and "online" in PAYGATE, "button")
check("settings payments card", 'import PaymentsCard from "./PaymentsCard";'
      in SETTINGS and "PaymentsCard" in SETTINGS, "card")
check("settings datasafety card",
      'import DataSafetyCard from "./DataSafetyCard";' in SETTINGS
      and "DataSafetyCard" in SETTINGS, "card")
check("pay card configured readout", "Configured" in PAY_CARD, "mask")
check("safe card download", "Download backup (JSON)" in SAFE_CARD, "export")

print("== icon law (text-presentation only) ==")
BAD = ["\u260e", "\u2733", "\u2709", "\u263a", "\u26a1", "\u2696"]
for label, body in (("portal", PORTAL), ("growth", GROWTH),
                    ("public", PUBLIC), ("settings", SETTINGS),
                    ("paycard", PAY_CARD), ("safecard", SAFE_CARD)):
    ok = all(ch not in body for ch in BAD)
    check("no raw emoji " + label, ok, label)

summary("811_890_ui")
