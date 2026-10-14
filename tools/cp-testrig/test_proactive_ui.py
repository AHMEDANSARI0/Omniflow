"""242 web pins: the Proactive alerts card on Settings, the two BFF routes
and the portal.ts client. Every field the web reads is checked against the
CP module's real payload builders so the two sides cannot drift."""
import os
import re
import sys

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "x")
sys.path.insert(0, os.getcwd())

from test_lib import check, summary  # noqa: E402
import portal_proactive as pp  # noqa: E402

ROOT = os.environ.get("OF_RIG_WEB_ROOT") or os.path.abspath(os.path.join(os.getcwd(), ".."))


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return fh.read()


PORTAL = read("lib/omniflow/portal.ts")
WIRE = PORTAL[PORTAL.index("/** §242 proactive business alerts"):]
ROUTE = read("app/api/omniflow/portal/proactive/route.ts")
RUN = read("app/api/omniflow/portal/proactive/run/route.ts")
CARD = read("app/dashboard/(portal)/settings/ProactiveAlertsCard.tsx")
PAGE = read("app/dashboard/(portal)/settings/page.tsx")


def fields(name):
    body = re.search(r"export interface " + name + r" \{([^}]*)\}", WIRE).group(1)
    return set(re.findall(r"^\s*([a-z_A-Z]+)\??:", body, re.M))


print("== portal.ts ==")
check("one client per call, own names", WIRE.count("export function getProactive(") == 1
      and WIRE.count("export function saveProactive(") == 1
      and WIRE.count("export function runProactiveCheck(") == 1
      and PORTAL.count('const PROACTIVE = "api/v1/portal/proactive";') == 1)
check("paths = the CP routes", '@bp.get("/proactive")' in open("portal_proactive.py").read()
      and '@bp.put("/proactive")' in open("portal_proactive.py").read()
      and '@bp.post("/proactive/run")' in open("portal_proactive.py").read()
      and 'portalService<ProactiveState>(accessToken, PROACTIVE, { method: "GET" })' in WIRE
      and 'portalService<ProactiveState>(accessToken, PROACTIVE, { method: "PUT", body: JSON.stringify(change) })' in WIRE
      and 'portalService<ProactiveRun>(accessToken, PROACTIVE + "/run", { method: "POST" })' in WIRE)
settings = {"enabled": True, "rules": pp.default_rules(), "last_run_at": None}
payload = pp._payload(settings, [], {"role": "owner"})
check("state type = the CP payload", fields("ProactiveState") == set(payload), (fields("ProactiveState"), set(payload)))
rule = pp.public_rules(pp.default_rules())[0]
check("rule type = the CP rule", fields("ProactiveRule") == set(rule), set(rule))
check("param type = the CP param", fields("ProactiveParam") == set(rule["params"][0]))
event = pp._shape_event({"id": 1, "rule": "complaint_spike", "conversation_id": None})
check("alert type = the CP alert", fields("ProactiveAlert") == set(event), set(event))
check("run type = the CP run response", fields("ProactiveRun") == {"ok", "checked", "alerts"}
      and '"ok": True, "checked": result["checked"], "alerts": result["alerts"]' in open("portal_proactive.py").read())

print("== BFF ==")
check("GET passes through with the session", "export async function GET()" in ROUTE
      and "serviceResponse(await getProactive(accessToken))" in ROUTE)
check("PUT and POST check the origin (request passed to withPortalToken)",
      "    return serviceResponse(await saveProactive(accessToken, change));\n  }, request);" in ROUTE
      and "serviceResponse(await runProactiveCheck(accessToken)), request);" in RUN)
check("PUT forwards only booleans / whole numbers under simple keys",
      "const KEY = /^[a-z_]{1,40}$/;" in ROUTE
      and '!(typeof value === "boolean" || Number.isInteger(value))' in ROUTE
      and 'if (typeof body.enabled !== "boolean") return bad("enabled must be true or false.");' in ROUTE)
key_re = re.compile(r"^[a-z_]{1,40}$")
check("every CP rule / param key passes the BFF key filter", all(
    key_re.match(key) and all(key_re.match(name) for name in spec["params"])
    for key, spec in pp.RULES.items()))
check("BFF caps the number of rules / settings it forwards",
      ".slice(0, 20)" in ROUTE and ".slice(0, 10)" in ROUTE
      and len(pp.RULES) <= 20 and all(len(s["params"]) + 1 <= 10 for s in pp.RULES.values()))

print("== card ==")
check("settings page shows the card after the weekly email",
      'import ProactiveAlertsCard from "./ProactiveAlertsCard";' in PAGE
      and "      <WeeklyProblemsCard />\n      <ProactiveAlertsCard />\n" in PAGE)
check("client component, BFF only", CARD.startswith('"use client";')
      and 'const API = "/api/omniflow/portal/proactive";' in CARD
      and 'fetch(API + "/run", { method: "POST", credentials: "same-origin" })' in CARD
      and "localhost" not in CARD and "127.0.0.1" not in CARD)
check("rules rendered from the API (no rule key hardcoded in the card)",
      not any(key in CARD for key in pp.RULE_KEYS) and "rules.map((rule) =>" in CARD
      and "rule.params.map((param) =>" in CARD)
check("save sends {enabled, rules:{key:{enabled, ...params}}}",
      "{ enabled: rule.enabled, ...Object.fromEntries(rule.params.map((p) => [p.key, p.value])) }" in CARD
      and 'method: "PUT"' in CARD)
check("only owners / admins get Save; inputs read-only otherwise",
      "{canEdit ? (" in CARD and CARD.count("disabled={!canEdit") >= 3
      and "Only owners and admins can change these rules." in CARD)
check("Check now off while alerts are off", "!state.enabled || !state.available" in CARD)
check("links only inside the dashboard", 'alert.href.startsWith("/dashboard/")' in CARD
      and all(href.startswith("/dashboard/") for href in re.findall(r'"href": "([^"]+)"',
                                                                     open("portal_proactive.py").read())))
check("no raw HTML", "dangerouslySetInnerHTML" not in CARD)
check("text glyphs only (no emoji code points)", all(ord(ch) < 0x2190 for ch in CARD + ROUTE + RUN + WIRE
                                                     if ord(ch) > 127 and ch != "\u00a7"),
      sorted({ch for ch in CARD + WIRE if ord(ch) > 127}))
check("existing palette tokens only", not re.search(r"(?<!&)#[0-9a-fA-F]{3,8}\b", CARD)
      and "text-danger" in CARD and "text-ok" in CARD)
check("JSX apostrophes escaped", "don&apos;t" in CARD and "don't" not in re.sub(r'"[^"\n]*"', "", CARD))

summary("proactive_ui")
