"""206-210: night guard (quiet hours) for sequence auto-sends."""
import os

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")

from flask import Flask

import portal_sequences, test_lib
from test_lib import check, human_principal, install_db_stub, summary, PrincipalStub

SRC = open("portal_sequences.py", encoding="utf8").read()
PORTAL_TS = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts", encoding="utf8").read()
BFF = open(
    "/tmp/p13/Omniflow/app/api/omniflow/portal/sequences/settings/route.ts",
    encoding="utf8",
).read()
PAGE = open(
    "/tmp/p13/Omniflow/app/dashboard/(portal)/sequences/page.tsx", encoding="utf8"
).read()

DDL = [[], [], [], [], [], [], [], [], [], []]  # 4 CREATE + ALTER tk + settings + ALTER por + ALTER oii + step_log + idx


def fresh(script):
    portal_sequences._SEQ_DDL_READY = False
    conn = install_db_stub(portal_sequences, DDL + script)
    portal_sequences.portal_db.CMD_TABLE = "portal_connector_commands"
    return conn


app = Flask(__name__)
app.register_blueprint(portal_sequences.bp)
client = app.test_client()
human = human_principal(client_id=1, user_id=11, email="ahmed@example.com")
PrincipalStub(portal_sequences, principal=human)

print("== GET settings ==")

conn = fresh([[]])
response = client.get("/api/v1/portal/sequences/settings")
payload = response.get_json()
check("200 defaults", response.status_code == 200 and payload == {
    "quiet_enabled": False, "quiet_start": 22, "quiet_end": 8, "utc_offset": 5,
}, payload)

conn = fresh([[{"quiet_enabled": True, "quiet_start": 21, "quiet_end": 9,
                "utc_offset": 0}]])
response = client.get("/api/v1/portal/sequences/settings")
check("200 stored row", response.get_json()["quiet_start"] == 21
      and response.get_json()["utc_offset"] == 0, response.get_json())

PrincipalStub(portal_sequences, principal=None)
conn = fresh([[]])
response = client.get("/api/v1/portal/sequences/settings")
check("401 unauth", response.status_code == 401, response.status_code)
PrincipalStub(portal_sequences, principal=human)

print("== PUT settings ==")

conn = fresh([])
response = client.put("/api/v1/portal/sequences/settings",
                      json={"quiet_enabled": "yes"})
check("400 non-bool enabled", response.status_code == 400, response.status_code)
response = client.put("/api/v1/portal/sequences/settings",
                      json={"quiet_enabled": True, "quiet_start": 24})
check("400 hour 24", response.status_code == 400, response.status_code)
response = client.put("/api/v1/portal/sequences/settings",
                      json={"quiet_enabled": True, "quiet_start": 22,
                            "quiet_end": True})
check("400 bool hour", response.status_code == 400, response.status_code)
response = client.put("/api/v1/portal/sequences/settings",
                      json={"quiet_enabled": True, "quiet_start": 22,
                            "quiet_end": 8, "utc_offset": 15})
check("400 offset 15", response.status_code == 400, response.status_code)

conn = fresh([[], []])
response = client.put("/api/v1/portal/sequences/settings",
                      json={"quiet_enabled": True, "quiet_start": 22,
                            "quiet_end": 8, "utc_offset": 5})
check("200 save", response.status_code == 200 and response.get_json() == {"ok": True},
      response.status_code)
upsert = conn.cur.executed[10]
check("upsert sql", "ON CONFLICT (client_id) DO UPDATE" in upsert[0], upsert[0][:60])
check("upsert params", upsert[1][:5] == (1, True, 22, 8, 5)
      and upsert[1][5:] == (True, 22, 8, 5), upsert[1])
check("quiet audit", conn.cur.executed[11][1][1] == "sequence.quiet_updated",
      conn.cur.executed[11][1])
check("audit window text", "22:00-08:00" in str(conn.cur.executed[11][1]),
      conn.cur.executed[11][1])

conn = fresh([[], []])
response = client.put("/api/v1/portal/sequences/settings",
                      json={"quiet_enabled": False, "quiet_start": 0,
                            "quiet_end": 23, "utc_offset": -5})
check("200 extremes", response.status_code == 200, response.status_code)
check("negative offset kept", conn.cur.executed[10][1][4] == -5, conn.cur.executed[10][1])

print("== delivery filter ==")

check("NOT EXISTS in due query", "AND NOT EXISTS (" in
      SRC.split("def deliver_due_sequence_steps")[1][:1600], "not exists")
seg = SRC.split("def deliver_due_sequence_steps")[1][:1600]
check("settings table joined", "SETTINGS_TABLE" in seg, "table")
check("guard flag checked", "q.quiet_enabled IS TRUE" in seg, "flag")
check("normal window branch", "q.quiet_start < q.quiet_end" in seg, "branch1")
check("wrap window branch", "q.quiet_start > q.quiet_end" in seg, "branch2")
check("utc offset math", "EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC')::int"
      " + q.utc_offset" in seg.replace("\n            ", " ").replace("\n", " ")
      or "+ q.utc_offset" in seg, "offset")
check("client param twice", "(client_id, client_id)," in seg, "params")
check("settings created lazily", "SETTINGS_TABLE" in
      SRC.split("def _ensure_seq_tables")[1].split("def _parse_steps")[0]
      and "quiet_enabled BOOLEAN NOT NULL DEFAULT FALSE" in SRC, "ddl")

print("== portal clients ==")

check("settings type", "export interface SequenceSettings {" in PORTAL_TS, "type")
check("get client", "export async function getSequenceSettings(" in PORTAL_TS, "get")
seg = PORTAL_TS.split("getSequenceSettings(")[1][:900]
check("get url", "api/v1/portal/sequences/settings" in seg, "url")
check("get defaults", "quiet_start === \"number\" ? row.quiet_start : 22" in seg
      or "row.quiet_start" in seg, "defaults")
seg = PORTAL_TS.split("saveSequenceSettings(")[1][:1000]
check("save wire snake", "quiet_enabled: settings.quietEnabled" in seg
      and "utc_offset: settings.utcOffset" in seg, "snake")
check("save before deleteSequence", PORTAL_TS.index("saveSequenceSettings(")
      < PORTAL_TS.index("export async function deleteSequence("), "order")

print("== BFF route ==")

check("6 ups import", '"../../../../../../lib/omniflow/portal"' in BFF, "depth")
check("GET handler", "export async function GET(" in BFF, "get")
check("PUT handler", "export async function PUT(" in BFF, "put")
check("validates integers", "Number.isInteger(quietStart)" in BFF
      and "Number.isInteger(utcOffset)" in BFF, "int")
check("hour bounds", "quietStart > 23" in BFF and "quietEnd < 0" in BFF, "bounds")
check("offset bounds", "utcOffset < -12" in BFF and "utcOffset > 14" in BFF, "offset")
check("forwards camel", "quietEnabled," in BFF and "quietEnd," in BFF, "forward")

print("== page ==")

check("night guard card", "Night guard" in PAGE, "card")
check("guard hint", "nobody gets woken" in PAGE, "hint")
check("pause from selects", "Pause from" in PAGE and "hourLabel" in PAGE, "selects")
check("tz offset select", "(Pakistan)" in PAGE and "UTC" in PAGE, "offset")
check("saveQuiet puts", '"/api/omniflow/portal/sequences/settings"' in
      PAGE.split("const saveQuiet")[1][:800] and '"PUT"' in
      PAGE.split("const saveQuiet")[1][:800], "put")
check("quiet states", "quietBusy" in PAGE and "quietNote" in PAGE, "states")
check("hand replies never blocked", "never blocked" in PAGE, "copy")

summary("quiet_hours")
