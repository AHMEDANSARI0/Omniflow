"""236-250 part 2: segments portal clients, BFF depths, page + sidebar pins."""
import os

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")

from test_lib import check, summary

PORTAL_TS = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts", encoding="utf8").read()
PAGE = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/segments/page.tsx", encoding="utf8"
).read()
SIDEBAR = open(
    "/tmp/p13/Omniflow/app/dashboard/components/DashSidebar.tsx", encoding="utf8"
).read()
BFF = open("/tmp/p13/Omniflow/app/api/omniflow/portal/segments/route.ts",
           encoding="utf8").read()
BFF_ID = open("/tmp/p13/Omniflow/app/api/omniflow/portal/segments/[id]/route.ts",
              encoding="utf8").read()
BFF_MEMBERS = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/segments/[id]/members/route.ts",
    encoding="utf8").read()
BFF_CAST = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/segments/[id]/broadcast/route.ts",
    encoding="utf8").read()

print("== portal clients ==")

check("SegmentRow type", "export interface SegmentRow {" in PORTAL_TS, "type")
check("filters normalizer", "function normalizeSegmentFilters" in PORTAL_TS, "norm")
check("list client", "export async function listSegments(" in PORTAL_TS, "list")
check("create client", "export async function createSegment(" in PORTAL_TS, "create")
check("delete client", "export async function deleteSegment(" in PORTAL_TS, "delete")
check("members client", "export async function listSegmentMembers(" in PORTAL_TS,
      "members")
check("broadcast client", "export async function broadcastToSegment(" in PORTAL_TS,
      "cast")
check("members url clean", '"/members?limit=50"' in PORTAL_TS
      and "sequences/../segments" not in PORTAL_TS, "url")
check("member count mapped", "member_count" in PORTAL_TS.split("listSegments(")[1][:1800],
      "count")
check("cast parses sent", 'typeof sent === "number" ? sent : 0' in PORTAL_TS, "sent")

print("== BFF routes ==")

check("list/create 5 ups", '"../../../../../lib/omniflow/portal"' in BFF, "depth")
check("[id] 6 ups", '"../../../../../../lib/omniflow/portal"' in BFF_ID, "depth")
check("members 7 ups", '"../../../../../lib/omniflow/portal"' not in BFF_MEMBERS
      and '"../../../../../../../lib/omniflow/portal"' in BFF_MEMBERS, "depth")
check("broadcast 7 ups", '"../../../../../../../lib/omniflow/portal"' in BFF_CAST,
      "depth")
check("create whitelists filters", "rawFilters.lead_temp === \"hot\"" in BFF
      and 'filters.tag = rawFilters.tag.trim().slice(0, 32);' in BFF, "whitelist")
check("create requires one filter", "Object.keys(filters).length === 0" in BFF, "400")
check("members forwards", "listSegmentMembers(accessToken, segmentId)" in BFF_MEMBERS,
      "forward")
check("broadcast body cap", "body.length > 1000" in BFF_CAST, "cap")
check("broadcast 400 note", "No members match this segment right now." in BFF_CAST,
      "400")
check("broadcast returns sent", "sent: result.sent" in BFF_CAST, "sent")

print("== page ==")

check("create form", "New segment" in PAGE, "form")
check("filter pickers", "Any lead temperature" in PAGE
      and "Quiet for N days (optional)" in PAGE, "pickers")
check("idle validation", "Idle days must be 1-365." in PAGE, "validate")
check("requires filter", "at least one filter" in PAGE, "400")
check("describe line", "quiet for \" + filters.idle_days + \"d" in PAGE, "describe")
check("member count chip", "member{row.memberCount === 1 ? \"\" : \"s\"}" in PAGE,
      "count")
check("people toggle", '{openMembers === row.id ? "Hide people" : "People"}' in PAGE,
      "people")
check("broadcast dialog", "Message everyone in" in PAGE
      and '"Send now"' in PAGE, "cast")
check("cast success note", "Broadcast queued to \" + payload.sent + \" member(s)." in PAGE,
      "note")
check("cast no-members note", "No members match this segment right now." in PAGE,
      "empty")
check("cast cap hint", "up to 200 members per" in PAGE, "hint")
check("delete button", "Delete" in PAGE, "delete")

print("== sidebar ==")

check("nav item", '{ label: "Segments", href: "/dashboard/segments"' in SIDEBAR,
      "nav")
check("nav after sequences", SIDEBAR.index('"Sequences"')
      < SIDEBAR.index('"Segments"'), "order")

summary("segments_ui")
