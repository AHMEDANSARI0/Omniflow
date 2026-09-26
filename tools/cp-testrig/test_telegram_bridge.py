"""Tests for the Telegram bridge (pure helpers; no network)."""
import importlib.util
import sys

import test_lib
from test_lib import check, summary

spec = importlib.util.spec_from_file_location(
    "telegram_bridge",
    "/tmp/p13/Omniflow/connector-node/telegram_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

print("== map_update ==")

item = bridge.map_update({
    "update_id": 7,
    "message": {
        "chat": {"id": 424242, "type": "private"},
        "from": {"id": 1, "first_name": "Ali", "last_name": "Khan"},
        "text": "Salam, order kahan hai?",
    },
})
check("contact mapped", item["from"] == "tg:424242", item)
check("channel telegram", item["channel"] == "telegram", item)
check("direction in", item["direction"] == "in", item)
check("name joined", item["name"] == "Ali Khan", item)
check("body passthrough", item["body"] == "Salam, order kahan hai?", item)
check("body capped", len(bridge.map_update({
    "message": {"chat": {"id": 1}, "text": "x" * 5000}})["body"]) == 1000, "cap")

check("photo without caption skipped", bridge.map_update({
    "message": {"chat": {"id": 1}, "photo": {}}}) is None, "skip")
check("no chat skipped", bridge.map_update({"message": {}}) is None, "skip")
check("empty text skipped", bridge.map_update({
    "message": {"chat": {"id": 1}, "text": "   "}}) is None, "skip")
check("group title fallback", bridge.map_update({
    "message": {"chat": {"id": -100, "title": "Shop", "type": "group"},
                "text": "hi"}})["name"] == "Shop", "name")

print("== extract_out ==")

out = bridge.extract_out({
    "id": 5, "action": "send_message",
    "payload": {"external_user_id": "tg:424242", "body": "Welcome!"}})
check("telegram out", out == ("424242", "Welcome!"), out)
check("whatsapp untouched", bridge.extract_out({
    "payload": {"external_user_id": "92300@c.us", "body": "x"}}) is None, "skip")
check("bad tg id rejected", bridge.extract_out({
    "payload": {"external_user_id": "tg:abc", "body": "x"}}) is None, "skip")
check("group ids ok", bridge.extract_out({
    "payload": {"external_user_id": "tg:-100123", "body": "x"}})
    == ("-100123", "x"), "group")

print("== cp calls ==")

captured = []


def fake_http(url, payload=None, timeout=20):
    captured.append((url, payload))
    return {"ok": True, "result": []}


orig = bridge._http_json
bridge._http_json = fake_http
try:
    bridge.ingest_messages([{"from": "tg:1", "body": "hi", "channel": "telegram"}])
    url, payload = captured[-1]
    check("ingest url", url.endswith(bridge.INGEST_PATH), url)
    check("ingest payload", payload["messages"][0]["channel"] == "telegram",
          payload)

    bridge.poll_commands()
    url, _ = captured[-1]
    check("commands filtered by channel", "channel=telegram" in url, url)

    bridge.ack_command(9, True)
    url, payload = captured[-1]
    check("ack url", url.endswith(bridge.ACK_PATH), url)
    check("ack payload", payload == {"command_id": 9, "ok": True}, payload)

    bridge.ack_command(9, False, "send failed")
    _, payload = captured[-1]
    check("ack failure note", payload["ok"] is False
          and payload["note"] == "send failed", payload)
finally:
    bridge._http_json = orig

print("== config ==")

check("tg api base", bridge.TG_API.startswith("https://api.telegram.org/bot"),
      bridge.TG_API)
check("long poll timeout", bridge.TG_TIMEOUT >= 50, bridge.TG_TIMEOUT)
check("stdlib only", "urllib.request" in open(
    "/tmp/p13/Omniflow/connector-node/telegram_bridge.py").read(), "imports")

sys.exit(1 if summary("telegram_bridge") else 0)
