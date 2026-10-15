"""Tests for the COD confirmation flow (Phases 126-130)."""
import sys

from flask import Flask

import portal_cod
import test_lib
from test_lib import check, human_principal, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_cod.bp)
client = app.test_client()

human = human_principal(client_id=1, user_id=11, email="ahmed@example.com")
PrincipalStub(portal_cod, principal=human)


def fresh(script):
    portal_cod._COD_DDL_READY = False
    conn = install_db_stub(portal_cod, script)
    portal_cod.portal_db.CMD_TABLE = "portal_connector_commands"
    return conn


print("== settings endpoints ==")

conn = fresh([[], [], [], []])
response = client.get("/api/v1/portal/cod/settings")
check("200 default settings", status(response) == 200
      and response.get_json()["settings"]["enabled"] is False
      and "YES" in response.get_json()["settings"]["template"], status(response))

conn = fresh([[], [], [], []])
response = client.put("/api/v1/portal/cod/settings",
                      json={"enabled": True, "template": "Confirm karein {name}: YES/NO"})
check("200 save", status(response) == 200 and response.get_json()["ok"] is True, status(response))
check("upsert sql", "ON CONFLICT (client_id) DO UPDATE" in conn.cur.executed[3][0])

response = client.put("/api/v1/portal/cod/settings",
                      json={"enabled": "yes", "template": "x"})
check("400 enabled not bool", status(response) == 400, status(response))

response = client.put("/api/v1/portal/cod/settings",
                      json={"enabled": True, "template": "   "})
check("400 empty template", status(response) == 400, status(response))

response = client.put("/api/v1/portal/cod/settings",
                      json={"enabled": True, "template": "x" * 1001})
check("400 long template", status(response) == 400, status(response))

print("== requests endpoint ==")

ROWS = [{"id": 4, "conversation_id": 9, "contact_id": "92300@c.us",
         "contact_name": "Ali", "status": "confirmed",
         "created_at": None, "answered_at": None}]
conn = fresh([[], [], [], ROWS])
response = client.get("/api/v1/portal/cod/requests?status=confirmed")
check("200 list", status(response) == 200
      and response.get_json()["requests"][0]["id"] == 4, status(response))
check("status filter in sql", "status = %s" in conn.cur.executed[3][0]
      and conn.cur.executed[3][1][-1] == "confirmed", conn.cur.executed[3][1])
check("counts derived", response.get_json()["counts"]["confirmed"] == 1, response.get_json()["counts"])

response = client.get("/api/v1/portal/cod/requests?status=bogus")
check("400 bad status", status(response) == 400, status(response))

PrincipalStub(portal_cod, principal=None)
response = client.get("/api/v1/portal/cod/settings")
check("401 without session", status(response) == 401, status(response))
PrincipalStub(portal_cod, principal=human)

print("== maybe_cod_flow ==")

def run_flow(body, direction="in", script=None):
    conn = fresh(script or [[{"enabled": True, "template": "Confirm {name}!"}], []])
    portal_cod.maybe_cod_flow(1, 9, "92300@c.us", "Ali Khan", body, direction, conn)
    return conn

conn = run_flow("order", direction="out", script=[])
check("outbound no-op", len(conn.cur.executed) == 0, len(conn.cur.executed))

conn = run_flow("order", script=[[{"enabled": False, "template": ""}]])
check("disabled stops early", len(conn.cur.executed) == 1, len(conn.cur.executed))

PENDING = [{"id": 12, "status": "pending"}]

conn = fresh([[{"enabled": True, "template": "Confirm!"}], PENDING, [], []])
portal_cod.maybe_cod_flow(1, 9, "92300@c.us", "Ali", "haan confirm", "in", conn)
check("yes updates confirmed", conn.cur.executed[2][1][0] == "confirmed"
      and conn.cur.executed[2][1][1] == 12, conn.cur.executed[2][1])
check("yes audit", conn.cur.executed[3][1][1] == "cod.confirmed", conn.cur.executed[3][1])

conn = fresh([[{"enabled": True, "template": "Confirm!"}], PENDING, [], []])
portal_cod.maybe_cod_flow(1, 9, "92300@c.us", "Ali", "NAHI cancel", "in", conn)
check("no updates declined", conn.cur.executed[2][1][0] == "declined", conn.cur.executed[2][1])

conn = run_flow("kya rate hai?", script=[[{"enabled": True, "template": "C"}], PENDING])
check("unrelated keeps pending", len(conn.cur.executed) == 2, len(conn.cur.executed))

conn = fresh([[{"enabled": True, "template": "Confirm {name}!"}], [], [{}], [], [], []])
portal_cod.maybe_cod_flow(1, 9, "92300@c.us", "Ali Khan", "order karna hai", "in", conn)
inserts = [e for e in conn.cur.executed
           if "INSERT INTO" in e[0] and "portal_action_log" not in e[0]]
check("ask inserts request + command", len(inserts) == 2, len(inserts))
import json as _json
cmd_payload = inserts[1][1][2]
if isinstance(cmd_payload, str):
    cmd_payload = _json.loads(cmd_payload)
check("command payload cod", cmd_payload.get("source") == "cod_confirm"
      and cmd_payload.get("external_user_id") == "92300@c.us", cmd_payload)
check("template personalized", "Confirm Ali!" == cmd_payload.get("body"), cmd_payload.get("body"))
check("ask audit", conn.cur.executed[5][1][1] == "cod.confirm_sent", conn.cur.executed[5][1])

conn = run_flow("order", script=[[{"enabled": True, "template": "C"}], [], []])
check("warm lead not asked", len(conn.cur.executed) == 3, len(conn.cur.executed))

conn = run_flow("order", script=[[{"enabled": True, "template": "C"}], [], []])
check("cooldown blocks ask", len(conn.cur.executed) == 3, len(conn.cur.executed))

print("== structural ==")
app_src = open("/tmp/p13/OmniFlow-Control-Plane/app.py").read()
check("app registers cod", "register_blueprint(portal_cod_bp)" in app_src)
conn_src = open("/tmp/p13/OmniFlow-Control-Plane/connector_api.py").read()
check("hook after away", conn_src.index("maybe_cod_flow(") > conn_src.index("_maybe_enqueue_away_reply("))
check("hook in-only by design", 'direction != "in"' in open("/tmp/p13/OmniFlow-Control-Plane/portal_cod.py").read())
lib_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("lib exports", "export async function getCodSettings(" in lib_src
      and "export async function listCodRequests(" in lib_src)
bff1 = open("/tmp/p13/Omniflow/app/api/omniflow/portal/cod/route.ts").read()
bff2 = open("/tmp/p13/Omniflow/app/api/omniflow/portal/cod/requests/route.ts").read()
check("bff depths", bff1.count("../") == 15 and bff2.count("../") == 18,
      (bff1.count("../"), bff2.count("../")))
page_src = open("/tmp/p13/Omniflow/app/dashboard/(portal)/cod/page.tsx").read()
check("page client + filters", page_src.startswith('"use client"') and "aria-pressed" in page_src)
nav_src = open("/tmp/p13/Omniflow/app/dashboard/components/DashSidebar.tsx").read()
check("nav item inserted", 'href: "/dashboard/cod"' in nav_src)

failures = summary("cod")
sys.exit(1 if failures else 0)
