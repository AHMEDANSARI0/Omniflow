"""251-265 part 2: customer 360 client, BFF route, profile page + link pins."""
import os

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")

from test_lib import check, summary

PORTAL_TS = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts", encoding="utf8").read()
BFF = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/customers/profile/route.ts",
    encoding="utf8",
).read()
PAGE = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/customers/profile/page.tsx",
    encoding="utf8",
).read()
CLIENT = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/customers/profile/ProfileClient.tsx",
    encoding="utf8",
).read()
CUSTOMERS = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/customers/CustomersClient.tsx",
    encoding="utf8",
).read()
CARD = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/conversations/[id]/CustomerCard.tsx",
    encoding="utf8",
).read()

print("== portal client ==")

check("CustomerProfile type", "export interface CustomerProfile {" in PORTAL_TS, "type")
check("conversation ref type", "export interface CustomerConversationRef {" in PORTAL_TS, "ref")
check("profile fn", "export async function getCustomerProfile(" in PORTAL_TS, "fn")
check("encoded contact", 'encodeURIComponent(contact)' in PORTAL_TS, "enc")
check("maps conversations", "row.conversations" in PORTAL_TS, "convs")
check("maps cod", "row.cod_requests" in PORTAL_TS, "cod")
check("maps step", "current_step" in PORTAL_TS, "step")
check("maps lead temp", "row.lead_temp" in PORTAL_TS, "temp")
check("null on 404", "response.status === 404 || response.status === 501" in PORTAL_TS, "404")

print("== bff ==")

check("token first", BFF.index("await requirePortalAccessToken") < BFF.index("await getCustomerProfile"), "auth")
check("six ups", '../../../../../lib/omniflow/portal' in BFF, "ups")
check("contact required", 'searchParams.get("contact")' in BFF, "param")
check("blank 400", '"contact is required."' in BFF, "400")
check("401 json", '"unauthorized"' in BFF, "401")
check("503 json", '"portal_unavailable"' in BFF, "503")
check("not found 404", '"not_found"' in BFF, "404")
check("no-store", "noStoreHeaders" in BFF, "nostore")
check("err type guard", "ControlPlaneRequestError" in BFF, "err")

print("== page ==")

check("server wrapper awaits params", "await searchParams" in PAGE, "async")
check("renders client", "<ProfileClient" in PAGE, "render")
check("client directive", '"use client";' in CLIENT, "use")
check("fetch endpoint", "/api/omniflow/portal/customers/profile?contact=" in CLIENT, "fetch")
check("encode contact", "encodeURIComponent(contact)" in CLIENT, "enc")
check("missing state", "No customer selected." in CLIENT, "missing")
import re as _re
check("back link", r"\\u2190 Customers" in CLIENT, "back")
check("back link raw", CLIENT.find("Customers") < CLIENT.find("</Link>") and "Customers" in CLIENT, "backraw")
check("wa.me action", "https://wa.me/" in CLIENT, "wa")
check("chats stat", "Total chats" in CLIENT, "chats")
check("open stat", "Open now" in CLIENT, "open")
check("first seen stat", "First seen" in CLIENT, "first")
check("last seen stat", "Last seen" in CLIENT, "last")
check("hot style", "hot:" in CLIENT, "hot")
check("warm style", "warm:" in CLIENT, "warm")
check("cold style", "cold:" in CLIENT, "cold")
check("tags chips", "profile.tags.map" in CLIENT, "tags")
check("conversations section", "Conversations</p>" in CLIENT, "convs")
check("conv deep link", '"/dashboard/conversations/" + conversation.id' in CLIENT, "deeplink")
check("cod section", "COD orders</p>" in CLIENT, "cod")
check("cod colors", "COD_STYLES" in CLIENT, "codstyles")
check("series section", "Series</p>" in CLIENT, "seq")
check("series step", "step {series.currentStep + 1}" in CLIENT, "step")
check("notes section", "Notes</p>" in CLIENT, "notes")
check("note author", "note.authorEmail" in CLIENT, "author")
check("relative time helper", "function when(" in CLIENT, "when")
check("just now", '"just now"' in CLIENT, "now")

print("== links ==")

check("customers rail 360", "customers/profile?contact=" in CUSTOMERS, "rail")
check("card 360", "customers/profile?contact=" in CARD, "card")
check("card uses Link", "prefetch={false}\n              href={`/dashboard/customers/profile" in CARD, "link")
check("rail title", 'title="Open customer 360"' in CUSTOMERS, "title")

print("== polish ==")

check("no debugger", "debugger" not in CLIENT + BFF, "dbg")
check("no console", "console." not in CLIENT + BFF, "console")
check("no any client", ": any" not in CLIENT, "any")

summary("customer_360_ui")
