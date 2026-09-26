"""UI/contract tests for the growth pack (351-370): clients, BFF depths,
Growth page, public checkout page, icon fixes and the 20-card dashboard."""
import os
import sys

import test_lib
from test_lib import check, summary

SITE = "/tmp/p13/Omniflow/"


def read(rel):
    return open(SITE + rel, encoding="utf8").read()


PORTAL = read("lib/omniflow/portal.ts")
SIDEBAR = read("app/dashboard/components/DashSidebar.tsx")
OVERVIEW = read("app/dashboard/(portal)/page.tsx")
GROWTH = read("app/dashboard/(portal)/growth/page.tsx")
PUBLIC = read("app/c/[token]/page.tsx")
ASSIST = read("app/dashboard/(portal)/conversations/[id]/AssistCard.tsx")

print("== portal.ts clients ==")

for name in ("getSentiment", "listChurnRisk", "getStaffingForecast",
             "listBroadcastSuggestions", "getNegotiationSettings",
             "saveNegotiationSettings", "getNegotiationQuote",
             "createCheckoutLink", "listCheckoutLinks",
             "setCheckoutLinkStatus", "listListenRules", "addListenRule",
             "deleteListenRule", "listListenHits", "listRoutingRules",
             "addRoutingRule", "deleteRoutingRule", "getPublicCheckout"):
    check("client " + name, "export async function " + name in PORTAL, name)
for name in ("SentimentResult", "ChurnContact", "StaffingForecast",
             "BroadcastSuggestion", "NegotiationSettings", "NegotiationQuote",
             "CheckoutLink", "ListenRule", "ListenHit", "RoutingRule",
             "PublicCheckoutView", "AssistSentiment"):
    check("type " + name, ("export interface " + name in PORTAL)
          or ("export type " + name in PORTAL), name)
check("public helper no-auth",
      "controlPlanePublicRequest" in PORTAL
      and "Bearer" not in PORTAL.split("controlPlanePublicRequest")[1][:400],
      "helper")
check("public path", "api/v1/public/checkout/" in PORTAL, "path")
check("assist sentiment mapped", "row.sentiment" in PORTAL, "map")

print("== BFF depths (all depth 6) ==")

BFFS = [
    "app/api/omniflow/portal/insights/churn/route.ts",
    "app/api/omniflow/portal/insights/staffing/route.ts",
    "app/api/omniflow/portal/insights/broadcast-suggestions/route.ts",
    "app/api/omniflow/portal/negotiation/settings/route.ts",
    "app/api/omniflow/portal/negotiation/quote/route.ts",
    "app/api/omniflow/portal/checkout/links/route.ts",
    "app/api/omniflow/portal/listen/rules/route.ts",
    "app/api/omniflow/portal/routing/rules/route.ts",
]
for rel in BFFS:
    src = read(rel)
    expected = "../../../../../../lib/omniflow/portal"
    check("depth " + rel.split("portal/")[1], expected in src, expected)
    check("401 " + rel.split("portal/")[1], "requirePortalAccessToken" in src,
          "guard")

opt = read("app/api/omniflow/portal/negotiation/settings/route.ts")
check("settings GET+PUT", "export async function GET" in opt
      and "export async function PUT" in opt, "methods")
links = read("app/api/omniflow/portal/checkout/links/route.ts")
check("links GET+POST", "export async function GET" in links
      and "export async function POST" in links, "methods")
for rel in ("app/api/omniflow/portal/listen/rules/route.ts",
            "app/api/omniflow/portal/routing/rules/route.ts"):
    src = read(rel)
    check("CRUD " + rel.split("portal/")[1], "export async function DELETE" in src,
          "delete")

print("== growth page ==")

check("churn section", "Churn risk" in GROWTH, "section")
check("days selector", "DAYS_OPTIONS" in GROWTH and "60" in GROWTH, "selector")
check("staffing bars", "Staffing peaks" in GROWTH
      and "staffing.suggested" in GROWTH, "section")
check("suggestions section", "Broadcast ideas" in GROWTH, "section")
check("negotiation section", "Negotiation limits" in GROWTH
      and "Guardrails" in GROWTH, "section")
check("quote calc", "Calculate" in GROWTH and "quote.verdict" in GROWTH,
      "calc")
check("checkout section", "Checkout links" in GROWTH and "/c/" in GROWTH,
      "section")
check("listen section", "Keyword alerts" in GROWTH, "section")
check("routing section", "Routing rules" in GROWTH, "section")

print("== public checkout page ==")

check("token param", "params: Promise<{ token: string }>" in PUBLIC, "param")
check("uses public client", "getPublicCheckout" in PUBLIC, "client")
check("not-found state", "Link not found" in PUBLIC, "404")
check("items rendered", "view.items.map(" in PUBLIC, "list")
check("total row", "view.total" in PUBLIC, "total")
check("status shown", 'view.status === "returned"' in PUBLIC
      and "order.indexOf(view.status)" in PUBLIC, "status")
check("no auth guard", "requirePortalAccessToken" not in PUBLIC, "public")

print("== assist sentiment ==")

check("sentiment chip", "Sentiment: {sentiment}" in ASSIST, "chip")
check("negative rose", "text-danger" in ASSIST and "sentiment === \"negative\""
      in ASSIST, "color")
check("flagged words", "assist.sentiment.negative.join" in ASSIST, "flags")

print("== icons: text-presentation only ==")

EMOJI_CAPABLE = ("\\u260e", "\\u2733", "\\u2709", "\\u263a", "\\u26a1",
                 "\\u2696", "\\u26a")
for code in EMOJI_CAPABLE:
    check("sidebar no emoji " + code, code not in SIDEBAR, code)
for code in ("\\u2302", "\\u25a6", "\\u2706", "\\u2736", "\\u270e",
             "\\u2606", "\\u2301", "\\u25c9", "\\u25ad", "\\u26e8",
             "\\u25b2"):
    check("sidebar has " + code, code in SIDEBAR, code)
check("growth nav", '{ label: "Growth", href: "/dashboard/growth",'
      ' icon: "\\u25b2", enabled: true }' in SIDEBAR, "nav")
check("overview no emoji lightning", '"⚡"' not in OVERVIEW
      and "\\u26a1" not in OVERVIEW, "icon")
check("overview no emoji smiley", '"☻"' not in OVERVIEW, "icon")
check("overview 23 quick links", OVERVIEW.count("{ icon:") == 23,
      OVERVIEW.count("{ icon:"))
check("overview no ai-brain duplicate", "ai-brain" not in OVERVIEW,
      "dedupe")
check("overview links compliance", '"Compliance"' in OVERVIEW, "link")
check("overview links growth-missing-none", '"COD confirmations"' in OVERVIEW
      and '"Sequences"' in OVERVIEW and '"Integrations"' in OVERVIEW
      and '"Segments"' in OVERVIEW and '"Pipeline"' in OVERVIEW
      and '"Quick replies"' in OVERVIEW and '"Activity"' in OVERVIEW
      and '"Weekly"' in OVERVIEW and '"Configure AI"' in OVERVIEW
      and '"WhatsApp setup"' in OVERVIEW and '"Settings"' in OVERVIEW,
      "links")
check("overview links growth", '"/dashboard/growth"' in OVERVIEW, "growth")

print("== client boundary (Vercel build fix) ==")

check("growth has no portal import", 'lib/omniflow/portal"' not in GROWTH, "boundary")
check("assist has no portal import", 'lib/omniflow/portal"' not in ASSIST, "boundary")
check("growth fetches BFF churn", "/api/omniflow/portal/insights/churn?days=" in GROWTH, "fetch")
check("growth fetches staffing", "/api/omniflow/portal/insights/staffing" in GROWTH, "fetch")
check("growth fetches negotiation", "/api/omniflow/portal/negotiation/quote?ask=" in GROWTH, "fetch")
check("assist fetches BFF", "conversations/${conversationId}/assist" in ASSIST, "fetch")
HITS_ROUTE = read("app/api/omniflow/portal/listen/hits/route.ts")
check("listen/hits BFF exists", "export async function GET" in HITS_ROUTE, "route")
check("listen/hits depth", "../../../../../../lib/omniflow/portal" in HITS_ROUTE, "depth")
check("listen/hits 401", "requirePortalAccessToken" in HITS_ROUTE, "guard")

print("== reco surfaces (371-390) ==")

RECOCARD = read("app/dashboard/(portal)/conversations/[id]/RecoCard.tsx")
THREADSRC = read("app/dashboard/(portal)/conversations/[id]/ThreadClient.tsx")
PROFILE = read("app/dashboard/(portal)/customers/profile/ProfileClient.tsx")
SUGGEST = read("app/api/omniflow/portal/reco/suggest/route.ts")
SURFACE = read("app/api/omniflow/portal/reco/surface/route.ts")
REPORT = read("app/api/omniflow/portal/reco/report/route.ts")

check("reco client in portal.ts", "export async function getRecoSuggestions" in PORTAL
      and "export async function getConversationRecos" in PORTAL
      and "export async function getRecoReport" in PORTAL, "clients")
check("reco types", "RecoSuggestion" in PORTAL and "RecoResult" in PORTAL
      and "RecoReport" in PORTAL, "types")
check("suggest BFF 6 ups", "../../../../../../lib/omniflow/portal" in SUGGEST, "depth")
check("surface BFF 6 ups", "../../../../../../lib/omniflow/portal" in SURFACE
      and "../../../../../../../lib" not in SURFACE, "depth")
check("report BFF 6 ups", "../../../../../../lib/omniflow/portal" in REPORT, "depth")
check("reco card boundary-safe", "lib/omniflow/portal" not in RECOCARD
      and "reco/surface?conversation_id=" in RECOCARD, "fetch-only")
check("reco card rendered", "RecoCard conversationId={Number(id)}" in THREADSRC
      and 'dynamic(() => import("./RecoCard"))' in THREADSRC, "render")
check("profile reco section", "Recommended next" in PROFILE
      and "/api/omniflow/portal/reco/suggest?contact=" in PROFILE, "section")
check("suggest 401 guard", "requirePortalAccessToken" in SUGGEST, "guard")

print("== churn radar (391-410) ==")

SCORE = read("app/api/omniflow/portal/churn/score/route.ts")
RADAR = read("app/api/omniflow/portal/churn/radar/route.ts")
CREPORT = read("app/api/omniflow/portal/churn/report/route.ts")
GROWTH = read("app/dashboard/(portal)/growth/page.tsx")

check("churn clients in portal.ts",
      "export async function getChurnScore" in PORTAL
      and "export async function getChurnRadar" in PORTAL
      and "export async function getChurnReport" in PORTAL, "clients")
check("churn types", "ChurnScore" in PORTAL and "ChurnRadarEntry" in PORTAL
      and "ChurnReport" in PORTAL and "ChurnSignals" in PORTAL, "types")
check("churn score BFF 6 ups",
      "../../../../../../lib/omniflow/portal" in SCORE, "depth")
check("churn radar BFF 6 ups",
      "../../../../../../lib/omniflow/portal" in RADAR
      and "../../../../../../../lib" not in RADAR, "depth")
check("churn report BFF 6 ups",
      "../../../../../../lib/omniflow/portal" in CREPORT, "depth")
check("growth radar section", "Churn radar" in GROWTH
      and "/api/omniflow/portal/churn/radar?limit=5" in GROWTH, "section")
check("growth boundary-safe", "lib/omniflow/portal" not in GROWTH,
      "fetch-only")
check("profile churn chip",
      "/api/omniflow/portal/churn/score?contact=" in PROFILE
      and "Churn:" in PROFILE, "chip")
check("profile boundary-safe", "lib/omniflow/portal" not in PROFILE,
      "fetch-only")
check("churn BFF 401 guards", "requirePortalAccessToken" in SCORE
      and "requirePortalAccessToken" in RADAR
      and "requirePortalAccessToken" in CREPORT, "guard")

print("== winback kit (411-430) ==")

WBPAGE = read("app/dashboard/(portal)/winback/page.tsx")
WBROUTE = read("app/api/omniflow/portal/winback/queue/route.ts")
SIDEBAR = read("app/dashboard/components/DashSidebar.tsx")
OVERVIEW = read("app/dashboard/(portal)/page.tsx")

check("winback client in portal.ts",
      "export async function getWinbackQueue" in PORTAL
      and "WinbackEntry" in PORTAL and "WinbackQueue" in PORTAL, "client")
check("winback BFF 6 ups",
      "../../../../../../lib/omniflow/portal" in WBROUTE
      and "../../../../../../../lib" not in WBROUTE, "depth")
check("winback page boundary-safe", "lib/omniflow/portal" not in WBPAGE
      and "/api/omniflow/portal/winback/queue" in WBPAGE, "fetch-only")
check("winback page actions", "Copy message" in WBPAGE
      and "Open WhatsApp" in WBPAGE and 'target="_blank"' in WBPAGE, "actions")
SENDROUTE = read("app/api/omniflow/portal/winback/send/route.ts")
check("winback send client in portal.ts",
      "export async function sendWinbackEntry" in PORTAL
      and "WinbackSendResult" in PORTAL, "client")
check("winback send BFF 6 ups",
      "../../../../../../lib/omniflow/portal" in SENDROUTE
      and "../../../../../../../lib" not in SENDROUTE, "depth")
check("winback page send action", "Send via WhatsApp" in WBPAGE
      and "/api/omniflow/portal/winback/send" in WBPAGE, "send")
check("winback sections", "Carts to recover" in WBPAGE
      and "Reorder due" in WBPAGE and "Win-back" in WBPAGE, "sections")
check("sidebar winback nav", 'label: "Win-back"' in SIDEBAR
      and "/dashboard/winback" in SIDEBAR, "nav")
check("overview winback card", 'title: "Win-back"' in OVERVIEW
      and "/dashboard/winback" in OVERVIEW, "card")

print("== revenue pulse (451-470) ==")

SUMMARY_ROUTE = read("app/api/omniflow/portal/revenue/summary/route.ts")
ITEMS_ROUTE = read("app/api/omniflow/portal/revenue/items/route.ts")

check("revenue clients in portal.ts",
      "export async function getRevenueSummary" in PORTAL
      and "export async function getRevenueItems" in PORTAL
      and "RevenueSummary" in PORTAL and "RevenueItem" in PORTAL, "clients")
check("revenue summary BFF 6 ups",
      "../../../../../../lib/omniflow/portal" in SUMMARY_ROUTE, "depth")
check("revenue items BFF 6 ups",
      "../../../../../../lib/omniflow/portal" in ITEMS_ROUTE
      and "../../../../../../../lib" not in ITEMS_ROUTE, "depth")
check("growth revenue section", "Revenue & pipeline" in GROWTH
      and "/api/omniflow/portal/revenue/summary?days=" in GROWTH
      and "/api/omniflow/portal/revenue/items?days=" in GROWTH, "section")
check("growth revenue tiles", "Top items by revenue" in GROWTH
      and "Pipeline" in GROWTH and "vs prior" in GROWTH, "tiles")

print("== restock radar (471-490) ==")

RESTOCK_ROUTE = read("app/api/omniflow/portal/restock/radar/route.ts")

check("restock client in portal.ts",
      "export async function getRestockRadar" in PORTAL
      and "RestockItem" in PORTAL and "RestockRadar" in PORTAL, "client")
check("restock BFF 6 ups",
      "../../../../../../lib/omniflow/portal" in RESTOCK_ROUTE
      and "../../../../../../../lib" not in RESTOCK_ROUTE, "depth")
check("growth restock section", "Restock radar" in GROWTH
      and "/api/omniflow/portal/restock/radar?days=" in GROWTH, "section")
check("growth restock groups", "Stock up" in GROWTH and "Watch" in GROWTH
      and "Slow movers" in GROWTH, "groups")

print("== customer value (491-510) ==")

VALUE_ROUTE = read("app/api/omniflow/portal/value/summary/route.ts")
TOP_ROUTE = read("app/api/omniflow/portal/value/top/route.ts")
CUSTOMERS = read("app/dashboard/(portal)/customers/CustomersClient.tsx")

check("value clients in portal.ts",
      "export async function getCustomerValue" in PORTAL
      and "export async function getTopCustomers" in PORTAL
      and "CustomerValue" in PORTAL and "ValueCustomer" in PORTAL, "clients")
check("value summary BFF 6 ups",
      "../../../../../../lib/omniflow/portal" in VALUE_ROUTE, "depth")
check("value top BFF 6 ups",
      "../../../../../../lib/omniflow/portal" in TOP_ROUTE
      and "../../../../../../../lib" not in TOP_ROUTE, "depth")
check("profile lifetime section", "Lifetime value" in PROFILE
      and "/api/omniflow/portal/value/summary?contact=" in PROFILE, "section")
check("profile boundary-safe", "lib/omniflow/portal" not in PROFILE,
      "fetch-only")
check("customers top strip", "Top customers" in CUSTOMERS
      and "/api/omniflow/portal/value/top?limit=5" in CUSTOMERS
      and "/dashboard/customers/profile?contact=" in CUSTOMERS, "strip")
check("customers boundary-safe", "lib/omniflow/portal" not in CUSTOMERS,
      "fetch-only")

print("== daily brief (511-530) ==")

BRIEF = read("app/dashboard/(portal)/DailyBrief.tsx")
OVERVIEW_PAGE = read("app/dashboard/(portal)/page.tsx")

check("brief boundary-safe", "lib/omniflow/portal" not in BRIEF
      and '"use client"' in BRIEF, "fetch-only")
check("brief fetches", "/api/omniflow/portal/winback/queue" in BRIEF
      and "/api/omniflow/portal/churn/radar?limit=1" in BRIEF
      and "/api/omniflow/portal/revenue/summary?days=7" in BRIEF, "sources")
check("brief self-hides", "if (failed || !brief) return null;" in BRIEF,
      "hide")
check("overview renders brief", 'import DailyBrief from "./DailyBrief";'
      in OVERVIEW_PAGE and "<DailyBrief />" in OVERVIEW_PAGE, "render")

print("== checkout suite (551-610) ==")

OURS = read("app/dashboard/(portal)/growth/OrderUpdatesSettings.tsx")
RET_CARD = read("app/dashboard/(portal)/growth/CheckoutReturnsCard.tsx")
BFF_SET = read("app/api/omniflow/portal/checkout/settings/route.ts")
BFF_RET = read("app/api/omniflow/portal/checkout/returns/route.ts")

# 551-570: order status updates
check("updates card boundary", '"use client"' in OURS
      and "/api/omniflow/portal/checkout/settings" in OURS
      and OURS.count('from "') == 1, "card")
check("updates card fields", "notifyEnabled" in OURS
      and "tpl_paid" in OURS and "Updates on" in OURS, "card")
check("growth renders updates card",
      'from "./OrderUpdatesSettings"' in GROWTH
      and "<OrderUpdatesSettings />" in GROWTH, "page")
check("growth shipped/delivered buttons",
      'markLink(link, "shipped")' in GROWTH
      and 'markLink(link, "delivered")' in GROWTH
      and 'link.status === "paid" ? (' in GROWTH, "page")
check("chip colors extended", 'link.status === "shipped"' in GROWTH
      and "border-violet-400/25" in GROWTH, "page")
check("portal settings client", "CheckoutNotifySettings" in PORTAL
      and "getCheckoutNotifySettings" in PORTAL
      and "saveCheckoutNotifySettings" in PORTAL
      and "api/v1/portal/checkout/settings" in PORTAL, "client")
check("bff settings route", "export async function GET" in BFF_SET
      and "export async function PUT" in BFF_SET
      and "saveCheckoutNotifySettings" in BFF_SET, "bff")

# 571-590: cart recovery
check("card cart section", "Cart recovery" in OURS
      and "cartGap1" in OURS and "Recovery on" in OURS
      and "gap_1" in OURS and "cartEnabled" in OURS, "card")
check("card cart inputs", 'type="number"' in OURS
      and "min={1}" in OURS and "max={168}" in OURS, "card")
check("portal cart client", "normalizeCart" in PORTAL
      and "cartEnabled: raw.enabled === true" in PORTAL
      and "cart:" in PORTAL, "client")
check("bff cart passthrough", "cartRaw" in BFF_SET
      and "Reminder gaps" in BFF_SET, "bff")

# 591-610: returns / RTO
check("growth returned ui", "RETURN_REASONS" in GROWTH
      and 'markLink(link, "returned", code)' in GROWTH
      and "returnFor" in GROWTH, "page")
check("growth renders returns card",
      'from "./CheckoutReturnsCard"' in GROWTH
      and "<CheckoutReturnsCard />" in GROWTH, "page")
check("returns card boundary", '"use client"' in RET_CARD
      and "/api/omniflow/portal/checkout/returns" in RET_CARD
      and RET_CARD.count('from "') == 1, "card")
check("portal returns client", "CheckoutReturn {" in PORTAL
      and "listCheckoutReturns" in PORTAL
      and "api/v1/portal/checkout/returns" in PORTAL, "client")
check("bff returns route", "listCheckoutReturns" in BFF_RET
      and "export async function GET" in BFF_RET, "bff")
check("returned template box", "tplReturned" in OURS
      and "Returned message" in OURS, "card")
check("bff settings returned", "tpl_returned" in BFF_SET, "bff")

print("== digest + exports (611-650) ==")

DIG_CARD = read("app/dashboard/(portal)/growth/DigestCard.tsx")
BFF_DIG = read("app/api/omniflow/portal/digest/route.ts")
BFF_REVEX = read("app/api/omniflow/portal/revenue/export/route.ts")
BFF_RETEX = read("app/api/omniflow/portal/checkout/returns/export/route.ts")

check("digest card boundary", '"use client"' in DIG_CARD
      and "/api/omniflow/portal/digest/settings" in DIG_CARD
      and DIG_CARD.count('from "') == 1, "card")
check("digest card fields", "ownerContact" in DIG_CARD
      and "Digest on" in DIG_CARD and "hour" in DIG_CARD, "card")
check("growth renders digest", 'from "./DigestCard"' in GROWTH
      and "<DigestCard />" in GROWTH, "page")
check("portal digest client", "getDigestSettings" in PORTAL
      and "saveDigestSettings" in PORTAL
      and "api/v1/portal/digest/settings" in PORTAL, "client")
check("bff digest route", "export async function GET" in BFF_DIG
      and "export async function PUT" in BFF_DIG
      and "saveDigestSettings" in BFF_DIG, "bff")
check("growth revenue export", "omniflow-revenue.csv" in GROWTH
      and "downloadCsv" in GROWTH, "page")
check("returns card export", "omniflow-returns.csv" in RET_CARD
      and "Export CSV" in RET_CARD, "card")
check("portal export clients", "exportRevenueCsv" in PORTAL
      and "exportReturnsCsv" in PORTAL, "client")
check("bff revenue export", "exportRevenueCsv" in BFF_REVEX
      and "omniflow-revenue.csv" in BFF_REVEX, "bff")
check("bff returns export depth", '"' + "../" * 7
      + 'lib/omniflow/portal"' in BFF_RETEX, "bff")

print("== link edit + duplicate (651-670) ==")

check("growth edit state", "editFor" in GROWTH
      and "editItems" in GROWTH and "startEdit" in GROWTH
      and "saveEdit" in GROWTH, "page")
check("growth edit/duplicate buttons",
      'onClick={() => startEdit(link)}' in GROWTH
      and 'onClick={() => void duplicateLink(link)}' in GROWTH, "page")
check("growth edit panel", "Save changes" in GROWTH
      and "/edit\"" in GROWTH.replace("\\", "") or "/edit" in GROWTH, "page")
check("portal edit clients", "editCheckoutLink" in PORTAL
      and "duplicateCheckoutLink" in PORTAL
      and "CheckoutEditMutation" in PORTAL, "client")
check("bff edit route depth", '"' + "../" * 8
      + 'lib/omniflow/portal"' in read(
          "app/api/omniflow/portal/checkout/links/[id]/edit/route.ts"), "bff")
check("bff duplicate route", "duplicateCheckoutLink" in read(
      "app/api/omniflow/portal/checkout/links/[id]/duplicate/route.ts"), "bff")

print("== link expiry + views (671-690) ==")

check("growth expiry helpers", "function isExpired(" in GROWTH
      and "function expiryLabel(" in GROWTH
      and '"Expired"' in GROWTH, "page")
check("growth views chip", '" views"' in GROWTH
      and "viewCount" in GROWTH, "page")
check("growth expiry select", "Link expiry" in GROWTH
      and "<option value=\"0\">No expiry</option>" in GROWTH
      and "editExpiry" in GROWTH, "page")
check("portal expiry clients", "expires_in_days" in PORTAL
      and "expiresAt" in PORTAL and "viewCount" in PORTAL, "client")
check("bff create expiry pass", "expires_in_days" in read(
      "app/api/omniflow/portal/checkout/links/route.ts"), "bff")
check("bff edit expiry pass", "expires_in_days" in read(
      "app/api/omniflow/portal/checkout/links/[id]/edit/route.ts"), "bff")

print("== link advance (691-710) ==")

check("growth advance ui", "Advance received (Rs)" in GROWTH
      and "recordAdvance" in GROWTH and "dueOf" in GROWTH
      and "advanceBusy" in GROWTH, "page")
check("growth due chip", '" · due "' in GROWTH
      or "\": \" · due \"" in GROWTH
      or "due " in GROWTH and "dueOf(link)" in GROWTH, "page")
check("portal advance client", "addCheckoutAdvance" in PORTAL
      and "CheckoutAdvanceMutation" in PORTAL
      and "paid_amount" in PORTAL, "client")
check("bff advance route", "addCheckoutAdvance" in read(
      "app/api/omniflow/portal/checkout/links/[id]/advance/route.ts"),
      "bff")

print("== public page 2.0 + whatsapp share (711-750) ==")

PUBLIC = read("app/c/[token]/page.tsx")

check("public timeline", '"ordered", "paid", "shipped", "delivered"'
      in PUBLIC and "Due on delivery" in PUBLIC
      and "Paid in full" in PUBLIC, "public page")
check("public line totals", "item.price * item.qty" in PUBLIC
      and "has expired, ask the business" in PUBLIC, "public page")
check("portal payment type", "PublicCheckoutPayment" in PORTAL
      and "payment:" in PORTAL, "client")
check("share client", "shareCheckoutLink" in PORTAL
      and "CheckoutShareMutation" in PORTAL, "client")
check("bff share route", "shareCheckoutLink" in read(
      "app/api/omniflow/portal/checkout/links/[id]/share/route.ts"), "bff")
check("page share button", "Send on WhatsApp" in GROWTH
      and "async function shareLink(" in GROWTH
      and "/c/" in GROWTH, "page")

print("== composer + discounts (751-790) ==")

check("growth composer", "New checkout link" in GROWTH
      and "function createLink(" in GROWTH
      and "Customer WhatsApp ID" in GROWTH
      and "+ Add item" in GROWTH, "page")
check("growth discount fields", "Discount (Rs)" in GROWTH
      and "discount_amount" in GROWTH and "editDiscount" in GROWTH, "page")
check("growth discount chip", '" off"' in GROWTH, "page")
check("portal discount client", "discountAmount" in PORTAL
      and "discount_amount" in PORTAL, "client")
check("public discount", "Discount" in PUBLIC
      and "view.discount > 0" in PUBLIC, "public page")
check("bff create discount", "discount_amount" in read(
      "app/api/omniflow/portal/checkout/links/route.ts"), "bff")
check("bff edit discount", "discount_amount" in read(
      "app/api/omniflow/portal/checkout/links/[id]/edit/route.ts"), "bff")

print("== courier tracking (791-810) ==")

check("growth tracking ui", "function openTracking(" in GROWTH
      and "function saveTracking(" in GROWTH
      and "Save tracking" in GROWTH and "Tracking #" in GROWTH, "page")
check("growth tracking chip", "link.trackingNumber" in GROWTH, "page")
check("portal tracking client", "setLinkTracking" in PORTAL
      and "tracking_number" in PORTAL, "client")
check("public tracking card", "Tracking #: {view.trackingNumber}" in PUBLIC,
      "public page")
check("bff tracking route", "setLinkTracking" in read(
      "app/api/omniflow/portal/checkout/links/[id]/tracking/route.ts"), "bff")

print("== test consistency ==")

check("bridge untouched telegram",
      "channel=telegram" in read("connector-node/telegram_bridge.py"), "bridge")

sys.exit(1 if summary("growth_ui") else 0)
