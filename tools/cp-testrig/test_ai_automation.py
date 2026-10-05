"""§240 AI + automation analytics quadrant (portal_ai_automation).

Units (days parsing, shares, reason keys, labels cover every brain tool and
reason, the actor mapping equals portal_actions._shape_run), HTTP guards
(401 / 503 / 403 API key / 400 bad days before any DB work), then the real
thing on pgserver: a fresh database (every block unavailable, nothing
created), seeded ledgers with a foreign workspace on the SAME ids, window
edges, priced vs unpriced cost (per agent too), a broken / missing ledger
failing soft per block, roles, read-only.
"""
import json
import os
import sys
import tempfile

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "svc-test-key")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "admin-test-key")
for name in ("OF_AI_ANALYTICS_HIGH_CONFIDENCE", "OF_AI_PRICES_JSON", "OF_ACTION_RUNS_KEEP_DAYS",
             "OF_BRAIN_MIN_CONFIDENCE"):
    os.environ.pop(name, None)
sys.path.insert(0, os.getcwd())
sys.modules.pop("portal_db", None)

from flask import Flask  # noqa: E402

from test_lib import check, summary  # noqa: E402
import portal_db  # noqa: E402
import portal_ai_automation as qa  # noqa: E402
from portal_auth import PortalAuthUnavailable  # noqa: E402

HERE = os.getcwd()

print("== units ==")
check("days: blank -> 30", qa.parse_days(None) == 30 and qa.parse_days("") == 30 and qa.parse_days(" ") == 30)
check("days: 1..90 accepted", qa.parse_days("1") == 1 and qa.parse_days("90") == 90 and qa.parse_days(" 7 ") == 7)
check("days: junk / out of range refused", all(qa.parse_days(v) is None for v in
      ("0", "91", "365", "-1", "7.5", "abc", "1e1", "0x10", "٣")))
check("share: rounded, None when nothing to divide", qa._share(1, 3) == 0.333 and qa._share(0, 0) is None
      and qa._share(2, None) is None and qa._share(3, 3) == 1.0)
check("reason key: prefix of policy:/output_guard:, blank -> unknown",
      qa._reason_key("policy:refund") == "policy" and qa._reason_key("output_guard:phone") == "output_guard"
      and qa._reason_key("") == "unknown" and qa._reason_key(None) == "unknown"
      and qa._reason_key("low_confidence") == "low_confidence")
check("high band default 0.8, low = brain bar 0.6", qa.HIGH_CONFIDENCE == 0.8 and qa._low_below() == 0.6)
os.environ["OF_AI_ANALYTICS_HIGH_CONFIDENCE"] = "7"
check("high band env clamped to 0..1", qa._env_float("OF_AI_ANALYTICS_HIGH_CONFIDENCE", 0.8) == 1.0)
os.environ["OF_AI_ANALYTICS_HIGH_CONFIDENCE"] = "nope"
check("high band env junk -> default", qa._env_float("OF_AI_ANALYTICS_HIGH_CONFIDENCE", 0.8) == 0.8)
os.environ.pop("OF_AI_ANALYTICS_HIGH_CONFIDENCE")

brain_src = open(os.path.join(HERE, "portal_brain.py"), encoding="utf8").read()
import re  # noqa: E402
brain_tools = set(re.findall(r'grounding\["tools"\]\.append\("([a-z_]+)"\)', brain_src))
brain_reasons = {r.split(":")[0] for r in re.findall(r'grounding\["reason"\] = "([a-z_:]+)', brain_src)}
check("every tool the brain records has a label", brain_tools and brain_tools <= set(qa.TOOL_LABELS),
      sorted(brain_tools - set(qa.TOOL_LABELS)))
check("every handoff reason the brain records has a label",
      brain_reasons and brain_reasons <= set(qa.BRAIN_REASONS), sorted(brain_reasons - set(qa.BRAIN_REASONS)))
check("labels are plain words (no emoji)", all(ord(ch) < 0x2000 for text in
      list(qa.TOOL_LABELS.values()) + list(qa.BRAIN_REASONS.values()) for ch in text))

import portal_actions  # noqa: E402
quad_src = open(os.path.join(HERE, "portal_ai_automation.py"), encoding="utf8").read()
check("read-only: the request rolls back, never commits", "conn.rollback()" in quad_src
      and ".commit()" not in quad_src and "INSERT " not in quad_src and "UPDATE " not in quad_src)
check("action outcomes = the ledger's statuses", set(qa.ACTION_OUTCOMES) == set(portal_actions.RUN_STATUSES))

print("== HTTP guards (no database touched) ==")
app = Flask(__name__)
app.register_blueprint(qa.bp)
client = app.test_client()
URL = "/api/v1/portal/analytics/ai-automation"
current = {"p": None, "exc": None}


def fake_auth():
    if current["exc"]:
        raise current["exc"]
    return current["p"]


qa.authenticate_portal_request = fake_auth
db_calls = []
real_conn = portal_db._conn
portal_db._conn = lambda: db_calls.append(1) or (_ for _ in ()).throw(RuntimeError("db down"))
owner = {"client_id": 7, "user_id": 1, "role": "owner", "via_api_key": False}
check("no session -> 401", client.get(URL).status_code == 401)
current["exc"] = PortalAuthUnavailable("auth down")
check("auth unavailable -> 503", client.get(URL).status_code == 503)
current["exc"] = None
current["p"] = dict(owner, via_api_key=True)
check("API key -> 403 (team members only)", client.get(URL).status_code == 403)
current["p"] = owner
for bad in ("0", "91", "abc", "7.5", "-3", "1e1"):
    response = client.get(URL + "?days=" + bad)
    check("days=" + bad + " -> 400 bad_request", response.status_code == 400
          and response.get_json()["error"]["code"] == "bad_request", response.get_json())
check("bad requests never reach the database", not db_calls)
response = client.get(URL + "?days=7")
check("database down -> 503 portal_unavailable (no internals leaked)", response.status_code == 503
      and response.get_json()["error"]["code"] == "portal_unavailable"
      and "db down" not in json.dumps(response.get_json()), response.get_json())
portal_db._conn = real_conn


def run_db():
    try:
        import pgserver
        import psycopg2
    except Exception:
        print("pgserver missing - database half skipped")
        return
    print("== real database (pgserver) ==")
    data = tempfile.mkdtemp(prefix="quad240_")
    server = pgserver.get_server(data, cleanup_mode="stop")  # noqa: F841
    os.environ.update({"DB_HOST": data, "DB_PORT": "5432", "DB_NAME": "postgres", "DB_USER": "postgres",
                       "DB_PASSWORD": "", "PGSSLMODE": "disable"})
    portal_db._ensured = False
    portal_db.ensure_tables()

    def sql(query, args=(), fetch=True):
        c = psycopg2.connect(host=data, dbname="postgres", user="postgres")
        try:
            cur = c.cursor()
            cur.execute(query, args)
            out = cur.fetchall() if fetch and cur.description else None
            c.commit()
            return out
        finally:
            c.close()

    def get(days=None):
        response = client.get(URL + ("" if days is None else "?days=" + str(days)))
        return response.status_code, response.get_json()

    # --- fresh database: no engine ledgers yet ---
    code, fresh = get()
    blocks = [fresh["ai"]["answers"], fresh["ai"]["usage"], fresh["automation"]["workflows"],
              fresh["automation"]["actions"], fresh["automation"]["sequences"]]
    check("fresh db: 200, every block unavailable with zeros", code == 200
          and all(block["available"] is False for block in blocks)
          and fresh["ai"]["answers"]["automatic"] == 0 and fresh["automation"]["workflows"]["runs"] == 0
          and fresh["ai"]["usage"]["cost_usd"] is None, fresh)
    check("fresh db: read-only (no ledger table created)",
          sql("SELECT to_regclass('portal_brain_traces'), to_regclass('portal_action_runs')")[0] == (None, None))
    check("fresh db: bands + window echoed", fresh["days"] == 30
          and fresh["ai"]["confidence_bands"] == {"high_from": 0.8, "low_below": 0.6}
          and isinstance(fresh["generated_at"], str))

    import portal_brain
    import portal_ai_usage
    import portal_workflows
    import portal_agents
    import portal_sequences
    c = psycopg2.connect(host=data, dbname="postgres", user="postgres")
    with c.cursor() as cur:
        for module in (portal_brain, portal_ai_usage, portal_workflows, portal_agents):
            module._DDL_READY = False
            module._ensure_ddl(cur)
        portal_actions._RUNS_DDL_READY = False
        portal_actions._ensure_runs_ddl(cur)
    c.commit()
    portal_sequences._SEQ_DDL_READY = False
    portal_sequences._ensure_seq_tables(c)
    c.commit()
    c.close()

    sana = sql("INSERT INTO portal_agents (client_id, name) VALUES (7, 'Sana') RETURNING id")[0][0]
    foreign_agent = sql("INSERT INTO portal_agents (client_id, name) VALUES (8, 'Spy') RETURNING id")[0][0]

    def trace(client_id, kind, decision, days_ago, confidence=None, tools=(), agent=None, reason=None):
        grounding = {"tools": list(tools)}
        if confidence is not None:
            grounding["confidence"] = confidence
        if agent is not None:
            grounding["agent_id"] = agent
        if reason:
            grounding["reason"] = reason
        sql("INSERT INTO portal_brain_traces (client_id, conversation_id, kind, decision, grounding, created_at)"
            " VALUES (%s, 1, %s, %s, CAST(%s AS JSONB), NOW() - make_interval(days => %s))",
            (client_id, kind, decision, json.dumps(grounding), days_ago), fetch=False)

    trace(7, "ingest_answer", "send", 2, confidence=0.9, tools=["search_kb", "agent_persona"], agent=sana)
    trace(7, "voice_answer", "send", 1, confidence=0.85, tools=["business_facts"], agent=sana)
    trace(7, "ingest_answer", "handoff", 3, confidence=0.3, reason="low_confidence")
    trace(7, "ingest_answer", "handoff", 4, tools=["search_kb"], reason="policy:refund")
    trace(7, "ingest_answer", "handoff", 5, confidence=0.7, tools=["customer_orders"], agent=foreign_agent,
          reason="needs_human")
    trace(7, "draft", "send", 2, confidence=0.65, tools=["search_kb"])
    trace(7, "draft", "handoff", 2, confidence=0.2)
    trace(7, "ingest_answer", "send", 40, confidence=0.1, tools=["search_kb"])
    trace(7, "ingest_answer", "handoff", 40, tools=["search_kb"], reason="output_guard:phone")
    for _ in range(3):  # foreign workspace, SAME agent id as ours
        trace(8, "ingest_answer", "send", 1, confidence=0.95, tools=["search_kb"], agent=sana)
    trace(8, "ingest_answer", "handoff", 1, reason="error")

    def usage(client_id, feature, ok, days_ago, agent=None, p_tok=100, c_tok=50, latency=300):
        sql("INSERT INTO portal_ai_usage (client_id, feature, model, prompt_tokens, completion_tokens, latency_ms,"
            " ok, agent_id, created_at) VALUES (%s, %s, 'm1', %s, %s, %s, %s, %s, NOW() - make_interval(days => %s))",
            (client_id, feature, p_tok, c_tok, latency, ok, agent, days_ago), fetch=False)

    usage(7, "brain", True, 1, agent=sana)
    usage(7, "brain", True, 2, agent=sana)
    usage(7, "workflow", False, 3, p_tok=10, c_tok=0, latency=100)
    usage(7, "brain", True, 40)
    usage(8, "brain", True, 1, agent=sana)

    def workflow(client_id, name):
        return sql("INSERT INTO portal_workflows (client_id, name, status) VALUES (%s, %s, 'active') RETURNING id",
                   (client_id, name))[0][0]

    welcome, rescue, spy_flow = workflow(7, "Welcome"), workflow(7, "Cart rescue"), workflow(8, "Spy flow")
    run_no = [0]

    def run(client_id, workflow_id, status, days_ago=1, error=None):
        run_no[0] += 1
        sql("INSERT INTO portal_workflow_runs (client_id, workflow_id, event_key, status, steps_done, last_error,"
            " started_at, finished_at) VALUES (%s, %s, %s, %s, 1, %s, NOW() - make_interval(days => %s),"
            " CASE WHEN %s IN ('completed', 'goal_reached', 'stopped', 'failed') THEN NOW() END)",
            (client_id, workflow_id, "k" + str(run_no[0]), status, error, days_ago, status), fetch=False)

    for status in ("goal_reached", "goal_reached", "running"):
        run(7, welcome, status)
    run(7, welcome, "failed", error="x" * 300)
    for status in ("waiting_approval", "waiting", "completed", "stopped"):
        run(7, rescue, status)
    run(7, spy_flow, "completed")  # our run pointing at another workspace's workflow id
    run(7, welcome, "failed", days_ago=40, error="old")
    run(8, welcome, "failed", error="foreign")  # other workspace's run on our workflow id
    run(8, spy_flow, "goal_reached")

    def action(client_id, actor, status, days_ago=1):
        sql("INSERT INTO portal_action_runs (client_id, action, actor, status, created_at)"
            " VALUES (%s, 'tag', %s, %s, NOW() - make_interval(days => %s))",
            (client_id, actor, status, days_ago), fetch=False)

    for actor, status in (("brain", "executed"), ("agent:3", "approval_required"), ("workflow:5", "executed"),
                          ("workflow:5", "error"), ("approval", "denied"), ("owner@shop.pk", "executed"),
                          ("ai_assistant", "running")):
        action(7, actor, status)
    action(7, "brain", "executed", days_ago=40)
    action(8, "brain", "executed")
    action(8, "approval", "denied")

    seq = sql("INSERT INTO portal_sequences (client_id, name) VALUES (7, 'Drip') RETURNING id")[0][0]
    foreign_seq = sql("INSERT INTO portal_sequences (client_id, name) VALUES (8, 'Spy drip') RETURNING id")[0][0]

    def enrol(client_id, sequence_id, conversation_id, status, days_ago=1):
        return sql("INSERT INTO portal_sequence_enrollments (client_id, sequence_id, conversation_id, contact_id,"
                   " status, enrolled_at) VALUES (%s, %s, %s, 'c', %s, NOW() - make_interval(days => %s))"
                   " RETURNING id", (client_id, sequence_id, conversation_id, status, days_ago))[0][0]

    enrolments = [enrol(7, seq, n, status) for n, status in
                  enumerate(("active", "completed", "stopped", "cancelled", "paused"), 1)]
    old_enrolment = enrol(7, seq, 99, "active", days_ago=40)
    foreign_enrolment = enrol(8, foreign_seq, 1, "active")

    def step(client_id, sequence_id, enrolment, action_name, days_ago=1):
        sql("INSERT INTO portal_sequence_step_log (client_id, sequence_id, enrollment_id, step_no, action,"
            " created_at) VALUES (%s, %s, %s, 1, %s, NOW() - make_interval(days => %s))",
            (client_id, sequence_id, enrolment, action_name, days_ago), fetch=False)

    for name in ("sent", "sent", "sent", "skipped", "stopped"):
        step(7, seq, enrolments[0], name)
    step(7, seq, old_enrolment, "sent", days_ago=40)
    step(8, foreign_seq, foreign_enrolment, "sent")

    code, body = get()
    check("db: 200, every block available", code == 200 and all(
        block["available"] for block in (body["ai"]["answers"], body["ai"]["usage"],
                                         body["automation"]["workflows"], body["automation"]["actions"],
                                         body["automation"]["sequences"])), body)
    answers = body["ai"]["answers"]
    check("db: automatic answers = ingest + voice, sent vs handed off (tenant + window)",
          answers["automatic"] == 5 and answers["sent"] == 2 and answers["handed_off"] == 3
          and answers["sent_share"] == 0.4, answers)
    check("db: drafts + usable drafts", answers["drafts"] == 2 and answers["drafts_usable"] == 1, answers)
    check("db: confidence bands (unscored trace not counted)", answers["confidence"] ==
          {"average": 0.6, "scored": 6, "high": 2, "ok": 2, "low": 2}, answers["confidence"])
    check("db: answers with no tool", answers["no_tool"] == 2, answers["no_tool"])
    check("db: tools ranked, labelled, share of all traces",
          [(t["key"], t["count"]) for t in answers["tools"]] ==
          [("search_kb", 3), ("agent_persona", 1), ("business_facts", 1), ("customer_orders", 1)]
          and answers["tools"][0]["label"] == "Knowledge base" and answers["tools"][0]["share"] == 0.429,
          answers["tools"])
    check("db: handoff reasons grouped (policy:x -> policy), labelled, window kept",
          [(r["reason"], r["count"]) for r in answers["reasons"]] ==
          [("low_confidence", 1), ("needs_human", 1), ("policy", 1)]
          and answers["reasons"][2]["label"] == "Blocked by a business rule", answers["reasons"])
    agents = {row["name"]: row for row in answers["agents"]}
    check("db: per agent answers (foreign rows on the same agent id not counted)",
          agents["Sana"]["answers"] == 2 and agents["Sana"]["sent"] == 2 and agents["Sana"]["handed_off"] == 0
          and agents["Sana"]["avg_confidence"] == 0.875 and agents["Sana"]["agent_id"] == sana, agents)
    check("db: unattributed answers = Default assistant", agents["Default assistant"]["agent_id"] is None
          and agents["Default assistant"]["answers"] == 2 and agents["Default assistant"]["avg_confidence"] == 0.3,
          agents)
    check("db: another workspace's agent name never shown",
          "Spy" not in agents and agents["Agent #" + str(foreign_agent)]["answers"] == 1, list(agents))
    check("db: per agent AI calls from the usage ledger", agents["Sana"]["calls"] == 2
          and agents["Default assistant"]["calls"] == 1, agents)
    use = body["ai"]["usage"]
    check("db: engine usage totals (tenant + window)", use["calls"] == 3 and use["failed"] == 1
          and use["fail_share"] == 0.333 and use["tokens"] == 310 and use["avg_latency_ms"] == 233, use)
    check("db: top features labelled", [f["feature"] for f in use["features"]] == ["brain", "workflow"]
          and use["features"][0]["label"] == "AI Brain answers & drafts" and use["features"][0]["calls"] == 2, use)
    check("db: no prices -> no cost (never invented)", use["cost_usd"] is None and use["priced"] is False
          and all(row["cost_usd"] is None for row in answers["agents"]), use)
    check("db: internal agent list not leaked", "_by_agent" not in use)

    flows = body["automation"]["workflows"]
    check("db: workflow runs by outcome (tenant + window)", flows["runs"] == 9 and flows["goal_reached"] == 2
          and flows["completed"] == 2 and flows["stopped"] == 1 and flows["failed"] == 1
          and flows["in_progress"] == 2 and flows["waiting_approval"] == 1 and flows["steps"] == 9, flows)
    check("db: goal + failure shares", flows["goal_share"] == 0.222 and flows["failure_share"] == 0.111, flows)
    check("db: busiest workflows (ties by name), foreign workflow name hidden",
          [(t["name"], t["runs"]) for t in flows["top"]] ==
          [("Cart rescue", 4), ("Welcome", 4), ("Workflow #" + str(spy_flow), 1)]
          and flows["top"][1]["goal_reached"] == 2 and flows["top"][1]["failed"] == 1, flows["top"])
    check("db: latest failures (ours, in window, error trimmed to 200)", len(flows["failures"]) == 1
          and flows["failures"][0]["name"] == "Welcome" and flows["failures"][0]["error"] == "x" * 200
          and flows["failures"][0]["workflow_id"] == welcome and isinstance(flows["failures"][0]["at"], str),
          flows["failures"])

    acts = body["automation"]["actions"]
    check("db: actions by outcome (tenant + window)", acts["total"] == 7 and acts["by_outcome"] ==
          {"executed": 3, "approval_required": 1, "denied": 1, "error": 1, "running": 1}, acts)
    check("db: actions by who started them", acts["by_actor"] ==
          {"ai": 3, "workflow": 2, "approval": 1, "person": 1}, acts)
    check("db: kept days = the ledger's retention", acts["kept_days"] == portal_actions.RUNS_KEEP_DAYS == 30, acts)

    seqs = body["automation"]["sequences"]
    check("db: sequences (unenrolled counts as stopped; tenant + window)", {k: v for k, v in seqs.items()
          if k != "available"} == {"enrolled": 5, "active": 1, "completed": 1, "stopped": 2, "paused": 1,
                                   "sent": 3, "skipped": 1}, seqs)

    code, wide = get(60)
    check("db: wider window includes older rows", wide["ai"]["answers"]["automatic"] == 7
          and "output_guard" in [row["reason"] for row in wide["ai"]["answers"]["reasons"]]
          and wide["ai"]["usage"]["calls"] == 4 and wide["automation"]["workflows"]["runs"] == 10
          and wide["automation"]["actions"]["total"] == 8 and wide["automation"]["sequences"]["enrolled"] == 6,
          wide)
    code, narrow = get(1)
    check("db: 1-day window", code == 200 and narrow["days"] == 1
          and narrow["ai"]["usage"]["calls"] <= 1, narrow["ai"]["usage"])

    os.environ["OF_AI_PRICES_JSON"] = json.dumps({"m1": {"input": 10, "output": 20}})
    code, priced = get()
    check("db: with prices -> estimated cost", priced["ai"]["usage"]["priced"] is True
          and abs(priced["ai"]["usage"]["cost_usd"] - 0.0041) < 1e-6, priced["ai"]["usage"])
    priced_agents = {row["name"]: row for row in priced["ai"]["answers"]["agents"]}
    check("db: with prices -> cost per agent", abs(priced_agents["Sana"]["cost_usd"] - 0.004) < 1e-6
          and abs(priced_agents["Default assistant"]["cost_usd"] - 0.0001) < 1e-6
          and priced_agents["Agent #" + str(foreign_agent)]["cost_usd"] is None, priced_agents)
    os.environ.pop("OF_AI_PRICES_JSON")

    current["p"] = {"client_id": 7, "user_id": 3, "role": "agent", "via_api_key": False}
    code, as_agent = get(14)
    check("db: team member (agent role) can read", code == 200 and as_agent["days"] == 14)
    current["p"] = {"client_id": 8, "user_id": 9, "role": "owner", "via_api_key": False}
    code, other = get()
    check("db: other workspace sees only its own", other["ai"]["answers"]["automatic"] == 4
          and other["automation"]["actions"]["total"] == 2 and other["automation"]["workflows"]["runs"] == 2
          and other["automation"]["sequences"]["enrolled"] == 1, other)
    current["p"] = owner

    # --- broken / missing ledgers fail soft, one block at a time ---
    sql("ALTER TABLE portal_action_runs RENAME COLUMN actor TO actor_old", fetch=False)
    sql("ALTER TABLE portal_sequence_step_log RENAME TO portal_sequence_step_log_old", fetch=False)
    code, soft = get()
    check("db: broken actions ledger -> that block unavailable, zeros", code == 200
          and soft["automation"]["actions"]["available"] is False and soft["automation"]["actions"]["total"] == 0
          and soft["automation"]["actions"]["kept_days"] == 30, soft["automation"]["actions"])
    check("db: missing step log -> sequences unavailable", soft["automation"]["sequences"]["available"] is False)
    check("db: the other blocks still answer after a failed block", soft["ai"]["answers"]["automatic"] == 5
          and soft["automation"]["workflows"]["runs"] == 9 and soft["ai"]["usage"]["calls"] == 3, soft)
    sql("ALTER TABLE portal_action_runs RENAME COLUMN actor_old TO actor", fetch=False)
    sql("ALTER TABLE portal_sequence_step_log_old RENAME TO portal_sequence_step_log", fetch=False)
    sql("DROP TABLE portal_agents", fetch=False)
    code, no_agents = get()
    names = [row["name"] for row in no_agents["ai"]["answers"]["agents"]]
    check("db: agents table missing -> answers + usage still there, names fall back",
          code == 200 and no_agents["ai"]["answers"]["available"] and no_agents["ai"]["usage"]["available"]
          and no_agents["ai"]["usage"]["calls"] == 3 and "Agent #" + str(sana) in names, names)
    before = sql("SELECT COUNT(*) FROM portal_brain_traces")[0][0]
    get()
    check("db: read-only (no rows written)", sql("SELECT COUNT(*) FROM portal_brain_traces")[0][0] == before)


run_db()
sys.exit(1 if summary("ai_automation") else 0)
