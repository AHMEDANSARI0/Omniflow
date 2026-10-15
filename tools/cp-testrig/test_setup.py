"""Tests for the setup progress endpoint (Phases 141-145)."""
import sys

from flask import Flask

import portal_setup
import test_lib
from test_lib import check, human_principal, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_setup.bp)
client = app.test_client()

human = human_principal(client_id=1, user_id=11, email="ahmed@example.com")
PrincipalStub(portal_setup, principal=human)


def install(script):
    conn = install_db_stub(portal_setup, script)
    portal_setup.portal_db.STATUS_TABLE = "portal_whatsapp_status"
    return conn

FULL_SCRIPT = [
    [{"state": "connected"}],
    [{"bh": {"enabled": True, "timezone": "Asia/Karachi"}}],
    [{"oid": "portal_kb_entries"}],
    [{"total": 3}],
    [{"total": 9}],
    [{"oid": "portal_broadcasts"}],
    [{"1": 1}],
    [{"oid": "portal_cod_settings"}],
    [{"1": 1}],
]

print("== endpoint ==")

conn = install(FULL_SCRIPT)
response = client.get("/api/v1/portal/setup/status")
check("200 status", status(response) == 200, status(response))
checks = response.get_json()["setup"]["checks"]
check("all seven keys", set(checks.keys()) == {"whatsapp", "hours", "away", "kb", "customers", "broadcast", "cod"}, checks.keys())
check("all done true", all(checks.values()), checks)
check("client scoped everywhere", conn.cur.executed[0][1] == (1,)
      and conn.cur.executed[3][1] == (1,), conn.cur.executed[0][1])

conn = install([[{"state": "disconnected"}]] + FULL_SCRIPT[1:])
checks = client.get("/api/v1/portal/setup/status").get_json()["setup"]["checks"]
check("disconnected whatsapp false", checks["whatsapp"] is False, checks)

conn = install([[], [{"bh": None}]] + FULL_SCRIPT[2:])
checks = client.get("/api/v1/portal/setup/status").get_json()["setup"]["checks"]
check("no hours config", checks["hours"] is False and checks["away"] is False, checks)

conn = install([FULL_SCRIPT[0], FULL_SCRIPT[1], [{"oid": None}], [], FULL_SCRIPT[4],
                                      FULL_SCRIPT[5], FULL_SCRIPT[6], FULL_SCRIPT[7], FULL_SCRIPT[8]])
checks = client.get("/api/v1/portal/setup/status").get_json()["setup"]["checks"]
check("missing kb table safe", checks["kb"] is False, checks)

conn = install([FULL_SCRIPT[0], [{"bh": {"enabled": False}}], FULL_SCRIPT[2], FULL_SCRIPT[3],
                                      FULL_SCRIPT[4], [{"oid": None}], [],
                                      [{"oid": "portal_cod_settings"}], []])
checks = client.get("/api/v1/portal/setup/status").get_json()["setup"]["checks"]
check("away off + no broadcast + cod off", checks["away"] is False
      and checks["broadcast"] is False and checks["cod"] is False, checks)

PrincipalStub(portal_setup, principal=None)
response = client.get("/api/v1/portal/setup/status")
check("401 without session", status(response) == 401, status(response))
PrincipalStub(portal_setup, principal=human)

print("== structural ==")
app_src = open("/tmp/p13/OmniFlow-Control-Plane/app.py").read()
check("app registers setup", "register_blueprint(portal_setup_bp)" in app_src)
lib_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("lib exports setup", "export async function getSetupStatus(" in lib_src)
bff = open("/tmp/p13/Omniflow/app/api/omniflow/portal/setup/route.ts").read()
check("bff depth five", bff.count("../") == 15, bff.count("../"))
card = open("/tmp/p13/Omniflow/app/dashboard/components/SetupChecklist.tsx").read()
check("card seven items", card.count("href: \"/dashboard/") == 7)
check("card responsive grid", "sm:grid-cols-2" in card)
page_src = open("/tmp/p13/Omniflow/app/dashboard/(portal)/page.tsx").read()
check("overview renders card", "<SetupChecklist />" in page_src
      and page_src.index("<SetupChecklist />") < page_src.index("{overview && ("))

failures = summary("setup")
sys.exit(1 if failures else 0)
