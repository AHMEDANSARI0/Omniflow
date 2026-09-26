"""Tests for business hours storage (Phases 101-103)."""
import json
import sys

from flask import Flask

import portal_conversations
import test_lib
from test_lib import check, human_principal, install_db_stub, PrincipalStub, status, summary, portal_page_source, portal_thread_source

app = Flask(__name__)
app.register_blueprint(portal_conversations.bp)
client = app.test_client()
portal_conversations._STAR_COLUMN_READY = True
portal_conversations._SETTINGS_TABLE_READY = True

human = human_principal(client_id=1, user_id=11, email="ahmed@example.com")
GOOD_CONFIG = {
    "enabled": True,
    "timezone": "Asia/Karachi",
    "days": [{"enabled": index % 2 == 0, "start": "09:00", "end": "17:00"} for index in range(7)],
    "away_message": "We are away.",
}

print("== business hours ==")

PrincipalStub(portal_conversations, principal=None)
conn = install_db_stub(portal_conversations, [])
response = client.get("/api/v1/portal/business-hours")
check("401 get", status(response) == 401 and len(conn.cur.executed) == 0, status(response))
conn = install_db_stub(portal_conversations, [])
response = client.put("/api/v1/portal/business-hours", json={"business_hours": GOOD_CONFIG})
check("401 put", status(response) == 401 and len(conn.cur.executed) == 0, status(response))

PrincipalStub(portal_conversations, principal=human)
conn = install_db_stub(portal_conversations, [[]])
response = client.get("/api/v1/portal/business-hours")
check("200 get defaults", status(response) == 200, status(response))
config = response.get_json()["business_hours"]
check("defaults shape", config["enabled"] is False and len(config["days"]) == 7 and config["timezone"] == "Asia/Karachi", config)
check("selects json key", "settings -> 'business_hours'" in conn.cur.executed[0][0], conn.cur.executed[0][0])
check("select params", conn.cur.executed[0][1] == (1,), conn.cur.executed[0][1])

conn = install_db_stub(portal_conversations, [[{"business_hours": GOOD_CONFIG}]])
response = client.get("/api/v1/portal/business-hours")
check("returns stored", response.get_json()["business_hours"] == GOOD_CONFIG)

conn = install_db_stub(portal_conversations, [[], []])
response = client.put("/api/v1/portal/business-hours", json={"business_hours": GOOD_CONFIG})
check("200 put", status(response) == 200 and response.get_json()["ok"] is True, status(response))
sql = conn.cur.executed[0][0]
check("upsert sql", "ON CONFLICT (client_id)" in sql and "settings || EXCLUDED.settings" in sql, sql[-120:])
check("upsert params", conn.cur.executed[0][1][0] == 1 and json.loads(conn.cur.executed[0][1][1])["business_hours"] == GOOD_CONFIG)
check("audit logged", conn.cur.executed[1][1][1] == "business_hours.update", conn.cur.executed[1][1])

for name, payload in [
    ("not an object", "nope"),
    ("short days", {**GOOD_CONFIG, "days": GOOD_CONFIG["days"][:3]}),
    ("bad time", {**GOOD_CONFIG, "days": [{"enabled": True, "start": "9:99", "end": "17:00"} for _ in range(7)]}),
    ("long message", {**GOOD_CONFIG, "away_message": "x" * 501}),
    ("missing enabled", {k: v for k, v in GOOD_CONFIG.items() if k != "enabled"}),
]:
    conn = install_db_stub(portal_conversations, [])
    response = client.put("/api/v1/portal/business-hours", json={"business_hours": payload})
    check("400 " + name, status(response) == 400 and len(conn.cur.executed) == 0, status(response))

portal_conversations._SETTINGS_TABLE_READY = False
conn = install_db_stub(portal_conversations, [[]])
client.get("/api/v1/portal/business-hours")
check("lazy ddl", "CREATE TABLE IF NOT EXISTS" in conn.cur.executed[0][0], conn.cur.executed[0][0][:90])
portal_conversations._SETTINGS_TABLE_READY = True

print("== structural ==")

lib_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("lib types", "export interface BusinessHoursConfig {" in lib_src)
check("lib get", "export async function getBusinessHours(" in lib_src)
check("lib put rejected kind", 'kind: "rejected"' in lib_src)
bff_src = open("/tmp/p13/Omniflow/app/api/omniflow/portal/business-hours/route.ts").read()
check("bff get+put", "export async function GET()" in bff_src and "export async function PUT(" in bff_src)
check("bff five levels", 'from "../../../../../lib/omniflow/portal";' in bff_src)
card_src = open("/tmp/p13/Omniflow/app/dashboard/(portal)/settings/BusinessHoursCard.tsx").read()
check("card live pill", "Open now" in card_src and "Closed now" in card_src)
check("card intl timezone", 'timeZone: config.timezone' in card_src)
check("card save put", 'method: "PUT"' in card_src)
settings_src = open("/tmp/p13/Omniflow/app/dashboard/(portal)/settings/page.tsx").read()
check("settings renders card", "<BusinessHoursCard />" in settings_src)
detail_src = portal_thread_source()
check("dynamic cards", 'const RatingCard = dynamic(() => import("./RatingCard"));' in detail_src)
inbox_src = portal_page_source("conversations")
check("poll 15s", "const POLL_MS = 15_000;" in inbox_src)

failures = summary("business_hours")
sys.exit(1 if failures else 0)
