"""296-310 part 2: merge dialog, weekly page, calendar page, clients, BFF depths."""
import os

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")

from test_lib import check, summary

PORTAL_TS = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts", encoding="utf8").read()
BFF_MERGE = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/customers/merge/route.ts",
    encoding="utf8",
).read()
BFF_WEEKLY = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/insights/weekly/route.ts",
    encoding="utf8",
).read()
BFF_CAL = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/insights/calendar/route.ts",
    encoding="utf8",
).read()
WEEKLY = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/weekly/page.tsx", encoding="utf8"
).read()
CAL = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/broadcasts/calendar/page.tsx",
    encoding="utf8",
).read()
CUSTOMERS = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/customers/CustomersClient.tsx",
    encoding="utf8",
).read()
BCAST = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/broadcasts/BroadcastsClient.tsx",
    encoding="utf8",
).read()
SIDEBAR = open(
    "/tmp/p13/Omniflow/app/dashboard/components/DashSidebar.tsx", encoding="utf8"
).read()

print("== portal clients ==")

check("weekly type", "export interface WeeklySummary {" in PORTAL_TS, "type")
check("weekly fn", "export async function getWeeklySummary(" in PORTAL_TS, "fn")
check("weekly url", '"api/v1/portal/insights/weekly"' in PORTAL_TS, "url")
check("snake mapping", "row.messages_in" in PORTAL_TS, "snake")
check("calendar type", "export interface BroadcastCalendar {" in PORTAL_TS, "cal")
check("calendar fn", "export async function getBroadcastCalendar(" in PORTAL_TS, "fn2")
check("calendar url", '"api/v1/portal/insights/calendar?month="' in PORTAL_TS, "url2")
check("merge type", "export type MergeMutation =" in PORTAL_TS, "merge")
check("merge fn", "export async function mergeCustomers(" in PORTAL_TS, "fn3")
check("merge url", '"api/v1/portal/customers/merge"' in PORTAL_TS, "url3")
check("merge 404 kind", 'response.status === 404) return { kind: "not_found" }' in PORTAL_TS, "404")
check("scheduled flag map", "scheduled: item.scheduled === true" in PORTAL_TS, "flag")

print("== bff ==")

check("merge 6 ups", '"../../../../../../lib/omniflow/portal"' in BFF_MERGE, "ups")
check("weekly 6 ups", '"../../../../../../lib/omniflow/portal"' in BFF_WEEKLY, "ups6")
check("cal 6 ups", '"../../../../../../lib/omniflow/portal"' in BFF_CAL, "ups6b")
check("merge posts", "export async function POST(request: Request)" in BFF_MERGE, "post")
check("merge same 400", '"Pick two different contacts."' in BFF_MERGE, "same")
check("merge caps", "keep.length > 100" in BFF_MERGE, "cap")
check("merge 404 json", '"The duplicate contact has no chats."' in BFF_MERGE, "404")
check("weekly token first", BFF_WEEKLY.find("const accessToken = await requirePortalAccessToken") < BFF_WEEKLY.find("await getWeeklySummary("), "auth")
check("weekly 503", '"portal_unavailable"' in BFF_WEEKLY, "503")
check("cal month regex", "MONTH_RE" in BFF_CAL, "regex")
check("cal 400 json", "month must look like" in BFF_CAL, "400")
check("no-store", "noStoreHeaders" in BFF_WEEKLY and "noStoreHeaders" in BFF_CAL, "nostore")

print("== weekly page ==")

check("client directive", '"use client";' in WEEKLY, "use")
check("fetch weekly", 'fetch("/api/omniflow/portal/insights/weekly"' in WEEKLY, "fetch")
check("eight tiles", '"New chats"' in WEEKLY and '"Avg rating"' in WEEKLY, "tiles")
check("cod tiles", '"COD confirmed"' in WEEKLY and '"COD declined"' in WEEKLY, "cod")
check("day bars", 'style={{' in WEEKLY and "peak" in WEEKLY, "bars")
check("bar legend", "Cyan = customer messages" in WEEKLY, "legend")
check("weekday label", 'Intl.DateTimeFormat("en", { weekday: "short" })' in WEEKLY, "wd")
check("failed state", "unavailable right now." in WEEKLY, "failed")
check("no any", ": any" not in WEEKLY, "any")

print("== calendar page ==")

check("fetch calendar", "/api/omniflow/portal/insights/calendar?month=" in CAL, "fetch")
check("prev next", "shiftMonth(current, -1)" in CAL and
      "shiftMonth(current, 1)" in CAL, "nav")
check("weekday header", '["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]' in CAL, "wk")
check("grid pads", "min-h-16" in CAL, "grid")
check("sent chip", "sent</" in CAL or "sent}" in CAL or '"sent"' in CAL or "sent" in CAL, "sent")
check("queued chip", "queued" in CAL, "queued")
check("month title", "monthTitle" in CAL, "title")
check("back link", 'href="/dashboard/broadcasts"' in CAL, "back")
check("items list", "This month" in CAL, "items")
check("no any", ": any" not in CAL, "any2")

print("== customers + broadcasts + sidebar ==")

check("merge rail", 'title="Merge duplicate contact"' in CUSTOMERS, "rail")
check("merge posts", 'fetch("/api/omniflow/portal/customers/merge"' in CUSTOMERS, "fetch")
check("merge dialog", "Merge duplicates into" in CUSTOMERS, "dialog")
check("merge warning", "This cannot be undone." in CUSTOMERS, "warn")
check("keep select", "Keep which contact?" in CUSTOMERS, "select")
check("refresh after merge", "void refresh();" in CUSTOMERS, "refresh")
check("broadcasts calendar link", 'href="/dashboard/broadcasts/calendar"' in BCAST, "link")
check("sidebar weekly", '"/dashboard/weekly"' in SIDEBAR, "nav")
check("sidebar label", 'label: "Weekly"' in SIDEBAR, "label")

print("== polish ==")

ALL = WEEKLY + CAL + BFF_MERGE
check("no debugger", "debugger" not in ALL, "dbg")
check("no console", "console." not in ALL, "console")

summary("workspace_tools_ui")
