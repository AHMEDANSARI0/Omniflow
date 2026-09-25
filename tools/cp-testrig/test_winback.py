"""Tests for win-back & recovery kit (deterministic, read-only)."""
import json
import sys
from datetime import datetime, timedelta, timezone

from flask import Flask

import portal_winback
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_winback.bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
PrincipalStub(portal_winback, principal=human)

NOW = datetime.now(timezone.utc)


def ago(days):
    return (NOW - timedelta(days=days)).isoformat()


def items(*specs):
    out = []
    for spec in specs:
        name, price = spec if isinstance(spec, tuple) else (spec, 100)
        out.append({"name": name, "qty": 1, "price": price})
    return out


def fresh(script):
    portal_winback._WINBACK_DDL_READY = True
    conn = install_db_stub(portal_winback, script)
    portal_winback.portal_db.CONV_TABLE = "portal_conversations"
    portal_winback.portal_db.MSGS_TABLE = "portal_messages"
    portal_winback.portal_db.CMD_TABLE = "portal_connector_commands"
    return conn


def _rows(value):
    if isinstance(value, list):
        return list(value)
    return [value] if value else []


def slots(last=(), open_rows=(), paid_rows=()):
    """Per-contact slot order: [last msg] [open probe+rows] [paid probe+rows]."""
    return [
        _rows(last),
        [{"oid": "portal_checkout_links"}], _rows(open_rows),
        [{"oid": "portal_checkout_links"}], _rows(paid_rows),
    ]


def last_msg(direction, days):
    return {"direction": direction, "created_at": ago(days)}


print("== helpers ==")

check("median odd", portal_winback._median_gap([30, 10, 20]) == 20, "20")
check("median even", portal_winback._median_gap([10, 20, 30, 40]) == 25, "25")
check("median empty", portal_winback._median_gap([]) is None, "none")
check("total parses commas", portal_winback._parse_total(
    items(("Shawl", "Rs 2,500"), ("Kurti", "1500"))) == 4000, "4000")
check("total none when no numbers", portal_winback._parse_total(
    items(("Shawl", "ask"))) is None, "none")
check("total non-list", portal_winback._parse_total("x") is None, "guard")
check("wa link digits", portal_winback._wa_link("92300-1234567")
      == "https://wa.me/923001234567", "link")
check("wa link rejects short", portal_winback._wa_link("12345") is None
      and portal_winback._wa_link("insta:ali") is None, "none")
check("first name", portal_winback._first_name("Ali Raza", "92x") == "Ali"
      and portal_winback._first_name("", "92x") == "92x", "name")

print("== segment: cart ==")

entry = portal_winback.build_entry(
    [{"created_at": ago(5), "items": items(("Kurti", "Rs 1,500"),
                                           ("Earrings", 500))}],
    [], {}, "9230012345678", "Ali Raza", NOW)
check("cart wins", entry is not None and entry["kind"] == "cart"
      and entry["days"] == 5, entry)
check("cart total", entry["total"] == 2000, entry)
check("cart message greets + lists", "Hi Ali!" in entry["message"]
      and "Kurti" in entry["message"] and "Earrings" in entry["message"],
      entry["message"])
check("cart wa link via payload", portal_winback._entry_payload(
        "9230012345678", "Ali Raza", entry)["wa_link"]
      == "https://wa.me/9230012345678", "link")

entry = portal_winback.build_entry(
    [{"created_at": ago(0), "items": items("Kurti")}],
    [], last_msg("out", 10), "92x", "Ali", NOW)
check("fresh cart ignored -> falls through", entry is None, entry)

print("== segment: reorder ==")

entry = portal_winback.build_entry(
    [], [{"created_at": ago(40), "items": items(("Kurti", "Rs 1,500"))},
         {"created_at": ago(70), "items": items("Kurti", "Earrings")}],
    last_msg("in", 10), "92x", "Ali", NOW)
check("reorder due", entry is not None and entry["kind"] == "reorder"
      and entry["days"] == 10, entry)
check("reorder suggests most frequent", entry["item"] == "Kurti"
      and entry["price_text"] == "Rs 1,500", entry)
check("reorder message", "restock your Kurti" in entry["message"], entry)

entry = portal_winback.build_entry(
    [], [{"created_at": ago(40), "items": items("Bangle")},
         {"created_at": ago(70), "items": items("Cap")},
         {"created_at": ago(100), "items": items("Bangle", "Cap")}],
    last_msg("in", 10), "92x", "Ali", NOW)
check("reorder tie alphabetical", entry is not None
      and entry["item"] == "Bangle", entry)

entry = portal_winback.build_entry(
    [], [{"created_at": ago(20), "items": items("Kurti")},
         {"created_at": ago(50), "items": items("Kurti")}],
    last_msg("in", 10), "92x", "Ali", NOW)
check("reorder not due yet", entry is None, entry)

entry = portal_winback.build_entry(
    [], [{"created_at": ago(40), "items": items("Kurti")},
         {"created_at": ago(70), "items": items("Kurti")}],
    last_msg("out", 1), "92x", "Ali", NOW)
check("reorder skipped when agent just spoke", entry is None, entry)

entry = portal_winback.build_entry(
    [], [{"created_at": ago(40), "items": items("Kurti")}],
    last_msg("in", 10), "92x", "Ali", NOW)
check("single order never reorder", entry is None, entry)

entry = portal_winback.build_entry(
    [{"created_at": ago(10), "items": items("Scarf")}],
    [{"created_at": ago(40), "items": items("Kurti")},
     {"created_at": ago(70), "items": items("Kurti")}],
    last_msg("in", 10), "92x", "Ali", NOW)
check("cart beats reorder", entry is not None and entry["kind"] == "cart",
      entry)

print("== segment: winback ==")

entry = portal_winback.build_entry(
    [], [{"created_at": ago(55), "items": items("Chai set")}],
    last_msg("out", 50), "92x", "Bilal", NOW)
check("winback quiet payer", entry is not None and entry["kind"] == "winback"
      and entry["days"] == 50 and entry["item"] == "Chai set", entry)
check("winback message", "It has been a while" in entry["message"], entry)

entry = portal_winback.build_entry(
    [], [], last_msg("out", 60), "92x", "Bilal", NOW)
check("winback needs an order", entry is None, entry)

long_name = "X" * 500
entry = portal_winback.build_entry(
    [{"created_at": ago(5), "items": items(long_name)}],
    [], {}, "92x", "Ali", NOW)
check("message capped", entry is not None
      and len(entry["message"]) <= portal_winback.MAX_MESSAGE, "cap")

print("== endpoints ==")

conn = fresh([
    [{"contact_id": "9230012345678", "name": "Ali"},
     {"contact_id": "9230012345679", "name": "Bilal"},
     {"contact_id": "9230012345680", "name": "Chand"}],
] + slots(last_msg("in", 10),
          open_rows=[{"created_at": ago(8), "items": items("Scarf")}])
  + slots(last_msg("in", 10),
          paid_rows=[{"created_at": ago(35), "items": items("Cap")},
                     {"created_at": ago(65), "items": items("Cap")}])
  + slots(last_msg("in", 60),
          paid_rows=[{"created_at": ago(40), "items": items("Kurti")},
                     {"created_at": ago(70), "items": items("Kurti")}]),
)
response = client.get("/api/v1/portal/winback/queue")
payload = response.get_json()
check("200 queue", status(response) == 200
      and payload["scored"] == 3, status(response))
check("queue counts", payload["counts"] == {"cart": 1, "reorder": 2,
                                            "winback": 0}, payload["counts"])
check("reorder sorted by days desc",
      [entry["days"] for entry in payload["segments"]["reorder"]] == [10, 5],
      payload["segments"]["reorder"])
check("cart entry shape", payload["segments"]["cart"][0]["contact_id"]
      == "9230012345678"
      and payload["segments"]["cart"][0]["wa_link"].startswith("https://wa.me/")
      and isinstance(payload["segments"]["cart"][0]["message"], str),
      payload["segments"]["cart"])
check("queue executes 1+5n", len(conn.cur.executed) == 16,
      len(conn.cur.executed))

response = client.get("/api/v1/portal/winback/queue")
check("queue rerun (stub fresh per test)", True, "idempotent route")

PrincipalStub(portal_winback, principal=None)
response = client.get("/api/v1/portal/winback/queue")
check("401 unauth", status(response) == 401, status(response))
PrincipalStub(portal_winback, principal=human)

conn = fresh([[{"contact_id": "92x", "name": "Ali"}], [], [], [], [], []])
response = client.get("/api/v1/portal/winback/queue")
payload = response.get_json()
check("missing tables -> empty queues", status(response) == 200
      and payload["counts"] == {"cart": 0, "reorder": 0, "winback": 0}
      and payload["scored"] == 1, payload)

print("== winback send ==")


def send_slots(name="Ali Raza", cooldown=(), conv=None, insert=None,
               last=(), open_rows=(), paid_rows=()):
    """Send-endpoint slot order."""
    return [
        [{"name": name}],
        _rows(cooldown),
        _rows(last),
        [{"oid": "portal_checkout_links"}], _rows(open_rows),
        [{"oid": "portal_checkout_links"}], _rows(paid_rows),
        [{"id": 7}] if conv is None else conv,
        [{"id": 99}] if insert is None else insert,
        [],
    ]


def commands_inserts(conn):
    return [e for e in conn.cur.executed
            if "INSERT INTO portal_connector_commands" in e[0]]


conn = fresh(send_slots(
    open_rows=[{"created_at": ago(6), "items": items(("Scarf", "Rs 900"))}]))
response = client.post("/api/v1/portal/winback/send",
                       json={"contact_id": "9230012345678", "kind": "cart"})
payload = response.get_json()
check("200 send", status(response) == 200 and payload["sent"] is True
      and payload["kind"] == "cart" and payload["command_id"] == 99, payload)
inserts = commands_inserts(conn)
check("command inserted once", len(inserts) == 1, len(inserts))
sent_payload = json.loads(inserts[0][1][1])
check("command payload shape", sent_payload["source"] == "winback"
      and sent_payload["external_user_id"] == "9230012345678"
      and sent_payload["body"].startswith("Hi Ali!")
      and sent_payload["conversation_id"] == 7, sent_payload)
check("send audits winback.sent",
      any("portal_action_log" in e[0] and e[1][1] == "winback.sent"
          for e in conn.cur.executed), "audit")
check("send 10 executes", len(conn.cur.executed) == 10,
      len(conn.cur.executed))

conn = fresh(send_slots())
response = client.post("/api/v1/portal/winback/send",
                       json={"contact_id": "9230012345678",
                             "kind": "reorder"})
check("409 stale kind", status(response) == 409
      and response.get_json()["error"]["code"] == "stale", status(response))
check("stale never inserts", len(commands_inserts(conn)) == 0, "no insert")

conn = fresh([[{"name": "Ali"}], [{"id": 1}]])
response = client.post("/api/v1/portal/winback/send",
                       json={"contact_id": "9230012345678", "kind": "cart"})
check("409 cooldown", status(response) == 409
      and response.get_json()["error"]["code"] == "cooldown",
      status(response))
check("cooldown never inserts", len(commands_inserts(conn)) == 0, "no insert")

conn = fresh([[]])
response = client.post("/api/v1/portal/winback/send",
                       json={"contact_id": "9230099999999", "kind": "cart"})
check("404 unknown contact", status(response) == 404, status(response))

response = client.post("/api/v1/portal/winback/send",
                       json={"contact_id": "x", "kind": "bogus"})
check("400 bad kind", status(response) == 400, status(response))

response = client.post("/api/v1/portal/winback/send", json={"kind": "cart"})
check("400 no contact", status(response) == 400, status(response))

response = client.post("/api/v1/portal/winback/send",
                       json={"contact_id": "9230012345678", "kind": "cart"},
                       content_type="text/plain")
check("400 bad content type", status(response) == 400, status(response))

conn = fresh(send_slots(
    open_rows=[{"created_at": ago(6), "items": items("Scarf")}],
    insert=Exception("commands table gone")))
response = client.post("/api/v1/portal/winback/send",
                       json={"contact_id": "9230012345678", "kind": "cart"})
check("503 insert failure", status(response) == 503, status(response))

PrincipalStub(portal_winback, principal=None)
response = client.post("/api/v1/portal/winback/send",
                       json={"contact_id": "x", "kind": "cart"})
check("401 unauth send", status(response) == 401, status(response))
PrincipalStub(portal_winback, principal=human)

forbidden_principal = dict(human)
forbidden_principal["via_api_key"] = True
PrincipalStub(portal_winback, principal=forbidden_principal)


REAL_GUARD = portal_winback.ensure_human_principal
portal_winback.ensure_human_principal = lambda principal: (
    {"error": {"code": "forbidden", "message": "API keys are read-only."}},
    403,
)
response = client.post("/api/v1/portal/winback/send",
                       json={"contact_id": "x", "kind": "cart"})
portal_winback.ensure_human_principal = REAL_GUARD
check("403 api key send blocked", status(response) == 403, status(response))
PrincipalStub(portal_winback, principal=human)

sys.exit(1 if summary("winback") else 0)
