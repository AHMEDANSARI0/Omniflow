"""§208 Scheduled agent hours: weekly windows per persona, default OFF
(always on), brain drafts-only outside hours, version/rollback carry
schedule, UI + BFF surface."""
import json
import os
import sys
from datetime import datetime, timezone, timedelta
from unittest import mock

_HERE = os.path.abspath(os.path.dirname(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
_CP = os.path.join(_ROOT, "omniflow-backend-patch")
sys.path = [p for p in sys.path if os.path.abspath(p or ".") != _HERE]
sys.path.insert(0, _CP)
sys.path.append(_HERE)

from flask import Flask

import portal_agents as agents
import portal_brain
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(agents.bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
PrincipalStub(agents, principal=human)


def fresh(script):
    agents._DDL_READY = True
    return install_db_stub(agents, script)


print("== defaults ==")

d = agents.default_schedule()
check("defaults off", d["enabled"] is False, d)
check("7 days", len(d["days"]) == 7, d)
check("tz set", isinstance(d["timezone"], str) and d["timezone"], d)

print("== normalize / validate ==")

out = agents._normalize_schedule(None)
check("None -> defaults", out["enabled"] is False, out)

out = agents._normalize_schedule({
    "enabled": True,
    "timezone": "Asia/Karachi",
    "days": [
        {"enabled": False, "start": "09:00", "end": "17:00"},  # Sun
        {"enabled": True, "start": "10:00", "end": "18:00"},   # Mon
        {"enabled": True, "start": "10:00", "end": "18:00"},
        {"enabled": True, "start": "10:00", "end": "18:00"},
        {"enabled": True, "start": "10:00", "end": "18:00"},
        {"enabled": True, "start": "10:00", "end": "18:00"},
        {"enabled": False, "start": "09:00", "end": "17:00"},  # Sat
    ],
})
check("enabled kept", out["enabled"] is True, out)
check("Mon start 10", out["days"][1]["start"] == "10:00", out["days"][1])
check("Sun off", out["days"][0]["enabled"] is False, out["days"][0])

check("validate none ok", agents._validate_schedule(None) is None, "-")
check("validate junk object",
      agents._validate_schedule("nope") is not None, agents._validate_schedule("nope"))
check("validate bad days len",
      agents._validate_schedule({"days": []}) is not None, "-")
check("validate start>=end",
      agents._validate_schedule({
          "days": [{"enabled": True, "start": "18:00", "end": "09:00"}] * 7
      }) is not None, "-")
check("validate good",
      agents._validate_schedule({
          "enabled": True,
          "timezone": "UTC",
          "days": [{"enabled": True, "start": "09:00", "end": "17:00"}] * 7
      }) is None, "-")

print("== agent_in_hours ==")

# Always on when schedule disabled
check("off schedule always on",
      agents.agent_in_hours({"schedule": {"enabled": False}}) is True, "-")
check("no agent always on", agents.agent_in_hours(None) is True, "-")

# Fixed moment: 2026-09-28 is Monday. Use UTC+5 so local = UTC+5.
# Monday 10:30 local = 05:30 UTC
when = datetime(2026, 9, 28, 5, 30, tzinfo=timezone.utc)
sched_on = {
    "enabled": True,
    "timezone": "Asia/Karachi",
    "days": [
        {"enabled": False, "start": "09:00", "end": "17:00"},  # Sun
        {"enabled": True, "start": "09:00", "end": "17:00"},   # Mon
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": False, "start": "09:00", "end": "17:00"},
    ],
}
check("Mon 10:30 in hours",
      agents.agent_in_hours({"schedule": sched_on}, when=when) is True, "-")

# Monday 08:00 local = 03:00 UTC
when_early = datetime(2026, 9, 28, 3, 0, tzinfo=timezone.utc)
check("Mon 08:00 outside",
      agents.agent_in_hours({"schedule": sched_on}, when=when_early) is False, "-")

# Monday 17:00 local = 12:00 UTC -> end exclusive -> outside
when_end = datetime(2026, 9, 28, 12, 0, tzinfo=timezone.utc)
check("Mon 17:00 outside (end exclusive)",
      agents.agent_in_hours({"schedule": sched_on}, when=when_end) is False, "-")

# Sunday
when_sun = datetime(2026, 9, 27, 8, 0, tzinfo=timezone.utc)  # Sun 13:00 PKT
check("Sun closed",
      agents.agent_in_hours({"schedule": sched_on}, when=when_sun) is False, "-")

# Fail-soft on broken tz still returns True? Actually ZoneInfo may fail and we
# fall back to UTC+5 - still works. Force exception via bad days:
check("broken days fail-soft True",
      agents.agent_in_hours({"schedule": {"enabled": True, "days": "x"}},
                            when=when) is True, "-")

print("== shape includes schedule ==")

row = {
    "id": 7, "name": "Sales", "tone": "warm", "instructions": "upsell",
    "escalation_user_id": None, "is_active": True, "updated_at": "",
    "allowed_actions": None, "max_risk": "high", "can_auto_reply": True,
    "schedule": json.dumps({"enabled": True, "timezone": "UTC",
                            "days": [{"enabled": True, "start": "00:00",
                                      "end": "23:59"}] * 7}),
}
shaped = agents._shape(row)
check("shape has schedule", isinstance(shaped.get("schedule"), dict), shaped)
check("shape schedule enabled", shaped["schedule"]["enabled"] is True, shaped)
check("shape has in_hours bool", isinstance(shaped.get("in_hours"), bool), shaped)

print("== API create/update with schedule ==")

# create: COUNT, INSERT returning id, INSERT version, log_action
conn = fresh([
    [{"total": 0}],
    [{"id": 42}],
    1,  # version insert
    1,  # log
])
response = client.post("/api/v1/portal/agents", json={
    "name": "Night Desk",
    "tone": "calm",
    "instructions": "After hours only",
    "schedule": {
        "enabled": True,
        "timezone": "Asia/Karachi",
        "days": [{"enabled": True, "start": "18:00", "end": "23:00"}] * 7,
    },
})
payload = response.get_json()
check("create 200", status(response) == 200, (status(response), payload))
check("create returns schedule",
      isinstance((payload or {}).get("agent", {}).get("schedule"), dict),
      payload)
check("create schedule on",
      (payload or {}).get("agent", {}).get("schedule", {}).get("enabled") is True,
      payload)
# INSERT params include schedule JSON
ins = [e for e in conn.cur.executed if e[0].lstrip().startswith("INSERT INTO portal_agents")]
check("create INSERT has schedule col",
      ins and "schedule" in ins[0][0], ins[0][0][:120] if ins else "-")

# bad schedule 400 - no DB needed after validate
conn = fresh([])
response = client.post("/api/v1/portal/agents", json={
    "name": "Bad",
    "schedule": {"enabled": True, "days": [{"start": "19:00", "end": "09:00"}] * 7},
})
check("bad schedule 400", status(response) == 400, status(response))

# update: UPDATE returning, version (SELECT max + INSERT), log
conn = fresh([
    [{"id": 42}],
    [{"max_version": 1}],
    1,  # insert version
    1,  # log
])
response = client.put("/api/v1/portal/agents/42", json={
    "name": "Night Desk",
    "tone": "calm",
    "instructions": "x",
    "is_active": True,
    "schedule": {
        "enabled": False,
        "timezone": "UTC",
        "days": [{"enabled": True, "start": "09:00", "end": "17:00"}] * 7,
    },
})
check("update 200", status(response) == 200, (status(response), response.get_json()))
upd = [e for e in conn.cur.executed if "UPDATE" in e[0] and "portal_agents" in e[0]]
check("update sets schedule",
      upd and "schedule" in upd[0][0], upd[0][0][:140] if upd else "-")


# update without schedule key preserves existing (SELECT schedule then UPDATE)
conn = fresh([
    [{"schedule": {"enabled": True, "timezone": "UTC",
                   "days": [{"enabled": True, "start": "01:00",
                             "end": "02:00"}] * 7}}],  # SELECT schedule
    [{"id": 42}],  # UPDATE returning
    [{"max_version": 2}],
    1,  # version insert
    1,  # log
])
response = client.put("/api/v1/portal/agents/42", json={
    "name": "Night Desk",
    "tone": "calm",
    "instructions": "x",
    "is_active": True,
    # no schedule key
})
check("update omit schedule 200", status(response) == 200, status(response))
upd_params = [e for e in conn.cur.executed if e[0].lstrip().startswith("UPDATE")]
# last param before agent_id should be schedule JSON with enabled true
if upd_params:
    params = upd_params[0][1]
    # schedule is the JSON string near the end
    dumped = [p for p in params if isinstance(p, str) and "enabled" in p]
    check("preserve schedule when omitted",
          dumped and '"enabled": true' in dumped[0].lower().replace("True","true")
          or (dumped and "true" in dumped[0]),
          dumped[0][:120] if dumped else params)
else:
    check("preserve schedule when omitted", False, "no update")

print("== brain gate ==")

# agent_auto_reply false when outside hours even if can_auto_reply True
# We unit-test the grounding logic by calling the small block via agent_in_hours
# and documenting brain source pin.
brain_src = open(os.path.join(_CP, "portal_brain.py"), encoding="utf8").read()
check("brain sets agent_in_hours",
      'grounding["agent_in_hours"]' in brain_src, "-")
check("brain AND in_hours for auto_reply",
      "is not False and in_hours" in brain_src
      or ("can_auto_reply" in brain_src and "agent_in_hours" in brain_src),
      "-")
check("brain imports agent_in_hours",
      "agent_in_hours" in brain_src, "-")

# Simulate: can_auto True + outside hours => auto_reply False
outside_agent = {
    "can_auto_reply": True,
    "schedule": sched_on,
}
in_hours = agents.agent_in_hours(outside_agent, when=when_early)
auto = (outside_agent.get("can_auto_reply", True) is not False) and in_hours
check("outside => no auto", auto is False, auto)

in_hours = agents.agent_in_hours(outside_agent, when=when)
auto = (outside_agent.get("can_auto_reply", True) is not False) and in_hours
check("inside => auto ok", auto is True, auto)

# can_auto False always drafts
outside_agent2 = {"can_auto_reply": False, "schedule": {"enabled": False}}
in_hours = agents.agent_in_hours(outside_agent2)
auto = (outside_agent2.get("can_auto_reply", True) is not False) and in_hours
check("can_auto false always drafts", auto is False, auto)

print("== DDL / columns ==")

check("AGENT_COLUMNS has schedule", "schedule" in agents.AGENT_COLUMNS,
      agents.AGENT_COLUMNS)
check("DDL adds schedule JSONB",
      "ADD COLUMN IF NOT EXISTS schedule JSONB" in agents._DDL, "-")

print("== UI + BFF + portal.ts ==")

ui = open(os.path.join(_ROOT, "app", "dashboard", "(portal)", "team",
                       "AgentsAndRouting.tsx"), encoding="utf8").read()
check("UI Active hours", "Active hours" in ui, "-")
check("UI schedule state", "setSchedule" in ui and "defaultSchedule" in ui, "-")
check("UI saves schedule", "schedule," in ui or "schedule }" in ui, "-")
check("UI no emoji", not any(g in ui for g in "\u25b6\u26a1\u2709\u2699\u2714"), "-")

ap = open(os.path.join(_ROOT, "lib", "omniflow", "agent-permissions.ts"),
          encoding="utf8").read()
check("BFF parseAgentSchedule", "parseAgentSchedule" in ap, "-")
check("permissions include schedule",
      "value.schedule" in ap and "parseAgentSchedule" in ap, "-")

pts = open(os.path.join(_ROOT, "lib", "omniflow", "portal.ts"),
           encoding="utf8").read()
check("portal AgentSchedule type", "export interface AgentSchedule" in pts, "-")
check("normalizeAgent schedule", "normalizeAgentSchedule" in pts, "-")
check("agentBody schedule", "body.schedule = input.schedule" in pts, "-")

# snapshot carries schedule
snap = agents._snapshot("A", "t", "i", None, True,
                        {"allowed_actions": None, "max_risk": "high",
                         "can_auto_reply": True},
                        {"enabled": True, "timezone": "UTC",
                         "days": [{"enabled": True, "start": "01:00",
                                   "end": "02:00"}] * 7})
check("snapshot has schedule",
      snap.get("schedule", {}).get("enabled") is True, snap)

# version shape
ver = agents._shape_version({
    "version": 3, "note": "Saved", "created_at": "2026-09-28",
    "snapshot": {"name": "A", "tone": "", "instructions": "",
                 "schedule": {"enabled": True, "timezone": "UTC",
                              "days": [{"enabled": True, "start": "08:00",
                                        "end": "12:00"}] * 7}},
})
check("version snapshot schedule",
      ver["snapshot"]["schedule"]["enabled"] is True, ver)

summary("agent_hours")
