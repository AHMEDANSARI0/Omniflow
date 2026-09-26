"""221-235 Sequences Pro part 3: portal clients, BFF routes, page UI pins."""
import os

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")

from test_lib import check, summary

PORTAL_TS = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts", encoding="utf8").read()
PAGE = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/sequences/page.tsx", encoding="utf8"
).read()
CREATE = open("/tmp/p13/Omniflow/app/api/omniflow/portal/sequences/route.ts",
              encoding="utf8").read()
STEPS = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/sequences/[id]/steps/route.ts",
    encoding="utf8").read()
UPDATE = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/sequences/[id]/route.ts",
    encoding="utf8").read()
STATS = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/sequences/[id]/stats/route.ts",
    encoding="utf8").read()

print("== portal clients ==")

check("SequenceStep field", "onlyIfIdleHours: number | null;" in PORTAL_TS, "field")
check("Row pauseOnReply", "pauseOnReply: boolean;" in PORTAL_TS, "field")
seg = PORTAL_TS.split("listSequences(")[1][:2200]
check("list maps idle", "only_if_idle_hours" in seg, "map")
check("list maps pause flag", "row.pause_on_reply !== false" in seg, "map")
check("create type carries idle", "only_if_idle_hours?: number | null;" in
      PORTAL_TS.split("export async function createSequence(")[1][:400], "type")
seg = PORTAL_TS.split("updateSequenceSteps(")[1][:500]
check("edit type carries idle", "only_if_idle_hours?: number | null;" in seg, "type")
seg = PORTAL_TS.split("pauseOnReply?: boolean;")[1][:600]
check("update wires snake flag", "wire.pause_on_reply = changes.pauseOnReply === true"
      in PORTAL_TS, "wire")
check("stats client", "export async function getSequenceStats(" in PORTAL_TS, "fn")
seg = PORTAL_TS.split("getSequenceStats(")[1][:800]
check("stats url", '"/stats"' in seg, "url")
check("stats type", "export interface SequenceStepStat {" in PORTAL_TS, "type")
check("stats filters junk", ".filter((row) => row.stepNo > 0)" in PORTAL_TS, "filter")

print("== BFF routes ==")

check("stats 7 ups", "../../../../../../../lib/omniflow/portal", "depth")
check("stats GET", "export async function GET(" in STATS
      and "getSequenceStats(accessToken, sequenceId)" in STATS, "forward")
check("create carries idle", "only_if_idle_hours" in CREATE
      and "step.only_if_idle_hours === \"number\"" in CREATE, "create")
check("steps route maps camel", "onlyIfIdleHours?: unknown;" in STEPS
      and "typeof item.onlyIfIdleHours === \"number\"" in STEPS, "steps")
check("update forwards flag", 'typeof input.pauseOnReply === "boolean"' in UPDATE
      and "changes.pauseOnReply = input.pauseOnReply;" in UPDATE, "update")

print("== page ==")

check("draft field", "onlyIfIdleHours: null" in PAGE, "draft")
check("create body maps idle", "only_if_idle_hours: step.onlyIfIdleHours" in PAGE,
      "create wire")
check("create condition checkbox", "Send only if no reply for" in PAGE, "create ui")
check("edit condition checkbox", PAGE.count("Send only if no reply for") == 2,
      PAGE.count("Send only if no reply for"))
check("edit seeds idle", "onlyIfIdleHours: step.onlyIfIdleHours," in PAGE, "seed")
check("edit add-step field", '{ delay_hours: 24, body: "", onlyIfIdleHours: null }' in PAGE,
      "add")
check("idle bounds", "Math.min(168, Number(event.target.value) || 24)" in PAGE, "cap")
check("auto-pause chip", '"pauses on reply"' in PAGE and '"ignores replies"' in PAGE,
      "chip")
check("chip toggles", "togglePauseReply(row)" in PAGE, "toggle")
check("toggle PUTs flag", "pauseOnReply: !row.pauseOnReply" in PAGE, "put")
check("stats button", '{openStats === row.id ? "Hide stats" : "Stats"}' in PAGE, "button")
check("stats bars", 'style={{ width: pct + "%" }}' in PAGE
      and "Step delivery" in PAGE, "bars")
check("stats labels", "sent \\u00b7 " in PAGE and "skipped" in PAGE, "labels")
check("stats fetch", '"/stats"' in PAGE.split("const toggleStats")[1][:600], "fetch")
check("interface pauseOnReply", "pauseOnReply: boolean;" in PAGE, "iface")

summary("sequence_ui_pro")
