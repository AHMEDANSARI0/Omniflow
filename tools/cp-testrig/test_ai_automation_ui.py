"""240 web pins: the AI + automation card on Analytics, its BFF route, the
portal.ts wire mapping (snake_case -> camelCase), and the Growth copy that
said "paid" while the numbers now count paid, shipped and delivered."""
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
WIRE = PORTAL[PORTAL.index("// §240 AI + automation analytics quadrant (read-only)"):]
ROUTE = read("app/api/omniflow/portal/analytics/ai-automation/route.ts")
CARD = read("app/dashboard/(portal)/analytics/AiAutomationCard.tsx")
CLIENT = read("app/dashboard/(portal)/analytics/AnalyticsClient.tsx")
GROWTH = read("app/dashboard/(portal)/growth/page.tsx")

# --- portal.ts wire mapping ---
check("one client function, own names", PORTAL.count("export async function getAiAutomation(") == 1
      and PORTAL.count("export interface AiAutomationView") == 1 and PORTAL.count("function qNullable(") == 1)
check("CP path + days", 'const AI_AUTOMATION = "api/v1/portal/analytics/ai-automation";' in WIRE
      and 'AI_AUTOMATION + "?days=" + encodeURIComponent(String(days))' in WIRE)
for pair in ("handedOff: retNumber(answers.handed_off)", "sentShare: qNullable(answers.sent_share)",
             "draftsUsable: retNumber(answers.drafts_usable)", "noTool: retNumber(answers.no_tool)",
             "avgConfidence: qNullable(row.avg_confidence)", "failShare: qNullable(usage.fail_share)",
             "avgLatencyMs: retNumber(usage.avg_latency_ms)", "costUsd: qNullable(usage.cost_usd)",
             "priced: usage.priced === true", "goalReached: retNumber(flows.goal_reached)",
             "inProgress: retNumber(flows.in_progress)", "waitingApproval: retNumber(flows.waiting_approval)",
             "failureShare: qNullable(flows.failure_share)", "approvalRequired: retNumber(outcome.approval_required)",
             "keptDays: retNumber(actions.kept_days, 30)", "highFrom: retNumber(bands.high_from, 0.8)",
             "lowBelow: retNumber(bands.low_below, 0.6)", "const bands = asRecord(ai.confidence_bands)",
             "agentId: qNullable(row.agent_id)", "costUsd: qNullable(row.cost_usd)"):
    check("map: " + pair, pair in WIRE)
check("availability is explicit (missing = not available)", WIRE.count(".available === true") == 5)
check("cost stays null when not priced (no invented number)", "costUsd: retNumber(" not in WIRE)

# --- BFF ---
check("BFF: GET only, read-only service call", "export async function GET(request: Request)" in ROUTE
      and "POST" not in ROUTE and "serviceResponse(await getAiAutomation(accessToken, Number(raw)))" in ROUTE)
check("BFF: days validated before the CP call (whole number 1-90)",
      r"/^\d{1,2}$/.test(raw)" in ROUTE and "Number(raw) < 1 || Number(raw) > 90" in ROUTE
      and ROUTE.index("bad_request") < ROUTE.rindex("withPortalToken("))
check("BFF: default window 30", '.get("days") ?? "30"' in ROUTE)

# --- card ---
check("Analytics renders the card with the page window",
      'import AiAutomationCard from "./AiAutomationCard";' in CLIENT and "<AiAutomationCard days={data.days} />" in CLIENT)
check("card is shown even when chat totals are empty (outside the empty branch)",
      CLIENT.rindex("<AiAutomationCard") > CLIENT.rindex(")}"))
check("card fetches its route with the window and cancels stale loads",
      '"/api/omniflow/portal/analytics/ai-automation?days=" + String(days)' in CARD
      and "new AbortController()" in CARD and "return () => controller.abort();" in CARD and "}, [days]);" in CARD)
check("card: unavailable + loading states", "AI and automation numbers are unavailable right now." in CARD
      and "Loading&#8230;" in CARD and "numbers are not available for this workspace yet." in CARD)
check("card: every block has an empty state", all(text in CARD for text in (
    "No AI answers in this window yet.", "No AI calls in this window.", "No workflow runs in this window.",
    "No actions in this window.", "No follow-ups in this window.")))
check("card: cost only when priced", '{usage.priced ? "estimated cost " + money(usage.costUsd)' in CARD
      and "cost not shown (model prices are not set)" in CARD and "agent.costUsd !== null" in CARD)
check("card: bands from the server, not hardcoded", "Math.round(bands.highFrom * 100)" in CARD
      and "Math.round(bands.lowBelow * 100)" in CARD)
check("card: two quadrants", "<AiQuadrant view={view} />" in CARD and "<AutomationQuadrant view={view} />" in CARD
      and "sm:grid-cols-2" in CARD)
check("card: action history limit explained", "view.days > actions.keptDays" in CARD)
check("card: links to the engines", 'href="/dashboard/workflows"' in CARD and 'href="/dashboard/sequences"' in CARD)
check("card: design tokens (no new palette)", "text-danger" in CARD and "shadow-card" in CARD
      and "bg-emerald-400" in CARD and not re.search(r"(?<!&)#[0-9a-fA-F]{3,6}\b", CARD)
      and not re.search(r"\b(?:bg|text)-(?:emerald|rose|amber)-(?:500|600|700)\b", CARD))
emoji = [ch for ch in CARD + ROUTE if ord(ch) > 0x2000 and ch not in "\u2014\u00b7"]
check("icon law: no emoji-capable glyphs", not emoji, emoji[:5])
check("no localhost in browser code", "localhost" not in CARD and "127.0.0.1" not in CARD)

# --- Growth copy ---
check("Growth copy: purchases, not 'paid' only", "Paid revenue" not in GROWTH and "from paid orders only" not in GROWTH
      and "Paid orders appear here" not in GROWTH
      and "Revenue from paid, shipped and delivered orders" in GROWTH
      and "What actually sells, from paid, shipped and delivered orders." in GROWTH)

sys.exit(1 if summary("ai_automation_ui") else 0)
