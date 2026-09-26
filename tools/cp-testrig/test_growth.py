"""Tests for B4: portal_obs (trace + slow-log), portal_rollups (rollup
math pins, trend reader) and the one-call Growth bundle (composition,
cache, kill switch) + web wiring pins."""
import json
import time

from flask import Flask

import portal_obs
import portal_rollups
import portal_db
from test_lib import install_db_stub
from test_lib import check, summary

PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}


def fresh(script, module=portal_rollups):
    portal_rollups._DDL_READY = True
    return install_db_stub(module, script)


# ---------- portal_obs: trace header + slow log ----------

app = Flask("obs-test")
portal_obs.install_obs(app)
client = app.test_client()


@app.get("/quick")
def _quick():
    return {"ok": True}


@app.get("/slow")
def _slow():
    time.sleep(0.05)
    return {"ok": True}


portal_obs.SLOW_MS = 10
lines = []


import logging


class ListHandler(logging.Handler):
    def emit(self, record):
        lines.append(record.getMessage())


obs_logger = logging.getLogger("omniflow.obs")
obs_logger.setLevel(logging.INFO)
lh = ListHandler()
obs_logger.addHandler(lh)

r1 = client.get("/quick")
r2 = client.get("/slow")
t1 = r1.headers.get("X-OF-Trace-Id")
t2 = r2.headers.get("X-OF-Trace-Id")
check("trace header present", bool(t1) and bool(t2)
      and t1 != t2, (t1, t2))
slow_logs = [x for x in lines if '"path":"/slow"' in x]
quick_logs = [x for x in lines if '"path":"/quick"' in x]
check("slow request logged once", len(slow_logs) == 1, slow_logs)
check("fast request not logged", len(quick_logs) == 0, quick_logs)
log_line = slow_logs[0] if slow_logs else ""
check("log fields structured", all(k in log_line for k in (
    "trace_id", "method", "path", "duration_ms", "status")), log_line)
check("trace id in log line", t2 in log_line, (t2, log_line))
obs_logger.removeHandler(lh)
portal_obs.SLOW_MS = 400

# ---------- rollups: refresh SQL pins + trend reader ----------

conn = fresh([[], [], []])
with conn.cur as cur:
    portal_rollups.refresh_recent(cur, 1, 14)
sqls = [sql for sql, params in conn.cur.executed]
check("ddl skipped via flag", "CREATE TABLE" not in sqls[0]
      and "'msgs_' || direction" in sqls[0], sqls[0][:60])
check("msgs rollup grouped by day+direction",
      any("'msgs_' || direction" in s and "GROUP BY" in s
          and "ON CONFLICT (client_id, day, kind, key)" in s
          for s in sqls), "upsert")
check("revenue rollup from paid links",
      any("'revenue'" in s and "SUM(COALESCE(paid_amount, 0))" in s
          and "status = 'paid'" in s for s in sqls), "revenue")
check("orders rollup counts paid links",
      any("'orders'" in s and "COUNT(*)" in s for s in sqls), "orders")

conn = fresh([[{"day": None, "value": 3}], []])
with conn.cur as cur:
    trend = portal_rollups.read_trend(cur, 1, "msgs_in", 30)
check("trend reader shape", trend == [{"day": None, "value": 3}], trend)

# ---------- bundle: composition + cache + kill switch ----------

# keyed by PATH BASENAME (the stub dispatches on the last path part)
SEG_SAMPLE = {
    "churn": {"contacts": [{"contactId": "9x", "chats": 3}]},
    "radar": {"contacts": []},
    "summary": {"total": 25000},
    "items": {"items": []},
    "staffing": {"hours": []},
    "broadcast-suggestions": {"suggestions": []},
    "settings": {"settings": {"enabled": False}},
    "links": {"links": []},
    "rules": {"rules": []},
    "hits": {"hits": []},
    "restock": {"products": []},
    "customer-analytics": {"customers": [], "languages": []},
    "product-analytics": {"products": []},
}
SEG_SAMPLE["trends_probe"] = {"ok": True}

calls = []
orig_run = portal_rollups._run_segment
portal_rollups._run_segment = lambda path, query: (
    calls.append((path, query)) or
    (SEG_SAMPLE.get(path.rsplit("/", 1)[-1], {"x": 1}), 200))
orig_conn = portal_rollups.portal_db._conn


class TrendConn:
    """Minimal conn: context manager + cursor() for the trends block."""

    def __init__(self):
        self.cur = install_db_stub(
            portal_rollups,
            [[], [{"day": "2026-09-20", "value": 5}], [],
             [{"day": "2026-09-20", "value": 1200}], []],
            module_ready=True)["cur"] if False else _FakeCur()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def close(self):
        pass

    def commit(self):
        pass

    def cursor(self):
        return self.cur


class _FakeCur:
    """fetchall feeds read_trend: msgs_in, msgs_out, revenue, orders."""

    FETCHES = [[("2026-09-20", 5)],
               [],
               [("2026-09-20", 1200)],
               []]

    description = [("day",), ("value",)]

    def __init__(self):
        self.queue = [rows for rows in self.FETCHES]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=()):
        pass

    def fetchall(self):
        return self.queue.pop(0) if self.queue else []


trend_conn = TrendConn()
portal_rollups.portal_db._conn = lambda: trend_conn
portal_rollups._BUNDLE_CACHE.clear()
bundle = portal_rollups.build_bundle(1, 14)
check("bundle has 14 segments",
      len(bundle["segments"]) == 14, list(bundle["segments"]))
check("bundle segment payloads pass through",
      bundle["segments"]["churn"]["contacts"][0]["contactId"] == "9x",
      bundle["segments"]["churn"])
check("bundle trends embedded",
      bundle["trends"]["revenue"][0]["value"] == 1200, bundle["trends"])
check("bundle days echo", bundle["days"] == 14, bundle["days"])
first_build = len(calls)
again = portal_rollups.build_bundle(1, 14)
check("bundle cached within ttl",
      len(calls) == first_build and again is bundle, "no rebuild")
freshness = portal_rollups.build_bundle(1, 7)
check("different days rebuilds", len(calls) > first_build, "rebuild")
check("cache key separates days",
      portal_rollups._BUNDLE_CACHE[(1, 14)] is not None
      and (1, 7) in portal_rollups._BUNDLE_CACHE, "two keys")
check("days query only on days segments",
      all(("days=14" in q) == (p.split("/")[-1] in (
          "churn", "summary", "items", "customer-analytics",
          "product-analytics"))
          for p, q in calls[:14] if "restock" not in p),
      [(p, q) for p, q in calls[:14]])
# radar keeps its fixed limit
check("radar segment keeps limit=5",
      any(p.endswith("/churn/radar") and q == "limit=5"
          for p, q in calls), "limit")

# kill switch + endpoint behaviour
app2 = Flask("bundle-test")
app2.register_blueprint(portal_rollups.bp)
c2 = app2.test_client()


class PrincipalStub:
    """Injects the owner principal into authenticate_portal_request."""

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


portal_rollups._BUNDLE_CACHE.clear()
with PrincipalStub(portal_rollups, PRINCIPAL):
    r_ok = c2.get("/api/v1/portal/growth-bundle?days=14")
check("bundle endpoint 200", r_ok.status_code == 200, r_ok.status_code)
check("bundle endpoint payload",
      r_ok.get_json()["segments"]["revenue"]["total"] == 25000,
      "segment passthrough")
portal_rollups.BUNDLE_ENABLED = False
with PrincipalStub(portal_rollups, PRINCIPAL):
    r_off = c2.get("/api/v1/portal/growth-bundle")
check("bundle kill switch 503", r_off.status_code == 503,
      r_off.status_code)
check("bundle kill switch code",
      r_off.get_json()["error"]["code"] == "bundle_disabled", "code")
portal_rollups.BUNDLE_ENABLED = True
with PrincipalStub(portal_rollups, {"via_api_key": True}):
    r_key = c2.get("/api/v1/portal/growth-bundle")
check("bundle rejects api keys", r_key.status_code == 403, r_key.status_code)
with PrincipalStub(portal_rollups, None):
    r_anon = c2.get("/api/v1/portal/growth-bundle")
check("bundle 401 anonymous", r_anon.status_code == 401, r_anon.status_code)

# segment runner: tuple (jsonify, code) vs response handling
portal_rollups._run_segment = orig_run
with PrincipalStub(portal_rollups, PRINCIPAL),         app2.test_request_context("/api/v1/portal/growth-bundle",
                               headers={"Authorization": "Bearer x"}):
    payload, code = portal_rollups._run_segment(
        "/api/v1/portal/growth-bundle", "")
    check("segment runner unwraps tuple", code == 200
          and payload.get("segments"), (code,))

# days clamping
with PrincipalStub(portal_rollups, PRINCIPAL):
    r_big = c2.get("/api/v1/portal/growth-bundle?days=9999")
check("bundle clamps days", r_big.get_json()["days"] == 90,
      r_big.get_json().get("days"))

# ---------- web wiring pins ----------

PAGE = open("/tmp/p13/Omniflow/app/dashboard/(portal)/growth/page.tsx",
            encoding="utf8").read()
check("page uses bundle first",
      '"/api/omniflow/portal/growth-bundle?days=" + days' in PAGE,
      "bundle call")
check("page keeps legacy fallback",
      "loadLegacy" in PAGE and "Promise.all" in PAGE, "fallback")
check("page maps segments",
      "segments" in PAGE and "setChurn(" in PAGE and "setRevenue(" in PAGE,
      "mapping")
BFF = open("/tmp/p13/Omniflow/app/api/omniflow/portal/growth-bundle"
           "/route.ts", encoding="utf8").read()
check("bff growth-bundle exists",
      "export async function GET" in BFF
      and "getGrowthBundle" in BFF, "route")
PORTAL = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts",
              encoding="utf8").read()
check("portal.ts client fn",
      "export async function getGrowthBundle" in PORTAL
      and "api/v1/portal/growth-bundle" in PORTAL, "client")
check("portal.ts bundle_disabled sentinel",
      '"bundle_disabled"' in PORTAL, "sentinel")

# app.py wiring pins (obs + rollups bp)
APP = open("/tmp/smoke971/app.py", encoding="utf8").read()
check("app.py installs obs", "install_obs(aux_app)" in APP, "obs")
check("app.py registers rollups bp",
      "aux_app.register_blueprint(portal_rollups_bp)" in APP, "bp")

summary("growth")
