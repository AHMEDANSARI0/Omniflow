"""Intelligence engine (master-upgrade engine 5): ONE shared analysis
result for the whole platform.

Before this module intent lived in portal_intents, sentiment in
portal_insights and language in portal_contacts — three classifiers,
three call sites, no shared shape. Engines downstream (Action Engine,
agents, workflows) need ONE answer:

    {"intent": ..., "sentiment": ..., "language": ...,
     "purchase_intent": "low|medium|high", "urgency": "low|medium|high",
     "confidence": 0.0-1.0}

Laws kept:
- reuses the existing classifiers (no duplicates): portal_intents for
  the KB intent, portal_insights.analyze_sentiment_smart for sentiment
  (lexicon or LLM per the admin switch), portal_contacts for language;
- purchase_intent / urgency are deterministic Roman-Urdu heuristics
  (v1) — never fabricated, cheap, and they ride the same result;
- the latest result per conversation is stored (portal_intelligence)
  so every surface reads the same numbers;
- fail-soft: analysis problems never break message ingest;
- kill switch: OF_INTELLIGENCE_ENABLED=0 keeps the API read-only.
"""

import json
import os
from typing import Any, Dict, Optional

from flask import Blueprint, jsonify, request

import portal_db
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
)

bp = Blueprint("portal_intelligence", __name__,
               url_prefix="/api/v1/portal/intelligence")

TABLE = os.environ.get("OF_INTELLIGENCE_TABLE", "portal_intelligence")
_ENABLED = os.environ.get("OF_INTELLIGENCE_ENABLED", "1").strip() \
    .lower() not in ("0", "false", "no", "off")

_PURCHASE_HIGH = (
    "chahiye", "lena hai", "order karna", "kharidna", "price kya",
    "rate kya", "kitne ka", "qarz", "buy", "order kar", "book kar",
)
_PURCHASE_MEDIUM = (
    "price", "rate", "rate bat", "kitne me", "detail", "stock",
    "available", "size", "colour", "color",
)
_URGENCY_HIGH = (
    "jaldi", "abhi", "foran", "urgent", "turant", "aaj hi", "today",
    "asap",
)
_URGENCY_MEDIUM = ("kal", "kal tak", "soon", "is week", "jald")


def _hit(text: str, needles) -> int:
    """Whole-word hits only — "kabhi" must not match "abhi"."""
    padded = " " + " ".join(str(text or "").lower().split()) + " "
    return sum(1 for needle in needles
               if " " + needle + " " in padded)


def purchase_intent(text: str) -> str:
    t = " ".join(str(text or "").lower().split())
    if not t:
        return "low"
    if _hit(t, _PURCHASE_HIGH) >= 1 and _hit(t, _PURCHASE_MEDIUM) >= 1:
        return "high"
    if _hit(t, _PURCHASE_HIGH) >= 1:
        return "high"
    if _hit(t, _PURCHASE_MEDIUM) >= 2:
        return "medium"
    if _hit(t, _PURCHASE_MEDIUM) == 1:
        return "low"
    return "low"


def urgency(text: str) -> str:
    t = " ".join(str(text or "").lower().split())
    if _hit(t, _URGENCY_HIGH) >= 1:
        return "high"
    if _hit(t, _URGENCY_MEDIUM) >= 1:
        return "medium"
    return "low"


def _ensure_ddl(cur) -> None:
    cur.execute(
        "CREATE TABLE IF NOT EXISTS " + portal_db._q(TABLE) + " ("
        " client_id BIGINT NOT NULL,"
        " conversation_id BIGINT NOT NULL,"
        " contact_id TEXT,"
        " intent TEXT,"
        " sentiment TEXT,"
        " sentiment_engine TEXT,"
        " language TEXT,"
        " purchase_intent TEXT,"
        " urgency TEXT,"
        " confidence NUMERIC(3,2) NOT NULL DEFAULT 0,"
        " source_text TEXT,"
        " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
        " PRIMARY KEY (client_id, conversation_id)"
        ")"
    )


def analyze(text: str, stored_language: Optional[str] = None) -> Dict[str, Any]:
    """The shared IntelligenceResult (never raises)."""
    body = str(text or "")
    intent = "general"
    sentiment = "neutral"
    sentiment_engine = "lexicon"
    language = stored_language or "roman"
    try:
        import portal_intents

        intent = portal_intents.classify(body) or "general"
    except Exception:
        pass
    try:
        import portal_insights

        verdict = portal_insights.analyze_sentiment_smart(body)
        if verdict:
            sentiment = str(verdict.get("label") or sentiment)
            sentiment_engine = str(verdict.get("engine")
                                   or sentiment_engine)
    except Exception:
        pass
    if stored_language is None:
        try:
            import portal_contacts

            language = portal_contacts.detect_language(body) or "roman"
        except Exception:
            pass
    try:
        confidence = round(0.9 if sentiment_engine == "llm" else 0.65, 2)
    except Exception:
        confidence = 0.6
    return {
        "intent": intent,
        "sentiment": sentiment,
        "sentiment_engine": sentiment_engine,
        "language": language,
        "purchase_intent": purchase_intent(body),
        "urgency": urgency(body),
        "confidence": confidence,
    }


def store(cur, client_id: int, conversation_id: Optional[int],
          contact_id: Optional[str], result: Dict[str, Any],
          source_text: str) -> None:
    """Upsert the latest result for one conversation (caller commits)."""
    if conversation_id is None:
        return
    _ensure_ddl(cur)
    cur.execute(
        "INSERT INTO " + portal_db._q(TABLE) +
        " (client_id, conversation_id, contact_id, intent, sentiment,"
        " sentiment_engine, language, purchase_intent, urgency,"
        " confidence, source_text, updated_at)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())"
        " ON CONFLICT (client_id, conversation_id) DO UPDATE SET"
        " contact_id = EXCLUDED.contact_id, intent = EXCLUDED.intent,"
        " sentiment = EXCLUDED.sentiment,"
        " sentiment_engine = EXCLUDED.sentiment_engine,"
        " language = EXCLUDED.language,"
        " purchase_intent = EXCLUDED.purchase_intent,"
        " urgency = EXCLUDED.urgency, confidence = EXCLUDED.confidence,"
        " source_text = EXCLUDED.source_text, updated_at = NOW()",
        (client_id, conversation_id, (contact_id or "")[:100] or None,
         result.get("intent"), result.get("sentiment"),
         result.get("sentiment_engine"), result.get("language"),
         result.get("purchase_intent"), result.get("urgency"),
         result.get("confidence"), str(source_text or "")[:400]),
    )


def maybe_analyze(client_id: int, conversation_id, contact_id: str,
                  body: str, direction: str, conn) -> bool:
    """Inbound side-effect hook: refresh the stored result. Never claims,
    never raises. Returns False always (no claim)."""
    if not _ENABLED or direction != "in" or conversation_id is None:
        return False
    try:
        with conn.cursor() as cur:
            stored = None
            try:
                import portal_contacts

                stored = portal_contacts.stored_language(
                    cur, client_id, contact_id)
            except Exception:
                stored = None
            result = analyze(body, stored)
            store(cur, client_id, conversation_id, contact_id, result,
                  body)
        return False
    except Exception:
        return False


def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable:
        return None, (jsonify({"error": {
            "code": "portal_unavailable",
            "message": "Auth is unavailable, try again."}}), 503)
    if not principal:
        return None, (jsonify({"error": {
            "code": "unauthorized",
            "message": "Sign in zaroori hai."}}), 401)
    return principal, None


def _serialize(row: Dict[str, Any]) -> Dict[str, Any]:
    def _plain(value):
        try:
            return float(value) if value is not None else None
        except (TypeError, ValueError):
            return None
    return {
        "conversationId": row.get("conversation_id"),
        "contactId": row.get("contact_id"),
        "intent": row.get("intent"),
        "sentiment": row.get("sentiment"),
        "sentimentEngine": row.get("sentiment_engine"),
        "language": row.get("language"),
        "purchaseIntent": row.get("purchase_intent"),
        "urgency": row.get("urgency"),
        "confidence": _plain(row.get("confidence")),
        "updatedAt": str(row.get("updated_at")) if row.get("updated_at")
        else None,
    }


@bp.get("/conversations/<int:conversation_id>")
def conversation_intelligence(conversation_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                cur.execute(
                    "SELECT * FROM " + portal_db._q(TABLE) +
                    " WHERE client_id = %s AND conversation_id = %s",
                    (principal["client_id"], conversation_id),
                )
                rows = portal_db.rows(cur)
                if rows:
                    return jsonify(_serialize(rows[0])), 200
                # nothing stored yet: analyze the latest inbound message
                cur.execute(
                    "SELECT body FROM " + portal_db._q(portal_db.MSGS_TABLE)
                    + " WHERE conversation_id = %s AND client_id = %s"
                    " AND direction = 'in' ORDER BY id DESC LIMIT 1",
                    (conversation_id, principal["client_id"]),
                )
                latest = portal_db.rows(cur)
                text = str((latest[0] if latest else {}).get("body") or "")
                stored_lang = None
                contact_row = []
                cur.execute(
                    "SELECT contact_id FROM " + portal_db._q(
                        portal_db.CONV_TABLE) +
                    " WHERE id = %s AND client_id = %s",
                    (conversation_id, principal["client_id"]),
                )
                contact_row = portal_db.rows(cur)
                contact_id = str((contact_row[0] if contact_row else {})
                                 .get("contact_id") or "")
                if contact_id:
                    try:
                        import portal_contacts

                        stored_lang = portal_contacts.stored_language(
                            cur, principal["client_id"], contact_id)
                    except Exception:
                        stored_lang = None
                result = analyze(text, stored_lang)
                if _ENABLED:
                    store(cur, principal["client_id"], conversation_id,
                          contact_id or None, result, text)
        finally:
            conn.close()
    except Exception as exc:
        return jsonify(portal_db.portal_unavailable(
            exc, "intelligence read")[0]), 503
    payload = dict(result)
    payload["conversationId"] = conversation_id
    return jsonify(payload), 200
