"""237 web pins: Sales desk page, the thread SalesCard, BFF routes and the
portal.ts wire mapping (snake_case from the Control Plane -> camelCase)."""
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
PAGE = read("app/dashboard/(portal)/sales/page.tsx")
DESK = read("app/dashboard/(portal)/sales/SalesDeskClient.tsx")
CARD = read("app/dashboard/(portal)/conversations/[id]/SalesCard.tsx")
THREAD = read("app/dashboard/(portal)/conversations/[id]/ThreadClient.tsx")
SIDEBAR = read("app/dashboard/components/DashSidebar.tsx")
SIDEBAR += "\n" + read("app/dashboard/components/portalNav.ts")  # §246 nav entries live in portalNav.ts
PALETTE = read("app/dashboard/components/CommandPalette.tsx")
PALETTE += "\n" + read("app/dashboard/components/portalNav.ts")  # §246 nav entries live in portalNav.ts
SETTINGS = read("app/api/omniflow/portal/sales/settings/route.ts")
PLAYBOOK = read("app/api/omniflow/portal/sales/playbook/[kind]/route.ts")
LEAD = read("app/api/omniflow/portal/sales/conversations/[id]/route.ts")
OVERVIEW = read("app/api/omniflow/portal/sales/overview/route.ts")
QUOTES = read("app/api/omniflow/portal/sales/quotes/route.ts")

# --- portal.ts wire mapping ---
check("settings map", "autoStage: settings.auto_stage === true" in PORTAL
      and "brainContext: settings.brain_context !== false" in PORTAL, "settings")
check("settings save sends only known keys", "body.auto_stage = input.autoStage" in PORTAL
      and "body.brain_context = input.brainContext" in PORTAL and "body.qualifiers = input.qualifiers" in PORTAL)
check("lead map camelCase", "approvedAnswer: salesText(row.approved_answer)" in PORTAL
      and "askNext: salesText(raw.ask_next)" in PORTAL and "stageHint: salesText(raw.stage_hint)" in PORTAL)
check("lead catalog + limits", "maxDiscountPercent: salesNumber(result.data.max_discount_percent)" in PORTAL
      and "canDiscount: result.data.can_discount === true" in PORTAL)
check("overview map", "hasAnswer: row.has_answer === true" in PORTAL
      and 'totals: { hot: total("hot"), warm: total("warm"), cold: total("cold") }' in PORTAL)
check("quote wire: catalog ids, default expiry left to the server",
      "catalog_id: item.catalogId" in PORTAL
      and "...(input.expiresInDays === null ? {} : { expires_in_days: input.expiresInDays })" in PORTAL)
check("no hardcoded quote days in the client", "quoteDays: salesNumber(result.data.quote_days)" in PORTAL)

# --- BFF routes ---
for name, src in (("settings PUT", SETTINGS), ("playbook PUT", PLAYBOOK), ("quotes POST", QUOTES)):
    check("BFF " + name + " is same-origin guarded", "}, request);" in src, name)
check("BFF reads use the portal token", all("withPortalToken(" in src for src in (SETTINGS, LEAD, OVERVIEW)))
check("BFF settings whitelists keys", "typeof body.autoStage === \"boolean\"" in SETTINGS
      and "slice(0, 6)" in SETTINGS)
check("BFF playbook validates the kind", "/^[a-z_]{2,30}$/.test(kind)" in PLAYBOOK)
check("BFF lead validates the id", "Number.isInteger(id) || id <= 0" in LEAD)
check("BFF quotes: integers only, <= 10 items",
      "Number.isInteger(value)" in QUOTES and ".slice(0, 10)" in QUOTES and "expiresInDays: days > 0 ? days : null" in QUOTES)

# --- thread card ---
check("thread loads the card lazily", 'const SalesCard = dynamic(() => import("./SalesCard"));' in THREAD
      and "<SalesCard conversationId={Number(id)} />" in THREAD)
check("card type-only import", "import type { SalesLeadView, SalesQuote }" in CARD)
check("card fail-soft (hidden on error / empty)", "if (failed || !view) return null;" in CARD
      and "lead.score === 0) return null;" in CARD)
check("card copies the approved answer only", "copy(item.approvedAnswer)" in CARD
      and "suggestion" not in CARD.split("approvedAnswer ?")[1].split(") : (")[0])
check("card discount gated by role + limit", "view.canDiscount && view.maxDiscountPercent > 0" in CARD
      and "max={view.maxDiscountPercent}" in CARD)
check("card sends via the existing share route", '"/api/omniflow/portal/checkout/links/" + String(quote.id) + "/share"'
      in CARD and '"/c/" + token' in CARD)
check("card customer message is Roman Urdu", "Order yahan confirm karein" in CARD)

# --- page + nav ---
check("page loads settings + overview in parallel", "Promise.all([getSalesSettings(accessToken), getSalesOverview(accessToken)])"
      in PAGE and 'redirect("/dashboard/login")' in PAGE)
check("desk: suggestion is a placeholder until saved", "placeholder={entry.suggestion}" in DESK
      and "Use suggestion" in DESK)
check("desk: edit controls follow canEdit", "disabled={!canEdit || busy}" in DESK
      and "Only owners and admins can change these settings." in DESK)
check("sidebar + palette link", '{ label: "Sales desk", href: "/dashboard/sales", icon: "salesDesk" }' in SIDEBAR
      and "NAV_GROUPS.flatMap(" in PALETTE)
EMOJI = "[\u25b6\u261d\u2714\u26a1\u2699\u2709\u260e\u2733\u263a\u25fc\u27a1]"
ESC = r"\\u(25b6|261d|2714|26a1|2699|2709|260e|2733|263a|25fc|27a1)"
check("no emoji-capable glyphs", not any(re.search(EMOJI, src) or re.search(ESC, src)
                                          for src in (CARD, DESK, PAGE)))
check("no apostrophes in JSX text", not re.search(r">[^<{]*'[^<{]*<", CARD + DESK + PAGE))

sys.exit(1 if summary("sales_ui") else 0)
