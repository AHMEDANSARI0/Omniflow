"""238 web pins: Retention page, the thread LoyaltyCard, BFF routes, the
portal.ts wire mapping (snake_case -> camelCase), nav, and the win-back
queue's new "opted out" answer."""
import os
import re
import sys

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")

from test_lib import check, summary

ROOT = os.environ.get("OF_RIG_WEB_ROOT") or os.path.abspath(os.path.join(os.getcwd(), ".."))


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return fh.read()


PORTAL = read("lib/omniflow/portal.ts")
LOYALTY = PORTAL[PORTAL.index("// Retention & loyalty (§238)"):]
PAGE = read("app/dashboard/(portal)/retention/page.tsx")
CLIENT = read("app/dashboard/(portal)/retention/RetentionClient.tsx")
CARD = read("app/dashboard/(portal)/conversations/[id]/LoyaltyCard.tsx")
THREAD = read("app/dashboard/(portal)/conversations/[id]/ThreadClient.tsx")
SIDEBAR = read("app/dashboard/components/DashSidebar.tsx")
PALETTE = read("app/dashboard/components/CommandPalette.tsx")
SETTINGS = read("app/api/omniflow/portal/retention/settings/route.ts")
OVERVIEW = read("app/api/omniflow/portal/retention/overview/route.ts")
CUSTOMER = read("app/api/omniflow/portal/retention/customer/route.ts")
RUN = read("app/api/omniflow/portal/retention/run/route.ts")
WB_ROUTE = read("app/api/omniflow/portal/winback/send/route.ts")
WB_PAGE = read("app/dashboard/(portal)/winback/page.tsx")

# --- portal.ts wire mapping ---
check("own names (data retention keeps getRetention / runRetention)",
      "export async function getLoyaltySettings(" in LOYALTY and "export async function runLoyaltyMessages(" in LOYALTY
      and PORTAL.count("export async function runRetention(") == 1 and "export interface LoyaltySettings" in LOYALTY)
check("settings map", "autoReorder: row.auto_reorder === true" in LOYALTY and "minOrders: retNumber(tier.min_orders, 1)" in LOYALTY
      and "brainContext: row.brain_context !== false" in LOYALTY)
check("settings save sends only known keys",
      "body.auto_reorder = input.autoReorder" in LOYALTY and "body.tpl_offer = input.tplOffer" in LOYALTY
      and "label: tier.label, min_orders: tier.minOrders, min_spend: tier.minSpend, coupon: tier.coupon" in LOYALTY)
check("overview map", "sentLastDay: retNumber(data.sent_last_day)" in LOYALTY and "inSequence: retNumber(row.in_sequence)" in LOYALTY
      and "returned: row.returned === true" in LOYALTY)
check("customer map", "ordersNeeded: retNumber(next.orders_needed)" in LOYALTY and "optedOut: data.opted_out === true" in LOYALTY
      and 'RETENTION + "/customer?contact_id=" + encodeURIComponent(contactId)' in LOYALTY)
check("run sends dry_run", "JSON.stringify({ dry_run: dryRun })" in LOYALTY)
check("win-back send maps opted_out", 'if (errorCode === "opted_out") return { kind: "opted_out" };' in PORTAL
      and '| { kind: "opted_out" }' in PORTAL)

# --- BFF routes ---
for name, src in (("settings PUT", SETTINGS), ("run POST", RUN)):
    check("BFF " + name + " is same-origin guarded", "}, request);" in src, name)
check("BFF reads use the portal token", all("withPortalToken(" in src for src in (SETTINGS, OVERVIEW, CUSTOMER, RUN)))
check("BFF settings whitelists + types keys", "autoReorder: flag(body.autoReorder)" in SETTINGS
      and "dailyCap: whole(body.dailyCap)" in SETTINGS and "value.slice(0, 5)" in SETTINGS)
check("BFF customer validates contact_id", "contactId.length > 100" in CUSTOMER)
check("BFF run defaults to a preview", "body.dryRun !== false" in RUN)
check("BFF win-back send answers opted_out", 'result.kind === "opted_out"' in WB_ROUTE
      and "This customer asked not to be messaged." in WB_ROUTE)
check("win-back page explains opted_out", 'payload?.error?.code === "opted_out"' in WB_PAGE)

# --- thread card ---
check("thread loads the card lazily", 'const LoyaltyCard = dynamic(() => import("./LoyaltyCard"));' in THREAD
      and "<LoyaltyCard contactId={conversation?.contactId ?? null} />" in THREAD)
check("card type-only import + fail-soft", "import type { LoyaltyCustomer }" in CARD
      and "if (!view || view.orders === 0) return null;" in CARD)
check("card hides the due message for opted-out customers", "view.due && !view.optedOut" in CARD)

# --- page + nav ---
check("page loads settings + overview in parallel",
      "Promise.all([getLoyaltySettings(accessToken), getLoyaltyOverview(accessToken)])" in PAGE
      and 'redirect("/dashboard/login")' in PAGE)
check("client: edit controls follow canEdit", "disabled={!canEdit || busy}" in CLIENT
      and "Only owners and admins can change retention settings or send messages." in CLIENT)
check("client: send needs a preview + confirm", 'window.confirm("Send these messages now?")' in CLIENT
      and "preview && preview.messages.length > 0" in CLIENT)
check("client: defaults shown as placeholders, offer needs {code}", "placeholder={fallback}" in CLIENT
      and "Offer line (needs {code})" in CLIENT)
check("sidebar + palette link", '{ label: "Retention", href: "/dashboard/retention", icon: "\\u25d0", enabled: true }' in SIDEBAR
      and '{ group: "Pages", label: "Retention", href: "/dashboard/retention" }' in PALETTE)
EMOJI = "[\u25b6\u261d\u2714\u26a1\u2699\u2709\u260e\u2733\u263a\u25fc\u27a1]"
ESC = r"\\u(25b6|261d|2714|26a1|2699|2709|260e|2733|263a|25fc|27a1)"
check("no emoji-capable glyphs", not any(re.search(EMOJI, src) or re.search(ESC, src)
                                          for src in (CARD, CLIENT, PAGE, SIDEBAR)))
check("no apostrophes in JSX text", not re.search(r">[^<{]*'[^<{]*<", CARD + CLIENT + PAGE))

sys.exit(1 if summary("retention_ui") else 0)
