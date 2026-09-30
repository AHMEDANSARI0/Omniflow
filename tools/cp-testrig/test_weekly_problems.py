"""Tests for weekly problems email (§207): settings CRUD, body format,
schedule gates, connector wiring, notify kind, and UI/API surface."""
import json
import os
import sys
from unittest import mock

# Avoid rig portal_* stubs shadowing the real Control Plane modules.
_HERE = os.path.abspath(os.path.dirname(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
_CP = os.path.join(_ROOT, "omniflow-backend-patch")
sys.path = [p for p in sys.path if os.path.abspath(p or ".") != _HERE]
sys.path.insert(0, _CP)
sys.path.append(_HERE)

from flask import Flask

import portal_bi
import portal_notify
from test_lib import check, install_db_stub, PrincipalStub, status, summary

ROOT = _ROOT

app = Flask(__name__)
app.register_blueprint(portal_bi.bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
PrincipalStub(portal_bi, principal=human)

# ensure_human_principal is imported inside the route handlers
try:
    import portal_auth

    def _ok_human(principal):
        return None

    portal_auth.ensure_human_principal = _ok_human
except Exception:
    pass


def fresh(script):
    return install_db_stub(portal_bi, script)


print("== notify kind ==")

check("insights kind registered",
      "insights" in portal_notify.KIND_KEYS,
      portal_notify.KIND_KEYS)
check("insights label",
      any(k == "insights" and "insight" in l.lower()
          for k, l, _d in portal_notify.KINDS),
      portal_notify.KINDS)

print("== defaults ==")

d = portal_bi.default_weekly_settings()
check("defaults off", d["enabled"] is False, d)
check("default hour in range", 6 <= d["hour"] <= 21, d)
check("default weekday mon-sun", 1 <= d["weekday"] <= 7, d)
check("no last sent", d["last_sent_date"] is None, d)

print("== load settings ==")

conn = fresh([[{"weekly_problems": {
    "enabled": True, "hour": 10, "weekday": 5, "last_sent_date": "2026-09-26"
}}]])
out = portal_bi._load_weekly_settings(conn.cur, 1)
check("load kept values",
      out["enabled"] is True and out["hour"] == 10
      and out["weekday"] == 5 and out["last_sent_date"] == "2026-09-26",
      out)

conn = fresh([[{"weekly_problems": {
    "enabled": True, "hour": 99, "weekday": 0
}}]])
out = portal_bi._load_weekly_settings(conn.cur, 1)
check("junk hour ignored",
      out["hour"] == portal_bi.default_weekly_settings()["hour"], out)
check("junk weekday ignored",
      out["weekday"] == portal_bi.default_weekly_settings()["weekday"], out)

conn = fresh([[]])  # no row
out = portal_bi._load_weekly_settings(conn.cur, 1)
check("empty -> defaults", out["enabled"] is False, out)

conn = fresh([[{"weekly_problems": json.dumps({
    "enabled": True, "hour": 8, "weekday": 2
})}]])
out = portal_bi._load_weekly_settings(conn.cur, 1)
check("json string stored ok",
      out["enabled"] is True and out["hour"] == 8 and out["weekday"] == 2, out)

print("== format body ==")

title, detail, sev = portal_bi._format_weekly_body({
    "days": 7, "problems": [], "problem_counts": {"critical": 0, "warn": 0},
})
check("quiet title", "quiet" in title.lower(), title)
check("quiet severity normal", sev == "normal", sev)

title, detail, sev = portal_bi._format_weekly_body({
    "days": 7,
    "problem_counts": {"critical": 2, "warn": 1},
    "problems": [
        {"severity": "critical", "title": "Knowledge gaps growing",
         "action": {"label": "Open knowledge", "href": "/dashboard/knowledge"}},
        {"severity": "warn", "title": "Handoffs spiking",
         "action": {"label": "Review AI", "href": "/dashboard/insights"}},
        {"severity": "warn", "title": "Delivery complaints"},
    ],
})
check("busy title counts", "2" in title and "1" in title, title)
check("busy severity high", sev == "high", sev)
check("detail has FIX/LOOK", "[FIX]" in detail and "[LOOK]" in detail, detail)
check("detail capped", len(detail) <= 500, len(detail))
check("title capped", len(title) <= 200, len(title))

print("== settings API ==")

conn = fresh([[{"weekly_problems": {
    "enabled": False, "hour": 9, "weekday": 1, "last_sent_date": None
}}]])
response = client.get("/api/v1/portal/bi/weekly-problems")
payload = response.get_json()
check("get 200", status(response) == 200, status(response))
check("get settings object", isinstance(payload.get("settings"), dict), payload)
check("get defaults off", payload["settings"]["enabled"] is False, payload)
check("get weekdays 7",
      isinstance(payload.get("weekdays"), list)
      and len(payload["weekdays"]) == 7, payload.get("weekdays"))

# PUT: load current, CREATE TABLE, INSERT, log_action
conn = fresh([
    [{"weekly_problems": {"enabled": False, "hour": 9, "weekday": 1}}],
    [],  # CREATE TABLE
    1,   # INSERT
    1,   # log_action
])
response = client.put(
    "/api/v1/portal/bi/weekly-problems",
    json={"settings": {"enabled": True, "hour": 10, "weekday": 3}},
)
payload = response.get_json()
check("put 200", status(response) == 200 and payload.get("ok") is True,
      (status(response), payload))
check("put saved enabled",
      isinstance(payload, dict) and payload.get("settings", {}).get("enabled") is True,
      payload)
check("put saved hour",
      isinstance(payload, dict) and payload.get("settings", {}).get("hour") == 10,
      payload)
check("put saved weekday",
      isinstance(payload, dict) and payload.get("settings", {}).get("weekday") == 3,
      payload)

conn = fresh([
    [{"weekly_problems": {"enabled": False, "hour": 9, "weekday": 1}}],
])
response = client.put(
    "/api/v1/portal/bi/weekly-problems",
    json={"settings": {"enabled": True, "hour": 3}},
)
check("bad hour 400", status(response) == 400, status(response))

conn = fresh([
    [{"weekly_problems": {"enabled": False, "hour": 9, "weekday": 1}}],
])
response = client.put(
    "/api/v1/portal/bi/weekly-problems",
    json={"settings": {"enabled": True, "weekday": 9}},
)
check("bad weekday 400", status(response) == 400, status(response))

print("== materialize gates ==")

conn = fresh([[{"weekly_problems": {"enabled": False, "hour": 9, "weekday": 1}}]])
n = portal_bi.materialize_weekly_problems(conn.cur, 1, conn)
check("off -> 0", n == 0, n)

conn = fresh([
    [{"weekly_problems": {"enabled": True, "hour": 9, "weekday": 1,
                          "last_sent_date": None}}],
    [{"wd": 2, "h": 10, "d": "2026-09-29"}],
])
n = portal_bi.materialize_weekly_problems(conn.cur, 1, conn)
check("wrong weekday -> 0", n == 0, n)

conn = fresh([
    [{"weekly_problems": {"enabled": True, "hour": 12, "weekday": 1,
                          "last_sent_date": None}}],
    [{"wd": 1, "h": 9, "d": "2026-09-28"}],
])
n = portal_bi.materialize_weekly_problems(conn.cur, 1, conn)
check("before hour -> 0", n == 0, n)

conn = fresh([
    [{"weekly_problems": {"enabled": True, "hour": 9, "weekday": 1,
                          "last_sent_date": "2026-09-28"}}],
    [{"wd": 1, "h": 10, "d": "2026-09-28"}],
])
n = portal_bi.materialize_weekly_problems(conn.cur, 1, conn)
check("already sent -> 0", n == 0, n)

# happy path: mock report + notify
conn = fresh([
    [{"weekly_problems": {"enabled": True, "hour": 9, "weekday": 1,
                          "last_sent_date": None}}],
    [{"wd": 1, "h": 10, "d": "2026-09-28"}],
    [],  # CREATE TABLE in _save
    1,   # INSERT
    1,   # log_action
])
fake_report = {
    "days": 7,
    "problems": [
        {"severity": "critical", "title": "Gaps",
         "action": {"label": "Fix KB", "href": "/x"}},
    ],
    "problem_counts": {"critical": 1, "warn": 0},
}
notifies = []


def fake_notify(client_id, kind, title, detail, **kwargs):
    notifies.append({"client_id": client_id, "kind": kind, "title": title,
                     "detail": detail, **kwargs})
    return {"in_app": 1, "email": "queued"}


with mock.patch.object(portal_bi, "report", return_value=fake_report):
    with mock.patch.object(portal_notify, "notify", side_effect=fake_notify):
        n = portal_bi.materialize_weekly_problems(conn.cur, 1, conn)

check("sent once", n == 1, n)
check("notify called", len(notifies) == 1, notifies)
if notifies:
    check("notify kind insights", notifies[0]["kind"] == "insights", notifies[0])
    check("dedupe key has date",
          "weekly_problems:2026-09-28" in str(notifies[0].get("dedupe_key")),
          notifies[0])
    check("title mentions critical", "1" in notifies[0]["title"], notifies[0])

conn = fresh([Exception("db down")])
n = portal_bi.materialize_weekly_problems(conn.cur, 1, conn)
check("fail soft -> 0", n == 0, n)

print("== send now API ==")

conn = fresh([
    1,  # log_action only (report mocked)
])
with mock.patch.object(portal_bi, "report", return_value={
    "days": 7, "problems": [], "problem_counts": {"critical": 0, "warn": 0},
}):
    with mock.patch.object(portal_notify, "notify",
                           return_value={"in_app": 9, "email": "queued"}):
        response = client.post("/api/v1/portal/bi/weekly-problems/send")
payload = response.get_json()
check("send 200", status(response) == 200 and payload.get("ok") is True,
      (status(response), payload))
check("send title quiet",
      "quiet" in str((payload or {}).get("title") or "").lower(),
      payload)

print("== connector wiring ==")

ca = open(os.path.join(_CP, "connector_api.py"), encoding="utf8").read()
check("connector imports portal_bi", "import portal_bi" in ca, "missing import")
check("connector calls materialize",
      "materialize_weekly_problems" in ca, "missing call")

print("== UI + BFF surface ==")

card = os.path.join(ROOT, "app", "dashboard", "(portal)", "settings",
                    "WeeklyProblemsCard.tsx")
check("card exists", os.path.isfile(card), card)
if os.path.isfile(card):
    ct = open(card, encoding="utf8").read()
    check("card English title", "Weekly problems email" in ct, "title")
    check("card fetch path",
          "/api/omniflow/portal/bi/weekly-problems" in ct, "path")
    check("card send test", "Send test now" in ct, "send")
    check("no emoji glyphs", not any(g in ct for g in "\u25b6\u26a1\u2709\u2699\u2714"),
          "emoji")

sp = open(os.path.join(ROOT, "app", "dashboard", "(portal)", "settings",
                       "page.tsx"), encoding="utf8").read()
check("settings imports card", "WeeklyProblemsCard" in sp, "import")

route = os.path.join(ROOT, "app", "api", "omniflow", "portal", "bi",
                     "weekly-problems", "route.ts")
check("BFF route", os.path.isfile(route), route)
send_route = os.path.join(ROOT, "app", "api", "omniflow", "portal", "bi",
                          "weekly-problems", "send", "route.ts")
check("BFF send route", os.path.isfile(send_route), send_route)

portal_ts = open(os.path.join(ROOT, "lib", "omniflow", "portal.ts"),
                 encoding="utf8").read()
check("portal get helper", "getWeeklyProblemsSettings" in portal_ts, "get")
check("portal save helper", "saveWeeklyProblemsSettings" in portal_ts, "save")
check("portal send helper", "sendWeeklyProblemsNow" in portal_ts, "send")

summary("weekly_problems")
