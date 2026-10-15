"""Tests for the event core v1 (B1): inbound idempotency gate, command
retry scheduling (backoff, dead-letter, replay), the deliveries API, and the
web/bridge pins."""
import json

from flask import Flask

import portal_events
import test_lib
from test_lib import FakeConn, check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_events.bp)
client = app.test_client()

# direct FakeConn calls skip the lazy-DDL execute (endpoints use fresh())
portal_events._DDL_READY = True

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
apikey = dict(human, via_api_key=True)
PrincipalStub(portal_events, principal=human)


def fresh(script):
    portal_events._DDL_READY = True
    return install_db_stub(portal_events, script)


MSG = {"channel": "whatsapp", "from": "92300@c.us",
       "direction": "in", "body": "salam", "name": "Ali"}

print("== inbound idempotency gate ==")

conn = FakeConn([[], []])
check("new message passes", portal_events.record_inbound(
    conn.cur, 1, MSG) is True, "-")
gate_sql, gate_params = conn.cur.executed[0]
check("content fingerprint", gate_params[1].startswith("sha:")
      and "replay-window" not in gate_sql, gate_params[1][:12])
check("window guarded", "INTERVAL" in gate_sql, gate_sql[-60:])
ins_sql, ins_params = conn.cur.executed[1]
check("event row inserted", 'INSERT INTO "portal_events"' in ins_sql
      and "'inbound_message'" in ins_sql
      and ins_params[1].startswith("sha:"), ins_sql[:60])

provider_msg = dict(MSG, id="wamid.XYZ")
conn = FakeConn([[], []])
portal_events.record_inbound(conn.cur, 1, provider_msg)
check("provider key", conn.cur.executed[0][1][1] == "pid:wamid.XYZ"
      and "INTERVAL" not in conn.cur.executed[0][0], "-")

conn = FakeConn([[{"id": 7}]])
check("provider dupe blocked", portal_events.record_inbound(
    conn.cur, 1, provider_msg) is False, "-")

conn = FakeConn([RuntimeError("db down")])
check("gate fails open", portal_events.record_inbound(
    conn.cur, 1, MSG) is True, "-")

conn = FakeConn([None])
portal_events.mark_inbound_done(conn.cur, 1, MSG)
check("mark done sql", "SET status = 'done'" in conn.cur.executed[0][0]
      and conn.cur.executed[0][1][1].startswith("sha:"), "-")

print("== retry scheduling ==")

check("backoff math", portal_events.backoff_delay_seconds(1) == 30
      and portal_events.backoff_delay_seconds(2) == 60
      and portal_events.backoff_delay_seconds(3) == 120
      and portal_events.backoff_delay_seconds(9) == 900, "-")

conn = FakeConn([[]])
portal_events.on_command_ack(conn.cur, 1, 5, True, None, "wamid.OUT")
sql, params = conn.cur.executed[0]
check("ack ok stamps provider id", "provider_message_id = COALESCE" in sql
      and params[0] == "wamid.OUT", sql[:70])

conn = FakeConn([[{"attempts": 0}], []])
portal_events.on_command_ack(conn.cur, 1, 5, False, "phone offline")
sched_sql, sched_params = conn.cur.executed[1]
check("failure schedules retry", "status = CASE" in sched_sql
      and "MAKE_INTERVAL" in sched_sql, sched_sql[:80])
check("backoff interval", sched_params[4] == 30, sched_params)
check("dead threshold param", sched_params[0] == portal_events.MAX_ATTEMPTS, "-")

conn = FakeConn([[{"attempts": 4}], []])
portal_events.on_command_ack(conn.cur, 1, 5, False, "still failing")
sched_params = conn.cur.executed[1][1]
check("dead on max attempts", sched_params[0] == 5
      and sched_params[2] == 5, sched_params)

conn = FakeConn([[]])
check("requeue sql", portal_events.requeue_due_commands(conn.cur, 1) == 0, "-")
rq_sql, rq_params = conn.cur.executed[0]
check("requeue only due failures", "status = 'failed'" in rq_sql
      and "next_attempt_at <= NOW()" in rq_sql
      and rq_params == (1, portal_events.MAX_ATTEMPTS), rq_sql[:90])

print("== deliveries API ==")

PrincipalStub(portal_events, principal=None)
response = client.get("/api/v1/portal/deliveries")
check("401 without session", status(response) == 401, status(response))

PrincipalStub(portal_events, principal=apikey)
response = client.get("/api/v1/portal/deliveries")
check("403 api-key", status(response) == 403, status(response))
PrincipalStub(portal_events, principal=human)

conn = fresh([[{"status": "dead", "count": 2}, {"status": "done", "count": 9}],
              [{"id": 5, "kind": "command", "label": "send_template",
                "status": "dead", "attempts": 5, "next_attempt_at": None,
                "error_code": "max_attempts",
                "error_message": "phone offline", "provider_message_id": None,
                "result_note": None, "channel": "whatsapp",
                "created_at": None, "updated_at": None}]])
response = client.get("/api/v1/portal/deliveries")
payload = response.get_json()
check("list 200", status(response) == 200, status(response))
check("counts", payload["counts"] == {"pending": 0, "failed": 0,
                                      "dead": 2, "done": 9}, payload["counts"])
check("row shape", payload["deliveries"][0]["id"] == 5
      and payload["deliveries"][0]["errorMessage"] == "phone offline"
      and payload["deliveries"][0]["attempts"] == 5, payload["deliveries"])
count_sql, _ = conn.cur.executed[0]
rows_sql, rows_params = conn.cur.executed[1]
check("tenant scoped", "client_id = %s" in count_sql
      and rows_params == (1,), rows_sql[:80])

conn = fresh([[{"status": "dead", "count": 1}], []])
response = client.get("/api/v1/portal/deliveries?status=dead")
check("filter applied", "AND status = 'dead'"
      in conn.cur.executed[1][0], conn.cur.executed[1][0][-80:])

conn = fresh([])
response = client.get("/api/v1/portal/deliveries?status=weird")
check("400 bad status", status(response) == 400, status(response))

conn = fresh([RuntimeError("db down")])
response = client.get("/api/v1/portal/deliveries")
check("503 wrap", status(response) == 503, status(response))

conn = fresh([])
response = client.post("/api/v1/portal/deliveries/replay", json={"id": 0})
check("400 bad id", status(response) == 400
      and len(conn.cur.executed) == 0, status(response))

conn = fresh([[{"id": 5}]])
response = client.post("/api/v1/portal/deliveries/replay", json={"id": 5})
check("replay 200", status(response) == 200
      and response.get_json() == {"ok": True}, status(response))
rp_sql, rp_params = conn.cur.executed[0]
check("replay resets", "SET status = 'pending', attempts = 0" in rp_sql
      and "status IN ('failed', 'dead')" in rp_sql
      and rp_params == (5, 1), rp_sql[:90])

conn = fresh([[]])
response = client.post("/api/v1/portal/deliveries/replay", json={"id": 5})
check("404 not replayable", status(response) == 404, status(response))

conn = fresh([RuntimeError("db down")])
response = client.post("/api/v1/portal/deliveries/replay", json={"id": 5})
check("503 wrap replay", status(response) == 503, status(response))

print("== pipeline + web + bridge pins ==")

CONNECTOR = open("/tmp/smoke971/connector_api.py", encoding="utf8").read()
check("ingest gate wired", "portal_events.record_inbound(" in CONNECTOR
      and "portal_events.mark_inbound_done(" in CONNECTOR, "ingest")
check("ack bookkeeping wired", "portal_events.on_command_ack(" in CONNECTOR
      and 'payload.get("provider_message_id")' in CONNECTOR, "ack")
check("poll requeue wired", "portal_events.requeue_due_commands(" in CONNECTOR
      and "next_attempt_at <= NOW())" in CONNECTOR, "poll")

APP = open("/tmp/smoke971/app.py", encoding="utf8").read()
check("app registration", "from portal_events import bp as portal_events_bp"
      in APP and "aux_app.register_blueprint(portal_events_bp)" in APP, "app")

PORTAL = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts", encoding="utf8").read()
check("portal clients", "export async function listDeliveries(" in PORTAL
      and "export async function replayDelivery(" in PORTAL
      and "export interface DeliveryRow {" in PORTAL, "clients")

for rel, name, depth in [
    ("app/api/omniflow/portal/deliveries/route.ts", "deliveries", 5),
    ("app/api/omniflow/portal/deliveries/replay/route.ts", "replay", 6),
]:
    body = open("/tmp/p13/Omniflow/" + rel, encoding="utf8").read()
    check("bff " + name, '"../" * depth + "lib/' in body.replace('"../" * depth', '"' + "../" * depth + '"') if False else
          ('"' + "../" * depth + 'lib/' in body)
          and "export async function" in body, rel)

SETTINGS = open("/tmp/p13/Omniflow/app/dashboard/(portal)/settings/page.tsx",
                encoding="utf8").read()
CARD = open("/tmp/p13/Omniflow/app/dashboard/(portal)/settings/"
            "DeliveriesCard.tsx", encoding="utf8").read()
check("settings wired", 'import DeliveriesCard from "./DeliveriesCard";'
      in SETTINGS and "<DeliveriesCard />" in SETTINGS, "settings")
check("card behaviors", "Replay" in CARD and "Retrying" in CARD
      and "deliveries/replay" in CARD, "card")

BRIDGE = open("/home/user/Omniflow/connector-bridge/control_plane_bridge.py",
              encoding="utf8").read()
check("bridge provider plumbing", "provider_message_id=None," in BRIDGE
      and '**({"provider_message_id": provider_message_id}' in BRIDGE, "bridge")

check("patchers archived", __import__("os").path.isfile(
    "/home/user/Omniflow/tools/patchers/add_batch_991_1010_cloud_lang.mjs"),
    "tools/patchers")

summary("events")
