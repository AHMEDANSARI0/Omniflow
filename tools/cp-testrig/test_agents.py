"""Tests for Router+Agents upgrade: portal_agents (AI agent personas +
versioning + soft archive, human-only API) + portal_routing agent targets
+ portal_brain persona wiring + web pins (BFF, portal.ts, team UI)."""
from flask import Flask

import portal_agents
import portal_routing
import portal_db
from test_lib import install_db_stub
from test_lib import check, summary

PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}

AGENT_ROW = {"id": 7, "name": "Sales Aunty", "tone": "cheerful",
             "instructions": "Upsell gently.", "escalation_user_id": 9,
             "is_active": True, "updated_at": "u"}


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
    portal_agents._DDL_READY = True
    return install_db_stub(portal_agents, script)


def run_api(script, method, path, json_body=None, principal=PRINCIPAL):
    fresh(script)
    app = Flask("agents-test")
    app.register_blueprint(portal_agents.bp)
    with PrincipalStub(portal_agents, principal):
        client = app.test_client()
        if method == "GET":
            return client.get(path)
        if method == "POST":
            return client.post(path, json=json_body)
        if method == "PUT":
            return client.put(path, json=json_body)
        if method == "DELETE":
            return client.delete(path)
    return None


# ---------- read helpers (fail-soft) ----------

conn = fresh([[AGENT_ROW]])
with conn.cur as cur:
    agent = portal_agents.load_agent(cur, 1, 7)
check("load_agent shaped", agent is not None and agent["name"] == "Sales Aunty"
      and agent["tone"] == "cheerful", agent)

conn = fresh([[]])
with conn.cur as cur:
    check("load_agent missing -> None",
          portal_agents.load_agent(cur, 1, 7) is None, "none")

conn = fresh([[AGENT_ROW]])
with conn.cur as cur:
    got = portal_agents.agent_for_conversation(cur, 1, 55)
check("agent_for_conversation", got is not None
      and got["id"] == 7 and got["name"] == "Sales Aunty", got)

conn = fresh([])
with conn.cur as cur:
    check("agent_for_conversation fail-soft",
          portal_agents.agent_for_conversation(cur, 1, 55) is None, "soft")

conn = fresh([[]])
with conn.cur as cur:
    portal_agents.assign_agent(cur, 1, 55, 7)
check("assign_agent upsert",
      any("ON CONFLICT" in s for s, p in conn.cur.executed), "upsert")


# ---------- owner API ----------

r = run_api([[AGENT_ROW], [{"agent_id": 7, "versions": 3}]], "GET",
            "/api/v1/portal/agents")
check("agents list 200", r.status_code == 200, r.status_code)
body = r.get_json()
check("agents list shape", body["agents"][0]["id"] == 7
      and body["agents"][0]["name"] == "Sales Aunty"
      and body["agents"][0]["versions"] == 3
      and body["agents"][0]["escalation_user_id"] == 9, body)

r = run_api([[{"total": 0}], [{"id": 7}], [], []], "POST", "/api/v1/portal/agents",
            json_body={"name": "Support Pro", "tone": "formal",
                       "instructions": "Policy strict.", "escalation_user_id": 5})
check("agents create 200", r.status_code == 200
      and r.get_json()["agent"]["id"] == 7
      and r.get_json()["agent"]["versions"] == 1, r.get_json())
sqls = [s for s, p in portal_agents.portal_db.conn.cur.executed]
check("agents create versions snapshot",
      any("INSERT INTO portal_agent_versions" in s for s in sqls), "version")

r = run_api([[]], "POST", "/api/v1/portal/agents",
            json_body={"name": "", "tone": "", "instructions": ""})
check("agents create 400 empty name", r.status_code == 400, r.status_code)

r = run_api([[]], "POST", "/api/v1/portal/agents",
            json_body={"name": "X", "tone": "", "instructions": "",
                       "escalation_user_id": -3})
check("agents create 400 bad escalation", r.status_code == 400, r.status_code)

r = run_api([[{"total": 10}]], "POST", "/api/v1/portal/agents",
            json_body={"name": "X", "tone": "", "instructions": ""})
check("agents create 400 max", r.status_code == 400, r.status_code)

# §205: an update without "schedule" first reads the stored schedule so
# partial saves never wipe business hours (one extra SELECT).
r = run_api([[{"schedule": None}], [{"id": 7}], [], []], "PUT", "/api/v1/portal/agents/7",
            json_body={"name": "Support Pro v2", "tone": "formal",
                       "instructions": "x", "escalation_user_id": None,
                       "is_active": False})
check("agents update 200", r.status_code == 200, r.status_code)

r = run_api([[]], "PUT", "/api/v1/portal/agents/999",
            json_body={"name": "X", "tone": "", "instructions": ""})
check("agents update 404", r.status_code == 404, r.status_code)

r = run_api([[{"id": 7}], []], "DELETE", "/api/v1/portal/agents/7")
check("agents archive 200 soft", r.status_code == 200, r.status_code)
sqls = [s for s, p in portal_agents.portal_db.conn.cur.executed]
check("agents archive soft delete",
      any("SET is_active = FALSE" in s for s in sqls), "soft")

r = run_api([[]], "DELETE", "/api/v1/portal/agents/999")
check("agents archive 404", r.status_code == 404, r.status_code)

r = run_api([[]], "GET", "/api/v1/portal/agents",
            principal={"via_api_key": True, "client_id": 1, "user_id": 1})
check("agents api key 403", r.status_code == 403, r.status_code)

r = run_api([[]], "GET", "/api/v1/portal/agents", principal=None)
check("agents anon 401", r.status_code == 401, r.status_code)


# ---------- permissions + versioning/rollback (Control Center batch) ----------

check("ddl: permission columns + version note (lazy ALTER, data-preserving)",
      "ADD COLUMN IF NOT EXISTS allowed_actions JSONB" in portal_agents._DDL
      and "ADD COLUMN IF NOT EXISTS max_risk TEXT NOT NULL DEFAULT 'high'"
      in portal_agents._DDL
      and "ADD COLUMN IF NOT EXISTS can_auto_reply BOOLEAN NOT NULL DEFAULT"
      " TRUE" in portal_agents._DDL
      and "ADD COLUMN IF NOT EXISTS note TEXT" in portal_agents._DDL, "ddl")
check("shape: legacy row -> permissive defaults",
      portal_agents._shape(AGENT_ROW)["allowed_actions"] is None
      and portal_agents._shape(AGENT_ROW)["max_risk"] == "high"
      and portal_agents._shape(AGENT_ROW)["can_auto_reply"] is True, "shape")
PERM_ROW = dict(AGENT_ROW, allowed_actions='["add_conversation_tag", "x", ""]',
                max_risk="MEDIUM", can_auto_reply=False)
shaped = portal_agents._shape(PERM_ROW)
check("shape: JSON string list, risk normalised, draft-only",
      shaped["allowed_actions"] == ["add_conversation_tag", "x"]
      and shaped["max_risk"] == "medium" and shaped["can_auto_reply"] is False,
      shaped)
check("read helpers select the permission columns",
      "allowed_actions" in portal_agents.AGENT_COLUMNS
      and "can_auto_reply" in portal_agents.AGENT_COLUMNS, "cols")
conn = fresh([[PERM_ROW]])
with conn.cur as cur:
    got = portal_agents.agent_for_conversation(cur, 1, 55)
check("agent_for_conversation carries permissions",
      got["max_risk"] == "medium" and got["can_auto_reply"] is False
      and "a.allowed_actions" in conn.cur.executed[0][0], got)

check("permits: allow-list + max risk + no-agent passthrough",
      portal_agents.permits(shaped, "add_conversation_tag", "low") == (True, "")
      and portal_agents.permits(shaped, "queue_whatsapp_message", "low")
      == (False, "action_not_allowed")
      and portal_agents.permits(shaped, "add_conversation_tag", "high")
      == (False, "risk_above_max")
      and portal_agents.permits(None, "anything", "high") == (True, ""),
      "permits")

r = run_api([[{"total": 0}], [{"id": 8}], [], []], "POST",
            "/api/v1/portal/agents",
            json_body={"name": "Ops", "tone": "", "instructions": "",
                       "allowed_actions": ["add_conversation_tag",
                                           "add_customer_note"],
                       "max_risk": "medium", "can_auto_reply": False})
check("create with permissions 200 + echoed", r.status_code == 200
      and r.get_json()["agent"]["allowed_actions"]
      == ["add_conversation_tag", "add_customer_note"]
      and r.get_json()["agent"]["max_risk"] == "medium"
      and r.get_json()["agent"]["can_auto_reply"] is False, r.get_json())
ins = portal_agents.portal_db.conn.cur.executed[1]
check("create persists allowed_actions JSON, max_risk, can_auto_reply",
      "allowed_actions, max_risk, can_auto_reply" in ins[0]
      and ins[1][5] == '["add_conversation_tag", "add_customer_note"]'
      and ins[1][6] == "medium" and ins[1][7] is False, ins)
snap = portal_agents.portal_db.conn.cur.executed[2]
check("create snapshot carries permissions + note",
      '"max_risk": "medium"' in snap[1][2] and snap[1][3] == "Created", snap)

r = run_api([[]], "POST", "/api/v1/portal/agents",
            json_body={"name": "X", "tone": "", "instructions": "",
                       "allowed_actions": ["rm_rf"]})
check("create 400 unknown action name", r.status_code == 400
      and "Unknown action" in r.get_json()["error"]["message"], r.get_json())
r = run_api([[]], "POST", "/api/v1/portal/agents",
            json_body={"name": "X", "tone": "", "instructions": "",
                       "max_risk": "extreme"})
check("create 400 bad max_risk", r.status_code == 400, r.status_code)
r = run_api([[]], "POST", "/api/v1/portal/agents",
            json_body={"name": "X", "tone": "", "instructions": "",
                       "can_auto_reply": "yes"})
check("create 400 bad can_auto_reply", r.status_code == 400, r.status_code)
r = run_api([[]], "POST", "/api/v1/portal/agents",
            json_body={"name": "X", "tone": "", "instructions": "",
                       "allowed_actions": "all"})
check("create 400 allowed_actions not a list", r.status_code == 400,
      r.status_code)

r = run_api([[{"schedule": None}], [{"id": 7}], [], []], "PUT", "/api/v1/portal/agents/7",
            json_body={"name": "Support Pro", "tone": "", "instructions": "",
                       "allowed_actions": None, "max_risk": "low",
                       "can_auto_reply": True})
upd = portal_agents.portal_db.conn.cur.executed[1]
check("update persists permissions (null = every action)",
      r.status_code == 200 and "allowed_actions = CAST(%s AS JSONB)" in upd[0]
      and upd[1][5] is None and upd[1][6] == "low" and upd[1][7] is True, upd)
ver = portal_agents.portal_db.conn.cur.executed[2]
check("update appends a version row (never rewrites)",
      "INSERT INTO portal_agent_versions" in ver[0]
      and "COALESCE(MAX(version), 0) + 1" in ver[0]
      and ver[1][3] == "Saved", ver)

VERSION_ROWS = [
    {"version": 3, "snapshot": {"name": "Support Pro", "tone": "formal",
                                "instructions": "v3", "escalation_user_id": 9,
                                "is_active": True, "allowed_actions": None,
                                "max_risk": "high", "can_auto_reply": True},
     "note": "Saved", "created_at": "2026-09-29T10:00:00+00:00"},
    {"version": 2, "snapshot": '{"name": "Support Pro", "tone": "warm",'
                               ' "instructions": "v2", "max_risk": "medium",'
                               ' "can_auto_reply": false,'
                               ' "allowed_actions": ["add_customer_note"]}',
     "note": "Saved", "created_at": "2026-09-28T10:00:00+00:00"},
]
r = run_api([[{"id": 7}], VERSION_ROWS], "GET",
            "/api/v1/portal/agents/7/versions")
body = r.get_json()
check("versions list 200 newest first", r.status_code == 200
      and [v["version"] for v in body["versions"]] == [3, 2], body)
check("versions list shapes JSON-string snapshots too",
      body["versions"][1]["snapshot"]["max_risk"] == "medium"
      and body["versions"][1]["snapshot"]["can_auto_reply"] is False
      and body["versions"][1]["snapshot"]["allowed_actions"]
      == ["add_customer_note"]
      and body["versions"][0]["snapshot"]["escalation_user_id"] == 9, body)
sqls = [s for s, p in portal_agents.portal_db.conn.cur.executed]
check("versions list tenant-scoped", all("client_id = %s" in q for q in sqls),
      sqls)
r = run_api([[]], "GET", "/api/v1/portal/agents/999/versions")
check("versions list 404 foreign agent", r.status_code == 404, r.status_code)

r = run_api([[VERSION_ROWS[1]], [{"id": 7}], [{"version": 4}], []], "POST",
            "/api/v1/portal/agents/7/rollback", json_body={"version": 2})
check("rollback 200 -> new version number", r.status_code == 200
      and r.get_json() == {"ok": True, "version": 4, "restored_from": 2},
      r.get_json())
ex = portal_agents.portal_db.conn.cur.executed
check("rollback reads the requested version tenant-scoped",
      "portal_agent_versions" in ex[0][0] and ex[0][1] == (1, 7, 2), ex[0])
check("rollback restores config incl. permissions",
      "UPDATE portal_agents" in ex[1][0] and ex[1][1][0] == "Support Pro"
      and ex[1][1][1] == "warm" and ex[1][1][2] == "v2"
      and ex[1][1][4] == '["add_customer_note"]' and ex[1][1][5] == "medium"
      and ex[1][1][6] is False, ex[1])
check("rollback appends a NEW version noted as restored (history intact)",
      "INSERT INTO portal_agent_versions" in ex[2][0]
      and '"restored_from": 2' in ex[2][1][2]
      and ex[2][1][3] == "Restored from version 2"
      and not any("DELETE" in q for q, _p in ex), ex[2])
check("rollback audited", "agents.rolled_back" in str(ex[3][1]), ex[3])
r = run_api([[]], "POST", "/api/v1/portal/agents/7/rollback",
            json_body={"version": 9})
check("rollback 404 unknown version", r.status_code == 404, r.status_code)
r = run_api([[]], "POST", "/api/v1/portal/agents/7/rollback",
            json_body={"version": "two"})
check("rollback 400 bad version", r.status_code == 400, r.status_code)
r = run_api([[]], "POST", "/api/v1/portal/agents/7/rollback",
            json_body={"version": 2},
            principal={"via_api_key": True, "client_id": 1, "user_id": 1})
check("rollback api key 403", r.status_code == 403, r.status_code)

ACTIONS_SRC = open("portal_actions.py", encoding="utf8").read()
check("action engine enforces persona permissions (agent=...)",
      "portal_agents.permits(agent, action, risk)" in ACTIONS_SRC
      and '"action.denied"' in ACTIONS_SRC, "actions")
WORKFLOWS_SRC = open("portal_workflows.py", encoding="utf8").read()
check("workflow action step passes the conversation persona",
      "agent_for_conversation(" in WORKFLOWS_SRC
      and "agent=agent)" in WORKFLOWS_SRC
      and '"outcome": "denied"' in WORKFLOWS_SRC, "workflows")


# ---------- routing: agent targets ----------

def routing_fresh(script):
    portal_routing._ROUTING_DDL_READY = True
    conn = install_db_stub(portal_routing, script)
    portal_routing.portal_db.CONV_TABLE = "portal_conversations"
    return conn


routing_app = Flask("routing-test")
routing_app.register_blueprint(portal_routing.bp)


def run_routing(script, method, path, json_body=None, principal=PRINCIPAL):
    routing_fresh(script)
    with PrincipalStub(portal_routing, principal):
        client = routing_app.test_client()
        if method == "POST":
            return client.post(path, json=json_body)
        if method == "GET":
            return client.get(path)
        if method == "DELETE":
            return client.delete(path)
    return None


r = run_routing([[{"total": 0}], [AGENT_ROW], [{"id": 9}], []],
                "POST", "/api/v1/portal/routing/rules",
                json_body={"match": "refund", "target_type": "agent",
                           "agent_id": 7, "priority": 5})
check("agent rule 200", r.status_code == 200
      and r.get_json()["id"] == 9, r.status_code)
sqls = [s for s, p in portal_routing.portal_db.conn.cur.executed]
check("agent rule insert has agent_id",
      any("target_type" in s and "agent_id" in s for s in sqls), "insert")

r = run_routing([[{"total": 0}], []], "POST", "/api/v1/portal/routing/rules",
                json_body={"match": "refund", "target_type": "agent",
                           "agent_id": 99, "priority": 5})
check("agent rule 400 unknown agent", r.status_code == 400, r.status_code)

r = run_routing([[]], "POST", "/api/v1/portal/routing/rules",
                json_body={"match": "refund", "target_type": "agent",
                           "agent_id": 0})
check("agent rule 400 bad agent id", r.status_code == 400, r.status_code)

r = run_routing([[]], "POST", "/api/v1/portal/routing/rules",
                json_body={"match": "refund", "target_type": "robot",
                           "agent_id": 7})
check("agent rule 400 bad target type", r.status_code == 400, r.status_code)

# maybe_route assigns an agent (not a teammate) for agent rules
AGENT_RULE = [{"id": 1, "match_text": "refund", "user_id": 0,
               "target_type": "agent", "agent_id": 7}]
conn = routing_fresh([AGENT_RULE, [], [], []])
portal_routing.maybe_route(1, 42, "92x", "REFUND chahiye", conn)
sqls = [s for s, p in conn.cur.executed]
check("route assigns agent row",
      any("portal_conversation_agents" in s and "ON CONFLICT" in s
          for s in sqls), sqls)
check("route no teammate assign",
      not any("UPDATE portal_conversations" in s for s in sqls), "no user")

# inactive agent rule is skipped (LEFT JOIN filter)
conn = routing_fresh([[], []])
portal_routing.maybe_route(1, 42, "92x", "salam", conn)
check("no rule no assign", len(conn.cur.executed) == 1, conn.cur.executed)


# ---------- wiring pins ----------

APP = open("/tmp/smoke971/app.py", encoding="utf8").read()
check("app.py registers agents bp",
      "aux_app.register_blueprint(portal_agents_bp)" in APP, "bp")

BRAIN = open("portal_brain.py", encoding="utf8").read()
check("brain resolves agent persona",
      "agent_for_conversation(" in BRAIN
      and "agent_persona" in BRAIN, "brain")

ROUTING = open("portal_routing.py", encoding="utf8").read()
check("routing target_type column",
      "ADD COLUMN IF NOT EXISTS target_type" in ROUTING
      and "ADD COLUMN IF NOT EXISTS agent_id" in ROUTING, "ddl")
check("routing assign_agent wired",
      "portal_agents.assign_agent(" in ROUTING, "wire")

PORTAL = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts",
              encoding="utf8").read()
for fn in ("listAgents", "createAgent", "updateAgent", "archiveAgent"):
    check("client " + fn, "export async function " + fn in PORTAL, fn)
check("client RoutingRule agent fields",
      "targetType: RoutingTargetType;" in PORTAL
      and "agentName: string | null;" in PORTAL, "type")

BFF_ROUTE = open("/tmp/smoke971/bff_routing_rules.ts", encoding="utf8").read()
check("bff routing validates agent target",
      "target_type" in BFF_ROUTE and "agent_id is required for agent targets"
      in BFF_ROUTE, "bffroute")

BFF = open("/tmp/smoke971/bff_agents.ts", encoding="utf8").read()
check("bff agents list/create", "listAgents" in BFF
      and "createAgent" in BFF, "bff")
BFF_ID = open("/tmp/smoke971/bff_id_agent_id.ts", encoding="utf8").read()
check("bff agents [id] update/archive", "updateAgent" in BFF_ID
      and "archiveAgent" in BFF_ID, "bffid")
check("bff agents [id] awaits Next 16 params (Promise)",
      "params: Promise<{ id: string }>" in BFF_ID
      and "params: { id: string }" not in BFF_ID, "bffid-params")
UI = open("/tmp/smoke971/agents_routing.tsx", encoding="utf8").read()
check("team UI agents + routing",
      "Create agent" in UI and "Add rule" in UI, "ui")
TEAM = open("/tmp/smoke971/team_page.tsx", encoding="utf8").read()
check("team page mounts agents section",
      "<AgentsAndRouting />" in TEAM, "mount")

# permissions + versions web pins
check("client PortalAgent permission fields + version helpers",
      "allowedActions: string[] | null;" in PORTAL
      and "canAutoReply: boolean;" in PORTAL
      and "export async function listAgentVersions" in PORTAL
      and "export async function rollbackAgent" in PORTAL
      and '"/rollback"' in PORTAL, "portal.ts")
W = "/tmp/p13/Omniflow/"
PERM_TS = open(W + "lib/omniflow/agent-permissions.ts", encoding="utf8").read()
check("shared BFF permission parser",
      "export function parseAgentPermissions" in PERM_TS
      and "max_risk must be low, medium or high." in PERM_TS, "parser")
check("bff create/update parse permissions", "parseAgentPermissions" in BFF
      and "parseAgentPermissions" in BFF_ID
      and "...permissions.value" in BFF and "...permissions.value" in BFF_ID,
      "bff-perms")
BFF_VER = open(W + "app/api/omniflow/portal/agents/[id]/versions/route.ts",
               encoding="utf8").read()
BFF_RB = open(W + "app/api/omniflow/portal/agents/[id]/rollback/route.ts",
              encoding="utf8").read()
check("bff versions + rollback routes (depth 7, Promise params)",
      "listAgentVersions" in BFF_VER and "rollbackAgent" in BFF_RB
      and BFF_VER.count("../../../../../../../lib/") >= 3
      and "params: Promise<{ id: string }>" in BFF_RB
      and "version must be a positive integer." in BFF_RB, "bff-versions")
check("team UI permission controls + version history",
      "Permissions" in UI and "Actions this agent may trigger" in UI
      and "May send replies automatically" in UI
      and "Version history" in UI and "Restore" in UI
      and "workflows/catalog" in UI, "ui-perms")

summary("agents")
