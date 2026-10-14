"""241 web pins: the Traces tab + step-by-step trace view on Configure AI ->
AI operations, the audit rows' trace links, the two BFF routes and the
portal.ts client. Every value the web relies on (kinds, decisions, step
keys, statuses, match values, detail fields) is checked against the CP
module itself so the two sides cannot drift."""
import os
import re
import sys

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "x")
sys.path.insert(0, os.getcwd())

from test_lib import check, summary  # noqa: E402
import portal_ai_traces as tr  # noqa: E402

ROOT = os.environ.get("OF_RIG_WEB_ROOT") or os.path.abspath(os.path.join(os.getcwd(), ".."))


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return fh.read()


CP = open(os.path.join(os.getcwd(), "portal_ai_traces.py"), encoding="utf-8").read()
PORTAL = read("lib/omniflow/portal.ts")
WIRE = PORTAL[PORTAL.index("/** §241 AI execution traces"):]
LIST_ROUTE = read("app/api/omniflow/portal/ai/traces/route.ts")
DETAIL_ROUTE = read("app/api/omniflow/portal/ai/traces/[id]/route.ts")
VIEW = read("app/dashboard/(portal)/bot/AiTraceView.tsx")
OPS = read("app/dashboard/(portal)/bot/AiOpsCard.tsx")

print("== portal.ts ==")
check("one client per call, own names", PORTAL.count("export function listAiTraces(") == 1
      and PORTAL.count("export function getAiTrace(") == 1 and PORTAL.count("export interface AiTraceDetail") == 1
      and PORTAL.count('const AI_TRACES = "api/v1/portal/ai/traces";') == 1)
check("query names = the CP's (snake_case), only when set", 'params.set("agent_id", String(query.agentId))' in WIRE
      and 'params.set("conversation_id", String(query.conversationId))' in WIRE
      and "if (query.kind) params.set(\"kind\", query.kind);" in WIRE
      and "if (query.decision) params.set(\"decision\", query.decision);" in WIRE
      and 'new URLSearchParams({ days: String(query.days) })' in WIRE)
for name in ("kind", "decision", "limit", "days"):
    check("the CP reads query param " + name, 'arg("' + name + '")' in CP)
check("the CP reads query params agent_id + conversation_id",
      'for name in ("agent_id", "conversation_id"):\n        if arg(name):' in CP)
check("trace id encoded into the path", 'AI_TRACES + "/" + encodeURIComponent(String(traceId))' in WIRE)
check("audit item type carries the optional trace link",
      "trace?: { id: number; agent: { id: number; name: string } | null; model: string | null };" in PORTAL)
step_keys = set(re.findall(r'\{\s*"key": "([a-z]+)",\s*"label"', CP)) - {"conversation"}  # a tool row
type_keys = re.findall(r'"([a-z]+)"', re.search(r'key: ("input"[^;]+);', WIRE).group(1))
check("step key type = the CP's step keys", type_keys == ["input", "guard", "agent", "tools", "model",
                                                          "decision", "response"]
      and set(step_keys) == set(type_keys), (type_keys, step_keys))
cp_status = set(re.findall(r'"status": "([a-z]+)"', CP)) | set(re.findall(r'"(ok|warn|blocked|failed|skipped|unknown)"'
                                                                         r' if', CP))
type_status = set(re.findall(r'"([a-z]+)"', re.search(r'status: ("ok"[^;]+);', WIRE).group(1)))
check("status type covers every status the CP sends", cp_status <= type_status, (cp_status, type_status))

print("== BFF routes ==")
kinds = re.search(r"const KINDS = \[([^\]]+)\]", LIST_ROUTE).group(1)
check("list route kinds = CP kinds", re.findall(r'"([a-z_]+)"', kinds) == list(tr.KINDS), kinds)
decisions = re.search(r"const DECISIONS = \[([^\]]+)\]", LIST_ROUTE).group(1)
check("list route decisions = CP decisions", tuple(re.findall(r'"([a-z]+)"', decisions)) == tr.DECISIONS)
check("list route: days 1..90 (CP MAX_DAYS), default 7 (CP default)", tr.MAX_DAYS == 90 and tr.DEFAULT_DAYS == 7
      and '/^\\d{1,2}$/.test(days) || Number(days) < 1 || Number(days) > 90' in LIST_ROUTE
      and 'params.get("days") ?? "7"' in LIST_ROUTE)
check("list route: ids ASCII digits, positive", '/^\\d{1,18}$/.test(raw) || !Number(raw)' in LIST_ROUTE)
check("list route: limit capped at the CP max", tr.MAX_LIMIT == 100
      and "limit: Math.min(Number(limit), 100)" in LIST_ROUTE and '/^\\d{1,3}$/.test(limit) || Number(limit) < 1'
      in LIST_ROUTE)
check("list route: token + service mapping", "withPortalToken(async (accessToken) =>" in LIST_ROUTE
      and "serviceResponse(" in LIST_ROUTE and "listAiTraces(accessToken, {" in LIST_ROUTE)
check("detail route: async params (Next 16), id ASCII digits, 400 before the CP",
      "{ params }: { params: Promise<{ id: string }> }" in DETAIL_ROUTE
      and '!/^\\d{1,18}$/.test(id ?? "") || !Number(id)' in DETAIL_ROUTE
      and "serviceResponse(await getAiTrace(accessToken, Number(id)))" in DETAIL_ROUTE)

print("== trace view ==")
check("fetches the BFF (relative URLs only)", '"/api/omniflow/portal/ai/traces/" + traceId' in VIEW
      and '"/api/omniflow/portal/ai/traces?" + params.toString()' in VIEW and "localhost" not in VIEW
      and "127.0.0.1" not in VIEW)
check("404 -> 'no longer on record'; other errors -> unavailable",
      'if (response.status === 404) return setState("missing");' in VIEW
      and "This answer is no longer on record." in VIEW and "The trace is unavailable right now." in VIEW)
check("stale responses ignored after the trace changes", "let live = true;" in VIEW and "live = false;" in VIEW
      and "if (!live) return;" in VIEW)
for key in ("input", "guard", "agent", "tools", "model", "decision"):
    check("step '" + key + "' has its own rendering", 'step.key === "' + key + '"' in VIEW)
used = set(re.findall(r'\bd\.([a-z_]+)', VIEW)) | set(re.findall(r'\b(?:item|call|timings|reason)\.([a-z_]+)', VIEW))
summary_fields = set(re.findall(r'^  ([a-z_]+)[?]?:', VIEW[VIEW.index("interface TraceSummary"):
                                                         VIEW.index("interface TraceList")], re.M))
import portal_guard  # noqa: E402
guard_fields = set(portal_guard.summary(portal_guard.inspect("hello"))) | {"mode"}  # brain: dict(summary, mode=)
cp_fields = set(re.findall(r'"([a-z_]+)":', CP)) | set(re.findall(r'\b([a-z_]+)=', CP)) | guard_fields | {
    "prompt_tokens", "completion_tokens", "latency_ms", "route", "ok", "model", "tools"}
check("guard step fields come from portal_guard.summary (+ mode)", {"level", "signals", "mode"} <= guard_fields,
      guard_fields)
check("every detail field the view reads is sent by the CP (or the brain's model call)", used - {"length"} <= cp_fields,
      sorted(used - cp_fields))
check("every summary field the list reads is sent by the CP", summary_fields <= cp_fields,
      sorted(summary_fields - cp_fields))
check("match notes = the CP's non-exact matches", set(re.findall(r'^  ([a-z_]+): "', VIEW[
    VIEW.index("const MATCH_NOTE"):VIEW.index("function text(")], re.M)) == {"same_time", "nearest"}
      and '"same_time" if same else "nearest"' in CP)
check("status dots use palette tokens only", all(t in VIEW for t in ("bg-emerald-400", "bg-amber-400", "bg-rose-400"))
      and not re.search(r"(?<!&)#[0-9a-fA-F]{3,6}\b", VIEW))
check("customer + reply text rendered as text (no HTML injection)", "dangerouslySetInnerHTML" not in VIEW
      and "{body}" in VIEW and "whitespace-pre-wrap" in VIEW)
check("cost shown only when prices are configured", 'd.prices_configured ? " \\u00b7 " + money(num(call.cost_usd)) : ""'
      in VIEW and 'value === null ? "no price"' in VIEW)
check("list filters = CP decisions + CP kinds (from the response)", '["send", "Sent by AI"]' in VIEW
      and '["handoff", "Handed to the team"]' in VIEW and "(data?.kinds ?? []).map(" in VIEW
      and "[days, decision, kind]" in VIEW)

print("== AI operations card ==")
check("Traces tab between Activity and Usage", '(["activity", "traces", "usage"] as const)' in OPS
      and 'option === "traces" ? "Traces"' in OPS and "<AiTracesPanel days={days} onOpen={setOpenTrace} />" in OPS)
check("audit rows with a trace show agent + model + a trace button", "{item.trace ? (" in OPS
      and 'item.trace.agent ? " \\u00b7 " + item.trace.agent.name : ""' in OPS
      and 'item.trace.model ? " \\u00b7 " + item.trace.model : ""' in OPS
      and "onClick={() => setOpenTrace(item.trace ? item.trace.id : null)}" in OPS)
check("one detail view, closable", OPS.count("<AiTraceDetailView traceId={openTrace} onClose={() => setOpenTrace(null)} />")
      == 1 and 'import { AiTraceDetailView, AiTracesPanel } from "./AiTraceView";' in OPS)

print("== copy + glyph laws ==")
for name, source in (("view", VIEW), ("card", OPS)):
    check(name + ": no emoji-capable code points", all(ord(ch) < 0x2000 for ch in source))
    check(name + ": no literal \\u escapes in JSX text", not re.search(r">[^<{}]*\\u[0-9a-fA-F]{4}[^<{}]*<", source))

summary("ai_traces_ui")
