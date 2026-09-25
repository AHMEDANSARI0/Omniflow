"""Tests for the away-reply queue (Phases 111-114)."""
import sys

from flask import Flask

import connector_api
import test_lib
from test_lib import check, status, summary

app = Flask(__name__)
app.register_blueprint(connector_api.bp)
client = app.test_client()
connector_api._AWAY_TABLE_READY = True

CLOSED_CONFIG = {
    "enabled": True,
    "timezone": "Asia/Karachi",
    "days": [{"enabled": False, "start": "09:00", "end": "17:00"} for _ in range(7)],
    "away_message": "We are away. We will reply during business hours.",
}
OPEN_CONFIG = {
    "enabled": True,
    "timezone": "Asia/Karachi",
    "days": [{"enabled": True, "start": "00:00", "end": "23:59"} for _ in range(7)],
    "away_message": "We are away.",
}

print("== closed-now math ==")
check("all days disabled -> closed", connector_api._away_closed_now(CLOSED_CONFIG) is True)
check("always-open window -> open", connector_api._away_closed_now(OPEN_CONFIG) is False)
check("bad timezone -> open (safe)", connector_api._away_closed_now({**OPEN_CONFIG, "timezone": "Nope/Zone"}) is False)
check("wrong days length -> open", connector_api._away_closed_now({**OPEN_CONFIG, "days": OPEN_CONFIG["days"][:3]}) is False)

print("== enqueue logic ==")
def run_enqueue(config, direction, script):
    conn = test_lib.FakeConn(script)
    connector_api._maybe_enqueue_away_reply(1, 7, "92300@c.us", direction, conn)
    return conn.cur.executed

# 971-990: the away hook now reads the stored contact language (slot 2)
# between the business-hours read and the cooldown check - variant pick
# happens only when the shop is actually closed.
executed = run_enqueue(CLOSED_CONFIG, "in", [[{"business_hours": CLOSED_CONFIG}], [], [], []])
check("closed enqueues insert", "INSERT INTO" in executed[3][0] and "portal_away_replies" in executed[3][0], executed[3][0][-80:] if len(executed) > 3 else executed)
check("insert params carry body", executed[3][1][3] == "We are away. We will reply during business hours.", executed[3][1])
check("language read happens", "portal_contact_lang" in executed[2][0], executed[2][0][:60])

executed = run_enqueue(CLOSED_CONFIG, "in", [[{"business_hours": CLOSED_CONFIG}], [{"?": 1}], []])
check("cooldown blocks second", len(executed) == 2, len(executed))

executed = run_enqueue(CLOSED_CONFIG, "out", [])
check("outbound never enqueues", len(executed) == 0, len(executed))

executed = run_enqueue(OPEN_CONFIG, "in", [[{"business_hours": OPEN_CONFIG}]])
check("open hours never enqueue", len(executed) == 1, len(executed))

executed = run_enqueue(
    {**CLOSED_CONFIG, "enabled": False}, "in", [[{"business_hours": {**CLOSED_CONFIG, "enabled": False}}]]
)
check("disabled never enqueues", len(executed) == 1, len(executed))

print("== connector endpoints ==")
connector_api._tenant_or_error = lambda value: ({"client_id": 1}, None)

response = client.get("/api/v1/connector/away-replies?client_id=1")
check("403 without key", status(response) == 403, status(response))

conn = test_lib.install_db_stub(connector_api, [[{"id": 1, "contact_id": "92300@c.us", "body": "Away.", "created_at": None}]])
response = client.get("/api/v1/connector/away-replies?client_id=1", headers={"X-Omniflow-Key": "x"})
check("200 list", status(response) == 200, status(response))
rows = response.get_json()["away_replies"]
check("list shape", rows and rows[0]["external_user_id"] == "92300@c.us" and rows[0]["body"] == "Away.", rows)

conn = test_lib.install_db_stub(connector_api, [[{"id": 1}]])
response = client.post("/api/v1/connector/away-replies/ack", json={"client_id": 1, "away_id": 1, "ok": True}, headers={"X-Omniflow-Key": "x"})
check("200 ack", status(response) == 200 and response.get_json()["ok"] is True, status(response))
check("ack updates sent", "SET status = %s" in conn.cur.executed[0][0] and conn.cur.executed[0][1][0] == "sent", conn.cur.executed[0][1])

conn = test_lib.install_db_stub(connector_api, [[], []])
response = client.post("/api/v1/connector/away-replies/ack", json={"client_id": 1, "away_id": 9, "ok": True}, headers={"X-Omniflow-Key": "x"})
check("404 unknown ack", status(response) == 404, status(response))

response = client.post("/api/v1/connector/away-replies/ack", json={"client_id": 1, "away_id": -1}, headers={"X-Omniflow-Key": "x"})
check("400 bad ack id", status(response) == 400, status(response))

connector_api._AWAY_TABLE_READY = False
conn = test_lib.install_db_stub(connector_api, [[], []])
client.get("/api/v1/connector/away-replies?client_id=1", headers={"X-Omniflow-Key": "x"})
check("lazy ddl", "CREATE TABLE IF NOT EXISTS" in conn.cur.executed[0][0], conn.cur.executed[0][0][:80])
connector_api._AWAY_TABLE_READY = True

print("== structural ==")
bridge_src = open("/tmp/p13/src/control_plane_bridge.py").read()
check("bridge polls away", "self.process_due_away(adapter)" in bridge_src)
check("bridge sends outbound", "OutboundMessage(" in bridge_src)
check("bridge ingests as out", 'direction="out"' in bridge_src)
check("bridge acks", "acknowledge_away(away_id, success, note)" in bridge_src)
cp_src = open("/tmp/p13/OmniFlow-Control-Plane/connector_api.py").read()
check("cp hook wired", "_maybe_enqueue_away_reply(" in cp_src and cp_src.count("_maybe_enqueue_away_reply(") == 2)
check("cp cooldown literal", 'str(AWAY_COOLDOWN_HOURS) + " hours\'"' in cp_src)
chip_src = open("/tmp/p13/Omniflow/app/dashboard/(portal)/channels/whatsapp/page.tsx").read()
check("chip rendered", "<AwayChip />" in chip_src)
check("chip component", "function AwayChip()" in chip_src)
check("chip amber", "Away replies are active until business hours" in chip_src)

failures = summary("away")
sys.exit(1 if failures else 0)
