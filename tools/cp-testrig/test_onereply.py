"""Tests for B2: the one-reply law (hook claims), KB auto-reply wiring in
the ingest chain, the claim audit, and the rate limiter (unit + endpoint)."""
from flask import Flask

import connector_api
import portal_cod
import portal_events
import portal_kb
import portal_ratelimit
import test_lib
from test_lib import FakeConn, check, install_db_stub, PrincipalStub, status, summary

portal_events._DDL_READY = True
portal_ratelimit._DDL_READY = True

app = Flask(__name__)
app.register_blueprint(connector_api.bp)
client = app.test_client()

MSG = {"channel": "whatsapp", "from": "923001234567", "direction": "in",
       "body": "delivery kitne din?"}

print("== intent classifier ==")

check("tracking hint", portal_kb.classify_intent("mera order kahan reach hua")
      == "order_tracking", portal_kb.classify_intent("order kahan"))
check("shipping hint", portal_kb.classify_intent("delivery kitne din")
      == "shipping", "-")
check("appointment hint", portal_kb.classify_intent("booking chahiye kal")
      == "appointment", "-")
check("default general", portal_kb.classify_intent("salam") == "general", "-")
check("blank safe", portal_kb.classify_intent("   ") == "general", "-")

print("== hooks return reply-queued ==")

# KB auto-reply: full happy path queues and returns True
conn = FakeConn([[{"auto_reply": True}], [], [{"lang": "roman"}],
                 [{"id": 3, "title": "T", "content": "Hi {name}",
                   "keywords": "delivery", "lang": "roman"}],
                 [], []])
got = portal_kb.maybe_auto_reply(1, 7, "923001234567", "Ali",
                                 "delivery kitne din", "shipping", conn)
check("kb returns True", got is True, got)
inserts = [e for e in conn.cur.executed
           if "INSERT INTO" in e[0] and "portal_connector_commands" in e[0]]
check("kb queued one command", len(inserts) == 1, len(inserts))

conn = FakeConn([[{"auto_reply": False}]])
check("kb quiet when disabled", portal_kb.maybe_auto_reply(
    1, 7, "923001234567", "Ali", "delivery", "shipping", conn) is None, "-")

# COD confirm-ask returns True; parse-only path stays silent
orig_send = portal_cod.portal_growth._send_command
portal_cod.portal_growth._send_command = lambda *a, **k: None
try:
    conn = install_db_stub(
        portal_cod,
        [[{"enabled": True, "template": "Confirm {name}?"}],
         [], [{"id": 1}], [{"id": 9}], [], []])
    got = portal_cod.maybe_cod_flow(1, 7, "923001234567", "Ali", "price?",
                                    "in", conn)
    check("cod returns True on ask", got is True, got)

    conn = install_db_stub(
        portal_cod,
        [[{"enabled": True, "template": "t"}],
         [{"id": 4, "status": "pending"}], [], []])
    got = portal_cod.maybe_cod_flow(1, 7, "923001234567", "Ali", "HAAN",
                                    "in", conn)
    check("cod parse stays silent", got is None, got)
finally:
    portal_cod.portal_growth._send_command = orig_send

print("== claim audit ==")

conn = FakeConn([None])
portal_events.note_claim(conn.cur, 1, MSG, "kb")
sql, params = conn.cur.executed[0]
check("claim update", "SET claimed_by = %s" in sql and params == ("kb", 1,
      "sha:" + __import__("hashlib").sha256(
          "1|whatsapp|923001234567|in|delivery kitne din?".encode()
      ).hexdigest()), str(params)[:60])

check("claimed_by in ddl", "claimed_by TEXT" in portal_events._DDL, "-")

print("== ingest chain wiring (static pins) ==")

SRC = open("/tmp/smoke971/connector_api.py", encoding="utf8").read()
check("away gated", 'claimed_by = "away"' in SRC
      and "if _maybe_enqueue_away_reply(" in SRC, "away")
check("cod gated", 'claimed_by = "cod"' in SRC
      and "if portal_cod.maybe_cod_flow(" in SRC, "cod")
check("kb wired", 'claimed_by = "kb"' in SRC
      and "portal_kb.maybe_auto_reply(" in SRC
      and "portal_intents.classify(" in SRC, "kb")
check("claim logged", "portal_events.note_claim(" in SRC, "claim")
check("gate order away->cod->kb", SRC.index('claimed_by = "away"')
      < SRC.index('claimed_by = "cod"') < SRC.index('claimed_by = "kb"'),
      "order")
check("side hooks still run", SRC.index("maybe_detect_language(")
      > SRC.index('claimed_by = "kb"'), "lang after kb")

print("== rate limiter ==")

conn = FakeConn([[{"count": 1}], []])
check("first hit allowed", portal_ratelimit.allow(conn.cur, "b:1", 5, 60)
      is True, "-")
upsert, up = conn.cur.executed[0]
check("upsert shape", "ON CONFLICT (bucket) DO UPDATE" in upsert
      and up[0] == "b:1", upsert[:60])
check("prune on new window", 'DELETE FROM "portal_rate_limits"' in
      conn.cur.executed[1][0], "-")

conn = FakeConn([[{"count": 5}]])
check("at limit allowed", portal_ratelimit.allow(conn.cur, "b:1", 5, 60)
      is True, "-")
conn = FakeConn([[{"count": 6}]])
check("over limit blocked", portal_ratelimit.allow(conn.cur, "b:1", 5, 60)
      is False, "-")
conn = FakeConn([[{"count": 6}], []])
check("no prune when hot", portal_ratelimit.allow(conn.cur, "b:1", 5, 60)
      is False and len(conn.cur.executed) == 1, "-")
conn = FakeConn([RuntimeError("db down")])
check("fails open", portal_ratelimit.allow(conn.cur, "b:1", 5, 60) is True, "-")

check("limit accessors", portal_ratelimit.ingest_limit() > 0
      and portal_ratelimit.checkout_limit() > 0
      and portal_ratelimit.checkout_post_limit() > 0, "-")

print("== endpoint guards ==")

# ingest: over-limit tenant gets 429 (rate slot consumes the first execute)
conn = install_db_stub(connector_api, [[{"count": 999}]])
connector_api.portal_db.CMD_TABLE = "portal_connector_commands"
connector_api._AWAY_TABLE_READY = True
response = client.post(
    "/api/v1/connector/whatsapp/messages",
    json={"client_id": 1,
          "messages": [{"from": "923001234567", "body": "hi"}]},
    headers={"X-Omniflow-Key": "x"})
check("ingest 429", status(response) == 429
      and response.get_json()["error"]["code"] == "rate_limited",
      status(response))

conn = install_db_stub(
    connector_api,
    [[{"count": 1}], [], [], [], [], [], [], [], [], [], [], []])
connector_api._AWAY_TABLE_READY = True
response = client.post(
    "/api/v1/connector/whatsapp/messages",
    json={"client_id": 1,
          "messages": [{"from": "923001234567", "body": "salam"}]},
    headers={"X-Omniflow-Key": "x"})
check("ingest ok under limit", status(response) == 200, status(response))
check("rate slot first", "portal_rate_limits"
      in conn.cur.executed[0][0], conn.cur.executed[0][0][:60])

for mod, marker, bucket in [
    ("portal_checkout", 'portalcHECKOUT', "checkout"),
    ("portal_coupons", "coupon:", "coupon"),
    ("portal_changes", "changereq:", "changereq"),
    ("portal_payments", "paycb:", "paycb"),
]:
    src = open("/tmp/smoke971/" + mod + ".py", encoding="utf8").read()
    check("guard in " + mod, "portal_ratelimit.allow(" in src
          and bucket in src, bucket)

import portal_checkout  # noqa: E402  (guard placement checks)
src = open("/tmp/smoke971/portal_checkout.py", encoding="utf8").read()
di = src.index("def public_checkout(token: str")
nd = src.index("\ndef ", di + 10)
check("checkout guard in public view",
      "portal_ratelimit.allow" in src[di:nd], "placement")
dd = src.index("def duplicate_checkout_link")
nd2 = src.index("\ndef ", dd + 10)
check("duplicate untouched", "portal_ratelimit" not in src[dd:nd2], "clean")

summary("onereply")
