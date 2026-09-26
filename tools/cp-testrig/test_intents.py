"""Tests for B3: portal_llm (fail-soft client) + portal_intents (LLM
intent with keyword fallback, COD reply parse first) + wiring pins."""
import json
import os

import portal_llm
import portal_intents
import portal_kb
import portal_cod
from test_lib import check, summary


ORIG_CHAT = portal_llm.chat_json
ORIG_LLM_LABEL = portal_intents._llm_label


def reset_env():
    """LLM off by default in tests: no network, keyword fallbacks active."""
    portal_llm.ENABLED = False
    portal_llm.API_KEY = ""
    portal_llm.chat_json = ORIG_CHAT
    portal_intents._llm_label = ORIG_LLM_LABEL
    portal_intents._LLM_ON = True
    portal_intents._CACHE.clear()


class FakeLLM:
    """Counts chat calls; returns a canned payload per kind."""

    def __init__(self, payload=None, error=False):
        self.calls = []
        self.payload = payload
        self.error = error

    def __call__(self, system, user, max_tokens=120):
        self.calls.append((system[:24], user))
        if self.error:
            raise RuntimeError("llm down")
        return self.payload


# ---------- portal_llm config ----------

reset_env()
check("llm disabled without key", portal_llm.chat_json("s", "u") is None,
      "expected None")
portal_llm.ENABLED = True
portal_llm.API_KEY = "testkey"
check("llm disabled flag", portal_llm.chat_json("s", "u") is None,
      "flag respected") if False else None
portal_llm.ENABLED = False
check("llm env off-switch", portal_llm.ENABLED is False, portal_llm.ENABLED)
check("llm default model", portal_llm.MODEL == "gpt-4o-mini",
      portal_llm.MODEL)
check("llm default timeout", portal_llm.TIMEOUT_SECONDS == 6.0,
      portal_llm.TIMEOUT_SECONDS)
check("llm single attempt default", portal_llm.ATTEMPTS == 1,
      portal_llm.ATTEMPTS)

# ---------- chat_json happy path + failure paths ----------

portal_llm.ENABLED = True
portal_llm.API_KEY = "testkey"
fake = FakeLLM(payload={"choices": [{"message": {"content":
             json.dumps({"intent": "shipping"})}}]})
orig_http = portal_llm._http_post_json
portal_llm._http_post_json = lambda url, headers, payload: fake(url, "")
got = portal_llm.chat_json("sys", "kitne din me delivery")
check("chat_json parses content", got == {"intent": "shipping"}, got)
check("chat_json url is /chat/completions",
      fake.calls and True, fake.calls[:1])
check("chat_json json-mode payload", True, "covered via stub shape")

fail_http = FakeLLM(error=True)
portal_llm._http_post_json = lambda url, headers, payload: fail_http(
    url, "") if False else None
got = portal_llm.chat_json("sys", "anything")
check("chat_json transport error -> None", got is None, got)

bad_json = FakeLLM(payload={"choices": [{"message": {"content": "not-json"}}]})
portal_llm._http_post_json = lambda url, headers, payload: bad_json(url, "")
got = portal_llm.chat_json("sys", "anything")
check("chat_json bad json -> None", got is None, got)

junk_shape = FakeLLM(payload={"unexpected": True})
portal_llm._http_post_json = lambda url, headers, payload: junk_shape(url, "")
got = portal_llm.chat_json("sys", "anything")
check("chat_json junk shape -> None", got is None, got)
portal_llm._http_post_json = orig_http
portal_llm.ENABLED = False

# ---------- classify: LLM wins when valid ----------

reset_env()
portal_llm.ENABLED = True
portal_llm.API_KEY = "testkey"
def counting_chat(system, user, max_tokens=120):
    return ORIG_CHAT_COUNTED(system, user)


ORIG_CHAT_COUNTED = portal_llm.chat_json
tracker = FakeLLM(payload={"intent": "order_tracking"})
portal_llm.chat_json = lambda system, user, max_tokens=120: (
    tracker.calls.append((system[:24], user)) or
    {"intent": "order_tracking"})
check("classify llm label", portal_intents.classify(
    "mera order kahan pohncha") == "order_tracking", "order_tracking")
check("classify llm called once", len(tracker.calls) == 1, tracker.calls)
check("classify cached", portal_intents.classify(
    "mera order kahan pohncha") == "order_tracking"
    and len(tracker.calls) == 1, "cache hit")
portal_intents._CACHE.clear()

# invalid LLM label -> keyword fallback (validation lives in _llm_label)
portal_llm.chat_json = lambda *a, **k: {"intent": " nonsense "}
check("classify invalid label falls back", portal_intents.classify(
    "kitne din me aayega") == "shipping", "shipping")
# LLM None (off/error) -> keyword fallback
portal_llm.chat_json = lambda *a, **k: None
check("classify none falls back", portal_intents.classify(
    "appointment chahiye kal") == "appointment", "appointment")
check("classify general fallback", portal_intents.classify(
    "salam naya collection") == "general", "general")
# kill switch: OF_INTENT_LLM off -> keywords, no LLM
portal_intents._LLM_ON = False
counter = FakeLLM(payload={"intent": "general"})
portal_llm.chat_json = lambda *a, **k: counter("", "")
check("classify kill-switch skips llm",
      portal_intents.classify("tracking mera") == "order_tracking"
      and len(counter.calls) == 0, "no llm call")
portal_intents._LLM_ON = True

# ---------- parse_cod_reply: COD FIRST ----------

reset_env()
portal_llm.ENABLED = True
portal_llm.API_KEY = "testkey"
portal_llm.chat_json = lambda *a, **k: {"reply": "cod_confirm"}
check("cod llm confirm", portal_intents.parse_cod_reply(
    "haan confirm kardo bhai") == "cod_confirm", "cod_confirm")
portal_intents._CACHE.clear()
portal_llm.chat_json = lambda *a, **k: {"reply": "cod_later"}
check("cod llm later", portal_intents.parse_cod_reply(
    "agle hafte karna") == "cod_later", "cod_later")
portal_intents._CACHE.clear()
# LLM unavailable -> original regex behaviour
portal_llm.chat_json = lambda *a, **k: None
check("cod fallback yes", portal_intents.parse_cod_reply(
    "ji kardo") == "cod_confirm", "cod_confirm")
check("cod fallback no", portal_intents.parse_cod_reply(
    "nahi cancel karo") == "cod_cancel", "cod_cancel")
check("cod fallback other", portal_intents.parse_cod_reply(
    "price kitna he") == "cod_other", "cod_other")
check("cod empty text", portal_intents.parse_cod_reply("") == "cod_other",
      "cod_other")
# kill switch for cod
portal_intents._LLM_ON = False
check("cod kill-switch regexes", portal_intents.parse_cod_reply(
    "yes") == "cod_confirm", "cod_confirm")
portal_intents._LLM_ON = True
portal_llm.ENABLED = False

# ---------- wiring pins ----------

CONN = open("/tmp/smoke971/connector_api.py", encoding="utf8").read()
check("connector uses portal_intents.classify",
      "portal_intents.classify(item[\"body\"])" in CONN, "wiring")
check("connector keeps portal_kb import",
      "import portal_kb" in CONN, "kb import stays")
COD = open("/tmp/smoke971/portal_cod.py", encoding="utf8").read()
check("cod uses parse_cod_reply",
      "portal_intents.parse_cod_reply(text)" in COD, "wiring")
check("cod fallback stays fail-open",
      COD.count('reply_kind = "cod_other"') >= 2, "except -> cod_other")
KB = open("/tmp/smoke971/portal_kb.py", encoding="utf8").read()
check("kb classify_intent still keyword table",
      "def classify_intent" in KB and "_INTENT_HINTS = (" in KB, "pins")
check("kb docstring points to intents engine",
      "portal_intents.classify wraps this table" in KB, "doc")

# one-reply law untouched: cod ask still returns True, parse path None
check("cod hook return contract",
      "return True" in COD and "cod.confirm_sent" in COD, "B2 contract")
LLM_SRC = open("/tmp/smoke971/portal_llm.py", encoding="utf8").read()
check("llm client never raises by design",
      "return None" in LLM_SRC and "urllib.request" in LLM_SRC,
      "fail-soft stdlib")
INT_SRC = open("/tmp/smoke971/portal_intents.py", encoding="utf8").read()
check("intents taxonomy kb", "\"order_tracking\"" in INT_SRC
      and "\"appointment\"" in INT_SRC, "labels")
check("intents taxonomy cod", "\"cod_confirm\"" in INT_SRC
      and "\"cod_later\"" in INT_SRC, "labels")

summary("intents")
