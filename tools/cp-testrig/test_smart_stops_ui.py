"""236 web pins: follow-up smart stops + handoff brief UI, the sequences page
settings/stats read fixes, and the JSX text-escape scan (a "\\u00b7" written
as JSX text renders literally, so every escape must sit inside a string)."""
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
PAGE = read("app/dashboard/(portal)/sequences/page.tsx")
UPDATE = read("app/api/omniflow/portal/sequences/[id]/route.ts")
SETTINGS = read("app/api/omniflow/portal/sequences/settings/route.ts")
CARD = read("app/dashboard/(portal)/conversations/[id]/HandoffBriefCard.tsx")
THREAD = read("app/dashboard/(portal)/conversations/[id]/ThreadClient.tsx")
ESC = read("app/dashboard/(portal)/bot/EscalationsCard.tsx")
BRIEF_GET = read("app/api/omniflow/portal/conversations/[id]/handoff-brief/route.ts")
BRIEF_AI = read("app/api/omniflow/portal/conversations/[id]/handoff-brief/ai/route.ts")
ESC_BRIEF = read("app/api/omniflow/portal/escalations/[id]/brief/route.ts")

# --- portal.ts wire mapping ---
check("list maps stop flags", "stopOnPurchase: row.stop_on_purchase !== false" in PORTAL
      and "stopOnHuman: row.stop_on_human !== false" in PORTAL, "map")
check("update wires stop flags", "wire.stop_on_purchase = changes.stopOnPurchase === true" in PORTAL
      and "wire.stop_on_human = changes.stopOnHuman === true" in PORTAL, "wire")
check("stats map stopped", 'stopped: typeof row.stopped === "number" ? row.stopped : 0' in PORTAL, "stats")
check("stop reason type", 'export type SequenceStopReason = "opted_out" | "purchased" | "human_took_over"'
      in PORTAL, "type")
check("brief mapper camelCase", "reasonLabel: briefText(handoff.reason_label)" in PORTAL
      and "nextStep: briefText(ai.next_step)" in PORTAL, "brief map")
check("brief clients", all(name in PORTAL for name in (
    "export function getHandoffBrief", "export function getEscalationBrief",
    "requestAiHandoffBrief")), "clients")

# --- BFF ---
check("update accepts booleans only", 'typeof input.stopOnPurchase === "boolean"' in UPDATE
      and 'typeof input.stopOnHuman === "boolean"' in UPDATE, "bool")
check("settings gap bounds", "gapHours > 168" in SETTINGS and "gapHours < 0" in SETTINGS
      and "Number.isInteger(gapHours)" in SETTINGS, "bounds")
check("settings gap optional", "...(gapHours !== undefined ? { gapHours } : {})" in SETTINGS, "optional")
check("stop + spacing PUTs same-origin", "if (!sameOrigin(request))" in UPDATE.split("export async function PUT")[1][:300]
      and "if (!sameOrigin(request))" in SETTINGS.split("export async function PUT")[1][:300], "csrf")
check("brief GET routes validate id", all("Number.isInteger(id) || id <= 0" in src
      for src in (BRIEF_GET, BRIEF_AI, ESC_BRIEF)), "ids")
check("AI POST is same-origin checked", "request\n  );" in BRIEF_AI
      and "export async function POST" in BRIEF_AI, "origin")
check("AI POST maxDuration", "export const maxDuration = 30;" in BRIEF_AI, "duration")
check("GET routes have no POST", "POST" not in BRIEF_GET and "POST" not in ESC_BRIEF, "get only")

# --- sequences page ---
load = PAGE.split("const load = useCallback")[1][:4000]
check("settings read camelCase", "settings.quietEnabled === true" in load
      and "settings.utcOffset" in load, "camel")
check("settings snake read gone", "quiet_enabled" not in PAGE and "row.settings.quiet_start" not in PAGE,
      "snake gone")
check("gap seeded from default", "settings.gapHoursDefault" in load and "gapDefault" in load, "gap")
save = PAGE.split("const saveQuiet")[1][:900]
check("save sends gap", "gapHours: quiet.gap," in save, "save gap")
stats = PAGE.split("const toggleStats")[1][:1500]
check("stats read stepNo", "map[row.stepNo]" in stats and "row.step_no" not in stats, "stepNo")
check("stats shown stopped", '" stopped"' in PAGE and "stat.stopped > 0" in PAGE, "stopped")
check("stop chips", "toggleStop(row, \"stopOnPurchase\")" in PAGE
      and "toggleStop(row, \"stopOnHuman\")" in PAGE, "chips")
check("chip labels", all(text in PAGE for text in (
    "stops on purchase", "ignores purchases", "stops on takeover", "ignores takeover")), "labels")
toggle = PAGE.split("const toggleStop")[1][:700]
check("toggle PUTs one key", '"PUT"' in toggle and "[key]: !row[key]" in toggle, "put")
check("stop labels", all(text in PAGE for text in (
    "opted_out: \"stopped \\u00b7 opted out\"", "purchased: \"stopped \\u00b7 bought\"",
    "human_took_over: \"stopped \\u00b7 teammate took over\"")), "reasons")
check("stopped status text", 'enrollment.status === "stopped"' in PAGE
      and "STOP_LABELS[enrollment.stop_reason]" in PAGE, "status")
check("resume stopped except opt-out", 'enrollment.stop_reason !== "opted_out"' in PAGE, "resume")
check("gap select", "space follow-ups of different series by" in PAGE
      and '"no spacing"' in PAGE and '" (default)"' in PAGE, "select")

# --- handoff brief UI ---
check("card dynamic in thread", 'const HandoffBriefCard = dynamic(() => import("./HandoffBriefCard"));'
      in THREAD and "<HandoffBriefCard conversationId={Number(id)} />" in THREAD, "thread")
check("card dynamic in queue", 'dynamic(() => import("../conversations/[id]/HandoffBriefCard"))' in ESC
      and "<HandoffBriefCard escalationId={item.id} compact />" in ESC, "queue")
check("queue brief toggle", '"Hide brief" : "Brief"' in ESC, "toggle")
check("card uses BFF paths", "/handoff-brief" in CARD and "/brief" in CARD
      and "/handoff-brief/ai" in CARD, "paths")
check("card type-only import", "import type { HandoffBrief, HandoffBriefView }" in CARD, "type import")
check("card AI button gated", "disabled={busy || !view.aiReady}" in CARD, "gated")
check("card opens on waiting handoff", 'data.brief.handoff?.status === "open"' in CARD, "auto open")
check("card stale label", "older than the latest message" in CARD, "stale")
check("card hides on failure in thread", "if (failed && !compact) return null;" in CARD, "fail soft")
check("card no emoji glyphs", not re.search("[\u25b6\u261d\u2714\u26a1\u2699\u2709\u260e\u2733\u263a\u25fc\u27a1]", CARD)
      and not re.search(r"\\u(25b6|261d|2714|26a1|2699|2709|260e|2733|263a|25fc|27a1)", CARD), "icons")

# --- JSX text escapes across the app ---
STR = re.compile(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|`(?:\\.|[^`\\])*`')
hits = []
for base in ("app", "components"):
    for folder, _dirs, files in os.walk(os.path.join(ROOT, base)):
        if "node_modules" in folder:
            continue
        for name in files:
            if not name.endswith(".tsx"):
                continue
            path = os.path.join(folder, name)
            with open(path, encoding="utf-8") as fh:
                for number, line in enumerate(fh, 1):
                    bare = re.sub(r"//.*", "", STR.sub('""', line))
                    if re.search(r"\\u[0-9a-fA-F]{4}", bare):
                        hits.append(os.path.relpath(path, ROOT) + ":" + str(number))
check("no literal \\u escapes in JSX text", not hits, hits[:8])

sys.exit(1 if summary("smart_stops_ui") else 0)
