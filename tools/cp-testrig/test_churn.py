"""Tests for churn radar v2 (deterministic, read-only)."""
import sys
from datetime import datetime, timedelta, timezone

from flask import Flask

import portal_churn
import test_lib
from test_lib import check, install_db_stub, PrincipalStub, status, summary

app = Flask(__name__)
app.register_blueprint(portal_churn.bp)
client = app.test_client()

human = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed", "via_api_key": False,
}
PrincipalStub(portal_churn, principal=human)

NOW = datetime.now(timezone.utc)


def ago(days):
    return (NOW - timedelta(days=days)).isoformat()


def fresh(script):
    portal_churn._CHURN_DDL_READY = True
    conn = install_db_stub(portal_churn, script)
    portal_churn.portal_db.CONV_TABLE = "portal_conversations"
    portal_churn.portal_db.MSGS_TABLE = "portal_messages"
    return conn


def slots(messages=(), open_cart=None, paid=()):
    """Score-endpoint slot order: [msgs] [probe+open] [probe+paid]."""
    return [
        list(messages),
        [{"oid": "portal_checkout_links"}],
        [{"created_at": open_cart}] if open_cart else [],
        [{"oid": "portal_checkout_links"}],
        [{"created_at": ts} for ts in paid],
    ]


def msg(direction, days):
    return {"direction": direction, "created_at": ago(days)}


print("== helpers ==")

check("days_since iso", portal_churn._days_since(ago(30), NOW) == 30,
      portal_churn._days_since(ago(30), NOW))
check("days_since invalid", portal_churn._days_since("garbage", NOW) is None
      and portal_churn._days_since(None, NOW) is None, "guard")
check("days_since naive datetime",
      portal_churn._days_since(datetime(2020, 1, 1), NOW) is not None,
      "naive ok")

print("== signal: quiet ==")

result = portal_churn.score_contact([msg("in", 1)], None, [], NOW)
check("healthy stays zero", result["score"] == 0
      and result["tier"] == "healthy" and result["reasons"] == [], result)
result = portal_churn.score_contact([msg("in", 30)], None, [], NOW)
check("quiet 30d", result["score"] == 25
      and "No message from them in 30 days" in result["reasons"], result)
result = portal_churn.score_contact([msg("in", 50)], None, [], NOW)
check("quiet 50d severe", result["score"] == 35
      and "No message from them in 50 days" in result["reasons"], result)
result = portal_churn.score_contact([], None, [], NOW)
check("never spoke -> no quiet penalty", result["score"] == 0
      and result["signals"]["last_inbound_days"] is None, result)

print("== signal: unanswered ==")

result = portal_churn.score_contact([msg("out", 10), msg("in", 12)], None,
                                    [], NOW)
check("unanswered 10d", result["score"] == 15 and
      "Your last reply is unanswered for 10 days" in result["reasons"], result)
result = portal_churn.score_contact([msg("out", 3), msg("in", 12)], None,
                                    [], NOW)
check("recent reply not penalised", result["score"] == 0
      and result["signals"]["unanswered_days"] is not None, result)

print("== signal: cold cart ==")

result = portal_churn.score_contact([], ago(10), [], NOW)
check("cart 10d", result["score"] == 20
      and "Cart open for 10 days" in result["reasons"], result)
result = portal_churn.score_contact([], ago(25), [], NOW)
check("cart 25d severe", result["score"] == 30
      and "Cart open for 25 days" in result["reasons"], result)

print("== signal: spend drop ==")

result = portal_churn.score_contact([], None, [ago(40), ago(45)], NOW)
check("no orders last month", result["score"] == 15
      and "No orders in the last month" in result["reasons"]
      and result["signals"]["orders_prior_30d"] == 2, result)
result = portal_churn.score_contact([], None, [ago(35), ago(40), ago(10)],
                                    NOW)
check("orders slowed down", result["score"] == 10
      and "Orders slowed down" in result["reasons"], result)

print("== signal: dormant repeat buyer ==")

result = portal_churn.score_contact([], None, [ago(50), ago(60)], NOW)
check("dormant + spend drop stack", result["score"] == 35
      and "Hasn't reordered in 50 days" in result["reasons"], result)
result = portal_churn.score_contact([], None, [ago(50)], NOW)
check("single order never dormant", result["score"] == 15, result)

print("== tiers + cap ==")

stacked = portal_churn.score_contact(
    [msg("out", 50), msg("in", 50)], ago(25), [ago(50), ago(60)], NOW)
check("score capped at 100", stacked["score"] == 100
      and stacked["tier"] == "at_risk", stacked)
check("cooling tier", portal_churn.score_contact(
    [msg("out", 10), msg("in", 30)], None, [], NOW)["tier"] == "cooling",
      "25+15=40")
check("quiet needs 21d", portal_churn.score_contact(
    [msg("in", 20)], None, [], NOW)["score"] == 0, "20d still fresh")
check("healthy 25 points", portal_churn.score_contact(
    [msg("in", 25)], None, [], NOW)["score"] == 25
    and portal_churn.score_contact(
        [msg("in", 25)], None, [], NOW)["tier"] == "healthy", "quiet only")
check("signals block raw",
      portal_churn.score_contact([msg("in", 5)], ago(2), [ago(3)], NOW)
      ["signals"] == {"last_inbound_days": 5, "unanswered_days": None,
                      "open_cart_days": 2, "orders_last_30d": 1,
                      "orders_prior_30d": 0, "paid_orders": 1,
                      "last_order_days": 3}, "signals")

print("== endpoints ==")

conn = fresh(slots(messages=[msg("in", 1)]))
response = client.get("/api/v1/portal/churn/score?contact=92x")
payload = response.get_json()
check("200 score", status(response) == 200
      and payload["contact_id"] == "92x"
      and payload["tier"] == "healthy", status(response))
check("5 executes", len(conn.cur.executed) == 5, len(conn.cur.executed))

response = client.get("/api/v1/portal/churn/score")
check("400 no contact", status(response) == 400, status(response))

conn = fresh(slots(messages=[msg("in", 1)]))
response = client.get("/api/v1/portal/churn/score?contact=" + "a" * 300)
check("contact capped at 100",
      len(response.get_json()["contact_id"]) == 100, "cap")

conn = fresh(slots(messages=[msg("in", 40)], open_cart=ago(30),
                   paid=[ago(55), ago(70)]))
response = client.get("/api/v1/portal/churn/score?contact=92x")
payload = response.get_json()
check("scored via endpoint", payload["score"] == 90
      and payload["tier"] == "at_risk"
      and len(payload["reasons"]) == 4, payload)

PrincipalStub(portal_churn, principal=None)
response = client.get("/api/v1/portal/churn/score?contact=x")
check("401 unauth", status(response) == 401, status(response))
PrincipalStub(portal_churn, principal=human)

response = client.get("/api/v1/portal/churn/radar?limit=zzz")
check("400 bad limit", status(response) == 400, status(response))


def radar_slots():
    hot = slots(messages=[msg("out", 50), msg("in", 50)],
                open_cart=ago(25),
                paid=[ago(50), ago(60)])
    calm = slots(messages=[msg("in", 1)])
    return [[{"contact_id": "92a", "name": "Ali"},
             {"contact_id": "92b", "name": "Bilal"}]] + hot + calm


conn = fresh(radar_slots())
response = client.get("/api/v1/portal/churn/radar?limit=5")
payload = response.get_json()
check("radar flags only scored", status(response) == 200
      and len(payload["contacts"]) == 1
      and payload["contacts"][0]["contact_id"] == "92a"
      and payload["contacts"][0]["score"] == 100, payload)
check("radar counts", payload["scored"] == 2
      and payload["counts"] == {"healthy": 1, "cooling": 0, "at_risk": 1},
      payload.get("counts"))
check("radar 11 executes", len(conn.cur.executed) == 11,
      len(conn.cur.executed))

conn = fresh([[]])
response = client.get("/api/v1/portal/churn/radar")
payload = response.get_json()
check("radar empty pool", payload["contacts"] == []
      and payload["scored"] == 0, payload)

conn = fresh(radar_slots())
response = client.get("/api/v1/portal/churn/report")
payload = response.get_json()
check("report tiers", payload["scored"] == 2
      and payload["tiers"]["at_risk"] == 1
      and payload["avg_score"] == 50.0, payload)
check("report top reasons", payload["top_reasons"][0]["count"] >= 1
      and any(entry["reason"] == "Cart open for 25 days"
              for entry in payload["top_reasons"]), payload)

print("== missing tables degrade ==")

conn = fresh([[], [], []])
response = client.get("/api/v1/portal/churn/score?contact=92x")
payload = response.get_json()
check("links missing -> signals only", status(response) == 200
      and payload["signals"]["open_cart_days"] is None
      and payload["signals"]["paid_orders"] == 0, payload)

sys.exit(1 if summary("churn") else 0)
