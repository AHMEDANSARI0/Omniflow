"""Tests for B12: portal_perf (hot index DDL, counts, live timings,
pg_indexes report, human-only) + wiring pins (client, BFF, PerfCard,
settings mount, bridge fallback helpers in the B11/B12 patchers)."""
import json

from flask import Flask

import portal_perf
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


def fresh(script):
    portal_perf._DDL_READY = False
    return install_db_stub(portal_perf, script)


def run_api(script, principal=PRINCIPAL):
    fresh(script)
    app = Flask("perf-test")
    app.register_blueprint(portal_perf.bp)
    with PrincipalStub(portal_perf, principal):
        return app.test_client().get("/api/v1/portal/perf")


# slot map (first run): 5 DDL + 4 counts + 3 timings + 1 pg_indexes
SCRIPT = [
    [], [], [], [], [],                                   # DDL x5
    [{"n": 12}],                                          # conversations
    [{"n": 340}],                                         # messages
    [{"n": 88}],                                          # actions
    [{"n": 4}],                                           # checkout links
    [],                                                   # timing: convs
    [],                                                   # timing: msgs
    [],                                                   # timing: links
    [{"indexname": "idx_portal_conv_client_updated"},
     {"indexname": "idx_portal_msgs_conv_id"},
     {"indexname": "conv_pkey"}],                          # pg_indexes
]

r = run_api(SCRIPT)
body = r.get_json()
check("perf 200", r.status_code == 200, r.status_code)
check("counts shape", body["counts"] == {
    "conversations": 12, "messages": 340, "actions": 88,
    "checkout_links": 4}, body["counts"])
check("timings numeric", all(isinstance(v, (int, float))
                             for v in body["timings_ms"].values()),
      body["timings_ms"])
check("indexes listed", "conv_pkey" in body["indexes"]
      and len(body["indexes"]) == 3, body["indexes"])
check("missing detected", body.get("missing_hot_indexes")
      == ["idx_portal_action_log_client",
          "idx_portal_checkout_contact",
          "idx_portal_msgs_client_created"], body.get("missing_hot_indexes"))
check("ok False while missing", body["ok"] is False, body["ok"])

conn = fresh(SCRIPT)
with PrincipalStub(portal_perf, PRINCIPAL):
    app = Flask("p2"); app.register_blueprint(portal_perf.bp)
    app.test_client().get("/api/v1/portal/perf")
ddls = [e[0] for e in conn.cur.executed[:5]]
check("5 hot indexes created", sum("CREATE INDEX IF NOT EXISTS" in s
                                   for s in ddls) == 5, ddls)
check("index on conversations updated",
      any("portal_conversations" in s and "updated_at DESC" in s
          for s in ddls), ddls)
check("index on messages conv+id",
      any("portal_messages" in s and "conversation_id, id DESC" in s
          for s in ddls), ddls)
check("index tenant scoped audit",
      any("portal_action_log" in s and "client_id, id DESC" in s
          for s in ddls), ddls)
check("timings are SELECTs", all(
    "SELECT" in e[0] for e in conn.cur.executed[9:12]), "timed")
check("pg_indexes query", "pg_indexes" in conn.cur.executed[12][0],
      "catalog")

# second process run: DDL flag cached -> no extra DDL executes
conn = fresh([[{"n": 1}]] * 4 + [[], [], []] +
             [[{"indexname": n} for n in
               ("idx_portal_conv_client_updated",
                "idx_portal_msgs_conv_id",
                "idx_portal_msgs_client_created",
                "idx_portal_action_log_client",
                "idx_portal_checkout_contact")]])
portal_perf._DDL_READY = True
with PrincipalStub(portal_perf, PRINCIPAL):
    app = Flask("p3"); app.register_blueprint(portal_perf.bp)
    r = app.test_client().get("/api/v1/portal/perf")
check("warm run all present", r.get_json()["ok"] is True
      and r.get_json()["missing_hot_indexes"] == [], r.get_json())
check("warm run skips DDL", all(
    "CREATE INDEX" not in e[0] for e in conn.cur.executed), "no-ddl")

r = run_api([[]], principal=dict(PRINCIPAL, via_api_key=True))
check("perf api key 403", r.status_code == 403, r.status_code)
conn = fresh([{"x": None}])
portal_perf.authenticate_portal_request = lambda: None
portal_perf.PortalAuthUnavailable = Exception
app = Flask("p4"); app.register_blueprint(portal_perf.bp)
check("perf 401 no session", app.test_client().get(
    "/api/v1/portal/perf").status_code == 401, "401")

# ---------- wiring pins ----------

APP = open("/tmp/smoke971/app.py", encoding="utf8").read()
check("app.py registers perf bp",
      "aux_app.register_blueprint(portal_perf_bp)" in APP, "bp")
PORTAL = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts",
              encoding="utf8").read()
check("client getPerfReport", "export async function getPerfReport"
      in PORTAL, "client")
BASE = "/tmp/smoke971/"
BFF = open(BASE + "bff_perf.ts", encoding="utf8").read()
check("bff perf", "export async function" in BFF
      and "getPerfReport" in BFF, "bff")
CARD = open(BASE + "perf_card.tsx", encoding="utf8").read()
check("perf card", "Performance" in CARD
      and "timings_ms" in CARD and "Refresh" in CARD, "card")
SETTINGS = open(BASE + "settings_page.tsx", encoding="utf8").read()
check("settings mounts perf card", "<PerfCard />" in SETTINGS
      and 'import PerfCard from "./PerfCard";' in SETTINGS, "mount")

summary("perf")
