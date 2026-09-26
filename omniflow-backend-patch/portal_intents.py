"""B3 intent engine: Roman-Urdu aware, LLM first, keyword fallback.

Two public helpers:

* ``classify(text)`` -> KB intent label (``order_tracking`` | ``shipping`` |
  ``appointment`` | ``general``). The LLM understands Roman Urdu naturally
  ("mera order kahan pohncha", "kitne din me aayega"); without a key (or on
  any failure) it falls back to ``portal_kb.classify_intent`` keywords.
* ``parse_cod_reply(text)`` -> COD confirmation label (``cod_confirm`` |
  ``cod_cancel`` | ``cod_later`` | ``cod_other``). COD parsing comes FIRST
  in the roadmap: the fallback path is the exact regex behaviour the COD
  flow shipped with, so turning the LLM on only widens understanding.

Cost/latency bounds: the engine only runs where the ingest chain already
needed a decision — COD parse fires only while a pending confirmation
request exists, and the KB classify sits last in the one-reply chain (B2),
behind away/COD. Identical texts are served from a small TTL cache.
Kill switches: ``OF_LLM_ENABLED=0`` (or ``OF_INTENT_LLM=0``) -> pure
keywords, zero latency, zero cost.
"""

import hashlib
import os
import time
from typing import Any, Dict, Optional, Tuple

KB_INTENTS = ("order_tracking", "shipping", "appointment", "general")
COD_LABELS = ("cod_confirm", "cod_cancel", "cod_later", "cod_other")

_LLM_ON = os.environ.get(
    "OF_INTENT_LLM", "1").strip().lower() not in ("0", "false", "no", "off")
_CACHE_TTL_SECONDS = int(
    os.environ.get("OF_INTENT_CACHE_SECONDS", "600") or 600)
_CACHE_MAX = 500

_CACHE: Dict[str, Tuple[float, str]] = {}

_INTENT_SYSTEM = (
    "You label WhatsApp customer messages for a Pakistani retail business. "
    "Customers often write in Roman Urdu. Reply ONLY with JSON: "
    '{"intent": "order_tracking|shipping|appointment|general"}. '
    "order_tracking = where is my order / status; shipping = delivery time, "
    "charges, courier; appointment = booking a time; general = everything "
    'else. Examples: "mera order kahan he" -> order_tracking, "kitne din me '
    'delivery hogi" -> shipping, "kal 5 baje appointment chahiye" -> '
    'appointment, "salam" -> general.'
)

_COD_SYSTEM = (
    "You interpret replies to a cash-on-delivery confirmation question "
    "(the customer was told to say YES to confirm or NO to cancel). "
    "Customers often write in Roman Urdu. Reply ONLY with JSON: "
    '{"reply": "cod_confirm|cod_cancel|cod_later|cod_other"}. '
    "cod_confirm = yes / confirm / kardo / theek he; cod_cancel = no / "
    "cancel / nahi chahiye; cod_later = maybe later / different date / ask "
    'me again; cod_other = anything unclear. Examples: "haan confirm kardo" '
    '-> cod_confirm, "nahi cancel kar do" -> cod_cancel, "agle hafte karna" '
    '-> cod_later, "price kitna he" -> cod_other.'
)


def _cache_get(key: str) -> Optional[str]:
    hit = _CACHE.get(key)
    if not hit:
        return None
    expires, value = hit
    if expires < time.time():
        _CACHE.pop(key, None)
        return None
    return value


def _cache_put(key: str, value: str) -> None:
    if len(_CACHE) >= _CACHE_MAX:
        oldest = sorted(_CACHE.items(), key=lambda kv: kv[1][0])[:64]
        for old_key, _ in oldest:
            _CACHE.pop(old_key, None)
    _CACHE[key] = (time.time() + max(30, _CACHE_TTL_SECONDS), value)


def _cache_key(kind: str, text: str) -> str:
    return kind + ":" + hashlib.sha1(
        (str(_LLM_ON) + "|" + text).encode("utf-8")).hexdigest()


def _llm_label(system: str, text: str, field: str,
               valid) -> Optional[str]:
    """Ask the LLM; return the label only when it is one of ``valid``."""
    import portal_llm

    data = portal_llm.chat_json(system, text)
    if not isinstance(data, dict):
        return None
    label = str(data.get(field) or "").strip()
    return label if label in valid else None


def classify(message_text) -> str:
    """KB intent for one inbound message (LLM, then keyword fallback)."""
    text = str(message_text or "").strip()
    if not text:
        return "general"
    key = _cache_key("i", text)
    cached = _cache_get(key)
    if cached is not None:
        return cached
    result: Optional[str] = None
    if _LLM_ON:
        result = _llm_label(_INTENT_SYSTEM, text, "intent", KB_INTENTS)
    if result is None:
        import portal_kb

        result = portal_kb.classify_intent(text)
    _cache_put(key, result)
    return result


def _keyword_cod_reply(text: str) -> str:
    """The original COD regexes — the offline fallback for parse_cod_reply."""
    import portal_cod

    if portal_cod._NO_RE.match(text):
        return "cod_cancel"
    if portal_cod._YES_RE.match(text):
        return "cod_confirm"
    return "cod_other"


def parse_cod_reply(message_text) -> str:
    """Label a reply to the COD confirmation ask (LLM, then regexes)."""
    text = str(message_text or "").strip()
    if not text:
        return "cod_other"
    key = _cache_key("c", text)
    cached = _cache_get(key)
    if cached is not None:
        return cached
    result: Optional[str] = None
    if _LLM_ON:
        result = _llm_label(_COD_SYSTEM, text, "reply", COD_LABELS)
    if result is None:
        result = _keyword_cod_reply(text)
    _cache_put(key, result)
    return result
