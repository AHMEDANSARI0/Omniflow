"""Centralised escalation (platform services): assignee chain (explicit ->
persona target -> first teammate -> nobody), one open escalation per
conversation, severity rules, ledger + audit + owner notification, resolve,
list/summary shapes, owner API + auth, and the wiring pins (brain handoff,
knowledge-gap path, workflow handoff step, page cards)."""
import os

from flask import Flask

import portal_escalation as pe
import portal_notify
from test_lib import check, install_db_stub, summary

PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}
API_KEY_PRINCIPAL = dict(PRINCIPAL, via_api_key=True)
AGENT = {"id": 3, "name": "Sales", "tone": "", "instructions": "",
         "escalation_user_id": 7, "is_active": True, "updated_at": None}
REG = [{"to_regclass": "portal_team_members"}]
ESC = {"id": 11, "conversation_id": 42, "reason": "needs_human", "source": "ai",
       "severity": "normal", "note": "AI handoff: needs_human",
       "target_user_id": 7, "status": "open", "hits": 1, "created_at": None,
       "updated_at": None, "resolved_at": None, "resolved_note": "",
       "contact_name": "Ali", "contact_id": "923001234567"}
notified = []


class PrincipalStub:
    def __init__(self, module, principal):
        self.module = module
        self.principal = principal

    def __enter__(self):
        self.orig = self.module.authenticate_portal_request
        self.module.authenticate_portal_request = lambda: self.principal
        self.module.PortalAuthUnavailable = Exception
        return self

    def __exit__(self, *a):
        self.module.authenticate_portal_request = self.orig


def fresh(script):
    pe._DDL_READY = True
    notified[:] = []
    return install_db_stub(pe, script)


def run_api(script, method, path, json_body=None, principal=PRINCIPAL):
    fresh(script)
    app = Flask("escalation-test")
    app.register_blueprint(pe.bp)
    with PrincipalStub(pe, principal):
        client = app.test_client()
        if method == "GET":
            return client.get(path)
        if method == "POST":
            return client.post(path, json=json_body)
    return None


portal_notify.notify = lambda *a, **k: notified.append((a, k)) or {"in_app": 1}

# ---------- pure ----------

print("== rules ==")
check("severity: policy blocks + owner-raised are high, the rest normal",
      pe.default_severity("policy:refund", "ai") == "high"
      and pe.default_severity("manual", "human") == "high"
      and pe.default_severity("needs_human", "ai") == "normal"
      and pe.default_severity("workflow 3", "workflow") == "normal", "-")
check("reason labels are human sentences", pe.reason_label("needs_human")
      == "AI asked for a human" and pe.reason_label("low_confidence")
      == "AI was not confident" and pe.reason_label("policy:discount")
      == "Blocked by policy (discount)" and pe.reason_label("workflow 3")
      == "Workflow handoff" and pe.reason_label("") == "Handoff", "-")
check("actor kinds map onto the existing audit vocabulary",
      pe.ACTOR_KIND == {"ai": "automation", "workflow": "workflow",
                        "kb": "bot", "rule": "automation",
                        "human": "customer_user", "system": "system"},
      pe.ACTOR_KIND)

# ---------- escalate ----------

print("== escalate ==")
conn = fresh([[], [{"to_regclass": "portal_conversation_agents"}], [AGENT], [], [{"id": 11}], []])
res = pe.escalate(conn.cur, 1, 42, "needs_human", "ai", note="AI handoff")
ex = conn.cur.executed
check("persona escalation target honoured (agent.escalation_user_id)",
      res and res["target_user_id"] == 7 and res["deduped"] is False
      and res["id"] == 11 and res["severity"] == "normal", res)
check("open-check first, then the assignment UPDATE (target, conversation, client)",
      "status = 'open'" in ex[0][0] and ex[0][1] == (1, 42)
      and ex[1][0] == "SELECT to_regclass(%s)"
      and ex[1][1] == ("portal_conversation_agents",)
      and "SET assigned_to" in ex[3][0] and ex[3][1] == (7, 42, 1), ex[:4])
check("ledger row: reason/source/severity/note/target",
      ex[4][0].startswith("INSERT") and "portal_escalations" in ex[4][0]
      and ex[4][1] == (1, 42, "needs_human", "ai", "normal", "AI handoff", 7),
      ex[4])
check("audit escalation.opened as automation with a readable note",
      ex[5][1][1] == "escalation.opened" and ex[5][1][2] == "automation"
      and ex[5][1][4] == 42
      and ex[5][1][5].startswith("AI asked for a human (ai) -> user 7: AI handoff"),
      ex[5][1])
check("owner notified once (kind escalation, deduped per conversation)",
      len(notified) == 1 and notified[0][0][1] == "escalation"
      and notified[0][1]["dedupe_key"] == "conv:42"
      and notified[0][1]["conversation_id"] == 42
      and "assigned to user 7" in notified[0][0][3]
      and res.get("notified") == {"in_app": 1}, notified)

conn = fresh([[], [], [{"id": 12}], []])
res = pe.escalate(conn.cur, 1, 43, "workflow 5", "workflow", note="VIP",
                  user_id=9)
check("explicit user wins (no persona / team lookups)",
      res["target_user_id"] == 9 and conn.cur.executed[1][1] == (9, 43, 1)
      and len(conn.cur.executed) == 4
      and conn.cur.executed[3][1][2] == "workflow", conn.cur.executed)

conn = fresh([[], [{"to_regclass": "portal_conversation_agents"}], [], REG, [{"user_id": 5}], [], [{"id": 13}], []])
res = pe.escalate(conn.cur, 1, 44, "repeated knowledge gaps", "kb")
check("first teammate fallback (legacy behaviour kept)",
      res["target_user_id"] == 5 and conn.cur.executed[5][1] == (5, 44, 1)
      and conn.cur.executed[7][1][2] == "bot", conn.cur.executed)

conn = fresh([[], [], [], [{"id": 14}], []])
res = pe.escalate(conn.cur, 1, 45, "low_confidence", "ai")
check("no persona table + no team table -> recorded, unassigned, owner told",
      res["target_user_id"] is None
      and not any("assigned_to" in e[0] for e in conn.cur.executed)
      and not any("portal_agents" in e[0] for e in conn.cur.executed)
      and "-> unassigned" in conn.cur.executed[4][1][5]
      and "nobody is assigned yet" in notified[0][0][3], conn.cur.executed)

conn = fresh([[{"id": 11, "hits": 2, "target_user_id": 7}], []])
res = pe.escalate(conn.cur, 1, 42, "needs_human", "ai")
check("second handoff on the same chat -> hits bump, no re-assign, no re-page",
      res["deduped"] is True and res["hits"] == 3 and res["id"] == 11
      and len(conn.cur.executed) == 2 and "hits = hits + 1" in conn.cur.executed[1][0]
      and not notified, res)

conn = fresh([[{"id": 11, "hits": 1, "target_user_id": 7}], []])
pe.escalate(conn.cur, 1, 42, "policy:refund", "ai")
check("a policy block upgrades an open escalation to high",
      conn.cur.executed[1][1][0] == "high", conn.cur.executed[1])

conn = fresh([[], [{"to_regclass": "portal_conversation_agents"}], [], [], [{"id": 15}], []])
res = pe.escalate(conn.cur, 1, 46, "policy:refund", "ai")
check("policy block -> high severity everywhere", res["severity"] == "high"
      and conn.cur.executed[4][1][4] == "high"
      and notified[0][1]["severity"] == "high", res)
conn = fresh([[], [], [], [{"id": 16}], []])
res = pe.escalate(conn.cur, 1, 47, "x", "bogus", severity="loud")
check("unknown source/severity normalised", res["source"] == "system"
      and res["severity"] == "normal", res)
conn = fresh([[], [], [], [{"id": 17}], []])
res = pe.escalate(conn.cur, 1, 48, "manual", "human", notify_owner=False)
check("notify_owner=False skips the page", not notified and res["id"] == 17, res)
conn = fresh([])
check("bad conversation id -> None without SQL",
      pe.escalate(conn.cur, 1, 0, "x") is None
      and pe.escalate(conn.cur, 1, "abc", "x") is None
      and conn.cur.executed == [], "-")
conn = fresh([Exception("db down")])
check("never raises", pe.escalate(conn.cur, 1, 42, "x") is None, "-")

# ---------- resolve / list / summary ----------

print("== resolve + reads ==")
conn = fresh([[{"id": 11, "conversation_id": 42, "reason": "needs_human",
                "source": "ai", "severity": "normal"}], []])
res = pe.resolve(conn.cur, 1, 11, 11, "called the customer")
check("resolve closes only OPEN rows of this tenant + audits",
      res == {"id": 11, "status": "resolved", "conversation_id": 42}
      and "status = 'open'" in conn.cur.executed[0][0]
      and conn.cur.executed[0][1] == (11, "called the customer", 11, 1)
      and conn.cur.executed[1][1][1] == "escalation.resolved"
      and conn.cur.executed[1][1][3] == 11, conn.cur.executed)
conn = fresh([[]])
check("resolve unknown -> None, no audit", pe.resolve(conn.cur, 1, 99) is None
      and len(conn.cur.executed) == 1, "-")
conn = fresh([2])
check("resolve_for_conversation returns the count",
      pe.resolve_for_conversation(conn.cur, 1, 42, 11) == 2
      and conn.cur.executed[0][1] == (11, "", 1, 42), conn.cur.executed)

conn = fresh([[ESC]])
items = pe.list_escalations(conn.cur, 1, "open", 20)
sql, params = conn.cur.executed[0]
check("list joins the conversation (name + id), filters status, caps limit",
      "LEFT JOIN" in sql and "portal_conversations" in sql
      and params == (1, "open", 20) and items[0]["contact_name"] == "Ali"
      and items[0]["reason_label"] == "AI asked for a human"
      and items[0]["target_user_id"] == 7, (sql, items))
conn = fresh([[]])
pe.list_escalations(conn.cur, 1, "all", 9999)
check("list 'all' drops the status filter and clamps the limit",
      "e.status = %s" not in conn.cur.executed[0][0]
      and conn.cur.executed[0][1] == (1, pe.LIST_LIMIT), conn.cur.executed[0])

conn = fresh([[{"open_now": 3, "open_high": 1, "opened_7d": 9, "resolved_7d": 6,
                "avg_resolve_seconds": 1500.0}],
              [{"source": "ai", "reason": "needs_human", "n": 5},
               {"source": "ai", "reason": "low_confidence", "n": 2},
               {"source": "workflow", "reason": "workflow 3", "n": 2}]])
stats = pe.summary(conn.cur, 1)
check("summary shape", stats == {
    "open": 3, "open_high": 1, "opened_7d": 9, "resolved_7d": 6,
    "avg_resolve_minutes": 25.0, "by_source": {"ai": 7, "workflow": 2},
    "top_reasons": [{"label": "AI asked for a human", "count": 5},
                    {"label": "AI was not confident", "count": 2},
                    {"label": "Workflow handoff", "count": 2}]}, stats)
conn = fresh([[], []])
check("summary on an empty table", pe.summary(conn.cur, 1)["open"] == 0
      and pe.summary.__doc__, "-")

# ---------- API ----------

print("== api ==")
r = run_api([[ESC], [{"open_now": 1}], []], "GET", "/api/v1/portal/escalations")
body = r.get_json()
check("GET escalations 200 {items, summary, sources}", r.status_code == 200
      and body["items"][0]["id"] == 11 and body["summary"]["open"] == 1
      and body["sources"] == list(pe.SOURCES), body)
r = run_api([], "GET", "/api/v1/portal/escalations?status=weird")
check("GET escalations 400 bad status", r.status_code == 400, r.status_code)
r = run_api([[], [], []], "GET", "/api/v1/portal/escalations?status=all",
            principal=API_KEY_PRINCIPAL)
check("GET escalations readable by API keys", r.status_code == 200, r.status_code)
r = run_api([], "GET", "/api/v1/portal/escalations", principal=None)
check("GET escalations 401", r.status_code == 401, r.status_code)

r = run_api([[{"id": 42}], [], [], [{"id": 21}], []], "POST",
            "/api/v1/portal/escalations",
            {"conversation_id": 42, "user_id": 9, "note": "VIP complaint"})
body = r.get_json()
check("POST manual escalation -> source human, high, assigned to the chosen user",
      r.status_code == 200 and body["escalation"]["source"] == "human"
      and body["escalation"]["severity"] == "high"
      and body["escalation"]["target_user_id"] == 9, body)
r = run_api([[]], "POST", "/api/v1/portal/escalations", {"conversation_id": 99})
check("POST 404 unknown conversation", r.status_code == 404, r.status_code)
r = run_api([], "POST", "/api/v1/portal/escalations", {})
check("POST 400 conversation_id required", r.status_code == 400, r.status_code)
r = run_api([], "POST", "/api/v1/portal/escalations",
            {"conversation_id": 42, "user_id": "x"})
check("POST 400 bad user_id", r.status_code == 400, r.status_code)
r = run_api([], "POST", "/api/v1/portal/escalations", {"conversation_id": 42},
            principal=API_KEY_PRINCIPAL)
check("POST 403 API key", r.status_code == 403, r.status_code)
r = run_api([[{"id": 11, "conversation_id": 42, "reason": "needs_human",
               "source": "ai", "severity": "normal"}], []], "POST",
            "/api/v1/portal/escalations/11/resolve", {"note": "done"})
check("POST resolve 200", r.status_code == 200
      and r.get_json()["escalation"]["status"] == "resolved", r.get_json())
r = run_api([[]], "POST", "/api/v1/portal/escalations/11/resolve", {})
check("POST resolve 404", r.status_code == 404, r.status_code)
r = run_api([], "POST", "/api/v1/portal/escalations/11/resolve", {},
            principal=API_KEY_PRINCIPAL)
check("POST resolve 403 API key", r.status_code == 403, r.status_code)

# ---------- wiring pins ----------

print("== wiring pins ==")
HERE = os.path.dirname(os.path.abspath(__file__))
CP = os.path.join(HERE, "..", "..", "omniflow-backend-patch")
RIG13 = "/tmp/p13/Omniflow/"


def read(path):
    return open(path, encoding="utf8").read() if os.path.exists(path) else ""


check("blueprint registered", "aux_app.register_blueprint(portal_escalation_bp)"
      in read(os.path.join(CP, "app.py")), "-")
BRAIN = read(os.path.join(CP, "portal_brain.py"))
check("brain: handoff decisions escalate (needs_human / low_confidence / policy)",
      "def _handoff(" in BRAIN and '_handoff(cur, client_id, int(conversation_id or 0), grounding)'
      in BRAIN and 'reason in ("needs_human", "low_confidence", "injection_suspected")' in BRAIN
      and 'reason.startswith("policy:")' in BRAIN
      and 'portal_escalation.escalate(cur, client_id, conversation_id, reason,\n                                   "ai"' in BRAIN, "-")
check("brain: escalation tables ride the brain DDL chain",
      "portal_escalation._ensure_ddl(cur)" in BRAIN, "-")
GROWTH = read(os.path.join(CP, "portal_growth.py"))
check("knowledge-gap escalation delegates to the service (legacy fallback kept)",
      'portal_escalation.escalate(cur, client_id, conversation_id, reason,\n                                      "kb")' in GROWTH
      and '"bot.escalated"' in GROWTH, "-")
WF = read(os.path.join(CP, "portal_workflows.py"))
check("workflow handoff step uses the service for both branches",
      'portal_escalation.escalate(' in WF and '"workflow", note=str(config.get("note") or "")' in WF
      and 'user_id=int(user_id) if user_id else None' in WF
      and '"workflow.handoff"' not in WF.split("def _run_step")[-1].split('if kind == "goal"')[0], "-")
SRC = read(pe.__file__)
check("writes human-only, reads any principal",
      SRC.count("= _human_or_error()") == 2 and SRC.count("= _principal_or_error()") == 2, "-")
check("audit on open + resolve", '"escalation.opened"' in SRC and '"escalation.resolved"' in SRC, "-")

LIB = read(RIG13 + "lib/omniflow/portal.ts")
check("portal.ts escalation client", all(t in LIB for t in (
    "export async function listEscalations", "export async function resolveEscalation",
    "export async function raiseEscalation", '"api/v1/portal/escalations"')), "-")
for rel, tokens in (("escalations/route.ts", ("listEscalations", "raiseEscalation",
                                              "export async function GET",
                                              "export async function POST")),
                    ("escalations/[id]/resolve/route.ts", ("resolveEscalation",
                                                           "export async function POST",
                                                           "params: Promise<{ id: string }>"))):
    src = read(RIG13 + "app/api/omniflow/portal/" + rel)
    depth = rel.count("/") + 4
    check("BFF " + rel, bool(src) and all(t in src for t in tokens)
          and ('"' + "../" * depth + 'lib/omniflow/portal"') in src, rel)
CARD = read(RIG13 + "app/dashboard/(portal)/bot/EscalationsCard.tsx")
check("Escalations card: queue, reason labels, source, Resolve, summary chips",
      all(t in CARD for t in ("/api/omniflow/portal/escalations", "Resolve",
                              "reason_label", "open_high", "top_reasons",
                              "/dashboard/conversations/")), "-")
check("Escalations card mounted on Configure AI", "<EscalationsCard />" in read(
    RIG13 + "app/dashboard/(portal)/bot/page.tsx"), "-")
check("UI copy English + text glyphs", "karein" not in CARD and "\\u25b6" not in CARD
      and "\\u2714" not in CARD, "-")

raise SystemExit(1 if summary("escalation") else 0)
