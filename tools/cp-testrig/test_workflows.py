"""Tests for the Workflow engine v1: portal_workflows (validation,
triggers, runner, approvals, owner API), the shared action-registry
additions, connector wiring, Rules-hub family + web pins (BFF, portal.ts,
Workflows page, sidebar)."""
import json
import os

from flask import Flask

import portal_actions
import portal_approvals
import portal_llm
import portal_workflows
from test_lib import install_db_stub
from test_lib import check, summary

PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}
API_KEY_PRINCIPAL = {"via_api_key": True, "client_id": 1, "user_id": 1}

WF_MSG = {"id": 31, "name": "Refund triage", "trigger_type": "message_received",
          "trigger_config": {"keyword": "refund",
                             "once_per_conversation": True},
          "stop_on_reply": False, "last_log_id": 0}
WF_NEW = {"id": 32, "name": "Welcome", "trigger_type": "contact_created",
          "trigger_config": {}, "stop_on_reply": True, "last_log_id": 0}
WF_STAGE = {"id": 33, "name": "Won", "trigger_type": "stage_changed",
            "trigger_config": {"stage": "won"}, "stop_on_reply": False,
            "last_log_id": 10}
WF_COD = {"id": 34, "name": "COD declined", "trigger_type": "cod_declined",
          "trigger_config": {}, "stop_on_reply": True, "last_log_id": 10}

RUN = {"id": 501, "workflow_id": 31, "conversation_id": 77,
       "contact_id": "923001234567", "contact_name": "Ali Khan",
       "current_step": 1, "steps_done": 0,
       "context": {"event": "message_received", "text": "refund please",
                   "conversation_id": 77, "contact_id": "923001234567",
                   "contact_name": "Ali Khan",
                   "intelligence": {"intent": "refund",
                                    "sentiment": "negative"}}}


def step(no, kind, **config):
    return {"step_no": no, "kind": kind, "label": kind, "config": config}


COND_REFUND = {"all": [{"field": "keyword", "op": "contains",
                        "value": "refund"}]}
COND_VIP = {"all": [{"field": "keyword", "op": "contains", "value": "vip"}]}


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
    portal_workflows._DDL_READY = True
    import portal_escalation

    portal_escalation._DDL_READY = True
    return install_db_stub(portal_workflows, script)


def run_api(script, method, path, json_body=None, principal=PRINCIPAL):
    fresh(script)
    app = Flask("workflows-test")
    app.register_blueprint(portal_workflows.bp)
    with PrincipalStub(portal_workflows, principal):
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


# business hours lookup is exercised elsewhere; keep the runner scripts tight
import connector_api  # noqa: E402

connector_api._load_business_hours = lambda cur, client_id: {}
connector_api._away_closed_now = lambda config: False


# ---------- catalog + validation (no DB) ----------

print("== catalog + validation ==")
triggers = {t["trigger"]: t for t in portal_workflows.trigger_catalog()}
check("8 triggers", len(triggers) == 8, sorted(triggers))
check("trigger sources", triggers["message_received"]["source"] == "ingest"
      and triggers["stage_changed"]["source"] == "log"
      and triggers["manual"]["source"] == "manual", triggers)
actions = {a["action"]: a for a in portal_workflows.action_catalog()}
check("registry grew to 15 (shared, not a workflow dialect)",
      len(actions) == 15 and "add_conversation_tag" in actions
      and "set_pipeline_stage" in actions and "enroll_in_sequence" in actions
      and "assign_agent" in actions and "assign_conversation" in actions,
      sorted(actions))
check("new actions are MEDIUM risk", all(
    actions[n]["risk"] == "medium" for n in (
        "add_conversation_tag", "assign_conversation", "assign_agent",
        "set_pipeline_stage", "enroll_in_sequence")), actions)
check("9 step kinds (D6 node list)", set(portal_workflows.STEP_KINDS) == {
    "condition", "branch", "ai_decision", "action", "wait", "approval",
    "handoff", "goal", "stop"}, portal_workflows.STEP_KINDS)

tpls = portal_workflows.templates()
check("21 templates across 7 verticals validate", len(tpls) == 21 and all(
    portal_workflows.validate_steps(t["steps"])[1] is None
    and portal_workflows.validate_trigger(
        t["trigger_type"], t["trigger_config"])[2] is None
    for t in tpls), [t["key"] for t in tpls])
check("template keys + names unique", len({t["key"] for t in tpls}) == 21
      and len({t["name"] for t in tpls}) == 21, "-")
check("vertical tags (D4: general + ecommerce + local business first)",
      [v["key"] for v in portal_workflows.template_verticals()] == [
          "general", "ecommerce", "salon", "clinic", "restaurant",
          "real_estate", "education"]
      and portal_workflows.template_verticals()[1]["label"]
      == "E-commerce store"
      and len(portal_workflows.templates("ecommerce")) == 4
      and len(portal_workflows.templates("salon")) == 3
      and len(portal_workflows.templates("general")) == 4
      and portal_workflows.templates("nope") == [],
      portal_workflows.template_verticals())
check("every template ends in a goal (measurable outcome)", all(
    t["steps"][-1]["kind"] == "goal" for t in tpls), "-")


def _rule_values_are_strings(step):
    rules = step["config"].get("rules") or {}
    for group in ("all", "any"):
        for cond in rules.get(group) or []:
            if not isinstance(cond.get("value"), str):
                return False
    return True


check("template rule values are strings (builder round-trip contract)", all(
    _rule_values_are_strings(step) for t in tpls for step in t["steps"]
    if step["kind"] in ("condition", "branch")), "-")
check("template waits use minutes (canonical) and stay in range", all(
    isinstance(step["config"].get("minutes"), int)
    and 1 <= step["config"]["minutes"] <= portal_workflows.MAX_WAIT_MINUTES
    and "hours" not in step["config"]
    for t in tpls for step in t["steps"] if step["kind"] == "wait"), "-")
check("normalize_definition normalises a template without Flask",
      portal_workflows.normalize_definition(tpls[0])[1] is None
      and portal_workflows.normalize_definition({"name": ""})[1]
      is not None, "-")

steps, err = portal_workflows.validate_steps([
    {"kind": "condition", "config": {"rules": COND_REFUND, "else": "skip"}},
    {"kind": "action", "config": {"action": "queue_whatsapp_message",
                                  "args": {"body": "hi {first_name}"}}},
    {"kind": "wait", "config": {"hours": 1.5}},
    {"kind": "ai_decision", "config": {"question": "Refund?"}},
    {"kind": "approval", "config": {"summary": "Send discount"}},
    {"kind": "handoff", "config": {"user_id": 9, "note": "VIP"}},
    {"kind": "goal", "config": {"name": "done"}},
    {"kind": "stop"},
])
check("valid steps normalised", err is None and len(steps) == 8
      and steps[0]["step_no"] == 1 and steps[2]["config"]["minutes"] == 90
      and steps[3]["config"]["fallback"] == "no"
      and steps[3]["config"]["else"] == "stop"
      and steps[5]["config"]["user_id"] == 9, (err, steps))
check("wait > 7 days rejected", portal_workflows.validate_steps(
    [{"kind": "wait", "config": {"hours": 200}}])[1] is not None, "-")
check("wait 0 rejected", portal_workflows.validate_steps(
    [{"kind": "wait", "config": {"minutes": 0}}])[1] is not None, "-")
check("unknown action rejected", portal_workflows.validate_steps(
    [{"kind": "action", "config": {"action": "rm_rf"}}])[1] is not None, "-")
check("empty rules rejected", portal_workflows.validate_steps(
    [{"kind": "condition", "config": {"rules": {"all": []}}}])[1]
      is not None, "-")
check("too many conditions rejected", portal_workflows.validate_steps(
    [{"kind": "condition", "config": {"rules": {"all": [
        {"field": "keyword", "op": "contains", "value": str(i)}
        for i in range(11)]}}}])[1] is not None, "-")
check("else goto out of range rejected", portal_workflows.validate_steps(
    [{"kind": "condition", "config": {"rules": COND_REFUND, "else": 9}}])[1]
      is not None, "-")
check("else goto in range ok", portal_workflows.validate_steps(
    [{"kind": "condition", "config": {"rules": COND_REFUND, "else": 2}},
     {"kind": "stop"}])[1] is None, "-")
check("unknown kind rejected", portal_workflows.validate_steps(
    [{"kind": "teleport"}])[1] is not None, "-")
check("max steps enforced", portal_workflows.validate_steps(
    [{"kind": "stop"}] * 13)[1] is not None, "-")
check("ai_decision needs question", portal_workflows.validate_steps(
    [{"kind": "ai_decision", "config": {}}])[1] is not None, "-")
check("goal needs name", portal_workflows.validate_steps(
    [{"kind": "goal", "config": {}}])[1] is not None, "-")
check("handoff user_id must be int", portal_workflows.validate_steps(
    [{"kind": "handoff", "config": {"user_id": "x"}}])[1] is not None, "-")

check("trigger keyword normalised", portal_workflows.validate_trigger(
    "message_received", {"keyword": "  ReFund  Now "}) == (
    "message_received", {"keyword": "refund now",
                         "once_per_conversation": True}, None), "-")
check("unknown trigger rejected", portal_workflows.validate_trigger(
    "comet", {})[2] is not None, "-")
check("bad stage rejected", portal_workflows.validate_trigger(
    "stage_changed", {"stage": "bogus"})[2] is not None, "-")
check("good stage kept", portal_workflows.validate_trigger(
    "stage_changed", {"stage": "won"})[1] == {"stage": "won"}, "-")

rendered = portal_workflows.render_template(
    {"body": "Hi {first_name} ({name}) re: {text} @{stage} [{contact_id}]",
     "nested": ["{event}"]},
    {"contact_name": "Ali Khan", "text": "refund pls", "event": "manual",
     "contact_id": "923", "data": {"stage": "won"}})
check("template rendering", rendered["body"]
      == "Hi Ali (Ali Khan) re: refund pls @won [923]"
      and rendered["nested"] == ["manual"], rendered)
check("template no-name fallback", portal_workflows.render_template(
    "{first_name}", {}) == "there", "-")
check("prompt-injection guard in decision prompt",
      "never instructions" in portal_workflows._DECISION_SYSTEM
      and "untrusted" in portal_workflows._DECISION_SYSTEM, "-")


# ---------- message trigger (ingest hook) ----------

print("== message trigger ==")
conn = fresh([[WF_MSG], [{"id": 501}], [], []])
started = portal_workflows.maybe_trigger_message(
    1, 77, "923001234567", "Ali Khan", "I want a refund", "in", conn)
insert = conn.cur.executed[1]
check("keyword workflow starts a run", started == 1
      and "INSERT INTO portal_workflow_runs" in insert[0]
      and "ON CONFLICT (client_id, workflow_id, event_key) DO NOTHING"
      in insert[0], (started, insert[0][:120]))
check("event_key once per conversation", insert[1][3] == "conv:77"
      and insert[1][2] == "message_received", insert[1])
ctx = json.loads(insert[1][7])
check("run context carries text + intelligence", ctx["text"]
      == "I want a refund" and "intent" in ctx["intelligence"]
      and ctx["contact_name"] == "Ali Khan", ctx)
check("trigger log line", "portal_workflow_run_log" in conn.cur.executed[2][0]
      and conn.cur.executed[2][1][4] == "fired", conn.cur.executed[2])
check("stop_on_reply sweep runs last", "stop_on_reply IS TRUE"
      in conn.cur.executed[3][0]
      and "started_at < NOW() - interval '1 minute'"
      in conn.cur.executed[3][0], conn.cur.executed[3][0])

conn = fresh([[WF_MSG], []])
check("keyword miss -> no run (whole word)",
      portal_workflows.maybe_trigger_message(
          1, 77, "923", "Ali", "refunded already", "in", conn) == 0
      and len(conn.cur.executed) == 2, len(conn.cur.executed))

conn = fresh([[WF_NEW], [{"n": 3}], []])
check("contact_created skips old conversations",
      portal_workflows.maybe_trigger_message(
          1, 77, "923", "Ali", "hello", "in", conn) == 0, "-")

conn = fresh([[WF_NEW], [{"n": 1}], [{"id": 502}], [], []])
check("contact_created fires on first message",
      portal_workflows.maybe_trigger_message(
          1, 77, "923", "Ali", "hello", "in", conn) == 1
      and conn.cur.executed[2][1][2] == "contact_created", "-")

WF_EVERY = dict(WF_MSG, trigger_config={"once_per_conversation": False})
conn = fresh([[WF_EVERY], [{"id": 503}], [], []])
portal_workflows.maybe_trigger_message(1, 77, "923", "Ali", "hi", "in", conn)
check("every-message key is unique", str(
    conn.cur.executed[1][1][3]).startswith("msg:77:"),
      conn.cur.executed[1][1][3])

conn = fresh([])
check("outbound never triggers", portal_workflows.maybe_trigger_message(
    1, 77, "923", "Ali", "hi", "out", conn) == 0
      and conn.cur.executed == [], "-")
conn = fresh([[]])
check("no active workflows -> 1 query", portal_workflows.maybe_trigger_message(
    1, 77, "923", "Ali", "hi", "in", conn) == 0
      and len(conn.cur.executed) == 1, "-")
conn = fresh([RuntimeError("db down")])
check("hook fail-soft", portal_workflows.maybe_trigger_message(
    1, 77, "923", "Ali", "hi", "in", conn) == 0, "-")

conn = fresh([[{"id": 501}]])
check("start_run dedupe returns id", portal_workflows.start_run(
    conn.cur, 1, 31, "manual", "k", {}) == 501, "-")
conn = fresh([[]])
check("start_run conflict -> None", portal_workflows.start_run(
    conn.cur, 1, 31, "manual", "k", {}) is None, "-")


# ---------- log-event triggers (poll) ----------

print("== log triggers ==")
STAGE_EVENT = {"id": 11, "action": "pipeline.stage_changed",
               "conversation_id": None,
               "note": "Contact moved to 'won': 923001234567.",
               "created_at": None}
conn = fresh([[WF_STAGE], [STAGE_EVENT],
              [{"id": 77, "contact_name": "Ali Khan"}], [{"id": 601}], [],
              []])
check("stage_changed fires from action log",
      portal_workflows.trigger_log_events(conn.cur, 1) == 1, "-")
scan = conn.cur.executed[1]
check("log scan ignores workflow-written rows + uses cursor",
      "actor_kind <> 'workflow'" in scan[0] and scan[1][2] == 10
      and scan[1][1] == ["pipeline.stage_changed"], scan)
run_ins = conn.cur.executed[3]
check("log run key + resolved contact", run_ins[1][3] == "log:11"
      and run_ins[1][4] == 77 and run_ins[1][5] == "923001234567"
      and json.loads(run_ins[1][7])["stage"] == "won", run_ins[1])
check("cursor advanced", "SET last_log_id" in conn.cur.executed[5][0]
      and conn.cur.executed[5][1][0] == 11, conn.cur.executed[5])

LOST = dict(STAGE_EVENT, id=12, note="Contact moved to 'lost': 923.")
conn = fresh([[WF_STAGE], [LOST], [{"id": 77, "contact_name": "A"}], []])
check("stage filter skips other stages",
      portal_workflows.trigger_log_events(conn.cur, 1) == 0
      and "SET last_log_id" in conn.cur.executed[3][0], "-")

COD_EVENT = {"id": 13, "action": "cod.declined", "conversation_id": 77,
             "note": "COD request 5 replied declined.", "created_at": None}
conn = fresh([[WF_COD], [COD_EVENT],
              [{"contact_id": "923", "contact_name": "Ali"}], [{"id": 602}],
              [], []])
check("cod_declined resolves via conversation",
      portal_workflows.trigger_log_events(conn.cur, 1) == 1
      and conn.cur.executed[3][1][4] == 77
      and conn.cur.executed[3][1][2] == "cod_declined", "-")

conn = fresh([[WF_COD], []])
check("no new events -> nothing", portal_workflows.trigger_log_events(
    conn.cur, 1) == 0 and len(conn.cur.executed) == 2, "-")
conn = fresh([[]])
check("no log workflows -> 1 query", portal_workflows.trigger_log_events(
    conn.cur, 1) == 0 and len(conn.cur.executed) == 1, "-")

conn = fresh([[{"contact_id": "923", "total": 1500}],
              [{"id": 78, "contact_name": "Sara"}]])
ctx = portal_workflows._ctx_from_log(conn.cur, 1, {
    "id": 20, "action": "payment.gateway_paid", "conversation_id": None,
    "note": "Gateway payment 1500 on link 44"})
check("payment ctx resolves link -> contact -> conversation",
      ctx and ctx["contact_id"] == "923" and ctx["conversation_id"] == 78
      and ctx["data"]["total"] == 1500.0 and conn.cur.executed[0][1][0] == 44,
      ctx)
conn = fresh([[{"contact_id": "923", "total": 900}],
              [{"id": 79, "contact_name": "S"}]])
ctx = portal_workflows._ctx_from_log(conn.cur, 1, {
    "id": 21, "action": "checkout.created", "conversation_id": None,
    "note": "Checkout link abcd1234 (900)"})
check("checkout ctx resolves token prefix", ctx and ctx["conversation_id"]
      == 79 and conn.cur.executed[0][1][1] == "abcd1234%", ctx)
conn = fresh([])
check("unparseable note -> None", portal_workflows._ctx_from_log(
    conn.cur, 1, {"id": 1, "action": "pipeline.stage_changed",
                  "note": "garbage"}) is None, "-")


# ---------- runner ----------

print("== runner ==")
STEPS_HAPPY = [
    step(1, "condition", rules=COND_REFUND, **{"else": "stop"}),
    step(2, "action", action="queue_whatsapp_message",
         args={"body": "Hi {first_name}"}),
    step(3, "wait", minutes=30),
    step(4, "goal", name="done"),
]
# action steps resolve the conversation's AI persona first (permission
# envelope): one extra SELECT per action step, [] = no agent assigned.
conn = fresh([[], [], [], [], [], [], []])
status = portal_workflows.advance_run(conn.cur, 1, dict(RUN), STEPS_HAPPY)
check("condition -> action -> wait", status == "waiting", status)
check("action step resolves persona first",
      "portal_conversation_agents" in conn.cur.executed[1][0]
      and conn.cur.executed[1][1] == (1, 77), conn.cur.executed[1])
queued = conn.cur.executed[2]
check("action queued through the registry (opt-out aware)",
      "portal_connector_commands" in queued[0]
      and "portal_optouts" in queued[0]
      and '"body": "Hi Ali"' in queued[1][1], queued)
check("action audit line", "action.queue_whatsapp_message"
      in str(conn.cur.executed[3][1]), conn.cur.executed[3][1])
waiting = conn.cur.executed[6]
check("wait persists resume_at + next step", "make_interval(mins => %s)"
      in waiting[0] and waiting[1][:3] == (4, 3, 30), waiting)
logs = [e for e in conn.cur.executed if "portal_workflow_run_log" in e[0]]
check("one log line per step", [e[1][4] for e in logs]
      == ["matched", "executed", "waiting"], [e[1][4] for e in logs])

conn = fresh([[], []])
status = portal_workflows.advance_run(conn.cur, 1, dict(RUN), [
    step(1, "condition", rules=COND_VIP), step(2, "goal", name="x")])
check("condition miss -> stopped (else stop)", status == "stopped"
      and "SET status = %s" in conn.cur.executed[1][0]
      and conn.cur.executed[1][1][0] == "stopped", status)

conn = fresh([[], [], []])
status = portal_workflows.advance_run(conn.cur, 1, dict(RUN), [
    step(1, "condition", rules=COND_VIP, **{"else": "skip"}),
    step(2, "action", action="queue_whatsapp_message", args={"body": "vip"}),
    step(3, "goal", name="reached")])
check("else skip jumps over the next step to goal", status == "goal_reached"
      and conn.cur.executed[2][1][0] == "goal_reached"
      and conn.cur.executed[2][1][4] == "reached", conn.cur.executed)

conn = fresh([[], [], []])
status = portal_workflows.advance_run(conn.cur, 1, dict(RUN), [
    step(1, "branch", rules=COND_VIP, **{"else": 2}),
    step(2, "stop")])
check("branch else goto step 2 -> stop", status == "stopped"
      and conn.cur.executed[0][1][2] == 1
      and conn.cur.executed[0][1][4] == "not_matched"
      and conn.cur.executed[1][1][2] == 2
      and conn.cur.executed[1][1][3] == "stop",
      conn.cur.executed)

conn = fresh([[], [], [{"id": 9}], [], [], []])
status = portal_workflows.advance_run(conn.cur, 1, dict(RUN), [
    step(1, "action", action="add_conversation_tag", args={"tag": " New Lead "})])
check("tag action + fall off the end -> completed", status == "completed"
      and conn.cur.executed[2][1][2] == "new lead"
      and conn.cur.executed[2][1][1] == 77, conn.cur.executed[2][1])

conn = fresh([[], [], []])
status = portal_workflows.advance_run(conn.cur, 1, dict(RUN), [
    step(1, "action", action="assign_conversation", args={})])
check("missing required arg -> run failed with detail", status == "failed"
      and "missing_args:assignee" in conn.cur.executed[1][1][5]
      and conn.cur.executed[2][1][0] == "failed", conn.cur.executed)

conn = fresh([[], RuntimeError("boom"), [], []])
status = portal_workflows.advance_run(conn.cur, 1, dict(RUN), [
    step(1, "action", action="queue_whatsapp_message", args={"body": "x"})])
check("db error inside a step -> failed, engine log", status == "failed"
      and conn.cur.executed[2][1][3] == "engine", conn.cur.executed[2][1])

# persona permission envelope: the assigned agent may not trigger this
# action -> denied (audited), run fails with a readable detail.
DENY_AGENT = [{"id": 7, "name": "Support Pro", "tone": "", "instructions": "",
               "escalation_user_id": None, "is_active": True, "updated_at": "",
               "allowed_actions": '["add_conversation_tag"]',
               "max_risk": "medium", "can_auto_reply": True}]
conn = fresh([DENY_AGENT, [], [], []])
status = portal_workflows.advance_run(conn.cur, 1, dict(RUN), [
    step(1, "action", action="queue_whatsapp_message", args={"body": "x"})])
check("agent permission denies action -> run failed", status == "failed"
      and "action.denied" in str(conn.cur.executed[1][1])
      and conn.cur.executed[2][1][4] == "denied"
      and "Support Pro" in conn.cur.executed[2][1][5]
      and "action_not_allowed" in conn.cur.executed[2][1][5],
      conn.cur.executed)
check("denied action never queued",
      not any("portal_connector_commands" in e[0] for e in conn.cur.executed),
      "no send")

_orig_create = portal_approvals.create_approval
portal_approvals.create_approval = lambda *a, **k: {"id": 88,
                                                    "ref_code": "AP-1"}
try:
    conn = fresh([[], [], []])
    status = portal_workflows.advance_run(conn.cur, 1, dict(RUN), [
        step(1, "action", action="request_refund", args={}),
        step(2, "goal", name="refund_routed")])
    check("HIGH-risk action -> approval gate, run waits", status
          == "waiting_approval" and conn.cur.executed[1][1][4]
          == "approval_required"
          and "approval_id = %s" in conn.cur.executed[2][0]
          and conn.cur.executed[2][1][2] == 88, conn.cur.executed)
    # permissions never bypass the approval gate: an agent allowed to
    # request refunds at max_risk high still lands in the approval queue.
    OK_AGENT = [{"id": 8, "name": "Ops", "tone": "", "instructions": "",
                 "escalation_user_id": None, "is_active": True,
                 "updated_at": "", "allowed_actions": None,
                 "max_risk": "high", "can_auto_reply": True}]
    conn = fresh([OK_AGENT, [], []])
    status = portal_workflows.advance_run(conn.cur, 1, dict(RUN), [
        step(1, "action", action="request_refund", args={}),
        step(2, "goal", name="refund_routed")])
    check("permitted HIGH-risk action still needs approval",
          status == "waiting_approval"
          and conn.cur.executed[1][1][4] == "approval_required",
          conn.cur.executed)
    LOW_AGENT = [dict(OK_AGENT[0], max_risk="medium")]
    conn = fresh([LOW_AGENT, [], [], []])
    status = portal_workflows.advance_run(conn.cur, 1, dict(RUN), [
        step(1, "action", action="request_refund", args={}),
        step(2, "goal", name="refund_routed")])
    check("max_risk medium blocks a HIGH-risk action", status == "failed"
          and "risk_above_max" in conn.cur.executed[2][1][5],
          conn.cur.executed)
    conn = fresh([[], []])
    status = portal_workflows.advance_run(conn.cur, 1, dict(RUN), [
        step(1, "approval", summary="Send {first_name} a discount"),
        step(2, "goal", name="x")])
    check("approval step waits on owner", status == "waiting_approval"
          and conn.cur.executed[1][1][2] == 88, conn.cur.executed)
    portal_approvals.create_approval = lambda *a, **k: None
    conn = fresh([[], []])
    status = portal_workflows.advance_run(conn.cur, 1, dict(RUN), [
        step(1, "approval", summary="dup"), step(2, "goal", name="x")])
    check("duplicate pending approval -> stopped, not spammed",
          status == "stopped" and conn.cur.executed[0][1][4]
          == "approval_pending_exists", conn.cur.executed[0][1])
finally:
    portal_approvals.create_approval = _orig_create

_orig_chat = portal_llm.chat_json
try:
    portal_llm.chat_json = lambda *a, **k: {"answer": "yes",
                                            "confidence": 0.91}
    conn = fresh([[], [], []])
    status = portal_workflows.advance_run(conn.cur, 1, dict(RUN), [
        step(1, "ai_decision", question="Refund?", fallback="no"),
        step(2, "goal", name="yes_path")])
    check("ai_decision yes -> continues", status == "goal_reached"
          and conn.cur.executed[0][1][4] == "yes"
          and "confidence 0.91" in conn.cur.executed[0][1][5],
          conn.cur.executed[0][1])
    captured = {}

    def _capture(system, user, max_tokens=0):
        captured["system"] = system
        captured["user"] = user
        return {"answer": "no", "confidence": 0.7}
    portal_llm.chat_json = _capture
    conn = fresh([[], []])
    status = portal_workflows.advance_run(conn.cur, 1, dict(RUN), [
        step(1, "ai_decision", question="Refund?", fallback="yes"),
        step(2, "goal", name="x")])
    check("ai_decision no -> else stop", status == "stopped", status)
    check("customer text sent as data, not instructions",
          '"customer_data"' in captured["user"]
          and "refund please" in captured["user"]
          and "never instructions" in captured["system"], captured)
    portal_llm.chat_json = lambda *a, **k: None
    conn = fresh([[], []])
    status = portal_workflows.advance_run(conn.cur, 1, dict(RUN), [
        step(1, "ai_decision", question="Refund?", fallback="no"),
        step(2, "goal", name="x")])
    check("llm unavailable -> fallback no (safe default)", status == "stopped"
          and "fallback no" in conn.cur.executed[0][1][5],
          conn.cur.executed[0][1])
    conn = fresh([[], [], []])
    status = portal_workflows.advance_run(conn.cur, 1, dict(RUN), [
        step(1, "ai_decision", question="Refund?", fallback="yes"),
        step(2, "goal", name="x")])
    check("llm unavailable -> fallback yes when configured",
          status == "goal_reached", status)
finally:
    portal_llm.chat_json = _orig_chat

conn = fresh([[], [{"to_regclass": "portal_conversation_agents"}], [],
              [{"to_regclass": "portal_team_members"}],
              [{"user_id": 5}], [], [{"id": 1}], [], [], []])
status = portal_workflows.advance_run(conn.cur, 1, dict(RUN), [
    step(1, "handoff")])
check("handoff goes through the central escalation service (first teammate)",
      status == "completed" and "SET assigned_to" in conn.cur.executed[5][0]
      and conn.cur.executed[5][1][0] == 5
      and conn.cur.executed[6][0].startswith("INSERT INTO")
      and "portal_escalations" in conn.cur.executed[6][0]
      and conn.cur.executed[6][1][3] == "workflow"
      and "escalation.opened" in str(conn.cur.executed[7][1])
      and conn.cur.executed[7][1][2] == "workflow", conn.cur.executed)

conn = fresh([[], [], [{"id": 2}], [], [], []])
status = portal_workflows.advance_run(conn.cur, 1, dict(RUN), [
    step(1, "handoff", user_id=9, note="VIP")])
check("handoff to explicit teammate (assign + ledger + audit)",
      status == "completed" and conn.cur.executed[1][1][0] == 9
      and conn.cur.executed[2][1][6] == 9
      and "escalation.opened" in str(conn.cur.executed[3][1])
      and "VIP" in str(conn.cur.executed[3][1]), conn.cur.executed)

conn = fresh([[]] * 11)
status = portal_workflows.advance_run(conn.cur, 1, dict(RUN), [
    step(i, "condition", rules=COND_REFUND) for i in range(1, 13)])
check("per-tick cap persists progress and yields", status == "running"
      and "SET current_step = %s, steps_done = %s" in conn.cur.executed[10][0]
      and conn.cur.executed[10][1][:2] == (11, 10), conn.cur.executed[10])

conn = fresh([[{"id": 5, "approval_id": 88, "current_step": 3,
                "decision": "approved"},
               {"id": 6, "approval_id": 89, "current_step": 2,
                "decision": "rejected"}], [], [], [], []])
check("approval resume: approved continues, rejected stops",
      portal_workflows.resume_approved_runs(conn.cur, 1) == 2
      and "SET status = 'running'" in conn.cur.executed[1][0]
      and conn.cur.executed[3][1][0] == "stopped"
      and conn.cur.executed[4][1][4] == "rejected", conn.cur.executed)

conn = fresh([[], [], [dict(RUN)], [step(1, "goal", name="g")], [], []])
count = portal_workflows.run_due_workflows(conn.cur, 1, conn)
check("poll pass advances due runs + commits", count == 1 and conn.committed
      and "w.status = 'active'" in conn.cur.executed[2][0], count)
conn = fresh([RuntimeError("x"), RuntimeError("x"), RuntimeError("x")])
check("poll pass fail-soft", portal_workflows.run_due_workflows(
    conn.cur, 1, conn) == 0, "-")
conn = fresh([[], [], []])
check("nothing due -> no commit", portal_workflows.run_due_workflows(
    conn.cur, 1, conn) == 0 and not conn.committed, "-")


# ---------- registry additions (direct) ----------

print("== registry additions ==")
conn = fresh([[{"to_regclass": 1}], [{"id": 3}]])
res = portal_actions._run_set_stage(conn.cur, 1, {
    "contact_id": "923", "stage": "won", "_actor": "workflow:31"})
check("set_pipeline_stage upserts + logs as workflow actor",
      res == {"stage": "won"} and "ON CONFLICT (client_id, contact_id)"
      in conn.cur.executed[0][0]
      and conn.cur.executed[1][1][2] == "workflow"
      and "moved to 'won': 923." in conn.cur.executed[1][1][5],
      conn.cur.executed)
try:
    portal_actions._run_set_stage(conn.cur, 1, {"contact_id": "9",
                                                "stage": "moon"})
    check("bad stage rejected", False, "no raise")
except ValueError as exc:
    check("bad stage rejected", str(exc) == "bad_stage", exc)
conn = fresh([[]])
try:
    portal_actions._run_assign_conversation(conn.cur, 1, {
        "conversation_id": 77, "assignee": "ghost@example.com"})
    check("unknown assignee rejected", False, "no raise")
except ValueError as exc:
    check("unknown assignee rejected", str(exc) == "assignee_not_found", exc)
conn = fresh([[{"id": 4}], [{"id": 12}]])
res = portal_actions._run_enroll_sequence(conn.cur, 1, {
    "conversation_id": 77, "sequence_id": 4})
check("enroll_in_sequence reuses sequence tables + NOT EXISTS",
      res["enrolled"] is True
      and "portal_sequence_enrollments" in conn.cur.executed[1][0]
      and "NOT EXISTS" in conn.cur.executed[1][0], conn.cur.executed[1][0])
conn = fresh([[]])
try:
    portal_actions._run_enroll_sequence(conn.cur, 1, {
        "conversation_id": 77, "sequence_id": 99})
    check("unknown sequence rejected", False, "no raise")
except ValueError as exc:
    check("unknown sequence rejected", str(exc) == "sequence_not_found", exc)
conn = fresh([[]])
try:
    portal_actions._run_assign_agent(conn.cur, 1, {"conversation_id": 77,
                                                   "agent_id": 7})
    check("inactive agent rejected", False, "no raise")
except ValueError as exc:
    check("inactive agent rejected", str(exc) == "agent_not_found", exc)
check("actor tagging helper", portal_actions._actor_kind(
    {"_actor": "workflow:3"}) == "workflow"
      and portal_actions._actor_kind({"_actor": "ahmed@x"}) == "system", "-")


# ---------- owner API ----------

print("== owner API ==")
r = run_api([], "GET", "/api/v1/portal/workflows/catalog")
body = r.get_json()
check("catalog 200", r.status_code == 200 and len(body["triggers"]) == 8
      and len(body["actions"]) == 15 and len(body["templates"]) == 21
      and body["limits"]["max_steps"] == 12, r.status_code)
check("catalog carries verticals + applied_vertical (fail-soft empty)",
      body["verticals"][0]["key"] == "general" and len(body["verticals"]) == 7
      and body["applied_vertical"] == "", body.get("applied_vertical"))
import portal_templates  # noqa: E402

conn = fresh([[], [{"vertical": "salon", "applied_at": "2026-01-01"}]])
portal_templates._DDL_READY = False
check("applied vertical read through portal_templates (DDL + select)",
      portal_workflows._applied_vertical(1) == "salon"
      and "portal_templates_applied" in conn.cur.executed[1][0], "-")
fresh([Exception("no table")])
portal_templates._DDL_READY = False
check("applied vertical fail-soft", portal_workflows._applied_vertical(1)
      == "", "-")

# ---- seed_templates (Setup-wizard hook) ----
print("== template seeding ==")
EDU = portal_workflows.templates("education")
conn = fresh([[{"name": EDU[1]["name"]}], [{"id": 71}], []]
             + [[]] * len(EDU[0]["steps"]) + [[], []])
created = portal_workflows.seed_templates(conn.cur, 1, "education", 11)
sqls = [e[0] for e in conn.cur.executed]
check("seeds only the missing template as a draft", created == 1
      and "'draft'" in sqls[1] and conn.cur.executed[1][1][1] == EDU[0]["name"],
      (created, sqls[1][:80]))
check("seed writes steps + version + audit", sqls[2].startswith("DELETE")
      and sum(1 for q in sqls if "portal_workflow_steps" in q
              and q.startswith("INSERT")) == len(EDU[0]["steps"])
      and any("portal_workflow_versions" in q for q in sqls)
      and any("workflow.saved" in json.dumps(e) and "Draft from template"
              in json.dumps(e) for e in conn.cur.executed), sqls)
conn = fresh([[{"name": t["name"]} for t in EDU]])
check("seeding is idempotent by name", portal_workflows.seed_templates(
    conn.cur, 1, "education") == 0 and len(conn.cur.executed) == 1, "-")
conn = fresh([[{"name": "w" + str(i)}
               for i in range(portal_workflows.MAX_WORKFLOWS)]])
check("seeding respects the workspace limit", portal_workflows.seed_templates(
    conn.cur, 1, "education") == 0, "-")
conn = fresh([])
check("unknown vertical seeds nothing (no SQL)", portal_workflows.seed_templates(
    conn.cur, 1, "nope") == 0 and conn.cur.executed == [], "-")
r = run_api([], "GET", "/api/v1/portal/workflows",
            principal=API_KEY_PRINCIPAL)
check("api key 403 (human-only)", r.status_code == 403, r.status_code)
r = run_api([], "POST", "/api/v1/portal/workflows", {"name": "x"},
            principal=API_KEY_PRINCIPAL)
check("api key 403 on create", r.status_code == 403, r.status_code)

VALID = {"name": "Refund triage", "description": "d",
         "trigger_type": "message_received",
         "trigger_config": {"keyword": "refund"},
         "stop_on_reply": True,
         "steps": [{"kind": "condition", "config": {"rules": COND_REFUND}},
                   {"kind": "goal", "config": {"name": "done"}}]}
r = run_api([[{"total": 2}], [{"id": 31}], [], [], [], [], []],
            "POST", "/api/v1/portal/workflows", VALID)
body = r.get_json()
check("create 200 draft + steps", r.status_code == 200
      and body["workflow"]["id"] == 31 and body["workflow"]["status"] == "draft"
      and len(body["workflow"]["steps"]) == 2
      and body["workflow"]["trigger_config"]["keyword"] == "refund", body)
conn = portal_workflows.portal_db.conn
check("create writes version 1 snapshot + audit",
      "portal_workflow_versions" in conn.cur.executed[5][0]
      and "workflow.saved" in str(conn.cur.executed[6][1])
      and json.loads(conn.cur.executed[5][1][2])["steps"][1]["kind"] == "goal",
      conn.cur.executed[5])
r = run_api([[{"total": 20}]], "POST", "/api/v1/portal/workflows", VALID)
check("create over limit 400", r.status_code == 400, r.status_code)
r = run_api([], "POST", "/api/v1/portal/workflows", dict(VALID, name=""))
check("create without name 400", r.status_code == 400, r.status_code)
r = run_api([], "POST", "/api/v1/portal/workflows",
            dict(VALID, trigger_type="comet"))
check("create unknown trigger 400", r.status_code == 400, r.status_code)
r = run_api([], "POST", "/api/v1/portal/workflows",
            dict(VALID, steps=[{"kind": "wait", "config": {"hours": 999}}]))
check("create bad step 400 with reason", r.status_code == 400
      and "step 1" in r.get_json()["error"]["message"], r.get_json())

r = run_api([[{"id": 31, "name": "A", "description": "", "status": "active",
               "trigger_type": "message_received",
               "trigger_config": {"keyword": "refund"},
               "stop_on_reply": False, "version": 3, "updated_at": "u"}],
             [{"workflow_id": 31, "total": 5, "live": 1, "goals": 3,
               "failed": 0, "last_run_at": "t"}],
             [{"workflow_id": 31, "steps": 4}]],
            "GET", "/api/v1/portal/workflows")
body = r.get_json()
check("list 200 with run stats + step count", r.status_code == 200
      and body["workflows"][0]["runs"]["goals"] == 3
      and body["workflows"][0]["steps"] == 4
      and body["workflows"][0]["version"] == 3, body)
check("list hides archived", "status <> 'archived'"
      in portal_workflows.portal_db.conn.cur.executed[0][0], "-")

r = run_api([[{"id": 31, "name": "A", "description": "", "status": "draft",
               "trigger_type": "manual", "trigger_config": {},
               "stop_on_reply": False, "version": 1, "updated_at": "u"}],
             [step(1, "goal", name="g")]],
            "GET", "/api/v1/portal/workflows/31")
body = r.get_json()
check("get 200 with steps", r.status_code == 200
      and body["workflow"]["steps"][0]["kind"] == "goal", body)
r = run_api([[]], "GET", "/api/v1/portal/workflows/31")
check("get 404", r.status_code == 404, r.status_code)

r = run_api([[{"version": 2}], [], [], [], [], []], "PUT",
            "/api/v1/portal/workflows/31", VALID)
check("update 200 bumps version + snapshot", r.status_code == 200
      and r.get_json()["version"] == 2
      and "ON CONFLICT (client_id, workflow_id, version)"
      in portal_workflows.portal_db.conn.cur.executed[4][0], r.get_json())
r = run_api([[]], "PUT", "/api/v1/portal/workflows/31", VALID)
check("update 404 + rollback", r.status_code == 404
      and portal_workflows.portal_db.conn.rolled_back, r.status_code)
r = run_api([], "PUT", "/api/v1/portal/workflows/31", dict(VALID, steps="x"))
check("update bad steps 400", r.status_code == 400, r.status_code)

r = run_api([[{"n": 2}], [{"id": 31}], []], "POST",
            "/api/v1/portal/workflows/31/status", {"status": "active"})
check("activate 200 + cursor to MAX(log id)", r.status_code == 200
      and "MAX(id) FROM portal_action_log"
      in portal_workflows.portal_db.conn.cur.executed[1][0], r.get_json())
r = run_api([[{"n": 0}]], "POST", "/api/v1/portal/workflows/31/status",
            {"status": "active"})
check("activate without steps 400", r.status_code == 400, r.status_code)
r = run_api([[{"id": 31}], []], "POST",
            "/api/v1/portal/workflows/31/status", {"status": "paused"})
check("pause 200", r.status_code == 200, r.status_code)
r = run_api([[]], "POST", "/api/v1/portal/workflows/31/status",
            {"status": "paused"})
check("pause 404 when not active", r.status_code == 404, r.status_code)
r = run_api([], "POST", "/api/v1/portal/workflows/31/status",
            {"status": "archived"})
check("status only active|paused", r.status_code == 400, r.status_code)

r = run_api([[{"id": 31}], [], []], "DELETE", "/api/v1/portal/workflows/31")
check("archive 200 soft + stops live runs", r.status_code == 200
      and "SET status = 'archived'"
      in portal_workflows.portal_db.conn.cur.executed[0][0]
      and "workflow_archived"
      in portal_workflows.portal_db.conn.cur.executed[1][0], r.get_json())
r = run_api([[]], "DELETE", "/api/v1/portal/workflows/31")
check("archive 404", r.status_code == 404, r.status_code)

r = run_api([[{"id": 501, "workflow_id": 31, "event": "manual",
               "conversation_id": 77, "contact_id": "923",
               "contact_name": "Ali", "status": "goal_reached",
               "current_step": 2, "steps_done": 2, "goal": "done",
               "last_error": None, "resume_at": None, "started_at": None,
               "finished_at": None}],
             [{"run_id": 501, "step_no": 0, "kind": "trigger",
               "outcome": "fired", "detail": "Manual", "created_at": None},
              {"run_id": 501, "step_no": 1, "kind": "goal",
               "outcome": "goal_reached", "detail": "done",
               "created_at": None}]],
            "GET", "/api/v1/portal/workflows/31/runs?limit=5")
body = r.get_json()
check("runs 200 with timeline", r.status_code == 200
      and body["runs"][0]["status"] == "goal_reached"
      and len(body["runs"][0]["log"]) == 2
      and body["runs"][0]["log"][1]["outcome"] == "goal_reached", body)

r = run_api([[{"id": 31, "name": "A", "status": "draft"}],
             [{"id": 77, "contact_id": "923", "contact_name": "Ali Khan",
               "last_text": "refund please"}],
             [{"id": 900}], [], [step(1, "goal", name="tested")], [], [],
             []],
            "POST", "/api/v1/portal/workflows/31/run",
            {"conversation_id": 77})
body = r.get_json()
check("manual run executes immediately", r.status_code == 200
      and body["run_id"] == 900 and body["status"] == "goal_reached", body)
check("manual run key + audit", str(
    portal_workflows.portal_db.conn.cur.executed[2][1][3]).startswith("manual:")
      and "workflow.manual_run"
      in str(portal_workflows.portal_db.conn.cur.executed[7][1]), "-")
r = run_api([], "POST", "/api/v1/portal/workflows/31/run", {})
check("manual run needs conversation_id", r.status_code == 400, r.status_code)
r = run_api([[]], "POST", "/api/v1/portal/workflows/31/run",
            {"conversation_id": 77})
check("manual run 404 workflow", r.status_code == 404, r.status_code)
r = run_api([[{"id": 31, "name": "A", "status": "draft"}], []], "POST",
            "/api/v1/portal/workflows/31/run", {"conversation_id": 77})
check("manual run 404 conversation", r.status_code == 404, r.status_code)


# ---------- wiring pins (CP + web) ----------

print("== wiring pins ==")
CONN = open("/tmp/smoke971/connector_api.py", encoding="utf8").read()
check("ingest hook wired after sequences", "portal_workflows.maybe_trigger_message("
      in CONN and CONN.index("maybe_auto_pause_replies(")
      < CONN.index("portal_workflows.maybe_trigger_message("), "-")
check("hook passes direction + conn", 'item["direction"],\n'
      in CONN.split("portal_workflows.maybe_trigger_message(")[1][:400], "-")
check("poll runner wired before requeue", "portal_workflows.run_due_workflows("
      in CONN and CONN.index("portal_workflows.run_due_workflows(")
      < CONN.index("portal_events.requeue_due_commands("), "-")
APP = open("/tmp/smoke971/app.py", encoding="utf8").read()
check("blueprint registered", "from portal_workflows import bp as"
      " portal_workflows_bp" in APP
      and "aux_app.register_blueprint(portal_workflows_bp)" in APP, "-")

import portal_policy  # noqa: E402

conn = install_db_stub(portal_policy, [[{"n": 1}], [{"n": 0}],
                                       [{"enabled": False}], [{}],
                                       [{"autonomy": "suggest"}],
                                       [{"n": 2}], [{"n": 0}]])
families = {f["ruleSet"]: f for f in portal_policy.rules_summary(
    conn.cursor(), 1)}
check("Rules hub shows the workflows family", "workflows" in families
      and families["workflows"]["href"] == "/dashboard/workflows"
      and families["workflows"]["count"] == 2, families.get("workflows"))

RIG13 = "/tmp/p13/Omniflow/"
LIB = open(RIG13 + "lib/omniflow/portal.ts", encoding="utf8").read()
check("portal.ts workflow helpers", all(token in LIB for token in (
    "export interface PortalWorkflow", "export interface WorkflowStep",
    "export interface WorkflowRun", "export async function listWorkflows",
    "export async function getWorkflowCatalog",
    "export async function createWorkflow",
    "export async function updateWorkflow",
    "export async function setWorkflowStatus",
    "export async function archiveWorkflow",
    "export async function listWorkflowRuns",
    "export async function runWorkflowNow")), "-")
check("portal.ts paths", 'api/v1/portal/workflows/catalog' in LIB
      and '"/status"' in LIB and '"/runs?limit="' in LIB
      and '"/run"' in LIB, "-")
BFF = "/tmp/smoke971/"
for name, tokens in (
        ("bff_workflows.ts", ("listWorkflows", "createWorkflow",
                              "export async function GET",
                              "export async function POST")),
        ("bff_workflows_id.ts", ("getWorkflow", "updateWorkflow",
                                 "archiveWorkflow",
                                 "export async function DELETE")),
        ("bff_workflows_status.ts", ("setWorkflowStatus",)),
        ("bff_workflows_runs.ts", ("listWorkflowRuns",)),
        ("bff_workflows_run.ts", ("runWorkflowNow", "conversation_id")),
        ("bff_workflows_catalog.ts", ("getWorkflowCatalog",))):
    path = BFF + name
    src = open(path, encoding="utf8").read() if os.path.exists(path) else ""
    check("BFF " + name, bool(src) and all(t in src for t in tokens)
          and "requirePortalAccessToken" in src, name)
BFF_SRC = open(BFF + "bff_workflows.ts", encoding="utf8").read() \
    if os.path.exists(BFF + "bff_workflows.ts") else ""
PAYLOAD_SRC = open(BFF + "workflow_payload.ts", encoding="utf8").read() \
    if os.path.exists(BFF + "workflow_payload.ts") else ""
check("BFF create validates shape server-side",
      "parseWorkflowPayload" in BFF_SRC and "MAX_NAME" in PAYLOAD_SRC
      and "MAX_STEPS" in PAYLOAD_SRC and "STEP_KINDS" in PAYLOAD_SRC
      and "400" in BFF_SRC, "-")
check("BFF [id] reuses the same payload guard (Next 16 params Promise)",
      "parseWorkflowPayload" in (open(BFF + "bff_workflows_id.ts",
                                      encoding="utf8").read()
                                 if os.path.exists(BFF + "bff_workflows_id.ts")
                                 else "")
      and "params: Promise<{ id: string }>" in (
          open(BFF + "bff_workflows_id.ts", encoding="utf8").read()
          if os.path.exists(BFF + "bff_workflows_id.ts") else ""), "-")
PAGE = BFF + "workflows_page.tsx"
CLIENT = BFF + "workflows_client.tsx"
page_src = open(PAGE, encoding="utf8").read() if os.path.exists(PAGE) else ""
client_src = open(CLIENT, encoding="utf8").read() \
    if os.path.exists(CLIENT) else ""
check("Workflows page mounts client", "WorkflowsClient" in page_src
      and "listWorkflows" in page_src, "-")
check("Workflows client: builder surfaces", all(t in client_src for t in (
    "/api/omniflow/portal/workflows", "Start from template",
    "Run test", "Activate", "Pause", "Archive", "Runs", "Open in builder",
    "WorkflowCanvas", "StepInspector", "TriggerInspector")), "-")


def _read(name):
    path = BFF + name
    return open(path, encoding="utf8").read() if os.path.exists(path) else ""


canvas_src = _read("workflow_canvas.tsx")
inspector_src = _read("step_inspector.tsx")
model_src = _read("workflow_model.ts")
onboarding_src = _read("onboarding_page.tsx")
builder_srcs = client_src + canvas_src + inspector_src + model_src
check("Builder model: every node kind + stop_on_reply live in the pure model",
      all(t in model_src for t in (
          "condition", "branch", "ai_decision", "action", "wait", "approval",
          "handoff", "goal", "stop", "stop_on_reply", "reachability",
          "layoutWorkflow", "moveToSlot")), "-")
check("Builder canvas: custom pointer-event drag + SVG edges (D6 design)",
      all(t in canvas_src for t in (
          "setPointerCapture", "touchAction", "<svg", "slotFromY",
          "Not reachable", "onKeyDown", "Insert a step at position")), "-")
check("Builder inspector: per-kind forms + approval-gate notice + key jumps",
      all(t in inspector_src for t in (
          "High-risk", "jump to", "Yes/no question", "Add rule",
          "Goal name", "Teammate user id")), "-")
check("Templates picker groups by vertical with the applied pack first",
      "optgroup" in client_src and "appliedVertical" in client_src
      and "Recommended for" in client_src, "-")
check("Setup wizard previews + links the seeded workflow drafts",
      "Workflow drafts" in onboarding_src
      and '"/dashboard/workflows"' in onboarding_src
      and "workflow drafts" in onboarding_src, "-")
check("Workflows UI: English copy, no Roman-Urdu UI strings",
      "karein" not in builder_srcs and "nahi" not in builder_srcs
      and "hai" not in builder_srcs.replace("hair", ""), "-")
check("Builder canvas: no emoji-capable glyphs (text-presentation law)",
      all(code not in canvas_src for code in (
          "\\u25b6", "\\u261d", "\\u2714", "\\u26a1", "\\u2699", "\\u2709",
          "\\u260e", "\\u2733", "\\u263a", "\\u25fc", "\\u27a1"))
      and "\\u25c9" in canvas_src, "-")
check("Workflows UI: no heavy libs (D6 law)", all(
    lib not in builder_srcs for lib in ("reactflow", "@xyflow", "dnd-kit",
                                        "react-beautiful-dnd", "konva")), "-")
PKG = open(RIG13 + "package.json", encoding="utf8").read()
check("package.json: no canvas/drag-drop dependency added", all(
    lib not in PKG for lib in ("reactflow", "@xyflow", "dnd-kit",
                               "react-beautiful-dnd", "konva", "d3")), "-")
SIDEBAR = open(RIG13 + "app/dashboard/components/DashSidebar.tsx",
               encoding="utf8").read()
PALETTE = open(RIG13 + "app/dashboard/components/CommandPalette.tsx",
               encoding="utf8").read()
check("sidebar + palette link", '"/dashboard/workflows"' in SIDEBAR
      and '"/dashboard/workflows"' in PALETTE, "-")
RULES = open(RIG13 + "app/dashboard/(portal)/rules/page.tsx",
             encoding="utf8").read()
check("Rules page has a workflows icon", "workflows:" in RULES, "-")

raise SystemExit(1 if summary("workflows") else 0)
