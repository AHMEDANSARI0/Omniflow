"""Tests for the Admin AI Control Center batch: platform AI controls
(platform_settings group "ai" + admin validation), the LLM gate (kill
switch + daily call cap in portal_ai_usage.gate / portal_llm.chat_json),
admin_ai overview + per-workspace autonomy override, and the web pins
(admin page, sidebar, BFF routes, admin client, BrainCard notice)."""
import os

from flask import Flask

import admin_ai
import admin_providers
import platform_settings
import portal_ai_usage
import portal_brain
import portal_llm
import portal_notify
from test_lib import check, install_db_stub, summary

W = "/tmp/p13/Omniflow/"


def read(rel):
    return open(rel if rel.startswith("/") else W + rel, encoding="utf8").read()


# ---------- platform_settings.ai_controls ----------

print("== ai controls ==")
_orig_get = platform_settings.get_setting
for key in ("OF_AI_KILL_SWITCH", "OF_AI_AUTONOMY_CAP", "OF_AI_DAILY_CALL_CAP"):
    os.environ.pop(key, None)


def stored(values):
    """ai_controls reads through the cached get_setting (per-call gate)."""
    platform_settings.get_setting = lambda key, default=None: values.get(
        key, default)


stored({})
c = platform_settings.ai_controls()
check("defaults are permissive", c == {"kill_switch": False,
                                       "autonomy_cap": "auto",
                                       "daily_call_cap": 0,
                                       "guard_mode": "standard",
                                       "source": "default"}, c)
stored({"ai.kill_switch": "on", "ai.autonomy_cap": "Suggest",
        "ai.daily_call_cap": "250"})
c = platform_settings.ai_controls()
check("panel values win + normalised", c["kill_switch"] is True
      and c["autonomy_cap"] == "suggest" and c["daily_call_cap"] == 250
      and c["source"] == "panel", c)
stored({"ai.autonomy_cap": "extreme", "ai.daily_call_cap": "lots"})
c = platform_settings.ai_controls()
check("garbage values -> safe defaults", c["autonomy_cap"] == "auto"
      and c["daily_call_cap"] == 0 and c["kill_switch"] is False, c)
stored({})
os.environ["OF_AI_KILL_SWITCH"] = "1"
os.environ["OF_AI_AUTONOMY_CAP"] = "off"
os.environ["OF_AI_DAILY_CALL_CAP"] = "40"
c = platform_settings.ai_controls()
check("env fallback OF_AI_*", c["kill_switch"] is True
      and c["autonomy_cap"] == "off" and c["daily_call_cap"] == 40
      and c["source"] == "env", c)
for key in ("OF_AI_KILL_SWITCH", "OF_AI_AUTONOMY_CAP", "OF_AI_DAILY_CALL_CAP"):
    os.environ.pop(key, None)


def _boom(key, default=None):
    raise RuntimeError("db down")


platform_settings.get_setting = _boom
check("storage failure -> defaults (fail-soft)",
      platform_settings.ai_controls()["autonomy_cap"] == "auto", "soft")
platform_settings.get_setting = _orig_get
check("ai_controls reads through the cached get_setting (no per-call query)",
      'get_setting("ai." + name, "")' in read(
          "/home/user/Omniflow/omniflow-backend-patch/platform_settings.py")
      and "get_group(\"ai\")" not in read(
          "/home/user/Omniflow/omniflow-backend-patch/platform_settings.py"),
      "cached")
check("group registered for the admin API",
      platform_settings.GROUP_KEYS["ai"] == ["kill_switch", "autonomy_cap",
                                             "daily_call_cap", "guard_mode"],
      platform_settings.GROUP_KEYS.get("ai"))

# admin validation (generic providers PUT handles group "ai")
values, err = admin_providers._clean_group("ai", {"kill_switch": "ON",
                                                  "autonomy_cap": "Auto",
                                                  "daily_call_cap": "100"})
check("admin clean: lowercases + accepts", err is None
      and values == {"kill_switch": "on", "autonomy_cap": "auto",
                     "daily_call_cap": "100"}, (values, err))
values, err = admin_providers._clean_group("ai", {"autonomy_cap": "turbo"})
check("admin clean: bad autonomy cap rejected", values is None
      and "ai.autonomy_cap must be one of" in err, err)
values, err = admin_providers._clean_group("ai", {"daily_call_cap": "12x"})
check("admin clean: non-numeric daily cap rejected", values is None
      and "whole number" in err, err)
values, err = admin_providers._clean_group("ai", {"daily_call_cap": "",
                                                  "kill_switch": "off"})
check("admin clean: blank cap = unlimited", err is None
      and values["daily_call_cap"] == "", (values, err))
check("admin configured chip for ai group",
      admin_providers._configured("ai", {"kill_switch": "off"}) is True
      and admin_providers._configured("ai", {"kill_switch": ""}) is False,
      "configured")

# ---------- gate: kill switch + daily cap ----------

print("== llm gate ==")
_orig_controls = platform_settings.ai_controls
_orig_since = portal_ai_usage.calls_since
_orig_notify = portal_notify.notify
sent = []
portal_notify.notify = lambda *a, **k: sent.append((a, k)) or {"ok": True}

platform_settings.ai_controls = lambda: {"kill_switch": True,
                                         "autonomy_cap": "auto",
                                         "daily_call_cap": 0}
check("gate: kill switch blocks every call",
      portal_ai_usage.gate("brain", 1) == "kill_switch"
      and portal_ai_usage.gate("other", 0) == "kill_switch", "kill")
platform_settings.ai_controls = lambda: {"kill_switch": False,
                                         "autonomy_cap": "auto",
                                         "daily_call_cap": 10}
portal_ai_usage.calls_since = lambda client_id, hours=24, cur=None: 3
check("gate: under the cap passes", portal_ai_usage.gate("brain", 1) is None,
      "under")
portal_ai_usage.calls_since = lambda client_id, hours=24, cur=None: 10
sent.clear()
check("gate: cap reached blocks + notifies owner once a day",
      portal_ai_usage.gate("brain", 1) == "daily_cap"
      and sent and sent[0][0][1] == "system"
      and sent[0][1]["dedupe_key"].startswith("aicap:1:")
      and "10/10" in sent[0][0][3], sent)
check("gate: platform scope (client 0) is never capped",
      portal_ai_usage.gate("other", 0) is None, "platform")
portal_ai_usage.calls_since = lambda client_id, hours=24, cur=None: None
check("gate: ledger unreadable -> fail-open",
      portal_ai_usage.gate("brain", 1) is None, "open")
platform_settings.ai_controls = lambda: {"kill_switch": False,
                                         "autonomy_cap": "auto",
                                         "daily_call_cap": 0}
portal_ai_usage.calls_since = _orig_since
conn = install_db_stub(portal_ai_usage, [[], [{"calls": 7}], []])
check("calls_since rides the caller's cursor behind a SAVEPOINT",
      portal_ai_usage.calls_since(1, 24, cur=conn.cur) == 7
      and conn.cur.executed[0][0] == "SAVEPOINT of_ai_gate"
      and "make_interval(hours => %s)" in conn.cur.executed[1][0]
      and conn.cur.executed[1][1] == (1, 24)
      and conn.cur.executed[2][0] == "RELEASE SAVEPOINT of_ai_gate",
      conn.cur.executed)
conn = install_db_stub(portal_ai_usage, [[], RuntimeError("no table"), []])
check("calls_since failure -> None + rollback to savepoint",
      portal_ai_usage.calls_since(1, 24, cur=conn.cur) is None
      and conn.cur.executed[2][0] == "ROLLBACK TO SAVEPOINT of_ai_gate",
      conn.cur.executed)
portal_notify.notify = _orig_notify

# chat_json consults the gate before any HTTP
_orig_runtime = portal_llm._runtime
_orig_http = portal_llm._http_post_json
_orig_gate = portal_ai_usage.gate
http_calls = []
portal_llm._runtime = lambda: {"base_url": "https://llm.test/v1",
                               "api_key": "k", "model": "m", "enabled": True}
portal_llm._http_post_json = lambda url, headers, payload: (
    http_calls.append(url) or {"choices": [{"message": {
        "content": '{"reply": "ok", "confidence": 0.9}'}}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1}})
portal_ai_usage.gate = lambda feature, client_id, cur=None: "kill_switch"
_orig_record = portal_llm._record_usage
portal_llm._record_usage = lambda *a, **k: None
check("chat_json: gated call returns None without HTTP",
      portal_llm.chat_json("s", "u") is None and http_calls == [], http_calls)
portal_ai_usage.gate = lambda feature, client_id, cur=None: None
check("chat_json: open gate -> provider called",
      portal_llm.chat_json("s", "u") == {"reply": "ok", "confidence": 0.9}
      and len(http_calls) == 1, http_calls)


def _gate_boom(feature, client_id, cur=None):
    raise RuntimeError("gate broke")


portal_ai_usage.gate = _gate_boom
check("chat_json: gate failure is fail-open",
      portal_llm.chat_json("s", "u") is not None, "open")
portal_ai_usage.gate = _orig_gate
portal_llm._runtime = _orig_runtime
portal_llm._http_post_json = _orig_http
portal_llm._record_usage = _orig_record
platform_settings.ai_controls = _orig_controls
LLM = read("/home/user/Omniflow/omniflow-backend-patch/portal_llm.py")
check("chat_json wires _gated() after the runtime check",
      "if _gated():\n        return None" in LLM
      and "portal_ai_usage.gate(feature, client_id, cur)" in LLM, "wire")

# ---------- overview ----------

print("== overview ==")
_orig_prices = portal_ai_usage.prices
portal_ai_usage.prices = lambda: {"gpt-4o-mini": {"input": 1.0, "output": 1.0}}
platform_settings.ai_controls = lambda: {"kill_switch": False,
                                         "autonomy_cap": "auto",
                                         "daily_call_cap": 0,
                                         "source": "default"}


def block(rows):
    return [[], rows, []]


SCRIPT = (
    block([{"client_id": 1, "email": "a@x.pk", "owner": "Ahmed", "users": 2},
           {"client_id": 2, "email": "b@x.pk", "owner": "", "users": 1}])
    + block([{"client_id": 1, "business_name": "Karachi Threads"}])
    + block([{"client_id": 1, "autonomy": "auto", "updated_at": "2026-09-29"},
             {"client_id": 3, "autonomy": "off", "updated_at": None}])
    + block([{"client_id": 1, "total": 3, "active": 2, "draft_only": 1}])
    + block([{"client_id": 2, "model": "gpt-4o-mini", "calls": 5, "failed": 1,
              "prompt_tokens": 1000000, "completion_tokens": 0,
              "last_call_at": "2026-09-29T09:00:00+00:00"},
             {"client_id": 1, "model": "other", "calls": 2, "failed": 0,
              "prompt_tokens": 10, "completion_tokens": 5,
              "last_call_at": "2026-09-28T09:00:00+00:00"}])
    + block([{"client_id": 1, "open": 4}])
    + block([{"client_id": 2, "pending": 1}])
    + block([{"client_id": 1, "decision": "send", "n": 9},
             {"client_id": 1, "decision": "handoff", "n": 3}])
    + block([{"id": 50, "client_id": 2, "action": "ai.answer",
              "actor_kind": "automation", "conversation_id": 7,
              "note": "Brain answered", "created_at": "2026-09-29T08:00:00"},
             {"id": 49, "client_id": 1, "action": "brain.autonomy_override",
              "actor_kind": "platform_admin", "conversation_id": None,
              "note": "Platform admin set AI autonomy to off",
              "created_at": None}])
)
conn = install_db_stub(admin_ai, list(SCRIPT))
out = admin_ai.overview(conn.cur, 7)
ws = {w["client_id"]: w for w in out["workspaces"]}
check("overview: every block behind a SAVEPOINT",
      conn.cur.executed[0][0] == "SAVEPOINT of_admin_ai"
      and conn.cur.executed[2][0] == "RELEASE SAVEPOINT of_admin_ai"
      and len(conn.cur.executed) == 27, len(conn.cur.executed))
check("overview: workspaces sorted by calls, extras never hidden",
      [w["client_id"] for w in out["workspaces"]] == [2, 1, 3], ws.keys())
check("overview: names + autonomy + agents merged",
      ws[1]["name"] == "Karachi Threads" and ws[1]["owner"] == "Ahmed"
      and ws[1]["autonomy"] == "auto" and ws[1]["agents_active"] == 2
      and ws[1]["agents_draft_only"] == 1 and ws[2]["autonomy"] == "suggest"
      and ws[3]["autonomy"] == "off" and ws[3]["users"] == 0, ws)
check("overview: usage + estimated cost per workspace",
      ws[2]["calls"] == 5 and ws[2]["failed"] == 1 and ws[2]["tokens"] == 1000000
      and ws[2]["cost_usd"] == 1.0 and ws[1]["cost_usd"] is None
      and ws[2]["last_call_at"] == "2026-09-29T09:00:00+00:00", ws[2])
check("overview: escalations, approvals, answers/handoffs",
      ws[1]["open_escalations"] == 4 and ws[2]["pending_approvals"] == 1
      and ws[1]["answers"] == 9 and ws[1]["handoffs"] == 3, ws[1])
t = out["totals"]
check("overview: totals", t["workspaces"] == 3 and t["auto"] == 1
      and t["suggest"] == 1 and t["off"] == 1 and t["calls"] == 7
      and t["failed"] == 1 and t["cost_usd"] == 1.0 and t["priced"] is True
      and t["open_escalations"] == 4 and t["pending_approvals"] == 1
      and t["answers"] == 9 and t["agents_active"] == 2, t)
check("overview: recent AI audit categorised",
      out["recent"][0]["action"] == "ai.answer"
      and out["recent"][0]["category"] and out["recent"][0]["client_id"] == 2
      and out["recent"][1]["created_at"] is None, out["recent"])
check("overview: controls + window echoed", out["controls"]["autonomy_cap"]
      == "auto" and out["days"] == 7 and out["generated_at"], out["controls"])
check("overview: usage window uses the requested days",
      any("make_interval(days => %s)" in q and p == (7,)
          for q, p in conn.cur.executed), "days")

# a missing table (fresh install) rolls back its savepoint, rest renders
BROKEN = list(SCRIPT)
BROKEN[10] = RuntimeError("relation portal_agents does not exist")
conn = install_db_stub(admin_ai, BROKEN)
out = admin_ai.overview(conn.cur, 400)
check("overview: failed block -> rollback to savepoint, zeros",
      conn.cur.executed[11][0] == "ROLLBACK TO SAVEPOINT of_admin_ai"
      and out["workspaces"] and all(w["agents_active"] == 0
                                    for w in out["workspaces"])
      and out["days"] == admin_ai.MAX_DAYS, out["days"])
portal_ai_usage.prices = _orig_prices
platform_settings.ai_controls = _orig_controls

# ---------- API ----------

print("== api ==")
app = Flask("admin-ai-test")
app.register_blueprint(admin_ai.bp)
client = app.test_client()
KEY = {"X-Omniflow-Key": "x"}

r = client.get("/api/v1/admin/ai/overview")
check("overview 403 without service key", r.status_code == 403, r.status_code)
_orig_overview = admin_ai.overview
admin_ai.overview = lambda cur, days: {"days": days, "workspaces": [],
                                       "controls": {}, "totals": {},
                                       "recent": [], "generated_at": "t"}
conn = install_db_stub(admin_ai, [])
r = client.get("/api/v1/admin/ai/overview?days=30", headers=KEY)
check("overview 200 with key + days clamp", r.status_code == 200
      and r.get_json()["days"] == 30 and conn.committed, r.get_json())
admin_ai.overview = _orig_overview


class Down:
    def _conn(self):
        raise RuntimeError("db down")


_stub_db = admin_ai.portal_db
admin_ai.portal_db = Down()
r = client.get("/api/v1/admin/ai/overview", headers=KEY)
check("overview 503 when the database is down", r.status_code == 503
      and r.get_json()["error"]["code"] == "db_unavailable", r.status_code)
admin_ai.portal_db = _stub_db

r = client.post("/api/v1/admin/ai/clients/5/autonomy", json={"autonomy": "max"},
                headers=KEY)
check("autonomy 400 bad level", r.status_code == 400, r.status_code)
r = client.post("/api/v1/admin/ai/clients/5/autonomy", json={"autonomy": "off"})
check("autonomy 403 without key", r.status_code == 403, r.status_code)
portal_brain._DDL_READY = True
sent = []
portal_notify.notify = lambda *a, **k: sent.append((a, k)) or {"ok": True}
conn = install_db_stub(admin_ai, [[], []])
r = client.post("/api/v1/admin/ai/clients/5/autonomy",
                json={"autonomy": "off", "reason": "abuse report"}, headers=KEY)
check("autonomy override 200", r.status_code == 200
      and r.get_json() == {"ok": True, "client_id": 5, "autonomy": "off"},
      r.get_json())
up = conn.cur.executed[0]
check("autonomy override upserts brain settings",
      "portal_brain_settings" in up[0] and "ON CONFLICT (client_id)" in up[0]
      and up[1] == (5, "off") and conn.committed, up)
log = conn.cur.executed[1]
check("autonomy override audited as platform_admin",
      log[1][1] == "brain.autonomy_override" and log[1][2] == "platform_admin"
      and "abuse report" in log[1][5], log)
check("autonomy override notifies the owner (system kind, deduped)",
      sent and sent[0][0][0] == 5 and sent[0][0][1] == "system"
      and sent[0][1]["dedupe_key"] == "autonomy_override:5:off"
      and sent[0][1]["severity"] == "high", sent)
portal_notify.notify = _orig_notify

# ---------- wiring pins ----------

print("== wiring pins ==")
APP = read("/tmp/smoke971/app.py")
check("app.py registers admin_ai bp",
      "from admin_ai import bp as admin_ai_bp" in APP
      and "aux_app.register_blueprint(admin_ai_bp)" in APP, "bp")
ACP = read("lib/omniflow/admin-control-plane.ts")
check("admin client: ai group + overview + autonomy helpers",
      '| "ai"' in ACP and '| "stt"' in ACP and '| "embeddings"' in ACP
      and '| "vision";' in ACP  # D5 (§212) appended vision
      and "export async function getAdminAiOverview" in ACP
      and "export async function setAdminClientAutonomy" in ACP
      and "api/v1/admin/ai/overview?days=" in ACP, "acp")
PROV = read("app/api/omniflow/admin/providers/route.ts")
check("providers BFF accepts the ai group", '"ai",' in PROV, "groups")
OV = read("app/api/omniflow/admin/ai/overview/route.ts")
check("bff admin ai overview (admin session + depth 6)",
      "getAdminAiOverview" in OV and "requireAdminSession" in OV
      and OV.count("../../../../../../lib/") >= 4
      and "../../../../../../../lib/" not in OV, "bff-overview")
AU = read("app/api/omniflow/admin/ai/clients/[id]/autonomy/route.ts")
check("bff admin autonomy override (depth 8, Promise params, validated)",
      "setAdminClientAutonomy" in AU
      and AU.count("../../../../../../../../lib/") >= 4
      and "params: Promise<{ id: string }>" in AU
      and "autonomy must be off, suggest or auto." in AU, "bff-autonomy")
PAGE = read("app/admin/(panel)/ai-control/page.tsx")
check("admin AI Control Center page",
      "AI Control Center" in PAGE and "Pause all AI answering" in PAGE
      and 'group: "ai"' in PAGE and "/api/omniflow/admin/ai/overview?days="
      in PAGE and "/autonomy" in PAGE and "Recent AI activity" in PAGE
      and "Pending approvals" in PAGE, "page")
SIDEBAR = read("app/admin/components/AdminSidebar.tsx")
check("admin sidebar entry (text-presentation glyph)",
      '/admin/ai-control' in SIDEBAR and '"\\u2736"' in SIDEBAR, "sidebar")
CARD = read("app/dashboard/(portal)/settings/BrainCard.tsx")
check("owner BrainCard shows platform pause / cap notice",
      "paused platform-wide" in CARD and "effective_autonomy" in CARD, "card")
PORTAL = read("lib/omniflow/portal.ts")
check("BrainSettings type carries platform block",
      "effective_autonomy:" in PORTAL, "type")

summary("admin_ai")
