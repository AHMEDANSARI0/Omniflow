"""266-280 part 2: pipeline clients, BFF depths, board page, segments stage UI."""
import os

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")

from test_lib import check, summary

PORTAL_TS = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts", encoding="utf8").read()
BFF = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/pipeline/route.ts", encoding="utf8"
).read()
BFF_STAGE = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/pipeline/stage/route.ts",
    encoding="utf8",
).read()
BFF_SEG = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/segments/route.ts", encoding="utf8"
).read()
PAGE = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/pipeline/page.tsx", encoding="utf8"
).read()
SEG_PAGE = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/segments/page.tsx", encoding="utf8"
).read()
SIDEBAR = open(
    "/tmp/p13/Omniflow/app/dashboard/components/DashSidebar.tsx", encoding="utf8"
).read()

print("== portal clients ==")

check("stage type", "export type PipelineStage =" in PORTAL_TS, "type")
check("stages const", "export const PIPELINE_STAGES: PipelineStage[]" in PORTAL_TS, "const")
check("contact type", "export interface PipelineContact {" in PORTAL_TS, "contact")
check("column type", "export interface PipelineColumn {" in PORTAL_TS, "column")
check("board fn", "export async function getPipelineBoard(" in PORTAL_TS, "board")
check("stage fn", "export async function setContactStage(" in PORTAL_TS, "stage")
check("board url", '"api/v1/portal/pipeline"' in PORTAL_TS, "url")
check("stage url", '"api/v1/portal/pipeline/stage"' in PORTAL_TS, "url2")
check("maps contact_id", "contact.contact_id" in PORTAL_TS, "map")
check("maps last_at", "contact.last_at" in PORTAL_TS, "map2")
check("count fallback", "typeof row.count === " in PORTAL_TS, "count")
check("null on 404", "response.status === 404 || response.status === 501" in PORTAL_TS, "404")
check("invalid on 400", 'response.status === 400) return { kind: "invalid" }' in PORTAL_TS, "400")
check("segment stage field", "stage?: PipelineStage;" in PORTAL_TS, "field")
check("normalize stage", 'input.stage === "negotiating"' in PORTAL_TS, "norm")

print("== bff ==")

check("board 5 ups", "../../../../../lib/omniflow/portal" in BFF, "ups")
check("stage 6 ups", "../../../../../../lib/omniflow/portal" in BFF_STAGE, "ups6")
check("board token first", BFF.find("const accessToken = await requirePortalAccessToken") < BFF.find("await getPipelineBoard(accessToken)"), "auth")
check("stage token first", BFF_STAGE.find("const accessToken = await requirePortalAccessToken") < BFF_STAGE.find("await setContactStage("), "auth")
check("board not found", '"not_found"' in BFF, "404")
check("board 503", '"portal_unavailable"' in BFF, "503")
check("stage whitelist", 'STAGE_VALUES.includes' in BFF_STAGE, "wl")
check("stage five values", 'stage === "won"' not in BFF_STAGE and '"lost",' in BFF_STAGE, "five")
check("stage contact 400", '"contact is required."' in BFF_STAGE, "400")
check("stage invalid 400", '"Pick a valid stage."' in BFF_STAGE, "invalid")
check("segments whitelist", 'rawFilters.stage === "negotiating"' in BFF_SEG, "segwl")
check("no-store", "noStoreHeaders" in BFF and "noStoreHeaders" in BFF_STAGE, "nostore")

print("== board page ==")

check("client directive", '"use client";' in PAGE, "use")
check("fetch board", 'fetch("/api/omniflow/portal/pipeline"' in PAGE, "fetch")
check("fetch stage", 'fetch("/api/omniflow/portal/pipeline/stage"' in PAGE, "fetch2")
check("five stages", 'value: "negotiating"' in PAGE and 'value: "lost"' in PAGE, "five")
check("counts shown", "{column.count}" in PAGE, "count")
check("move on select", "void move(contact.contactId, event.target.value)" in PAGE, "move")
check("reloads after move", "await load();" in PAGE, "reload")
check("deep links 360", "customers/profile?contact=" in PAGE, "360")
check("empty column", "No contacts here yet." in PAGE, "empty")
check("error note", "Could not move that contact." in PAGE, "note")
check("refresh", "Refresh</button>" in PAGE or '">Refresh' in PAGE or "Refresh" in PAGE, "refresh")
check("h-scroll board", "overflow-x-auto" in PAGE, "scroll")
check("lead chip", "lead" in PAGE and "chats" in PAGE, "chips")
check("unavailable state", "not available right now." in PAGE, "unavail")
check("won emerald", "bg-emerald-400" in PAGE, "emerald")
check("lost rose", "bg-rose-400" in PAGE, "rose")

print("== segments page + sidebar ==")

check("seg interface stage", "stage?: string;" in SEG_PAGE, "iface")
check("seg options", "STAGE_OPTIONS" in SEG_PAGE, "opts")
check("seg state", "const [stage, setStage] = useState(\"\");" in SEG_PAGE, "state")
check("seg payload", "if (stage) filters.stage = stage;" in SEG_PAGE, "payload")
check("seg describe", '"stage: " + filters.stage' in SEG_PAGE, "describe")
check("seg dropdown", "value={stage}" in SEG_PAGE, "dropdown")
check("sidebar item", '"/dashboard/pipeline"' in SIDEBAR, "nav")
check("sidebar label", 'label: "Pipeline"' in SIDEBAR, "label")

print("== polish ==")

ALL = PAGE + BFF + BFF_STAGE
check("no debugger", "debugger" not in ALL, "dbg")
check("no console", "console." not in ALL, "console")
check("no any", ": any" not in PAGE, "any")
check("stage post body", "JSON.stringify({ contact: contactId, stage })" in PAGE, "body")

summary("pipeline_ui")
