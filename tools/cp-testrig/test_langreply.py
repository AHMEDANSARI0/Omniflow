"""Tests for language-aware auto-replies (971-990 batch): stored_language
helper, away-reply per-language variant pick, business-hours variant
validation, and web pins."""
import connector_api
import portal_conversations
import portal_contacts
import test_lib
from test_lib import FakeConn, check, summary

VALID_DAYS = [{"enabled": True, "start": "00:00", "end": "23:59"}
              for _ in range(7)]

CONFIG = {
    "enabled": True,
    "timezone": "Asia/Karachi",
    "days": [{"enabled": False, "start": "09:00", "end": "17:00"}
             for _ in range(7)],
    "away_message": "We are away.",
    "away_message_ur": "ہم اس وقت دستیاب نہیں ہیں۔",
    "away_message_roman": "Hum abhi off hain, thori dair me reply karenge.",
}

print("== stored_language ==")


def lang_of(script):
    conn = FakeConn(script)
    with conn.cursor() as cur:
        return portal_contacts.stored_language(cur, 1, "923001234567")


check("ur stored", lang_of([[{"lang": "ur"}]]) == "ur", "-")
check("roman stored", lang_of([[{"lang": "roman"}]]) == "roman", "-")
check("en stored", lang_of([[{"lang": "en"}]]) == "en", "-")
check("missing row -> None", lang_of([]) is None, "-")
check("junk value -> None", lang_of([[{"lang": "   "}]] ) is None, "-")
conn = FakeConn([RuntimeError("db down")])
with conn.cursor() as cur:
    check("db error -> None", portal_contacts.stored_language(
        cur, 1, "923001234567") is None, "-")
check("no contact -> no query", portal_contacts.stored_language(
    FakeConn([]).cursor(), 1, "") is None, "-")

print("== away variant pick ==")


def away_body(config, lang_rows):
    conn = FakeConn([[{"business_hours": config}], [], lang_rows, []])
    connector_api._maybe_enqueue_away_reply(1, 7, "923001234567", "in", conn)
    executed = conn.cur.executed
    body = None
    for sql, params in executed:
        if "INSERT INTO" in sql and "portal_away_replies" in sql:
            body = params[3]
    return executed, body


executed, body = away_body(CONFIG, [{"lang": "ur"}])
check("urdu variant sent", body == "ہم اس وقت دستیاب نہیں ہیں۔", body)
check("lang query hits portal_contact_lang",
      "portal_contact_lang" in executed[2][0], executed[2][0][:60])

executed, body = away_body(CONFIG, [{"lang": "roman"}])
check("roman variant sent", body == "Hum abhi off hain, thori dair me reply karenge.",
      body)

executed, body = away_body(CONFIG, [])
check("unknown lang -> default", body == "We are away.", body)

executed, body = away_body(
    {**CONFIG, "away_message_ur": "   "}, [{"lang": "ur"}])
check("blank variant falls back", body == "We are away.", body)

executed, body = away_body(
    {k: v for k, v in CONFIG.items()
     if k not in ("away_message_ur", "away_message_roman")},
    [{"lang": "ur"}])
check("no variants configured -> default", body == "We are away.", body)

print("== business-hours validation ==")

problems = portal_conversations._validate_business_hours({
    "enabled": True,
    "timezone": "Asia/Karachi",
    "days": VALID_DAYS,
    "away_message": "Away.",
    "away_message_ur": "اردو",
    "away_message_roman": "Roman",
})
check("valid variants pass", problems == [], problems)

problems = portal_conversations._validate_business_hours({
    "enabled": True,
    "timezone": "Asia/Karachi",
    "days": VALID_DAYS,
    "away_message": "Away.",
    "away_message_ur": "x" * 501,
})
check("urdu cap", problems == ["away_message_ur must be at most 500"
                               " characters."], problems)

problems = portal_conversations._validate_business_hours({
    "enabled": True,
    "timezone": "Asia/Karachi",
    "days": VALID_DAYS,
    "away_message": "Away.",
    "away_message_roman": 5,
})
check("roman type", problems == ["away_message_roman must be at most 500"
                                 " characters."], problems)

print("== web shape ==")

CONNECTOR = open("/tmp/p13/OmniFlow-Control-Plane/connector_api.py",
                 encoding="utf8").read()
check("connector variant pick", "away_message_ur" in CONNECTOR
      and "away_message_roman" in CONNECTOR
      and "stored_language" in CONNECTOR, "connector")
CONTACTS = open("/tmp/p13/OmniFlow-Control-Plane/portal_contacts.py",
                encoding="utf8").read()
check("helper exists", "def stored_language(" in CONTACTS, "helper")

PORTAL = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts", encoding="utf8").read()
check("config fields", "away_message_ur?" in PORTAL
      and "away_message_roman?" in PORTAL, "config")

CARD = open("/tmp/p13/Omniflow/app/dashboard/(portal)/settings/"
            "BusinessHoursCard.tsx", encoding="utf8").read()
check("card variant fields", "Away message — Urdu" in CARD
      and "away_message_roman" in CARD
      and "/api/omniflow/portal/business-hours" in CARD, "card")

summary("langreply")
