"""Business Intelligence layer (MASTER-UPGRADE build-order 12): insights,
problem detector, AI quality and the journey funnel - deterministic mining
over data the platform ALREADY collects. Zero LLM cost, no new write path.

    GET /api/v1/portal/bi/report?days=7|30 ->
        {days, generated_at, insights, ai_quality, funnel, problems}

* insights   - what customers talk about (topic lexicon over the inbound
               messages of the window, with the previous window for trend
               and real example questions as evidence), sentiment /
               purchase-intent / urgency mix (portal_intelligence), busy
               hours, knowledge gaps, commerce signals (COD declines,
               checkout conversion, delivery problems, overdue replies,
               CSAT).
* ai_quality - what the assistant did and how well: decisions send vs
               handoff with reasons, average confidence, grounded / cited
               share (portal_brain_traces), resolution rate (answered chats
               that never needed a human), CSAT after AI answers, engine
               failures + latency (portal_ai_usage), handoff trend
               (portal_escalations), the questions it could not answer.
* funnel     - the owner's journey stages (portal_memory): who is where
               now, who reached each stage in the window, stage-to-stage
               conversion, median time to move on, contacts stalled.
* problems   - the Problem Detector: rules over the numbers above ->
               Problem / Evidence / Impact / Confidence / Action, each with
               a deep link. Thresholds default from env (OF_BI_*) and owners can
               override them per workspace (client_settings.bi_thresholds);
               busy hours use the business_hours timezone. Confidence
               grows with sample size, nothing fires on thin data.

Every block runs behind a SAVEPOINT so one missing table blanks only that
block; samples are capped (OF_BI_SAMPLE_MAX / OF_BI_EVENTS_MAX) so a busy
workspace cannot make the page wait. Tenant-scoped; open to API keys
(read-only).
"""

import json
import logging
import json
import os
import re
import statistics
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_db
from portal_auth import PortalAuthUnavailable, authenticate_portal_request

logger = logging.getLogger("omniflow.portal-bi")

bp = Blueprint("portal_bi", __name__, url_prefix="/api/v1/portal")

DEFAULT_DAYS = 7
ALLOWED_DAYS = (7, 30)
SAMPLE_MAX = int(os.environ.get("OF_BI_SAMPLE_MAX", "3000") or 3000)
EVENTS_MAX = int(os.environ.get("OF_BI_EVENTS_MAX", "5000") or 5000)
GAPS_MAX = int(os.environ.get("OF_BI_GAPS_MAX", "200") or 200)
EXAMPLES = int(os.environ.get("OF_BI_EXAMPLES", "3") or 3)
TZ_OFFSET_HOURS = int(os.environ.get("OF_BI_TZ_OFFSET_HOURS", "5") or 5)
STALL_DAYS = int(os.environ.get("OF_BI_STALL_DAYS", "7") or 7)
MAX_PROBLEMS = int(os.environ.get("OF_BI_MAX_PROBLEMS", "8") or 8)


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except Exception:
        return default


#: Problem-detector thresholds (share = 0..1, min = sample size).
THRESHOLDS: Dict[str, float] = {
    "gaps_min": _env_float("OF_BI_GAPS_MIN", 5),
    "topic_min": _env_float("OF_BI_TOPIC_MIN", 10),
    "delivery_share": _env_float("OF_BI_DELIVERY_SHARE", 0.25),
    "price_share": _env_float("OF_BI_PRICE_SHARE", 0.20),
    "trouble_share": _env_float("OF_BI_TROUBLE_SHARE", 0.15),
    "negative_share": _env_float("OF_BI_NEGATIVE_SHARE", 0.25),
    "sentiment_min": _env_float("OF_BI_SENTIMENT_MIN", 10),
    "handoff_share": _env_float("OF_BI_HANDOFF_SHARE", 0.30),
    "decisions_min": _env_float("OF_BI_DECISIONS_MIN", 10),
    "handoff_growth": _env_float("OF_BI_HANDOFF_GROWTH", 0.5),
    "handoff_min": _env_float("OF_BI_HANDOFF_MIN", 5),
    "policy_min": _env_float("OF_BI_POLICY_MIN", 3),
    "ai_fail_share": _env_float("OF_BI_AI_FAIL_SHARE", 0.20),
    "ai_calls_min": _env_float("OF_BI_AI_CALLS_MIN", 10),
    "cod_decline_share": _env_float("OF_BI_COD_DECLINE_SHARE", 0.30),
    "cod_min": _env_float("OF_BI_COD_MIN", 10),
    "checkout_conversion": _env_float("OF_BI_CHECKOUT_CONVERSION", 0.40),
    "checkout_min": _env_float("OF_BI_CHECKOUT_MIN", 10),
    "delivery_fail_share": _env_float("OF_BI_DELIVERY_FAIL_SHARE", 0.15),
    "bookings_min": _env_float("OF_BI_BOOKINGS_MIN", 10),
    "csat_low": _env_float("OF_BI_CSAT_LOW", 3.5),
    "csat_min": _env_float("OF_BI_CSAT_MIN", 5),
    "overdue_min": _env_float("OF_BI_OVERDUE_MIN", 5),
    "stall_share": _env_float("OF_BI_STALL_SHARE", 0.30),
    "stall_min": _env_float("OF_BI_STALL_MIN", 10),
}

#: Owner-editable knobs under client_settings.settings.bi_thresholds.
#: Env OF_BI_* remains the default floor; blank keys fall back here.
OWNER_THRESHOLD_KEYS = (
    "gaps_min", "topic_min", "delivery_share", "price_share", "trouble_share",
    "negative_share", "sentiment_min", "handoff_share", "decisions_min",
    "handoff_growth", "handoff_min", "policy_min", "ai_fail_share",
    "ai_calls_min", "cod_decline_share", "cod_min", "checkout_conversion",
    "checkout_min", "delivery_fail_share", "bookings_min", "csat_low",
    "csat_min", "overdue_min", "stall_share", "stall_min",
)
SHARE_KEYS = {
    "delivery_share", "price_share", "trouble_share", "negative_share",
    "handoff_share", "ai_fail_share", "cod_decline_share", "checkout_conversion",
    "delivery_fail_share", "stall_share", "handoff_growth",
}
MIN_KEYS = {
    "gaps_min", "topic_min", "sentiment_min", "decisions_min", "handoff_min",
    "policy_min", "ai_calls_min", "cod_min", "checkout_min", "bookings_min",
    "csat_min", "overdue_min", "stall_min",
}


def _clamp_threshold(key: str, value: float) -> float:
    if key in SHARE_KEYS:
        return max(0.0, min(1.0, float(value)))
    if key == "csat_low":
        return max(1.0, min(5.0, float(value)))
    if key in MIN_KEYS:
        return max(1.0, min(1000.0, float(value)))
    return float(value)


def default_thresholds() -> Dict[str, float]:
    return {k: float(v) for k, v in THRESHOLDS.items()}


def thresholds_for(cur, client_id: int) -> Dict[str, float]:
    """Env defaults overlaid with owner-saved client_settings.bi_thresholds."""
    out = default_thresholds()
    try:
        cur.execute(
            "SELECT settings -> 'bi_thresholds' AS bi_thresholds FROM "
            + portal_db._q("client_settings") +
            " WHERE client_id = %s",
            (client_id,),
        )
        rows = portal_db.rows(cur)
        stored = rows[0].get("bi_thresholds") if rows and rows[0] else None
        if isinstance(stored, str):
            import json as _json
            try:
                stored = _json.loads(stored)
            except Exception:
                stored = None
        if isinstance(stored, dict):
            for key in OWNER_THRESHOLD_KEYS:
                raw = stored.get(key)
                if raw is None or isinstance(raw, bool):
                    continue
                try:
                    out[key] = _clamp_threshold(key, float(raw))
                except Exception:
                    continue
    except Exception as error:
        logger.warning("bi thresholds load failed: %s", error)
    return out


def timezone_offset_hours(cur, client_id: int) -> int:
    """Workspace timezone from business_hours; env OF_BI_TZ_OFFSET_HOURS fallback."""
    name = None
    try:
        cur.execute(
            "SELECT settings -> 'business_hours' AS business_hours FROM "
            + portal_db._q("client_settings") +
            " WHERE client_id = %s",
            (client_id,),
        )
        rows = portal_db.rows(cur)
        stored = rows[0].get("business_hours") if rows and rows[0] else None
        if isinstance(stored, str):
            import json as _json
            try:
                stored = _json.loads(stored)
            except Exception:
                stored = None
        if isinstance(stored, dict):
            name = stored.get("timezone")
    except Exception as error:
        logger.warning("bi timezone load failed: %s", error)
    if isinstance(name, str) and name.strip():
        try:
            from zoneinfo import ZoneInfo
            from datetime import datetime as _dt
            now = _dt.now(ZoneInfo("UTC"))
            local = now.astimezone(ZoneInfo(name.strip()))
            offset = local.utcoffset()
            if offset is not None:
                return int(offset.total_seconds() // 3600)
        except Exception:
            pass
    return TZ_OFFSET_HOURS


def _validate_thresholds(payload) -> tuple:
    if not isinstance(payload, dict):
        return None, "bi_thresholds must be an object."
    clean: Dict[str, float] = {}
    for key, raw in payload.items():
        if key not in OWNER_THRESHOLD_KEYS:
            continue
        if raw is None or isinstance(raw, bool):
            return None, key + " must be a number."
        try:
            clean[key] = _clamp_threshold(key, float(raw))
        except Exception:
            return None, key + " must be a number."
    return clean, None


#: (key, label, keywords) - lower-cased substring / word matches over the
#: customer's text; Roman-Urdu + English. A message may carry several.
TOPICS: Tuple[Tuple[str, str, Tuple[str, ...]], ...] = (
    ("delivery_time", "Delivery time", (
        "kab tak", "kitne din", "kitna time", "kab aayega", "kab ayega",
        "kab milega", "kab pohnch", "kab pahunch", "delivery", "deliver",
        "shipping", "courier", "tracking", "track", "dispatch", "arrive",
        "pohanch", "pahunch")),
    ("price", "Price & discounts", (
        "price", "qeemat", "keemat", "kitne ka", "kitne ki", "kitna hai",
        "rate", "mehnga", "mehngi", "sasta", "sasti", "discount", "kam karo",
        "kam kar", "offer", "deal", "cheap", "expensive", "final price")),
    ("availability", "Availability & sizes", (
        "available", "availab", "stock", "mil jayega", "mil jaye ga",
        "milega", "hai kya", "size", "colour", "color", "variant", "restock",
        "out of stock", "khatam")),
    ("payment", "Payment & COD", (
        "payment", "jazzcash", "easypaisa", "bank", "advance", "cod",
        "cash on delivery", "paisay", "paise", "transfer", "card", "pay ")),
    ("returns", "Returns & refunds", (
        "return", "wapas", "wapis", "exchange", "refund", "replace",
        "kharab", "defect", "damage", "tuta", "toota", "galat", "wrong item")),
    ("complaint", "Complaints", (
        "complaint", "shikayat", "bakwas", "ghatiya", "late", "abhi tak nahi",
        "nahi aya", "nahi aaya", "nahi mila", "fraud", "dhoka", "cheat",
        "worst", "bura", "not received", "no response", "koi jawab")),
    ("order_status", "Order status", (
        "order", "status", "confirm", "booking", "book kar", "receipt",
        "invoice", "order number", "order no")),
    ("hours_location", "Hours & location", (
        "timing", "open hai", "kab tak open", "kab khulta", "address",
        "location", "kahan hai", "kahan par", "shop kahan", "branch",
        "map", "directions", "closed")),
)
TOPIC_LABELS = {key: label for key, label, _kw in TOPICS}
_WORD_RE = re.compile(r"[a-z]+")


def topics_for(text: str) -> List[str]:
    """Topic keys present in one customer text (deterministic lexicon)."""
    lowered = " " + re.sub(r"\s+", " ", str(text or "").lower()) + " "
    words = set(_WORD_RE.findall(lowered))
    found: List[str] = []
    for key, _label, keywords in TOPICS:
        for keyword in keywords:
            if " " in keyword.strip() or keyword.endswith(" "):
                hit = keyword in lowered
            elif len(keyword) <= 4:
                hit = keyword in words
            else:
                hit = keyword in lowered
            if hit:
                found.append(key)
                break
    return found


def _days(value: Any) -> int:
    try:
        days = int(value or DEFAULT_DAYS)
    except Exception:
        days = DEFAULT_DAYS
    return days if days in ALLOWED_DAYS else DEFAULT_DAYS


def _share(part: int, whole: int) -> float:
    return round(part / whole, 3) if whole else 0.0


def _iso(value: Any) -> Optional[str]:
    if value is None or value == "":
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _snippet(text: Any, limit: int = 120) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text[:limit] + ("\u2026" if len(text) > limit else "")


def _guarded(cur, label: str, fn: Callable[[], Any]):
    """Run one block behind a SAVEPOINT; None when it fails (a missing
    table must blank only its block, never the whole report)."""
    try:
        cur.execute("SAVEPOINT of_bi")
        value = fn()
        cur.execute("RELEASE SAVEPOINT of_bi")
        return value
    except Exception as error:
        logger.warning("bi %s failed: %s", label, error)
        try:
            cur.execute("ROLLBACK TO SAVEPOINT of_bi")
        except Exception:
            pass
        return None


# ---------------------------------------------------------------------------
# insights
# ---------------------------------------------------------------------------

def _sample_messages(cur, client_id: int, days: int) -> List[Dict[str, Any]]:
    cur.execute(
        "SELECT conversation_id, body, created_at,"
        " (created_at > NOW() - make_interval(days => %s)) AS current"
        " FROM " + portal_db._q(portal_db.MSGS_TABLE) +
        " WHERE client_id = %s AND direction = 'in'"
        " AND created_at > NOW() - make_interval(days => %s)"
        " ORDER BY id DESC LIMIT %s",
        (days, client_id, days * 2, SAMPLE_MAX),
    )
    return portal_db.rows(cur)


def topic_insights(messages: List[Dict[str, Any]],
                  tz_offset_hours: Optional[int] = None) -> Dict[str, Any]:
    """Pure: topic shares for the current window, the previous window's
    share for trend, example questions, busy hours."""
    offset = TZ_OFFSET_HOURS if tz_offset_hours is None else int(tz_offset_hours)
    current = [m for m in messages if m.get("current")]
    previous = [m for m in messages if not m.get("current")]
    counts: Dict[str, int] = {}
    prev_counts: Dict[str, int] = {}
    examples: Dict[str, List[str]] = {}
    conversations: Dict[str, set] = {}
    hours: Dict[int, int] = {}
    for message in current:
        keys = topics_for(message.get("body"))
        for key in keys:
            counts[key] = counts.get(key, 0) + 1
            conversations.setdefault(key, set()).add(message.get("conversation_id"))
            bucket = examples.setdefault(key, [])
            if len(bucket) < EXAMPLES:
                snippet = _snippet(message.get("body"))
                if snippet and snippet not in bucket:
                    bucket.append(snippet)
        when = message.get("created_at")
        if hasattr(when, "hour"):
            hours[(when.hour + offset) % 24] = hours.get(
                (when.hour + offset) % 24, 0) + 1
    for message in previous:
        for key in topics_for(message.get("body")):
            prev_counts[key] = prev_counts.get(key, 0) + 1
    total, prev_total = len(current), len(previous)
    topics = []
    for key, label, _kw in TOPICS:
        count = counts.get(key, 0)
        share = _share(count, total)
        prev_share = _share(prev_counts.get(key, 0), prev_total)
        trend = "flat"
        if prev_total and total:
            if share >= prev_share + 0.05:
                trend = "up"
            elif share <= prev_share - 0.05:
                trend = "down"
        elif total and count and not prev_total:
            trend = "new"
        topics.append({"key": key, "label": label, "count": count,
                       "share": share, "prev_share": prev_share,
                       "trend": trend,
                       "conversations": len(conversations.get(key, ())),
                       "examples": examples.get(key, [])})
    topics.sort(key=lambda t: (-t["count"], t["key"]))
    busy = sorted(hours.items(), key=lambda item: (-item[1], item[0]))[:3]
    return {
        "messages": total,
        "previous_messages": prev_total,
        "conversations": len({m.get("conversation_id") for m in current}),
        "topics": topics,
        "busy_hours": [{"hour": hour, "messages": n} for hour, n in busy],
        "tz_offset_hours": offset,
    }


def _intelligence_mix(cur, client_id: int, days: int) -> Dict[str, Any]:
    import portal_intelligence

    cur.execute(
        "SELECT sentiment, purchase_intent, urgency, language, COUNT(*) AS n"
        " FROM " + portal_db._q(portal_intelligence.TABLE) +
        " WHERE client_id = %s AND updated_at > NOW() - make_interval(days => %s)"
        " GROUP BY sentiment, purchase_intent, urgency, language",
        (client_id, days),
    )
    out: Dict[str, Any] = {"conversations": 0, "sentiment": {},
                           "purchase_intent": {}, "urgency": {}, "language": {}}
    for row in portal_db.rows(cur):
        n = int(row.get("n") or 0)
        out["conversations"] += n
        for field in ("sentiment", "purchase_intent", "urgency", "language"):
            key = str(row.get(field) or "unknown")
            out[field][key] = out[field].get(key, 0) + n
    total = out["conversations"]
    out["negative_share"] = _share(out["sentiment"].get("negative", 0), total)
    out["high_purchase_share"] = _share(out["purchase_intent"].get("high", 0), total)
    out["urgent_share"] = _share(out["urgency"].get("high", 0), total)
    return out


def _gaps(cur, client_id: int, days: int) -> Dict[str, Any]:
    cur.execute(
        "SELECT question, intent, resolved, created_at FROM " +
        portal_db._q(portal_db.GAPS_TABLE) +
        " WHERE client_id = %s AND created_at > NOW() - make_interval(days => %s)"
        " ORDER BY id DESC LIMIT %s",
        (client_id, days, GAPS_MAX),
    )
    rows = portal_db.rows(cur)
    topic_counts: Dict[str, int] = {}
    examples: List[str] = []
    unresolved = 0
    for row in rows:
        if not int(row.get("resolved") or 0):
            unresolved += 1
        for key in topics_for(row.get("question")):
            topic_counts[key] = topic_counts.get(key, 0) + 1
        snippet = _snippet(row.get("question"), 100)
        if snippet and len(examples) < 5 and snippet not in examples:
            examples.append(snippet)
    top = sorted(topic_counts.items(), key=lambda i: (-i[1], i[0]))[:3]
    return {"count": len(rows), "unresolved": unresolved,
            "top_topics": [{"key": k, "label": TOPIC_LABELS.get(k, k), "count": n}
                           for k, n in top],
            "examples": examples}


def _commerce(cur, client_id: int, days: int) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    cur.execute(
        "SELECT action, COUNT(*) AS n FROM " + portal_db._q("portal_action_log") +
        " WHERE client_id = %s AND created_at > NOW() - make_interval(days => %s)"
        " AND action IN ('cod.confirmed', 'cod.declined', 'negotiation.round',"
        " 'checkout.created', 'ai.answer', 'kb.auto_reply')"
        " GROUP BY action",
        (client_id, days),
    )
    actions = {str(r.get("action")): int(r.get("n") or 0) for r in portal_db.rows(cur)}
    confirmed = actions.get("cod.confirmed", 0)
    declined = actions.get("cod.declined", 0)
    out["cod"] = {"confirmed": confirmed, "declined": declined,
                  "decline_share": _share(declined, confirmed + declined)}
    out["negotiation_rounds"] = actions.get("negotiation.round", 0)
    out["auto_answers"] = actions.get("ai.answer", 0) + actions.get("kb.auto_reply", 0)
    return out


def _checkout(cur, client_id: int, days: int) -> Dict[str, Any]:
    import portal_checkout

    cur.execute(
        "SELECT COUNT(*) AS created,"
        " COUNT(*) FILTER (WHERE status IN ('paid', 'shipped', 'delivered')) AS paid"
        " FROM " + portal_db._q(portal_checkout.LINKS_TABLE) +
        " WHERE client_id = %s AND created_at > NOW() - make_interval(days => %s)",
        (client_id, days),
    )
    rows = portal_db.rows(cur)
    created = int((rows[0] if rows else {}).get("created") or 0)
    paid = int((rows[0] if rows else {}).get("paid") or 0)
    return {"created": created, "paid": paid, "conversion": _share(paid, created)}


def _deliveries(cur, client_id: int, days: int) -> Dict[str, Any]:
    import portal_courier

    cur.execute(
        "SELECT status, COUNT(*) AS n FROM " + portal_db._q(portal_courier.BOOKINGS_TABLE) +
        " WHERE client_id = %s AND created_at > NOW() - make_interval(days => %s)"
        " GROUP BY status",
        (client_id, days),
    )
    by_status: Dict[str, int] = {}
    total = problems = 0
    for row in portal_db.rows(cur):
        status = str(row.get("status") or "unknown").lower()
        n = int(row.get("n") or 0)
        by_status[status] = n
        total += n
        if any(word in status for word in ("fail", "return", "cancel", "lost", "refus")):
            problems += n
    return {"bookings": total, "problem_bookings": problems,
            "problem_share": _share(problems, total), "by_status": by_status}


def _service(cur, client_id: int, days: int) -> Dict[str, Any]:
    try:
        import portal_conversations

        overdue_hours = int(getattr(portal_conversations, "OVERDUE_HOURS", 4))
    except Exception:
        overdue_hours = 4
    msgs = portal_db._q(portal_db.MSGS_TABLE)
    cur.execute(
        "SELECT COUNT(*) AS n FROM " + portal_db._q(portal_db.CONV_TABLE) + " c"
        " WHERE c.client_id = %s AND c.status = 'open'"
        " AND EXISTS (SELECT 1 FROM " + msgs + " nr"
        " WHERE nr.conversation_id = c.id GROUP BY nr.conversation_id"
        " HAVING COALESCE(MAX(CASE WHEN nr.direction = 'in' THEN nr.id END), 0)"
        " > COALESCE(MAX(CASE WHEN nr.direction = 'out' THEN nr.id END), 0)"
        " AND MAX(CASE WHEN nr.direction = 'in' THEN nr.created_at END)"
        " < NOW() - make_interval(hours => %s))",
        (client_id, overdue_hours),
    )
    rows = portal_db.rows(cur)
    overdue = int((rows[0] if rows else {}).get("n") or 0)
    cur.execute(
        "SELECT AVG(score) AS avg_score, COUNT(*) AS n FROM " +
        portal_db._q(portal_db.CSAT_TABLE) +
        " WHERE client_id = %s AND score IS NOT NULL"
        " AND answered_at > NOW() - make_interval(days => %s)",
        (client_id, days),
    )
    rows = portal_db.rows(cur)
    avg = (rows[0] if rows else {}).get("avg_score")
    return {"overdue_replies": overdue, "overdue_hours": overdue_hours,
            "csat_avg": round(float(avg), 2) if avg is not None else None,
            "csat_answers": int((rows[0] if rows else {}).get("n") or 0)}


def insights(cur, client_id: int, days: int) -> Dict[str, Any]:
    """Customer-side picture for the window (each block fail-soft)."""
    days = _days(days)
    tz_off = timezone_offset_hours(cur, client_id)
    topics = _guarded(cur, "topics", lambda: topic_insights(
        _sample_messages(cur, client_id, days), tz_off))
    return {
        "days": days,
        "timezone_offset_hours": tz_off,
        "topics": topics,
        "mix": _guarded(cur, "intelligence", lambda: _intelligence_mix(cur, client_id, days)),
        "gaps": _guarded(cur, "gaps", lambda: _gaps(cur, client_id, days)),
        "commerce": _guarded(cur, "commerce", lambda: _commerce(cur, client_id, days)),
        "checkout": _guarded(cur, "checkout", lambda: _checkout(cur, client_id, days)),
        "deliveries": _guarded(cur, "deliveries", lambda: _deliveries(cur, client_id, days)),
        "service": _guarded(cur, "service", lambda: _service(cur, client_id, days)),
    }


# ---------------------------------------------------------------------------
# AI quality
# ---------------------------------------------------------------------------

def _traces(cur, client_id: int, days: int) -> Dict[str, Any]:
    import portal_brain

    traces = portal_db._q(portal_brain.TRACES_TABLE)
    cur.execute(
        "SELECT kind, decision, COALESCE(grounding->>'reason', '') AS reason,"
        " COUNT(*) AS n,"
        " AVG(NULLIF(grounding->>'confidence', '')::numeric) AS avg_confidence,"
        " COUNT(*) FILTER (WHERE"
        " jsonb_array_length(COALESCE(grounding->'kb_ids', '[]'::jsonb)) > 0"
        " OR jsonb_array_length(COALESCE(grounding->'knowledge_ids', '[]'::jsonb)) > 0"
        " OR jsonb_array_length(COALESCE(grounding->'fact_ids', '[]'::jsonb)) > 0)"
        " AS grounded,"
        " COUNT(*) FILTER (WHERE"
        " jsonb_array_length(COALESCE(grounding->'citations', '[]'::jsonb)) > 0)"
        " AS cited"
        " FROM " + traces +
        " WHERE client_id = %s AND created_at > NOW() - make_interval(days => %s)"
        " GROUP BY kind, decision, reason",
        (client_id, days),
    )
    groups = portal_db.rows(cur)
    cur.execute(
        "SELECT DATE(created_at) AS day, decision, COUNT(*) AS n FROM " + traces +
        " WHERE client_id = %s AND created_at > NOW() - make_interval(days => %s)"
        " GROUP BY DATE(created_at), decision ORDER BY day",
        (client_id, days),
    )
    daily = portal_db.rows(cur)
    return summarize_traces(groups, daily)


def summarize_traces(groups: List[Dict[str, Any]], daily: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Pure: decisions / handoff share / reasons / confidence / grounding."""
    total = sends = handoffs = grounded = cited = 0
    answers = drafts = 0
    reasons: Dict[str, int] = {}
    conf_weight = 0.0
    conf_n = 0
    for row in groups:
        n = int(row.get("n") or 0)
        total += n
        if str(row.get("kind") or "") == "ingest_answer":
            answers += n
        else:
            drafts += n
        if str(row.get("decision") or "") == "send":
            sends += n
        else:
            handoffs += n
            reason = str(row.get("reason") or "unknown")
            if reason.startswith("policy:"):
                reason = "policy"
            reasons[reason] = reasons.get(reason, 0) + n
        grounded += int(row.get("grounded") or 0)
        cited += int(row.get("cited") or 0)
        avg = row.get("avg_confidence")
        if avg is not None:
            conf_weight += float(avg) * n
            conf_n += n
    by_day: Dict[str, Dict[str, int]] = {}
    for row in daily:
        day = row.get("day")
        key = day.isoformat() if hasattr(day, "isoformat") else str(day)
        entry = by_day.setdefault(key, {"send": 0, "handoff": 0})
        if str(row.get("decision") or "") == "send":
            entry["send"] += int(row.get("n") or 0)
        else:
            entry["handoff"] += int(row.get("n") or 0)
    return {
        "decisions": total,
        "auto_answers": answers,
        "drafts": drafts,
        "sends": sends,
        "handoffs": handoffs,
        "handoff_share": _share(handoffs, total),
        "reasons": reasons,
        "policy_blocks": reasons.get("policy", 0),
        "llm_unavailable": reasons.get("llm_unavailable", 0),
        "avg_confidence": round(conf_weight / conf_n, 3) if conf_n else None,
        "grounded_share": _share(grounded, total),
        "cited_share": _share(cited, total),
        "by_day": [{"day": day, **entry} for day, entry in sorted(by_day.items())],
    }


def _resolution(cur, client_id: int, days: int) -> Dict[str, Any]:
    import portal_escalation

    cur.execute(
        "SELECT COUNT(DISTINCT a.conversation_id) AS answered,"
        " COUNT(DISTINCT CASE WHEN e.id IS NOT NULL THEN a.conversation_id END)"
        " AS escalated"
        " FROM " + portal_db._q("portal_action_log") + " a"
        " LEFT JOIN " + portal_db._q(portal_escalation.TABLE) + " e"
        " ON e.client_id = a.client_id AND e.conversation_id = a.conversation_id"
        " AND e.created_at >= a.created_at"
        " WHERE a.client_id = %s AND a.action = 'ai.answer'"
        " AND a.created_at > NOW() - make_interval(days => %s)",
        (client_id, days),
    )
    rows = portal_db.rows(cur)
    answered = int((rows[0] if rows else {}).get("answered") or 0)
    escalated = int((rows[0] if rows else {}).get("escalated") or 0)
    cur.execute(
        "SELECT AVG(s.score) AS avg_score, COUNT(*) AS n FROM " +
        portal_db._q(portal_db.CSAT_TABLE) + " s"
        " WHERE s.client_id = %s AND s.score IS NOT NULL"
        " AND s.answered_at > NOW() - make_interval(days => %s)"
        " AND EXISTS (SELECT 1 FROM " + portal_db._q("portal_action_log") + " a"
        " WHERE a.client_id = s.client_id AND a.conversation_id = s.conversation_id"
        " AND a.action = 'ai.answer')",
        (client_id, days),
    )
    rows = portal_db.rows(cur)
    avg = (rows[0] if rows else {}).get("avg_score")
    return {"answered_conversations": answered, "escalated_after": escalated,
            "resolved_share": _share(answered - escalated, answered),
            "csat_after_ai": round(float(avg), 2) if avg is not None else None,
            "csat_after_ai_n": int((rows[0] if rows else {}).get("n") or 0)}


def _handoffs(cur, client_id: int, days: int) -> Dict[str, Any]:
    import portal_escalation

    table = portal_db._q(portal_escalation.TABLE)
    cur.execute(
        "SELECT COUNT(*) FILTER (WHERE created_at > NOW() - make_interval(days => %s))"
        " AS current,"
        " COUNT(*) FILTER (WHERE created_at <= NOW() - make_interval(days => %s)"
        " AND created_at > NOW() - make_interval(days => %s)) AS previous,"
        " COUNT(*) FILTER (WHERE status = 'open') AS open_now,"
        " COUNT(*) FILTER (WHERE status = 'open' AND target_user_id IS NULL)"
        " AS open_unassigned,"
        " AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)))"
        " FILTER (WHERE resolved_at > NOW() - make_interval(days => %s))"
        " AS avg_resolve_seconds"
        " FROM " + table + " WHERE client_id = %s",
        (days, days, days * 2, days, client_id),
    )
    rows = portal_db.rows(cur)
    totals = rows[0] if rows else {}
    cur.execute(
        "SELECT source, reason, COUNT(*) AS n FROM " + table +
        " WHERE client_id = %s AND created_at > NOW() - make_interval(days => %s)"
        " GROUP BY source, reason ORDER BY n DESC LIMIT 20",
        (client_id, days),
    )
    by_source: Dict[str, int] = {}
    reasons: List[Dict[str, Any]] = []
    for row in portal_db.rows(cur):
        n = int(row.get("n") or 0)
        source = str(row.get("source") or "system")
        by_source[source] = by_source.get(source, 0) + n
        reasons.append({"label": portal_escalation.reason_label(row.get("reason")),
                        "source": source, "count": n})
    current = int(totals.get("current") or 0)
    previous = int(totals.get("previous") or 0)
    avg = totals.get("avg_resolve_seconds")
    growth = None
    if previous:
        growth = round((current - previous) / previous, 2)
    return {"current": current, "previous": previous, "growth": growth,
            "open": int(totals.get("open_now") or 0),
            "open_unassigned": int(totals.get("open_unassigned") or 0),
            "avg_resolve_minutes": (round(float(avg) / 60.0, 1)
                                    if avg is not None else None),
            "by_source": by_source, "reasons": reasons[:5]}


def ai_quality(cur, client_id: int, days: int,
               gaps: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    days = _days(days)

    def _usage():
        import portal_ai_usage

        portal_ai_usage._ensure_ddl(cur)
        report = portal_ai_usage.usage_report(cur, client_id, days)
        totals = report["totals"]
        return {"calls": totals["calls"], "failed": totals["failed"],
                "failed_share": _share(totals["failed"], totals["calls"]),
                "avg_latency_ms": totals["avg_latency_ms"],
                "cost_usd": totals["cost_usd"], "priced": totals["priced"]}

    out = {
        "days": days,
        "traces": _guarded(cur, "traces", lambda: _traces(cur, client_id, days)),
        "resolution": _guarded(cur, "resolution", lambda: _resolution(cur, client_id, days)),
        "handoffs": _guarded(cur, "handoffs", lambda: _handoffs(cur, client_id, days)),
        "usage": _guarded(cur, "usage", _usage),
    }
    if gaps is None:
        gaps = _guarded(cur, "gaps", lambda: _gaps(cur, client_id, days))
    out["unanswered"] = {"count": (gaps or {}).get("count", 0),
                         "examples": (gaps or {}).get("examples", [])}
    return out


# ---------------------------------------------------------------------------
# journey funnel
# ---------------------------------------------------------------------------

def _funnel_rows(cur, client_id: int, days: int) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]]]:
    import portal_memory

    cur.execute(
        "SELECT id, name, position FROM " + portal_db._q(portal_memory.STAGES_TABLE) +
        " WHERE client_id = %s AND is_active = TRUE ORDER BY position, id",
        (client_id,),
    )
    stages = portal_db.rows(cur)
    if not stages:
        return [], [], []
    cur.execute(
        "SELECT stage_id, COUNT(*) AS n FROM " + portal_db._q(portal_memory.STATE_TABLE) +
        " WHERE client_id = %s GROUP BY stage_id",
        (client_id,),
    )
    state = portal_db.rows(cur)
    cur.execute(
        "SELECT contact_id, stage_name, created_at FROM " +
        portal_db._q(portal_memory.EVENTS_TABLE) +
        " WHERE client_id = %s AND created_at > NOW() - make_interval(days => %s)"
        " ORDER BY contact_id, id LIMIT %s",
        (client_id, days * 2, EVENTS_MAX),
    )
    events = portal_db.rows(cur)
    return stages, state, events


def build_funnel(stages: List[Dict[str, Any]], state: List[Dict[str, Any]],
                 events: List[Dict[str, Any]], days: int,
                 now: Optional[datetime] = None) -> Dict[str, Any]:
    """Pure: current distribution, reached-in-window, conversion between
    consecutive stages, median hours to move on, stalled contacts."""
    now = now or datetime.now(timezone.utc)
    order = [str(s.get("name")) for s in stages]
    position = {name: index for index, name in enumerate(order)}
    by_id = {int(s.get("id") or 0): str(s.get("name")) for s in stages}
    current: Dict[str, int] = {name: 0 for name in order}
    for row in state:
        name = by_id.get(int(row.get("stage_id") or 0))
        if name is not None:
            current[name] += int(row.get("n") or 0)
    window_start = now.timestamp() - days * 86400
    reached: Dict[str, set] = {name: set() for name in order}
    durations: Dict[str, List[float]] = {name: [] for name in order}
    last_event: Dict[str, Tuple[str, float]] = {}
    per_contact: Dict[str, List[Tuple[str, float]]] = {}
    for row in events:
        name = str(row.get("stage_name") or "")
        if name not in position:
            continue
        when = row.get("created_at")
        stamp = when.timestamp() if hasattr(when, "timestamp") else 0.0
        contact = str(row.get("contact_id") or "")
        per_contact.setdefault(contact, []).append((name, stamp))
    for contact, moves in per_contact.items():
        for index, (name, stamp) in enumerate(moves):
            if stamp >= window_start:
                reached[name].add(contact)
            if index + 1 < len(moves):
                next_name, next_stamp = moves[index + 1]
                if position[next_name] > position[name] and next_stamp >= stamp:
                    durations[name].append((next_stamp - stamp) / 3600.0)
        last_event[contact] = moves[-1]
    stalled: Dict[str, int] = {name: 0 for name in order}
    stall_seconds = STALL_DAYS * 86400
    for contact, (name, stamp) in last_event.items():
        if position[name] < len(order) - 1 and now.timestamp() - stamp > stall_seconds:
            stalled[name] += 1
    out_stages = []
    for index, name in enumerate(order):
        reached_n = len(reached[name])
        prev_reached = len(reached[order[index - 1]]) if index else None
        conversion = (_share(reached_n, prev_reached) if prev_reached else None)
        median = (round(statistics.median(durations[name]), 1)
                  if durations[name] else None)
        out_stages.append({
            "name": name, "position": index, "current": current[name],
            "reached": reached_n, "conversion_from_previous": conversion,
            "median_hours_to_next": median, "stalled": stalled[name],
        })
    first = len(reached[order[0]]) if order else 0
    last = len(reached[order[-1]]) if order else 0
    total_contacts = sum(current.values())
    total_stalled = sum(stalled.values())
    return {
        "configured": bool(order),
        "days": days,
        "stages": out_stages,
        "contacts": total_contacts,
        "reached_first": first,
        "reached_last": last,
        "overall_conversion": _share(last, first) if first else None,
        "stalled": total_stalled,
        "stalled_share": _share(total_stalled, len(last_event)) if last_event else 0.0,
        "stall_days": STALL_DAYS,
        "events": len(events),
    }


def funnel(cur, client_id: int, days: int) -> Dict[str, Any]:
    days = _days(days)
    stages, state, events = _funnel_rows(cur, client_id, days)
    return build_funnel(stages, state, events, days)


# ---------------------------------------------------------------------------
# problem detector
# ---------------------------------------------------------------------------

def _confidence(n: float, minimum: float) -> float:
    """Grows with the sample: minimum -> 0.55, 4x minimum -> 0.95."""
    if minimum <= 0:
        return 0.95
    return round(min(0.95, 0.4 + 0.6 * min(1.0, n / (4.0 * minimum))), 2)


def _severity(value: float, threshold: float, factor: float = 2.0) -> str:
    return "critical" if threshold and value >= threshold * factor else "warn"


def _pct(share: Any) -> str:
    try:
        return str(int(round(float(share or 0) * 100))) + "%"
    except Exception:
        return "0%"


def detect_problems(ins: Optional[Dict[str, Any]], quality: Optional[Dict[str, Any]],
                    fun: Optional[Dict[str, Any]], days: int,
                    thresholds: Optional[Dict[str, float]] = None) -> List[Dict[str, Any]]:
    """Pure rules -> Problem / Evidence / Impact / Confidence / Action."""
    T = thresholds if isinstance(thresholds, dict) and thresholds else THRESHOLDS
    ins = ins or {}
    quality = quality or {}
    fun = fun or {}
    problems: List[Dict[str, Any]] = []

    def add(key, title, severity, evidence, impact, confidence, action_label, href):
        problems.append({"key": key, "title": title, "severity": severity,
                         "evidence": evidence, "impact": impact,
                         "confidence": confidence,
                         "action": {"label": action_label, "href": href}})

    topics = ins.get("topics") or {}
    by_topic = {t["key"]: t for t in (topics.get("topics") or [])}
    sample = int(topics.get("messages") or 0)

    gaps = ins.get("gaps") or {}
    if gaps.get("count", 0) >= T["gaps_min"]:
        top = gaps.get("top_topics") or []
        add("knowledge_gaps",
            "Customers keep asking things the assistant cannot answer",
            _severity(gaps["count"], T["gaps_min"], 3),
            {"unanswered_questions": gaps["count"],
             "top_topic": top[0]["label"] if top else None,
             "examples": gaps.get("examples", [])[:EXAMPLES]},
            str(gaps["count"]) + " questions in " + str(days)
            + " days waited for a person (" + str(gaps.get("unresolved", 0))
            + " still unresolved).",
            _confidence(gaps["count"], T["gaps_min"]),
            "Add these answers to the Knowledge base", "/dashboard/knowledge-base")

    delivery = by_topic.get("delivery_time")
    if delivery and delivery["count"] >= T["topic_min"] \
            and delivery["share"] >= T["delivery_share"]:
        add("delivery_questions",
            _pct(delivery["share"]) + " of customer messages ask about delivery time",
            _severity(delivery["share"], T["delivery_share"]),
            {"messages": delivery["count"], "share": delivery["share"],
             "trend": delivery["trend"], "examples": delivery["examples"]},
            "Publishing your delivery policy lets the assistant answer these "
            "instantly instead of your team.",
            _confidence(sample, T["topic_min"]),
            "Publish a delivery policy source", "/dashboard/knowledge-base")

    price = by_topic.get("price")
    if price and price["count"] >= T["topic_min"] and price["share"] >= T["price_share"]:
        add("price_objections",
            _pct(price["share"]) + " of messages are about price or discounts",
            _severity(price["share"], T["price_share"]),
            {"messages": price["count"], "share": price["share"],
             "negotiation_rounds": (ins.get("commerce") or {}).get("negotiation_rounds", 0),
             "examples": price["examples"]},
            "Price questions that go unanswered turn into lost sales; a "
            "price list the assistant can quote and clear negotiation bounds "
            "close them.",
            _confidence(sample, T["topic_min"]),
            "Review prices and negotiation bounds", "/dashboard/settings")

    trouble_count = sum(by_topic.get(k, {}).get("count", 0) for k in ("returns", "complaint"))
    trouble_share = _share(trouble_count, sample)
    if trouble_count >= T["topic_min"] and trouble_share >= T["trouble_share"]:
        add("complaints_returns",
            _pct(trouble_share) + " of messages are complaints or return requests",
            _severity(trouble_share, T["trouble_share"]),
            {"messages": trouble_count, "share": trouble_share,
             "examples": (by_topic.get("complaint", {}).get("examples", [])
                          + by_topic.get("returns", {}).get("examples", []))[:EXAMPLES]},
            "Unhappy customers rarely order twice; these chats need a human "
            "fast and a clear return policy the assistant can state.",
            _confidence(sample, T["topic_min"]),
            "Open the conversations", "/dashboard/conversations")

    mix = ins.get("mix") or {}
    if mix.get("conversations", 0) >= T["sentiment_min"] \
            and mix.get("negative_share", 0) >= T["negative_share"]:
        add("negative_sentiment",
            _pct(mix["negative_share"]) + " of recent conversations read negative",
            _severity(mix["negative_share"], T["negative_share"]),
            {"conversations": mix["conversations"],
             "negative": (mix.get("sentiment") or {}).get("negative", 0)},
            "Negative sentiment this high usually means a delivery or "
            "quality problem is repeating.",
            _confidence(mix["conversations"], T["sentiment_min"]),
            "Review negative conversations", "/dashboard/conversations")

    traces = quality.get("traces") or {}
    if traces.get("decisions", 0) >= T["decisions_min"] \
            and traces.get("handoff_share", 0) >= T["handoff_share"]:
        reasons = traces.get("reasons") or {}
        top_reason = max(reasons.items(), key=lambda i: i[1])[0] if reasons else None
        add("ai_low_confidence",
            "The assistant hands off " + _pct(traces["handoff_share"]) + " of the time",
            _severity(traces["handoff_share"], T["handoff_share"]),
            {"decisions": traces["decisions"], "handoffs": traces["handoffs"],
             "top_reason": top_reason, "avg_confidence": traces.get("avg_confidence"),
             "grounded_share": traces.get("grounded_share")},
            "Every handoff is a chat your team answers by hand. More business "
            "facts and published documents raise its confidence.",
            _confidence(traces["decisions"], T["decisions_min"]),
            "Add business facts and documents", "/dashboard/bot")

    if traces.get("policy_blocks", 0) >= T["policy_min"]:
        add("ai_policy_blocks",
            "Policy stopped " + str(traces["policy_blocks"]) + " AI replies",
            _severity(traces["policy_blocks"], T["policy_min"]),
            {"policy_blocks": traces["policy_blocks"], "decisions": traces.get("decisions", 0)},
            "The assistant keeps drafting promises it must not make (refunds, "
            "discounts, dates). Tighten its instructions and refund rules.",
            _confidence(traces["policy_blocks"], T["policy_min"]),
            "Review persona instructions and facts", "/dashboard/bot")

    handoffs = quality.get("handoffs") or {}
    if handoffs.get("current", 0) >= T["handoff_min"] and handoffs.get("growth") is not None \
            and handoffs["growth"] >= T["handoff_growth"]:
        add("handoffs_rising",
            "Handoffs to your team are up " + _pct(handoffs["growth"]) + " vs the previous "
            + str(days) + " days",
            _severity(handoffs["growth"], T["handoff_growth"]),
            {"current": handoffs["current"], "previous": handoffs["previous"],
             "by_source": handoffs.get("by_source"), "reasons": handoffs.get("reasons")},
            "Something new is tripping the assistant or your workflows.",
            _confidence(handoffs["current"], T["handoff_min"]),
            "Open the handoff queue", "/dashboard/bot")

    if handoffs.get("open_unassigned", 0) >= 1:
        add("handoffs_unassigned",
            str(handoffs["open_unassigned"]) + " handoff"
            + ("s are" if handoffs["open_unassigned"] != 1 else " is")
            + " waiting with nobody assigned",
            "critical" if handoffs["open_unassigned"] >= 3 else "warn",
            {"open_unassigned": handoffs["open_unassigned"], "open": handoffs.get("open", 0)},
            "Customers in these chats are waiting for a person who has not "
            "been picked.",
            0.95,
            "Set an escalation contact on your AI personas", "/dashboard/bot")

    usage = quality.get("usage") or {}
    if usage.get("calls", 0) >= T["ai_calls_min"] and usage.get("failed_share", 0) >= T["ai_fail_share"]:
        add("ai_engine_failures",
            _pct(usage["failed_share"]) + " of AI calls failed",
            _severity(usage["failed_share"], T["ai_fail_share"]),
            {"calls": usage["calls"], "failed": usage["failed"],
             "avg_latency_ms": usage.get("avg_latency_ms")},
            "Failed calls mean silent handoffs and slower replies; the AI "
            "engine key, model or provider needs attention.",
            _confidence(usage["calls"], T["ai_calls_min"]),
            "Check the AI engine status", "/dashboard/bot")

    cod = (ins.get("commerce") or {}).get("cod") or {}
    cod_total = cod.get("confirmed", 0) + cod.get("declined", 0)
    if cod_total >= T["cod_min"] and cod.get("decline_share", 0) >= T["cod_decline_share"]:
        add("cod_declines",
            _pct(cod["decline_share"]) + " of COD confirmations are declined",
            _severity(cod["decline_share"], T["cod_decline_share"]),
            {"confirmed": cod["confirmed"], "declined": cod["declined"]},
            "Each declined COD is a parcel that would have come back; advance "
            "payment on risky orders protects the margin.",
            _confidence(cod_total, T["cod_min"]),
            "Review COD risk and advance settings", "/dashboard/cod")

    checkout = ins.get("checkout") or {}
    if checkout.get("created", 0) >= T["checkout_min"] \
            and checkout.get("conversion", 0) < T["checkout_conversion"]:
        add("checkout_unpaid",
            "Only " + _pct(checkout["conversion"]) + " of checkout links get paid",
            "critical" if checkout["conversion"] < T["checkout_conversion"] / 2 else "warn",
            {"created": checkout["created"], "paid": checkout["paid"]},
            str(checkout["created"] - checkout["paid"]) + " links were sent and never paid; "
            "a reminder workflow recovers a share of them.",
            _confidence(checkout["created"], T["checkout_min"]),
            "Start a payment-reminder workflow", "/dashboard/workflows")

    deliveries = ins.get("deliveries") or {}
    if deliveries.get("bookings", 0) >= T["bookings_min"] \
            and deliveries.get("problem_share", 0) >= T["delivery_fail_share"]:
        add("delivery_failures",
            _pct(deliveries["problem_share"]) + " of courier bookings failed or came back",
            _severity(deliveries["problem_share"], T["delivery_fail_share"]),
            {"bookings": deliveries["bookings"], "problems": deliveries["problem_bookings"],
             "by_status": deliveries.get("by_status")},
            "Returned parcels cost twice; check addresses, COD confirmation "
            "and the courier's performance.",
            _confidence(deliveries["bookings"], T["bookings_min"]),
            "Open courier bookings", "/dashboard/courier")

    service = ins.get("service") or {}
    if service.get("overdue_replies", 0) >= T["overdue_min"]:
        add("slow_replies",
            str(service["overdue_replies"]) + " open chats have waited over "
            + str(service.get("overdue_hours", 4)) + " hours for a reply",
            _severity(service["overdue_replies"], T["overdue_min"]),
            {"overdue_replies": service["overdue_replies"],
             "overdue_hours": service.get("overdue_hours")},
            "Slow first replies lose sales; routing rules or a higher AI "
            "autonomy level cover the gap.",
            0.95,
            "Open overdue conversations", "/dashboard/conversations?needs_reply=overdue")

    if service.get("csat_answers", 0) >= T["csat_min"] and service.get("csat_avg") is not None \
            and service["csat_avg"] < T["csat_low"]:
        add("csat_low",
            "Customer satisfaction is " + str(service["csat_avg"]) + " / 5",
            "critical" if service["csat_avg"] < T["csat_low"] - 1 else "warn",
            {"csat_avg": service["csat_avg"], "answers": service["csat_answers"]},
            "Low ratings track the complaints above; fix the cause, then ask "
            "again.",
            _confidence(service["csat_answers"], T["csat_min"]),
            "Review recent ratings", "/dashboard/analytics")

    if fun.get("configured") and fun.get("events", 0) >= T["stall_min"] \
            and fun.get("stalled_share", 0) >= T["stall_share"]:
        stuck = sorted((fun.get("stages") or []), key=lambda s: -s.get("stalled", 0))
        add("journey_stalled",
            _pct(fun["stalled_share"]) + " of customers have not moved in "
            + str(fun.get("stall_days", STALL_DAYS)) + " days",
            _severity(fun["stalled_share"], T["stall_share"]),
            {"stalled": fun.get("stalled"), "worst_stage": stuck[0]["name"] if stuck else None,
             "overall_conversion": fun.get("overall_conversion")},
            "Customers stuck at one stage need a nudge - a follow-up workflow "
            "on that stage moves them.",
            _confidence(fun.get("events", 0), T["stall_min"]),
            "Automate a follow-up for that stage", "/dashboard/workflows")

    rank = {"critical": 0, "warn": 1, "info": 2}
    problems.sort(key=lambda p: (rank.get(p["severity"], 3), -p["confidence"], p["key"]))
    return problems[:MAX_PROBLEMS]


# ---------------------------------------------------------------------------
# report
# ---------------------------------------------------------------------------



# ---------------------------------------------------------------------------
# Narrative summary (deterministic by default; optional one LLM polish)
# ---------------------------------------------------------------------------

NARRATIVE_LLM = os.environ.get(
    "OF_BI_NARRATIVE_LLM", "0").strip().lower() not in ("0", "false", "no", "off")


def _narrative_deterministic(ins: Dict[str, Any], quality: Dict[str, Any],
                             fun: Dict[str, Any], problems: List[Dict[str, Any]],
                             days: int) -> Dict[str, Any]:
    """English owner brief from numbers already computed. Zero LLM."""
    paragraphs: List[str] = []
    bullets: List[str] = []
    topics = (ins or {}).get("topics") or {}
    topic_list = topics.get("topics") or []
    messages = int(topics.get("messages") or 0)
    top = topic_list[0] if topic_list else None
    if messages:
        line = (
            "In the last " + str(days) + " days customers sent about "
            + str(messages) + " inbound messages"
        )
        if top and top.get("label"):
            line += ", led by " + str(top.get("label"))
            if top.get("count"):
                line += " (" + str(top.get("count")) + ")"
        line += "."
        paragraphs.append(line)
    else:
        paragraphs.append(
            "Not enough inbound chat volume in the last " + str(days)
            + " days to describe customer topics yet."
        )

    q = quality or {}
    decisions = int(
        q.get("decisions")
        or q.get("total_decisions")
        or (q.get("decisions_total") if isinstance(q.get("decisions_total"), int) else 0)
        or 0
    )
    if not decisions and isinstance(q.get("send"), dict):
        decisions = int(q.get("send", {}).get("count") or 0) + int(
            (q.get("handoff") or {}).get("count") or 0
        )
    handoff_share = q.get("handoff_share")
    if handoff_share is None and isinstance(q.get("handoff"), dict):
        handoff_share = q["handoff"].get("share")
    if handoff_share is None and isinstance(q.get("handoffs"), dict):
        handoff_share = q["handoffs"].get("share")
    conf = q.get("avg_confidence")
    if conf is None and isinstance(q.get("confidence"), dict):
        conf = q["confidence"].get("avg")
    if decisions:
        blurb = "The assistant made " + str(decisions) + " decisions"
        if handoff_share is not None:
            try:
                blurb += (
                    " with a "
                    + str(int(round(float(handoff_share) * 100)))
                    + "% handoff rate"
                )
            except Exception:
                pass
        if conf is not None:
            try:
                blurb += (
                    " and average confidence "
                    + str(int(round(float(conf) * 100)))
                    + "%"
                )
            except Exception:
                pass
        blurb += "."
        paragraphs.append(blurb)

    fun = fun or {}
    contacts = fun.get("contacts") or fun.get("total_contacts")
    if contacts:
        paragraphs.append(
            "Journey tracking covers "
            + str(int(contacts))
            + " contacts in this window."
        )

    critical = [p for p in (problems or []) if p.get("severity") == "critical"]
    warn = [p for p in (problems or []) if p.get("severity") == "warn"]
    if critical or warn:
        paragraphs.append(
            "Problem detector flagged "
            + str(len(critical))
            + " to fix now and "
            + str(len(warn))
            + " worth a look."
        )
    else:
        paragraphs.append(
            "No problem-detector thresholds were crossed in this window."
        )

    for problem in (problems or [])[:5]:
        title = str(problem.get("title") or "").strip()
        if not title:
            continue
        sev = str(problem.get("severity") or "warn")
        action = (problem.get("action") or {}).get("label") or ""
        bullet = ("[" + ("FIX" if sev == "critical" else "LOOK") + "] " + title)
        if action:
            bullet += " — " + str(action)
        bullets.append(bullet)

    headline = "Business snapshot — last " + str(days) + " days"
    if critical:
        headline = (
            str(len(critical))
            + " critical issue"
            + ("s" if len(critical) != 1 else "")
            + " need attention"
        )
    elif warn:
        headline = "A few signals are worth a look"
    elif messages:
        headline = "Operations look steady this period"

    return {
        "mode": "deterministic",
        "llm_used": False,
        "headline": headline[:160],
        "paragraphs": paragraphs[:6],
        "bullets": bullets[:8],
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def _narrative_llm_polish(base: Dict[str, Any], client_id: int,
                          cur=None) -> Dict[str, Any]:
    """Optional one-shot polish. Fail-soft → return base unchanged."""
    if not NARRATIVE_LLM:
        return base
    try:
        import portal_llm
        system = (
            "You write a short owner briefing for a WhatsApp commerce workspace. "
            "Return JSON {\"headline\": string, \"paragraphs\": string[1..4], "
            "\"bullets\": string[0..6]}. Professional English. No hype, no "
            "invented numbers — only rephrase the facts provided."
        )
        user = json.dumps({
            "headline": base.get("headline"),
            "paragraphs": base.get("paragraphs"),
            "bullets": base.get("bullets"),
        }, ensure_ascii=False)[:2500]
        scope = portal_llm.usage_scope("bi_narrative", client_id, cur)
        scope.__enter__()
        try:
            payload = portal_llm.chat_json(system, user, max_tokens=220)
        finally:
            try:
                scope.__exit__(None, None, None)
            except Exception:
                pass
        if not isinstance(payload, dict):
            return base
        out = dict(base)
        if isinstance(payload.get("headline"), str) and payload["headline"].strip():
            out["headline"] = payload["headline"].strip()[:160]
        paras = payload.get("paragraphs")
        if isinstance(paras, list):
            cleaned = [str(p).strip() for p in paras if str(p).strip()][:6]
            if cleaned:
                out["paragraphs"] = cleaned
        bullets = payload.get("bullets")
        if isinstance(bullets, list):
            cleaned_b = [str(b).strip() for b in bullets if str(b).strip()][:8]
            if cleaned_b:
                out["bullets"] = cleaned_b
        out["mode"] = "llm_polish"
        out["llm_used"] = True
        return out
    except Exception as error:
        logger.warning("bi narrative llm polish failed: %s", error)
        return base


def build_narrative(ins, quality, fun, problems, days: int,
                    client_id: int = 0, cur=None,
                    use_llm=None) -> Dict[str, Any]:
    base = _narrative_deterministic(ins or {}, quality or {}, fun or {},
                                    problems or [], days)
    want = NARRATIVE_LLM if use_llm is None else bool(use_llm)
    if want:
        return _narrative_llm_polish(base, client_id, cur=cur)
    return base


def report(cur, client_id: int, days: int,
           narrative_llm: bool = None) -> Dict[str, Any]:
    days = _days(days)
    T = thresholds_for(cur, client_id)
    ins = insights(cur, client_id, days)
    quality = ai_quality(cur, client_id, days, gaps=ins.get("gaps"))
    fun = _guarded(cur, "funnel", lambda: funnel(cur, client_id, days))
    problems = detect_problems(ins, quality, fun, days, thresholds=T)
    narrative = build_narrative(
        ins, quality, fun, problems, days,
        client_id=client_id, cur=cur, use_llm=narrative_llm,
    )
    return {
        "days": days,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "insights": ins,
        "ai_quality": quality,
        "funnel": fun,
        "problems": problems,
        "problem_counts": {
            "critical": sum(1 for p in problems if p["severity"] == "critical"),
            "warn": sum(1 for p in problems if p["severity"] == "warn"),
        },
        "topics": [{"key": k, "label": l} for k, l, _kw in TOPICS],
        "thresholds": T,
        "timezone_offset_hours": ins.get("timezone_offset_hours", TZ_OFFSET_HOURS),
        "narrative": narrative,
    }


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": str(error)}}), 503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}),
                      401)
    return principal, None


@bp.get("/bi/report")
def get_report():
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    days = _days(request.args.get("days"))
    raw_llm = str(request.args.get("narrative_llm") or "").strip().lower()
    narrative_llm = None
    if raw_llm in ("1", "true", "yes", "on"):
        narrative_llm = True
    elif raw_llm in ("0", "false", "no", "off"):
        narrative_llm = False
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            data = report(cur, client_id, days, narrative_llm=narrative_llm)
        conn.commit()
    finally:
        conn.close()
    return jsonify(data), 200


@bp.get("/bi/thresholds")
def get_thresholds():
    """Owner-readable problem-detector thresholds (env defaults + overrides)."""
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            data = thresholds_for(cur, client_id)
            tz = timezone_offset_hours(cur, client_id)
        conn.commit()
    finally:
        conn.close()
    return jsonify({
        "thresholds": data,
        "defaults": default_thresholds(),
        "timezone_offset_hours": tz,
        "keys": list(OWNER_THRESHOLD_KEYS),
    }), 200


@bp.put("/bi/thresholds")
def update_thresholds():
    """Owner saves problem-detector thresholds into client_settings."""
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        from portal_auth import ensure_human_principal
        forbidden = ensure_human_principal(principal)
        if forbidden is not None:
            return forbidden
    except Exception:
        pass
    payload = request.get_json(silent=True) or {}
    raw = payload.get("thresholds", payload.get("bi_thresholds", payload))
    clean, problem = _validate_thresholds(raw)
    if problem:
        return jsonify({"error": {"code": "bad_request", "message": problem}}), 400
    client_id = int(principal.get("client_id") or 0)
    import json as _json
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "CREATE TABLE IF NOT EXISTS " + portal_db._q("client_settings") +
                " (client_id BIGINT PRIMARY KEY,"
                " settings JSONB NOT NULL DEFAULT '{}'::jsonb,"
                " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
            )
            # Merge with existing so partial updates keep other keys.
            cur.execute(
                "SELECT settings -> 'bi_thresholds' AS bi_thresholds FROM "
                + portal_db._q("client_settings") +
                " WHERE client_id = %s",
                (client_id,),
            )
            rows = portal_db.rows(cur)
            existing = {}
            if rows and isinstance(rows[0].get("bi_thresholds"), dict):
                existing = dict(rows[0]["bi_thresholds"])
            existing.update(clean)
            # Re-clamp whole map.
            final = {}
            for key in OWNER_THRESHOLD_KEYS:
                if key in existing:
                    try:
                        final[key] = _clamp_threshold(key, float(existing[key]))
                    except Exception:
                        continue
            cur.execute(
                "INSERT INTO " + portal_db._q("client_settings") +
                " (client_id, settings) VALUES (%s, %s::jsonb)"
                " ON CONFLICT (client_id) DO UPDATE SET"
                " settings = client_settings.settings || EXCLUDED.settings,"
                " updated_at = NOW()",
                (client_id, _json.dumps({"bi_thresholds": final})),
            )
            portal_db.log_action(
                cur, client_id, "bi.thresholds_update", "customer_user",
                principal.get("user_id"), None,
                ("BI thresholds updated (" + str(len(final)) + " keys).")[:200],
            )
            data = thresholds_for(cur, client_id)
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "thresholds": data}), 200


# ---------------------------------------------------------------------------
# Weekly problems email (ops polish): rides the connector poll like the
# owner daily digest. Defaults OFF. Uses portal_bi.report + portal_notify.
# ---------------------------------------------------------------------------

WEEKLY_DEFAULT_HOUR = int(os.environ.get("OF_BI_WEEKLY_HOUR", "9") or 9)
WEEKLY_DEFAULT_WEEKDAY = int(os.environ.get("OF_BI_WEEKLY_WEEKDAY", "1") or 1)  # Mon=1..Sun=7 ISO


def default_weekly_settings() -> Dict[str, Any]:
    return {
        "enabled": False,
        "hour": max(6, min(21, WEEKLY_DEFAULT_HOUR)),
        "weekday": max(1, min(7, WEEKLY_DEFAULT_WEEKDAY)),
        "last_sent_date": None,
    }


def _load_weekly_settings(cur, client_id: int) -> Dict[str, Any]:
    out = default_weekly_settings()
    try:
        cur.execute(
            "SELECT settings -> 'weekly_problems' AS weekly_problems FROM "
            + portal_db._q("client_settings") +
            " WHERE client_id = %s",
            (client_id,),
        )
        rows = portal_db.rows(cur)
        stored = rows[0].get("weekly_problems") if rows and rows[0] else None
        if isinstance(stored, str):
            try:
                stored = json.loads(stored)
            except Exception:
                stored = None
        if isinstance(stored, dict):
            if isinstance(stored.get("enabled"), bool):
                out["enabled"] = stored["enabled"]
            try:
                hour = int(stored.get("hour"))
                if 6 <= hour <= 21:
                    out["hour"] = hour
            except Exception:
                pass
            try:
                wd = int(stored.get("weekday"))
                if 1 <= wd <= 7:
                    out["weekday"] = wd
            except Exception:
                pass
            ls = stored.get("last_sent_date")
            if isinstance(ls, str) and ls:
                out["last_sent_date"] = ls[:10]
    except Exception as error:
        logger.warning("weekly problems settings load failed: %s", error)
    return out


def _save_weekly_settings(cur, client_id: int, settings: Dict[str, Any],
                          actor_user_id=None, note: str = "") -> Dict[str, Any]:
    cur.execute(
        "CREATE TABLE IF NOT EXISTS " + portal_db._q("client_settings") +
        " (client_id BIGINT PRIMARY KEY,"
        " settings JSONB NOT NULL DEFAULT '{}'::jsonb,"
        " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    )
    clean = {
        "enabled": bool(settings.get("enabled")),
        "hour": max(6, min(21, int(settings.get("hour") or WEEKLY_DEFAULT_HOUR))),
        "weekday": max(1, min(7, int(settings.get("weekday") or WEEKLY_DEFAULT_WEEKDAY))),
        "last_sent_date": settings.get("last_sent_date"),
    }
    cur.execute(
        "INSERT INTO " + portal_db._q("client_settings") +
        " (client_id, settings) VALUES (%s, %s::jsonb)"
        " ON CONFLICT (client_id) DO UPDATE SET"
        " settings = client_settings.settings || EXCLUDED.settings,"
        " updated_at = NOW()",
        (client_id, json.dumps({"weekly_problems": clean})),
    )
    if note:
        portal_db.log_action(
            cur, client_id, "bi.weekly_problems_settings", "customer_user",
            actor_user_id, None, note[:200],
        )
    return clean


def _format_weekly_body(data: Dict[str, Any]) -> Tuple[str, str, str]:
    """Return (title, detail, severity) for portal_notify."""
    problems = data.get("problems") or []
    counts = data.get("problem_counts") or {}
    critical = int(counts.get("critical") or 0)
    warn = int(counts.get("warn") or 0)
    days = int(data.get("days") or 7)
    if not problems:
        title = "Business insights: quiet week"
        detail = (
            "No problems crossed the detector thresholds in the last "
            + str(days) + " days. Open Insights anytime to review topics "
            "and AI quality."
        )
        return title, detail[:500], "normal"

    title = (
        "Business insights: "
        + str(critical) + " to fix now, "
        + str(warn) + " worth a look"
    )
    lines = []
    for problem in problems[:6]:
        sev = str(problem.get("severity") or "warn")
        label = "FIX" if sev == "critical" else "LOOK"
        action = (problem.get("action") or {}).get("label") or ""
        line = "[" + label + "] " + str(problem.get("title") or "")
        if action:
            line += " — " + action
        lines.append(line)
    detail = (
        "Last " + str(days) + " days. Top signals:\n"
        + "\n".join(lines)
        + "\nOpen /dashboard/insights to review evidence and act."
    )
    severity = "high" if critical else "normal"
    return title[:200], detail[:500], severity


def materialize_weekly_problems(cur, client_id: int, conn=None) -> int:
    """Once a week (owner-chosen weekday + hour), email/bell the BI problems.
    Defaults OFF. Never raises. Returns 1 when a notification was sent."""
    try:
        settings = _load_weekly_settings(cur, client_id)
        if not settings.get("enabled"):
            return 0
        # ISO weekday 1=Mon .. 7=Sun via PostgreSQL
        cur.execute(
            "SELECT EXTRACT(ISODOW FROM NOW())::int AS wd,"
            " EXTRACT(HOUR FROM NOW())::int AS h,"
            " TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS d"
        )
        rows = portal_db.rows(cur)
        row = rows[0] if rows else {}
        wd = int(row.get("wd") or 0)
        hour = int(row.get("h") or 0)
        today = str(row.get("d") or "")
        if wd != int(settings.get("weekday") or 0):
            return 0
        if hour < int(settings.get("hour") or 9):
            return 0
        if settings.get("last_sent_date") == today:
            return 0

        data = report(cur, client_id, 7)
        title, detail, severity = _format_weekly_body(data)
        import portal_notify

        portal_notify.notify(
            client_id,
            "insights",
            title,
            detail,
            severity=severity,
            dedupe_key="weekly_problems:" + today,
            in_app=True,
        )
        settings["last_sent_date"] = today
        _save_weekly_settings(cur, client_id, settings, note="")
        if conn is not None:
            try:
                conn.commit()
            except Exception:
                pass
        portal_db.log_action(
            cur, client_id, "bi.weekly_problems_sent", "system", None, None,
            (title)[:200],
        )
        if conn is not None:
            try:
                conn.commit()
            except Exception:
                pass
        return 1
    except Exception as error:
        logger.warning("weekly problems materialize failed: %s", error)
        return 0


@bp.get("/bi/weekly-problems")
def get_weekly_problems_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            data = _load_weekly_settings(cur, client_id)
        conn.commit()
    finally:
        conn.close()
    return jsonify({
        "settings": data,
        "weekdays": [
            {"value": 1, "label": "Monday"},
            {"value": 2, "label": "Tuesday"},
            {"value": 3, "label": "Wednesday"},
            {"value": 4, "label": "Thursday"},
            {"value": 5, "label": "Friday"},
            {"value": 6, "label": "Saturday"},
            {"value": 7, "label": "Sunday"},
        ],
    }), 200


@bp.put("/bi/weekly-problems")
def update_weekly_problems_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        from portal_auth import ensure_human_principal
        forbidden = ensure_human_principal(principal)
        if forbidden is not None:
            return forbidden
    except Exception:
        pass
    payload = request.get_json(silent=True) or {}
    raw = payload.get("settings", payload)
    if not isinstance(raw, dict):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "settings must be an object."}}), 400
    client_id = int(principal.get("client_id") or 0)
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            current = _load_weekly_settings(cur, client_id)
            if "enabled" in raw and isinstance(raw.get("enabled"), bool):
                current["enabled"] = raw["enabled"]
            if "hour" in raw:
                try:
                    hour = int(raw.get("hour"))
                    if not (6 <= hour <= 21):
                        raise ValueError("hour")
                    current["hour"] = hour
                except Exception:
                    return jsonify({"error": {
                        "code": "bad_request",
                        "message": "hour must be between 6 and 21."}}), 400
            if "weekday" in raw:
                try:
                    wd = int(raw.get("weekday"))
                    if not (1 <= wd <= 7):
                        raise ValueError("weekday")
                    current["weekday"] = wd
                except Exception:
                    return jsonify({"error": {
                        "code": "bad_request",
                        "message": "weekday must be 1 (Mon) to 7 (Sun)."}}), 400
            saved = _save_weekly_settings(
                cur, client_id, current,
                actor_user_id=principal.get("user_id"),
                note=("Weekly problems email "
                      + ("on" if current["enabled"] else "off") + "."),
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "settings": saved}), 200


@bp.post("/bi/weekly-problems/send")
def send_weekly_problems_now():
    """Owner test: build this week's report and notify immediately (no schedule gate)."""
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        from portal_auth import ensure_human_principal
        forbidden = ensure_human_principal(principal)
        if forbidden is not None:
            return forbidden
    except Exception:
        pass
    client_id = int(principal.get("client_id") or 0)
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            data = report(cur, client_id, 7)
            title, detail, severity = _format_weekly_body(data)
            import portal_notify
            result = portal_notify.notify(
                client_id, "insights", title, detail,
                severity=severity,
                dedupe_key="weekly_problems:manual:"
                + str(int(__import__("time").time())),
                in_app=True,
                email_sync=True,
            )
            portal_db.log_action(
                cur, client_id, "bi.weekly_problems_sent", "customer_user",
                principal.get("user_id"), None, (title + " (manual)")[:200],
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "title": title, "result": result,
                    "problem_counts": data.get("problem_counts")}), 200

