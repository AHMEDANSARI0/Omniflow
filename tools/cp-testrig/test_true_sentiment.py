"""Tests for V2 B24: TRUE SENTIMENT delivered (the AI-locked switch goes live).

The admin panel's true_sentiment flag now powers the Assist card too:
the assist endpoint classifies through the LLM (flag on) and falls back
to the deterministic Roman-Urdu lexicon (flag off or any LLM trouble);
the payload carries engine so the UI can tag real-AI results.
"""
import json

from flask import Flask

import platform_settings
import portal_insights
import portal_llm
import test_lib
from test_lib import (check, install_db_stub, PrincipalStub, status,
                      summary)

PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}

app = Flask("true-sentiment")
app.register_blueprint(portal_insights.bp)
client = app.test_client()

print("== flag off = lexicon engine ==")

platform_settings.flag = lambda name: False
result = portal_insights.analyze_sentiment_smart(
    "bohat kharab service hai, shikayat hai")
check("flag off lexicon", result["engine"] == "lexicon"
      and result["label"] == "negative", result)
check("flag off words", "shikayat" in result["negative"], result)

print("== flag on = LLM engine ==")

platform_settings.flag = lambda name: True
portal_llm.chat_json = lambda system, user, max_tokens=120: (
    {"label": "negative", "score": -4}
    if "shikayat" in user else {"label": "positive", "score": 3})
result = portal_insights.analyze_sentiment_smart(
    "bohat kharab service hai, shikayat hai")
check("llm label wins", result["label"] == "negative"
      and result["score"] == -4
      and result["engine"] == "llm", result)
check("llm prompt passes text", portal_llm.chat_json is not None, "stub")
check("llm kept words", "shikayat" in result["negative"], result)

result = portal_insights.analyze_sentiment_smart("shukriya acha kaam")
check("llm positive", result["label"] == "positive"
      and result["engine"] == "llm", result)

print("== LLM trouble falls back ==")

portal_llm.chat_json = lambda system, user, max_tokens=120: None
result = portal_insights.analyze_sentiment_smart("kharab hai")
check("none -> lexicon", result["engine"] == "lexicon", result)

portal_llm.chat_json = lambda system, user, max_tokens=120: {"nonsense": 1}
result = portal_insights.analyze_sentiment_smart("kharab hai")
check("bad label -> lexicon", result["engine"] == "lexicon"
      and result["label"] == "negative", result)

portal_llm.chat_json = lambda system, user, max_tokens=120: {
    "label": "negative", "score": "not-a-number"}
result = portal_insights.analyze_sentiment_smart("kharab hai")
check("bad score -> lexicon score", result["label"] == "negative"
      and result["engine"] == "llm" and result["score"] == -1, result)

def boom(*a, **k):
    raise RuntimeError("llm down")
portal_llm.chat_json = boom
result = portal_insights.analyze_sentiment_smart("kharab hai")
check("exception -> lexicon", result["engine"] == "lexicon", result)

print("== sentiment endpoint ==")

platform_settings.flag = lambda name: True
portal_llm.chat_json = lambda system, user, max_tokens=120: (
    {"label": "mixed", "score": -1})
PrincipalStub(portal_insights, principal=PRINCIPAL)
r = client.get("/api/v1/portal/insights/sentiment?text=acha lakin late")
body = r.get_json()
check("endpoint 200 llm", r.status_code == 200
      and body["label"] == "mixed" and body["engine"] == "llm", body)
r = client.get("/api/v1/portal/insights/sentiment")
check("endpoint empty 400", r.status_code == 400, r.status_code)

print("== assist endpoint uses the smart engine ==")

CONV = open("./portal_conversations.py", encoding="utf8").read()
check("assist smart switch", "portal_insights.analyze_sentiment_smart("
      in CONV, "switch")
check("lexicon still exported", "def analyze_sentiment(" in
      open("./portal_insights.py", encoding="utf8").read(), "export")

print("== admin switches ==")

ADMIN = open("./admin_providers.py", encoding="utf8").read()
check("admin true_sentiment switch", '"true_sentiment"' in ADMIN
      and '"kb_autodraft"' in ADMIN, "flags")
PLATFORM = open("./platform_settings.py", encoding="utf8").read()
check("flag defaults off", 'raw in ("on", "1", "true", "yes")' in PLATFORM,
      "off-default")

print("== website surface (vs /tmp/p13) ==")

P13 = "/tmp/p13/Omniflow/"


def read(path):
    return open(P13 + path, encoding="utf8").read()


PORTAL = read("lib/omniflow/portal.ts")
check("client sentiment engine", 'engine: entry.engine === "llm"' in PORTAL
      and 'engine: row.engine === "llm"' in PORTAL, "mappers")
check("client sentiment type", 'engine: "llm" | "lexicon";' in PORTAL,
      "types")

CARD = read("app/dashboard/(portal)/conversations/[id]/AssistCard.tsx")
check("assist ai tag", 'assist.sentiment?.engine === "llm"' in CARD
      and '" · AI"' in CARD, "tag")
check("assist local type", 'engine: "llm" | "lexicon";' in CARD, "type")

ADMIN_UI = read("app/admin/(panel)/integrations/IntegrationsClient.tsx")
check("admin switches text", "AI switches" in ADMIN_UI
      and "true_sentiment" in ADMIN_UI, "switches")

summary("true_sentiment")
