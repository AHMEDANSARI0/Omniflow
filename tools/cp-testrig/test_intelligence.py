"""Master-upgrade engine 5: the shared intelligence result.

Covers portal_intelligence: deterministic purchase_intent / urgency
heuristics (Roman-Urdu), analyze() reusing the existing classifiers
(monkeypatched here — portal_intents / portal_insights / portal_contacts),
maybe_analyze (in-direction only, stores, never claims), the stored-result
API (stored hit, fresh-analyze path, 401/503) and the web pins (connector
hook + app.py registration).
"""
import json

from flask import Flask

import portal_contacts
import portal_insights
import portal_intelligence
import portal_intents
from test_lib import install_db_stub
from test_lib import check, summary
from test_lib import PrincipalStub


class Principal:
    """CM wrapper — test_lib's PrincipalStub has no __enter__."""

    def __init__(self, module, principal=None, exc=None):
        self.stub = PrincipalStub(module, principal, exc)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.stub.restore()
        return False


PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}

app = Flask(__name__)
app.register_blueprint(portal_intelligence.bp)
client = app.test_client()

print("== heuristics ==")

check("purchase high",
      portal_intelligence.purchase_intent(
          "Bhai ye Lahore mein price kya hai, Lena hai aaj") == "high",
      "high")
check("purchase medium",
      portal_intelligence.purchase_intent(
          "Iska price aur stock check kar dein") == "medium", "medium")
check("purchase low",
      portal_intelligence.purchase_intent(
          "Salam, aap kaise hain?") == "low", "low")
check("urgency high",
      portal_intelligence.urgency("Jaldi bhej dein please, abhi chahiye")
      == "high", "high")
check("urgency low",
      portal_intelligence.urgency("Kabhi bhi bhej dena") == "low", "low")

print("== analyze(): existing classifiers reused, one shape ==")

_orig = (portal_intents.classify, portal_insights.analyze_sentiment_smart,
         portal_contacts.detect_language)
try:
    portal_intents.classify = lambda text: "order_tracking"
    portal_insights.analyze_sentiment_smart = lambda text: {
        "label": "negative", "engine": "llm", "score": -0.6}
    portal_contacts.detect_language = lambda text: "roman"
    result = portal_intelligence.analyze(
        "Mera order abhi tak nahi aya, jaldi dein")
    check("shape complete", result["intent"] == "order_tracking"
          and result["sentiment"] == "negative"
          and result["sentiment_engine"] == "llm"
          and result["language"] == "roman"
          and result["purchase_intent"] == "low"   # complaint, not buying
          and result["urgency"] == "high"
          and result["confidence"] == 0.9, result)
finally:
    (portal_intents.classify, portal_insights.analyze_sentiment_smart,
     portal_contacts.detect_language) = _orig

print("== maybe_analyze: stores, never claims ==")

_orig_stored = portal_contacts.stored_language
try:
    portal_contacts.stored_language = lambda cur, cid, contact: "roman"
    portal_intents.classify = lambda text: "general"
    portal_insights.analyze_sentiment_smart = lambda text: {
        "label": "neutral", "engine": "lexicon"}
    conn = install_db_stub(portal_intelligence, [
        [],                                # lazy DDL
        [],                                # upsert INSERT (no RETURN)
    ])
    check("no claim", portal_intelligence.maybe_analyze(
        1, 77, "923008887777@c.us", "Aap kaise hain", "in", conn) is False,
        "no-claim")
    insert = next((p for sql, p in conn.cur.executed
                   if "INSERT INTO portal_intelligence" in sql), None)
    check("stored upsert", insert is not None and insert[1] == 77,
          insert)

    conn = install_db_stub(portal_intelligence, [])
    check("outbound skipped", portal_intelligence.maybe_analyze(
        1, 77, "x@c.us", "salam", "out", conn) is False, "out")
    check("no sql on skip", len(conn.cur.executed) == 0, "clean")
finally:
    portal_contacts.stored_language = _orig_stored

print("== API ==")

with Principal(portal_intelligence, principal=None):
    check("401", client.get(
        "/api/v1/portal/intelligence/conversations/77").status_code == 401,
        401)

with Principal(portal_intelligence, PRINCIPAL):
    # stored hit
    conn = install_db_stub(portal_intelligence, [
        [],                                # DDL
        [{"client_id": 1, "conversation_id": 77, "contact_id": "x@c.us",
          "intent": "order_tracking", "sentiment": "negative",
          "sentiment_engine": "llm", "language": "roman",
          "purchase_intent": "high", "urgency": "high",
          "confidence": 0.9, "updated_at": None}],
    ])
    r = client.get("/api/v1/portal/intelligence/conversations/77")
    body = r.get_json()
    check("stored hit 200", r.status_code == 200
          and body["intent"] == "order_tracking"
          and body["confidence"] == 0.9
          and body["purchaseIntent"] == "high", body)

    # fresh path: no stored row -> latest inbound message analyzed
    _saved = (portal_intents.classify,
              portal_insights.analyze_sentiment_smart)
    portal_intents.classify = lambda text: "shipping"
    portal_insights.analyze_sentiment_smart = lambda text: {
        "label": "neutral", "engine": "lexicon"}
    try:
        conn = install_db_stub(portal_intelligence, [
            [],                                  # DDL
            [],                                  # stored SELECT -> none
            [{"body": "Delivery kab hogi?"}],    # latest inbound message
            [{"contact_id": "923008887777@c.us"}],
            [],                                  # stored_language SELECT
            [],                                  # store() lazy DDL
            [],                                  # upsert INSERT
        ])
        r = client.get("/api/v1/portal/intelligence/conversations/78")
        body = r.get_json()
        check("fresh analyze 200", r.status_code == 200
              and body["intent"] == "shipping"
              and body["conversationId"] == 78, body)
    finally:
        (portal_intents.classify,
         portal_insights.analyze_sentiment_smart) = _saved

portal_intelligence.PortalAuthUnavailable = Exception
with Principal(portal_intelligence, exc=Exception("db down")):
    r = client.get("/api/v1/portal/intelligence/conversations/77")
    check("auth down 503", r.status_code == 503, r.status_code)
del portal_intelligence.PortalAuthUnavailable

print("== web pins ==")

RIG13 = "/tmp/p13/Omniflow/"
CONNECTOR = open(RIG13 + "omniflow-backend-patch/connector_api.py",
                 encoding="utf8").read()
check("connector hook", "portal_intelligence.maybe_analyze" in CONNECTOR,
      "hook")
APP = open(RIG13 + "omniflow-backend-patch/app.py", encoding="utf8").read()
check("app registration",
      "portal_intelligence_bp" in APP and "portal_approvals_bp" in APP
      and "portal_actions_bp" in APP, "blueprints")

summary("intelligence")
