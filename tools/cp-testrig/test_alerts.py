"""Tests for B5: portal_alerts (raise/dedupe/dead-command/settings/API)
+ portal_events wiring + web pins (bell, brief blocks, clients)."""
import json

from flask import Flask

import portal_alerts
import portal_events
import portal_db
from test_lib import install_db_stub
from test_lib import check, summary

PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}


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


def fresh(script, module=portal_alerts):
    portal_alerts._DDL_READY = True
    db = install_db_stub(module, script)
    portal_alerts.portal_db.CMD_TABLE = "portal_connector_commands"
    return db


def reset():
    portal_alerts.ALERTS_ENABLED = True
    portal_alerts._DDL_READY = True


# ---------- raise_alert: insert, dedupe, kill switches ----------

reset()
conn = fresh([[{"enabled": True}], [], [{"id": 41}]])
with conn.cur as cur:
    aid = portal_alerts.raise_alert(
        cur, 1, "delivery_dead", "Delivery failed: cod_confirm #7",
        "gateway down", "revenue", dedupe_key="cmd:7")
sqls = [s for s, p in conn.cur.executed]
check("raise inserts alert",
      any("INSERT INTO portal_alerts" in s for s in sqls) and aid == 41,
      (aid, sqls[:1]))
check("severity stored", json.dumps(
    [p for s, p in conn.cur.executed if "INSERT" in s][0]).count(
    "revenue") == 1, "severity param")

conn = fresh([[{"enabled": True}], [{"id": 9}]])
with conn.cur as cur:
    aid = portal_alerts.raise_alert(
        cur, 1, "delivery_dead", "dup", "", "normal", dedupe_key="cmd:7")
check("dedupe suppresses unread duplicate", aid is None, aid)

conn = fresh([[{"enabled": True}], [], [{"id": 42}]])
with conn.cur as cur:
    aid = portal_alerts.raise_alert(
        cur, 1, "delivery_dead", "again", "", "normal", dedupe_key="cmd:7")
check("after read, same key alerts again", aid == 42, aid)

portal_alerts.ALERTS_ENABLED = False
conn = fresh([])
with conn.cur as cur:
    aid = portal_alerts.raise_alert(cur, 1, "k", "t")
check("env kill switch silences", aid is None, aid)
portal_alerts.ALERTS_ENABLED = True

# per-tenant toggle: enabled row FALSE suppresses; missing row = on
conn = fresh([[{"enabled": False}]])
with conn.cur as cur:
    check("tenant off -> alerts_on False",
          portal_alerts.alerts_on(cur, 1) is False, "off")
conn = fresh([[]])
with conn.cur as cur:
    check("missing settings row -> on",
          portal_alerts.alerts_on(cur, 1) is True, "on")
conn = fresh([[{"enabled": True}], [{"id": 43}]])
with conn.cur as cur:
    check("tenant on -> alert raised",
          portal_alerts.raise_alert(cur, 1, "k", "t") == 43, "43")

# fail-silent: db error -> None, never raises
conn = fresh([RuntimeError("db down")])
with conn.cur as cur:
    check("raise fails silent",
          portal_alerts.raise_alert(cur, 1, "k", "t") is None, "None")

# ---------- alert_dead_command: dead-only + severity by action ----------

DEAD_REVENUE = {"action": "cod_confirm", "status": "dead",
                "error_message": "max_attempts"}
DEAD_PLAIN = {"action": "send_message", "status": "dead",
              "error_message": "no route"}
RETRYING = {"action": "cod_confirm", "status": "failed",
            "error_message": "gateway 500"}

conn = fresh([[DEAD_REVENUE], [{"enabled": True}], [], [{"id": 50}]])
conn.CMD_TABLE = "portal_connector_commands"
with conn.cur as cur:
    aid = portal_alerts.alert_dead_command(cur, 1, 7, "gateway down")
check("dead revenue command alerts", aid == 50, aid)
ins_params = [p for s, p in conn.cur.executed if "INSERT" in s][0]
check("revenue severity for cod action", "revenue" in str(ins_params),
      ins_params)

conn = fresh([[DEAD_PLAIN], [{"enabled": True}], [], [{"id": 51}]])
conn.CMD_TABLE = "portal_connector_commands"
with conn.cur as cur:
    aid = portal_alerts.alert_dead_command(cur, 1, 8, "")
check("plain action alerts too", aid == 51, aid)
ins_params = [p for s, p in conn.cur.executed if "INSERT" in s][0]
check("normal severity for plain action", "revenue" not in str(ins_params),
      ins_params)

conn = fresh([[RETRYING]])
conn.CMD_TABLE = "portal_connector_commands"
with conn.cur as cur:
    aid = portal_alerts.alert_dead_command(cur, 1, 9, "")
check("retrying failure does not alert", aid is None, aid)

# ---------- unread_count ----------

conn = fresh([[{"n": 4}]])
with conn.cur as cur:
    check("unread count", portal_alerts.unread_count(cur, 1) == 4, 4)
conn = fresh([RuntimeError("x")])
with conn.cur as cur:
    check("unread fails to 0", portal_alerts.unread_count(cur, 1) == 0, 0)

# ---------- owner API ----------

app = Flask("alerts-test")
app.register_blueprint(portal_alerts.bp)
client = app.test_client()

ALERT_ROW = {"id": 60, "kind": "delivery_dead", "dedupe_key": "cmd:3",
             "severity": "revenue", "title": "Delivery failed",
             "detail": "gateway down", "is_read": False,
             "created_at": None}
conn = fresh([[ALERT_ROW], [{"n": 1}]])
with PrincipalStub(portal_alerts, PRINCIPAL):
    r = client.get("/api/v1/portal/alerts")
check("list 200", r.status_code == 200, r.status_code)
check("list payload", r.get_json()["alerts"][0]["id"] == 60
      and r.get_json()["unread"] == 1, r.get_json())
check("iso tolerant of None", r.get_json()["alerts"][0]["created_at"]
      is None, "null ok")

with PrincipalStub(portal_alerts, {"via_api_key": True}):
    r = client.get("/api/v1/portal/alerts")
check("api key forbidden", r.status_code == 403, r.status_code)
with PrincipalStub(portal_alerts, None):
    r = client.get("/api/v1/portal/alerts")
check("anon 401", r.status_code == 401, r.status_code)

conn = fresh([[]])
with PrincipalStub(portal_alerts, PRINCIPAL):
    r_all = client.post("/api/omniflow/portal/alerts/read".replace(
        "/api/omniflow", "/api/v1"), json={"all": True})
check("mark all read 200", r_all.status_code == 200, r_all.status_code)
check("mark all sql", any("SET is_read = TRUE" in s
                          and "is_read = FALSE" in s
                          for s, p in conn.cur.executed), "bulk")

conn = fresh([[{"id": 61}]])
with PrincipalStub(portal_alerts, PRINCIPAL):
    r_one = client.post("/api/v1/portal/alerts/read", json={"id": 61})
check("mark one 200", r_one.status_code == 200, r_one.status_code)
with PrincipalStub(portal_alerts, PRINCIPAL):
    r_bad = client.post("/api/v1/portal/alerts/read", json={})
check("mark read 400 without id/all", r_bad.status_code == 400,
      r_bad.status_code)

conn = fresh([[]])
with PrincipalStub(portal_alerts, PRINCIPAL):
    r_set = client.put("/api/v1/portal/alerts/settings",
                       json={"enabled": False})
check("settings put 200", r_set.status_code == 200, r_set.status_code)
check("settings upsert sql", any("ON CONFLICT (client_id)" in s
                                 for s, p in conn.cur.executed), "upsert")
with PrincipalStub(portal_alerts, PRINCIPAL):
    r_bad = client.put("/api/v1/portal/alerts/settings", json={})
check("settings 400 without bool", r_bad.status_code == 400,
      r_bad.status_code)
conn = fresh([[{"enabled": True}]])
with PrincipalStub(portal_alerts, PRINCIPAL):
    r_get = client.get("/api/v1/portal/alerts/settings")
check("settings get 200 default true",
      r_get.get_json()["settings"]["enabled"] is True, r_get.get_json())

# ---------- portal_events wiring ----------

EV = open("/tmp/smoke971/portal_events.py", encoding="utf8").read()
check("events raises dead alerts",
      "portal_alerts.alert_dead_command(" in EV
      and "import portal_alerts" in EV, "wire")
check("events alert call after dead-marking",
      EV.index("portal_alerts.alert_dead_command(")
      > EV.index("MAX_ATTEMPTS, note, MAX_ATTEMPTS, MAX_ATTEMPTS,"))

# ---------- web pins ----------

PORTAL = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts",
              encoding="utf8").read()
for fn in ("listAlerts", "markAlertsRead", "putAlertSettings"):
    check("client " + fn, "export async function " + fn in PORTAL, fn)
BELL = open("/tmp/p13/Omniflow/app/dashboard/components/AlertsBell.tsx",
            encoding="utf8").read()
check("bell fetches alerts",
      '"/api/omniflow/portal/alerts"' in BELL
      and "unread" in BELL, "bell")
check("bell settings toggle", "alerts/settings" in BELL, "toggle")
SIDEBAR = open("/tmp/p13/Omniflow/app/dashboard/components/DashSidebar.tsx",
               encoding="utf8").read()
check("sidebar mounts bell", '<AlertsBell />' in SIDEBAR, "mount")
BRIEF = open("/tmp/p13/Omniflow/app/dashboard/(portal)/DailyBrief.tsx",
             encoding="utf8").read()
check("brief needs-attention block", "Needs attention" in BRIEF, "block")
check("brief recommended block", "Recommended:" in BRIEF, "block")
check("brief reads alerts+deliveries",
      '"/api/omniflow/portal/alerts"' in BRIEF
      and '"/api/omniflow/portal/deliveries"' in BRIEF, "sources")
for route in ("app/api/omniflow/portal/alerts/route.ts",
              "app/api/omniflow/portal/alerts/read/route.ts",
              "app/api/omniflow/portal/alerts/settings/route.ts"):
    src = open("/tmp/p13/Omniflow/" + route, encoding="utf8").read()
    check("bff " + route.split("/")[-2] + "/" + route.split("/")[-1],
          "export async function" in src, route)
APP = open("/tmp/smoke971/app.py", encoding="utf8").read()
check("app.py registers alerts bp",
      "aux_app.register_blueprint(portal_alerts_bp)" in APP, "bp")

summary("alerts")
