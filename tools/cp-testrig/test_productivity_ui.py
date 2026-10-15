"""281-295 part 2: quick replies clients, BFF depths, manager page, export, picker."""
import os

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")

from test_lib import check, summary

PORTAL_TS = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts", encoding="utf8").read()
BFF_ID = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/saved-replies/[id]/route.ts",
    encoding="utf8",
).read()
BFF_USE = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/saved-replies/[id]/use/route.ts",
    encoding="utf8",
).read()
BFF_EXPORT = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/activity/export/route.ts",
    encoding="utf8",
).read()
PAGE = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/saved-replies/page.tsx",
    encoding="utf8",
).read()
ACTIVITY = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/activity/page.tsx", encoding="utf8"
).read()
PICKER = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/conversations/[id]/SavedRepliesPicker.tsx",
    encoding="utf8",
).read()
SIDEBAR = open(
    "/tmp/p13/Omniflow/app/dashboard/components/DashSidebar.tsx", encoding="utf8"
).read()

print("== portal clients ==")

check("saved iface usage", "useCount: number;" in PORTAL_TS, "iface")
check("last used field", "lastUsedAt: string | null;" in PORTAL_TS, "last")
check("parser maps use_count", "typeof p.use_count === " in PORTAL_TS, "parse")
check("update client", "export async function updateSavedReply(" in PORTAL_TS, "update")
check("use client", "export async function markSavedReplyUsed(" in PORTAL_TS, "use")
check("export client", "export async function exportActivityCsv(" in PORTAL_TS, "export")
check("put url", '"api/v1/portal/saved-replies/" + String(id)' in PORTAL_TS, "url")
check("use url suffix", '"/use"' in PORTAL_TS, "suffix")
check("mutation type", "export type SavedReplyMutation =" in PORTAL_TS, "type")
check("dup kind", '{ kind: "duplicate" }' in PORTAL_TS, "dup")
check("409 maps duplicate", "response.status === 409" in PORTAL_TS, "409")
check("csv text return", "return response.text();" in PORTAL_TS, "text")

print("== bff ==")

check("id route 6 ups", '"../../../../../../lib/omniflow/portal"' in BFF_ID, "ups6")
check("use route 7 ups", '"../../../../../../../lib/omniflow/portal"' in BFF_USE, "ups7")
check("export 6 ups", '"../../../../../../lib/omniflow/portal"' in BFF_EXPORT, "ups6b")
check("PUT handler", "export async function PUT(request: Request" in BFF_ID, "put")
check("shortcut cap 24", "shortcut.length > 24" in BFF_ID, "cap")
check("body cap 1000", "body.length > 1000" in BFF_ID, "cap2")
check("dup 409 json", '"duplicate"' in BFF_ID, "409")
check("use posts", "export async function POST(" in BFF_USE, "post")
check("use invalid id 400", "Invalid saved reply id." in BFF_USE, "400")
check("csv disposition", "omniflow-activity.csv" in BFF_EXPORT, "csv")
check("csv content type", "text/csv; charset=utf-8" in BFF_EXPORT, "ctype")
check("unauthorized json", '"unauthorized"' in BFF_USE and
      '"unauthorized"' in BFF_EXPORT, "401")

print("== manager page ==")

check("client directive", '"use client";' in PAGE, "use")
check("list fetch", 'fetch("/api/omniflow/portal/saved-replies"' in PAGE, "fetch")
check("create posts json", "method: \"POST\"" in PAGE, "create")
check("edit put", "method: \"PUT\"" in PAGE, "put")
check("delete", "method: \"DELETE\"" in PAGE, "delete")
check("inline edit form", "editId === reply.id" in PAGE, "edit")
check("usage line", "Used {reply.useCount} time" in PAGE, "usage")
check("when helper", "function when(" in PAGE, "when")
check("slash hint", "Type / in any conversation" in PAGE, "hint")
check("30 cap note", "Up to\n          30 per workspace." in PAGE or "30 per workspace" in PAGE, "cap")
check("empty state", "No quick replies yet" in PAGE, "empty")
check("unavailable state", "unavailable right now." in PAGE, "unavail")
check("network error note", "Network error" in PAGE, "net")
check("no any", ": any" not in PAGE, "any")

print("== activity + picker + sidebar ==")

check("activity export link", 'href="/api/omniflow/portal/activity/export"' in ACTIVITY, "link")
check("activity export label", "Export CSV" in ACTIVITY, "label")
check("picker usage iface", "useCount?: number;" in PICKER, "iface")
check("picker optimistic bump", "(item.useCount ?? 0) + 1" in PICKER, "bump")
check("picker fires use", 'saved-replies/${reply.id}/use' in PICKER, "fetch")
check("picker shows count", "used {reply.useCount}" in PICKER, "count")
check("sidebar item", '"/dashboard/saved-replies"' in SIDEBAR, "nav")
check("sidebar label", 'label: "Quick replies"' in SIDEBAR, "label")

print("== polish ==")

ALL = PAGE + BFF_USE + BFF_EXPORT
check("no debugger", "debugger" not in ALL, "dbg")
check("no console", "console." not in ALL, "console")
check("same-origin creds", 'credentials: "same-origin"' in PAGE, "creds")

summary("productivity_ui")
