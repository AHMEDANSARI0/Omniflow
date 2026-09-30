"""BI layer (build-order 12): topic lexicon, topic insights + trend +
busy hours, trace summary maths, funnel maths (conversion / median time /
stalled), the Problem Detector rule matrix (fires, stays quiet on thin
data, severity, confidence, ordering, cap), SQL pins for every block
(tenant + window params, sampling caps), savepoint isolation in the
report, API auth + day clamp, and the wiring pins (blueprint, sidebar,
palette, page, BFF, client, English copy / text glyphs)."""
import os
from datetime import datetime, timedelta, timezone

from flask import Flask

import portal_bi as bi
from test_lib import check, install_db_stub, summary

PRINCIPAL = {
    "session_id": "s", "user_id": 11, "client_id": 1, "role": "owner",
    "email": "ahmed@example.com", "display_name": "Ahmed",
    "via_api_key": False,
}
API_KEY_PRINCIPAL = dict(PRINCIPAL, via_api_key=True)
NOW = datetime(2026, 9, 28, 12, 0, tzinfo=timezone.utc)


class PrincipalStub:
    def __init__(self, module, principal):
        self.module = module
        self.principal = principal

    def __enter__(self):
        self.orig = self.module.authenticate_portal_request
        self.module.authenticate_portal_request = lambda: self.principal
        self.module.PortalAuthUnavailable = Exception
        return self

    def __exit__(self, *a):
        self.module.authenticate_portal_request = self.orig


def run_api(script, path, principal=PRINCIPAL):
    install_db_stub(bi, script)
    app = Flask("bi-test")
    app.register_blueprint(bi.bp)
    with PrincipalStub(bi, principal):
        return app.test_client().get(path)


# ---------- lexicon ----------

print("== topics ==")
for text, expected in (
        ("delivery kab tak hogi?", ["delivery_time"]),
        ("yeh kitne ka hai bhai", ["price"]),
        ("size L available hai kya", ["availability"]),
        ("order confirm kar do", ["order_status"]),
        ("jazzcash se payment kar sakta hun?", ["payment"]),
        ("item kharab aya wapas karna hai", ["returns"]),
        ("abhi tak nahi aya, bakwas service", ["complaint"]),
        ("shop kahan par hai", ["hours_location"]),
        ("tracking number bhejo", ["delivery_time"]),
        ("I want to pay by card", ["payment"]),
        ("price kam karo", ["price"]),
        ("salam", []),
        ("", [])):
    check("topics " + repr(text) + " -> " + str(expected), bi.topics_for(text) == expected,
          bi.topics_for(text))
check("a message may carry several topics",
      bi.topics_for("COD available?") == ["availability", "payment"], bi.topics_for("COD available?"))
check("short keywords match whole words only ('cod' not inside 'code')",
      "payment" not in bi.topics_for("promo code bhejo") and "payment" in bi.topics_for("cod hai?"), "-")
check("topic registry = 8 owner-facing topics with labels",
      len(bi.TOPICS) == 8 and bi.TOPIC_LABELS["delivery_time"] == "Delivery time", bi.TOPIC_LABELS)

# ---------- topic insights ----------

print("== insights maths ==")
def msg(conv, body, hours_ago, current=True):
    return {"conversation_id": conv, "body": body,
            "created_at": NOW - timedelta(hours=hours_ago), "current": current}


MESSAGES = [msg(1, "delivery kab tak", 1), msg(2, "price kya hai", 2),
            msg(2, "delivery kitne din", 3), msg(3, "salam", 30),
            msg(4, "kab milega", 9 * 24, current=False),
            msg(5, "price kam karo", 8 * 24, current=False)]
ti = bi.topic_insights(MESSAGES)
by = {t["key"]: t for t in ti["topics"]}
check("current vs previous windows split, conversations counted",
      ti["messages"] == 4 and ti["previous_messages"] == 2 and ti["conversations"] == 3, ti)
check("shares + counts + conversations per topic",
      by["delivery_time"]["count"] == 2 and by["delivery_time"]["share"] == 0.5
      and by["delivery_time"]["conversations"] == 2 and by["price"]["share"] == 0.25,
      by["delivery_time"])
check("trend vs previous window (share moved >= 5 points)",
      by["delivery_time"]["trend"] == "flat" and by["price"]["trend"] == "down"
      and by["availability"]["trend"] == "down", {k: v["trend"] for k, v in by.items()})
check("examples are real customer snippets (deduped, capped)",
      by["delivery_time"]["examples"] == ["delivery kab tak", "delivery kitne din"]
      and len(by["delivery_time"]["examples"]) <= bi.EXAMPLES, by["delivery_time"]["examples"])
check("topics sorted by count, busy hours in the workspace offset",
      [t["key"] for t in ti["topics"][:2]] == ["delivery_time", "price"]
      and [h["hour"] for h in ti["busy_hours"]]
      == sorted(((6 + bi.TZ_OFFSET_HOURS) % 24, (9 + bi.TZ_OFFSET_HOURS) % 24,
                 (10 + bi.TZ_OFFSET_HOURS) % 24))
      and ti["tz_offset_hours"] == bi.TZ_OFFSET_HOURS, ti["busy_hours"])
check("no previous window -> 'new' trend, empty input safe",
      bi.topic_insights([msg(1, "price?", 1)])["topics"][0]["trend"] == "new"
      and bi.topic_insights([])["messages"] == 0, "-")
check("snippet trims + ellipsis", bi._snippet(" a  b " * 40, 20).endswith("\u2026")
      and bi._snippet("  hi   there ") == "hi there", bi._snippet(" a  b " * 40, 20))

# ---------- trace summary ----------

GROUPS = [
    {"kind": "ingest_answer", "decision": "send", "reason": "", "n": 30,
     "avg_confidence": 0.9, "grounded": 24, "cited": 10},
    {"kind": "ingest_answer", "decision": "handoff", "reason": "low_confidence", "n": 8,
     "avg_confidence": 0.5, "grounded": 2, "cited": 0},
    {"kind": "ingest_answer", "decision": "handoff", "reason": "policy:refund", "n": 2,
     "avg_confidence": 0.9, "grounded": 1, "cited": 0},
    {"kind": "draft", "decision": "handoff", "reason": "llm_unavailable", "n": 10,
     "avg_confidence": None, "grounded": 0, "cited": 0},
]
DAILY = [{"day": "2026-09-27", "decision": "send", "n": 12},
         {"day": "2026-09-27", "decision": "handoff", "n": 3},
         {"day": "2026-09-28", "decision": "send", "n": 18}]
ts = bi.summarize_traces(GROUPS, DAILY)
check("trace summary: decisions / answers / drafts / handoff share",
      ts["decisions"] == 50 and ts["auto_answers"] == 40 and ts["drafts"] == 10
      and ts["sends"] == 30 and ts["handoffs"] == 20 and ts["handoff_share"] == 0.4, ts)
check("trace summary: reasons folded (policy:*), policy blocks, llm unavailable",
      ts["reasons"] == {"low_confidence": 8, "policy": 2, "llm_unavailable": 10}
      and ts["policy_blocks"] == 2 and ts["llm_unavailable"] == 10, ts["reasons"])
check("trace summary: weighted confidence + grounded / cited shares",
      ts["avg_confidence"] == round((0.9 * 30 + 0.5 * 8 + 0.9 * 2) / 40, 3)
      and ts["grounded_share"] == round(27 / 50, 3) and ts["cited_share"] == 0.2, ts)
check("trace summary: per-day send/handoff series",
      ts["by_day"] == [{"day": "2026-09-27", "send": 12, "handoff": 3},
                       {"day": "2026-09-28", "send": 18, "handoff": 0}], ts["by_day"])
check("empty traces are safe", bi.summarize_traces([], [])["avg_confidence"] is None
      and bi.summarize_traces([], [])["handoff_share"] == 0.0, "-")

# ---------- funnel ----------

print("== funnel ==")
STAGES = [{"id": 1, "name": "Lead", "position": 0}, {"id": 2, "name": "Quoted", "position": 1},
          {"id": 3, "name": "Paid", "position": 2}]
STATE = [{"stage_id": 1, "n": 5}, {"stage_id": 2, "n": 3}, {"stage_id": 3, "n": 2},
         {"stage_id": 99, "n": 4}]


def ev(contact, stage, days_ago):
    return {"contact_id": contact, "stage_name": stage, "created_at": NOW - timedelta(days=days_ago)}


EVENTS = [ev("a", "Lead", 3), ev("a", "Quoted", 2), ev("a", "Paid", 1),
          ev("b", "Lead", 10), ev("c", "Lead", 4), ev("c", "Quoted", 1.5),
          ev("d", "Gone", 1)]
f = bi.build_funnel(STAGES, STATE, EVENTS, 7, NOW)
stages = {s["name"]: s for s in f["stages"]}
check("current distribution ignores unknown stage ids",
      f["contacts"] == 10 and stages["Lead"]["current"] == 5 and stages["Paid"]["current"] == 2, f)
check("reached in window per stage (distinct contacts) + conversion between stages",
      stages["Lead"]["reached"] == 2 and stages["Quoted"]["reached"] == 2
      and stages["Paid"]["reached"] == 1 and stages["Quoted"]["conversion_from_previous"] == 1.0
      and stages["Paid"]["conversion_from_previous"] == 0.5
      and stages["Lead"]["conversion_from_previous"] is None, f["stages"])
check("median hours to move on (forward moves only)",
      stages["Lead"]["median_hours_to_next"] == 42.0 and stages["Quoted"]["median_hours_to_next"] == 24.0
      and stages["Paid"]["median_hours_to_next"] is None, f["stages"])
check("stalled = last move older than the stall window and not at the final stage",
      stages["Lead"]["stalled"] == 1 and f["stalled"] == 1 and f["stalled_share"] == round(1 / 3, 3)
      and f["stall_days"] == bi.STALL_DAYS, f)
check("overall conversion first -> last + event count", f["reached_first"] == 2
      and f["reached_last"] == 1 and f["overall_conversion"] == 0.5 and f["events"] == 7, f)
empty = bi.build_funnel([], [], [], 7, NOW)
check("no stages -> configured False, nothing else breaks",
      empty["configured"] is False and empty["stages"] == [] and empty["overall_conversion"] is None, empty)

# ---------- problem detector ----------

print("== problem detector ==")
T = bi.THRESHOLDS
QUIET = bi.detect_problems({"topics": {"messages": 3, "topics": [
    {"key": "delivery_time", "count": 3, "share": 1.0, "trend": "new", "examples": []}]},
    "gaps": {"count": 2}, "mix": {"conversations": 4, "negative_share": 0.5},
    "commerce": {"cod": {"confirmed": 1, "declined": 3, "decline_share": 0.75}},
    "checkout": {"created": 3, "paid": 0, "conversion": 0.0},
    "service": {"overdue_replies": 1, "csat_avg": 1.0, "csat_answers": 2}},
    {"traces": {"decisions": 4, "handoff_share": 1.0, "handoffs": 4, "policy_blocks": 1,
                "reasons": {"low_confidence": 4}},
     "usage": {"calls": 3, "failed": 3, "failed_share": 1.0},
     "handoffs": {"current": 2, "previous": 1, "growth": 1.0, "open_unassigned": 0}},
    {"configured": True, "events": 3, "stalled_share": 1.0, "stages": []}, 7)
check("thin data never fires (every rule has a minimum sample)", QUIET == [], QUIET)
check("empty / None inputs are safe", bi.detect_problems(None, None, None, 7) == [], "-")

LOUD_INS = {
    "topics": {"messages": 100, "topics": [
        {"key": "delivery_time", "count": 30, "share": 0.30, "trend": "up",
         "examples": ["delivery kab tak"]},
        {"key": "price", "count": 25, "share": 0.25, "trend": "flat", "examples": ["price?"]},
        {"key": "complaint", "count": 12, "share": 0.12, "trend": "up", "examples": ["bakwas"]},
        {"key": "returns", "count": 8, "share": 0.08, "trend": "flat", "examples": ["wapas"]}]},
    "gaps": {"count": 16, "unresolved": 9, "top_topics": [{"label": "Price & discounts"}],
             "examples": ["warranty kitni hai"]},
    "mix": {"conversations": 40, "negative_share": 0.5, "sentiment": {"negative": 20}},
    "commerce": {"cod": {"confirmed": 10, "declined": 10, "decline_share": 0.5},
                 "negotiation_rounds": 7},
    "checkout": {"created": 20, "paid": 2, "conversion": 0.1},
    "deliveries": {"bookings": 20, "problem_bookings": 8, "problem_share": 0.4,
                   "by_status": {"returned": 8, "delivered": 12}},
    "service": {"overdue_replies": 12, "overdue_hours": 4, "csat_avg": 2.4, "csat_answers": 8},
}
LOUD_Q = {
    "traces": {"decisions": 50, "handoffs": 30, "handoff_share": 0.6, "policy_blocks": 6,
               "reasons": {"low_confidence": 24, "policy": 6}, "avg_confidence": 0.55,
               "grounded_share": 0.3},
    "usage": {"calls": 40, "failed": 20, "failed_share": 0.5, "avg_latency_ms": 900},
    "handoffs": {"current": 12, "previous": 4, "growth": 2.0, "open": 5, "open_unassigned": 3,
                 "by_source": {"ai": 10}, "reasons": []},
}
LOUD_F = {"configured": True, "events": 40, "stalled": 18, "stalled_share": 0.6,
          "stall_days": 7, "overall_conversion": 0.2,
          "stages": [{"name": "Quoted", "stalled": 12}, {"name": "Lead", "stalled": 6}]}
problems = bi.detect_problems(LOUD_INS, LOUD_Q, LOUD_F, 7)
keys = [p["key"] for p in problems]
check("cap respected + critical first, then confidence",
      len(problems) == bi.MAX_PROBLEMS and all(p["severity"] == "critical" for p in problems)
      and problems == sorted(problems, key=lambda p: (-p["confidence"], p["key"])), keys)

bi.MAX_PROBLEMS, _cap = 50, bi.MAX_PROBLEMS
problems = bi.detect_problems(LOUD_INS, LOUD_Q, LOUD_F, 7)
bi.MAX_PROBLEMS = _cap
by_key = {p["key"]: p for p in problems}
EXPECTED = {"knowledge_gaps", "delivery_questions", "price_objections", "complaints_returns",
            "negative_sentiment", "ai_low_confidence", "ai_policy_blocks", "handoffs_rising",
            "handoffs_unassigned", "ai_engine_failures", "cod_declines", "checkout_unpaid",
            "delivery_failures", "slow_replies", "csat_low", "journey_stalled"}
check("all 16 rules fire on loud data", set(by_key) == EXPECTED, sorted(set(by_key) ^ EXPECTED))
check("every problem carries Problem / Evidence / Impact / Confidence / Action(+href)",
      all(p["title"] and isinstance(p["evidence"], dict) and p["impact"]
          and 0 < p["confidence"] <= 0.95 and p["action"]["label"]
          and p["action"]["href"].startswith("/dashboard") for p in problems), problems[:1])
check("delivery rule: title carries the share, evidence the examples + trend",
      by_key["delivery_questions"]["title"].startswith("30% of customer messages ask about delivery time")
      and by_key["delivery_questions"]["evidence"]["examples"] == ["delivery kab tak"]
      and by_key["delivery_questions"]["evidence"]["trend"] == "up"
      and by_key["delivery_questions"]["action"]["href"] == "/dashboard/knowledge-base",
      by_key["delivery_questions"])
check("complaints + returns are pooled", by_key["complaints_returns"]["evidence"]["messages"] == 20
      and by_key["complaints_returns"]["evidence"]["share"] == 0.2, by_key["complaints_returns"])
check("knowledge gaps: impact names the numbers, unresolved included",
      "16 questions in 7 days" in by_key["knowledge_gaps"]["impact"]
      and "9 still unresolved" in by_key["knowledge_gaps"]["impact"]
      and by_key["knowledge_gaps"]["evidence"]["top_topic"] == "Price & discounts", by_key["knowledge_gaps"])
check("AI handoff rule: top reason + confidence + grounding in evidence",
      by_key["ai_low_confidence"]["evidence"]["top_reason"] == "low_confidence"
      and by_key["ai_low_confidence"]["evidence"]["avg_confidence"] == 0.55
      and by_key["ai_low_confidence"]["action"]["href"] == "/dashboard/bot", by_key["ai_low_confidence"])
check("unassigned handoffs: certain (0.95) and critical at 3+",
      by_key["handoffs_unassigned"]["confidence"] == 0.95
      and by_key["handoffs_unassigned"]["severity"] == "critical"
      and "3 handoffs are waiting" in by_key["handoffs_unassigned"]["title"], by_key["handoffs_unassigned"])
check("checkout rule: impact counts unpaid links, critical below half the target",
      "18 links were sent and never paid" in by_key["checkout_unpaid"]["impact"]
      and by_key["checkout_unpaid"]["severity"] == "critical"
      and by_key["checkout_unpaid"]["action"]["href"] == "/dashboard/workflows", by_key["checkout_unpaid"])
check("slow replies deep-link to the overdue filter",
      by_key["slow_replies"]["action"]["href"] == "/dashboard/conversations?needs_reply=overdue"
      and "12 open chats have waited over 4 hours" in by_key["slow_replies"]["title"], by_key["slow_replies"])
check("journey stall names the worst stage",
      by_key["journey_stalled"]["evidence"]["worst_stage"] == "Quoted"
      and "60% of customers have not moved in 7 days" in by_key["journey_stalled"]["title"],
      by_key["journey_stalled"])
check("csat rule: critical when a full point under the bar",
      by_key["csat_low"]["severity"] == "critical" and by_key["csat_low"]["title"] == "Customer satisfaction is 2.4 / 5",
      by_key["csat_low"])

# severity + confidence helpers
check("severity: 2x threshold -> critical, else warn",
      bi._severity(0.5, 0.25) == "critical" and bi._severity(0.3, 0.25) == "warn"
      and bi._severity(15, 5, 3) == "critical", "-")
check("confidence grows with sample: min -> 0.55, 4x -> 0.95, capped",
      bi._confidence(10, 10) == 0.55 and bi._confidence(40, 10) == 0.95
      and bi._confidence(400, 10) == 0.95 and bi._confidence(5, 0) == 0.95, "-")
MILD = bi.detect_problems(
    {"topics": {"messages": 40, "topics": [
        {"key": "delivery_time", "count": 11, "share": 0.275, "trend": "flat", "examples": []}]}},
    {}, {}, 30)
check("warn severity + moderate confidence on a modest sample",
      MILD and MILD[0]["key"] == "delivery_questions" and MILD[0]["severity"] == "warn"
      and MILD[0]["confidence"] == bi._confidence(40, T["topic_min"]), MILD)
check("thresholds are env-tunable (OF_BI_*) - registry has every rule's knob",
      {"gaps_min", "delivery_share", "handoff_share", "cod_decline_share",
       "checkout_conversion", "stall_share", "csat_low"} <= set(T), sorted(T))

# ---------- SQL pins ----------

print("== sql pins ==")
conn = install_db_stub(bi, [[]])
bi._sample_messages(conn.cur, 1, 7)
sql, params = conn.cur.executed[0]
check("message sample: inbound only, 2x window flagged current, newest first, capped",
      "direction = 'in'" in sql and "AS current" in sql and "ORDER BY id DESC LIMIT %s" in sql
      and params == (7, 1, 14, bi.SAMPLE_MAX), (sql, params))
conn = install_db_stub(bi, [[{"sentiment": "negative", "purchase_intent": "high", "urgency": "low",
                              "language": "roman", "n": 3},
                             {"sentiment": "neutral", "purchase_intent": "low", "urgency": "high",
                              "language": "ur", "n": 1}]])
mix = bi._intelligence_mix(conn.cur, 1, 7)
check("intelligence mix: tenant + window, shares computed",
      "portal_intelligence" in conn.cur.executed[0][0] and conn.cur.executed[0][1] == (1, 7)
      and mix["conversations"] == 4 and mix["negative_share"] == 0.75
      and mix["high_purchase_share"] == 0.75 and mix["urgent_share"] == 0.25
      and mix["language"] == {"roman": 3, "ur": 1}, mix)
conn = install_db_stub(bi, [[{"question": "warranty kitni hai", "intent": "general", "resolved": 0,
                              "created_at": None},
                             {"question": "price kya hai", "intent": "general", "resolved": 1,
                              "created_at": None}]])
gaps = bi._gaps(conn.cur, 1, 7)
check("gaps: window + cap, unresolved count, topic tally, examples",
      conn.cur.executed[0][1] == (1, 7, bi.GAPS_MAX) and gaps["count"] == 2 and gaps["unresolved"] == 1
      and gaps["top_topics"][0]["key"] == "price" and gaps["examples"] == ["warranty kitni hai", "price kya hai"],
      gaps)
conn = install_db_stub(bi, [[{"action": "cod.confirmed", "n": 6}, {"action": "cod.declined", "n": 4},
                             {"action": "negotiation.round", "n": 2}, {"action": "ai.answer", "n": 9},
                             {"action": "kb.auto_reply", "n": 1}]])
com = bi._commerce(conn.cur, 1, 30)
check("commerce: one action-log query, COD decline share, auto answers pooled",
      "action IN (" in conn.cur.executed[0][0] and conn.cur.executed[0][1] == (1, 30)
      and com["cod"] == {"confirmed": 6, "declined": 4, "decline_share": 0.4}
      and com["negotiation_rounds"] == 2 and com["auto_answers"] == 10, com)
conn = install_db_stub(bi, [[{"created": 20, "paid": 8}]])
co = bi._checkout(conn.cur, 1, 7)
check("checkout: paid/shipped/delivered count as paid, conversion",
      "IN ('paid', 'shipped', 'delivered')" in conn.cur.executed[0][0]
      and co == {"created": 20, "paid": 8, "conversion": 0.4}, co)
conn = install_db_stub(bi, [[{"status": "booked", "n": 10}, {"status": "Returned", "n": 2},
                             {"status": "delivery_failed", "n": 1}]])
de = bi._deliveries(conn.cur, 1, 7)
check("deliveries: problem statuses by word (fail/return/cancel/lost)",
      de["bookings"] == 13 and de["problem_bookings"] == 3 and de["problem_share"] == round(3 / 13, 3)
      and de["by_status"]["returned"] == 2, de)
conn = install_db_stub(bi, [[{"n": 7}], [{"avg_score": 4.25, "n": 12}]])
se = bi._service(conn.cur, 1, 7)
check("service: overdue replies reuse the inbox needs-reply definition + SLA hours; CSAT window",
      "HAVING COALESCE(MAX(CASE WHEN nr.direction = 'in' THEN nr.id END), 0)" in conn.cur.executed[0][0]
      and "make_interval(hours => %s)" in conn.cur.executed[0][0]
      and conn.cur.executed[0][1][1] == se["overdue_hours"]
      and se["overdue_replies"] == 7 and se["csat_avg"] == 4.25 and se["csat_answers"] == 12, se)

conn = install_db_stub(bi, [GROUPS, DAILY])
tr = bi._traces(conn.cur, 1, 7)
sql = conn.cur.executed[0][0]
check("traces SQL: reason/confidence/grounding from the JSON grounding, tenant + window",
      "grounding->>'reason'" in sql and "grounding->>'confidence'" in sql
      and "grounding->'knowledge_ids'" in sql and "grounding->'citations'" in sql
      and conn.cur.executed[0][1] == (1, 7) and "GROUP BY DATE(created_at), decision" in conn.cur.executed[1][0]
      and tr["decisions"] == 50, sql)
conn = install_db_stub(bi, [[{"answered": 20, "escalated": 5}], [{"avg_score": 4.5, "n": 4}]])
res = bi._resolution(conn.cur, 1, 7)
check("resolution: answered chats vs later escalations + CSAT after AI",
      "a.action = 'ai.answer'" in conn.cur.executed[0][0] and "e.created_at >= a.created_at" in conn.cur.executed[0][0]
      and res == {"answered_conversations": 20, "escalated_after": 5, "resolved_share": 0.75,
                  "csat_after_ai": 4.5, "csat_after_ai_n": 4}, res)
conn = install_db_stub(bi, [[{"current": 9, "previous": 3, "open_now": 4, "open_unassigned": 1,
                              "avg_resolve_seconds": 900.0}],
                            [{"source": "ai", "reason": "needs_human", "n": 6},
                             {"source": "workflow", "reason": "workflow 2", "n": 3}]])
ho = bi._handoffs(conn.cur, 1, 7)
check("handoffs: current vs previous window growth, open/unassigned, reasons labelled",
      conn.cur.executed[0][1] == (7, 7, 14, 7, 1) and ho["growth"] == 2.0 and ho["open"] == 4
      and ho["open_unassigned"] == 1 and ho["avg_resolve_minutes"] == 15.0
      and ho["by_source"] == {"ai": 6, "workflow": 3}
      and ho["reasons"][0] == {"label": "AI asked for a human", "source": "ai", "count": 6}, ho)
conn = install_db_stub(bi, [STAGES, STATE, EVENTS])
fu = bi.funnel(conn.cur, 1, 7)
check("funnel SQL: active stages ordered, state grouped, events 2x window capped",
      "is_active = TRUE ORDER BY position, id" in conn.cur.executed[0][0]
      and "GROUP BY stage_id" in conn.cur.executed[1][0]
      and conn.cur.executed[2][1] == (1, 14, bi.EVENTS_MAX) and fu["configured"] is True
      and fu["contacts"] == 10, conn.cur.executed[2])

# ---------- report assembly ----------

print("== report ==")
import portal_ai_usage  # noqa: E402

portal_ai_usage._ensure_ddl = lambda cur: None
portal_ai_usage.prices = lambda: {}
SCRIPT = [
    [{"bi_thresholds": {}}],                            # thresholds_for
    [{"business_hours": {"timezone": "Asia/Karachi"}}], # timezone_offset_hours (insights)
    [], MESSAGES, [],                                   # topics
    [], [{"sentiment": "negative", "purchase_intent": "low", "urgency": "low",
          "language": "roman", "n": 12}], [],           # mix
    [], [], [],                                         # gaps (empty)
    [], Exception("no action log"), [],                 # commerce fails -> ROLLBACK TO
    [], [{"created": 20, "paid": 2}], [],               # checkout
    [], [], [],                                         # deliveries
    [], [{"n": 12}], [{"avg_score": None, "n": 0}], [], # service
    [], GROUPS, DAILY, [],                              # traces
    [], [{"answered": 20, "escalated": 5}], [{"avg_score": None, "n": 0}], [],  # resolution
    [], [{"current": 12, "previous": 4, "open_now": 5, "open_unassigned": 3,
          "avg_resolve_seconds": None}], [], [],        # handoffs
    [], [], [], [],                                     # usage (2 queries)
    [], STAGES, STATE, EVENTS, [],                      # funnel
]
conn = install_db_stub(bi, SCRIPT)
rep = bi.report(conn.cur, 1, 7)
ex = conn.cur.executed
sp = [e for e in ex if e[0].startswith("SAVEPOINT") or e[0].startswith("RELEASE") or e[0].startswith("ROLLBACK")]
check("report: every block behind SAVEPOINT / RELEASE, a failing block rolls back alone",
      sp and sp[0][0] == "SAVEPOINT of_bi" and any(e[0] == "RELEASE SAVEPOINT of_bi" for e in sp)
      and any(e[0] == "ROLLBACK TO SAVEPOINT of_bi" for e in ex)
      and rep["insights"]["commerce"] is None and rep["insights"]["checkout"]["created"] == 20
      and rep["insights"]["mix"]["conversations"] == 12, [e[0][:30] for e in ex[:14]])
check("report shape: days, generated_at, insights, ai_quality, funnel, problems, counts, topics registry",
      rep["days"] == 7 and rep["generated_at"] and rep["ai_quality"]["traces"]["decisions"] == 50
      and rep["funnel"]["configured"] is True and isinstance(rep["problems"], list)
      and set(rep["problem_counts"]) == {"critical", "warn"}
      and [t["key"] for t in rep["topics"]] == [k for k, _l, _kw in bi.TOPICS]
      and isinstance(rep.get("thresholds"), dict)
      and "timezone_offset_hours" in rep, list(rep))
check("problems come from the assembled numbers (slow replies, checkout, AI handoff, unassigned)",
      {"slow_replies", "checkout_unpaid", "ai_low_confidence", "handoffs_unassigned"}
      <= {p["key"] for p in rep["problems"]}, [p["key"] for p in rep["problems"]])
check("gaps fetched once and shared with ai_quality.unanswered",
      rep["ai_quality"]["unanswered"] == {"count": 0, "examples": []}
      and sum(1 for e in ex if "portal_kb_gaps" in e[0]) == 1, "-")
check("days clamp: only 7 or 30", bi._days(30) == 30 and bi._days(12) == 7 and bi._days("x") == 7
      and bi._days(None) == 7, "-")

# ---------- API ----------

print("== api ==")
r = run_api(SCRIPT, "/api/v1/portal/bi/report?days=30")
check("GET bi/report 200 with days=30", r.status_code == 200 and r.get_json()["days"] == 30, r.status_code)
r = run_api(SCRIPT, "/api/v1/portal/bi/report?days=999", principal=API_KEY_PRINCIPAL)
check("GET bi/report clamps days + readable by API keys", r.status_code == 200
      and r.get_json()["days"] == 7, r.status_code)
r = run_api([], "/api/v1/portal/bi/report", principal=None)
check("GET bi/report 401", r.status_code == 401, r.status_code)

# ---------- wiring pins ----------

print("== wiring pins ==")
HERE = os.path.dirname(os.path.abspath(__file__))
CP = os.path.join(HERE, "..", "..", "omniflow-backend-patch")
RIG13 = "/tmp/p13/Omniflow/"


def read(path):
    return open(path, encoding="utf8").read() if os.path.exists(path) else ""


check("blueprint registered", "aux_app.register_blueprint(portal_bi_bp)" in read(os.path.join(CP, "app.py")), "-")
SRC = read(bi.__file__)
# §210: the only LLM use in the BI layer is the OPTIONAL narrative polish
# (default off) - one chat_json under the gated/ledgered bi_narrative scope.
check("zero LLM cost by default: one optional, gated narrative polish only",
      SRC.count("chat_json(") == 1 and SRC.count("import portal_llm") == 1
      and 'usage_scope("bi_narrative"' in SRC
      and "OF_BI_NARRATIVE_LLM" in SRC and bi.NARRATIVE_LLM is False, "-")
check("no new BI tables: report stays a read model; thresholds reuse client_settings",
      "CREATE TABLE portal_bi" not in SRC and "portal_bi_" not in SRC
      and "thresholds_for" in SRC and "bi_thresholds" in SRC
      and "timezone_offset_hours" in SRC, "-")
check("reuses platform definitions (needs-reply SLA, escalation labels, usage report, journey tables)",
      all(t in SRC for t in ("portal_conversations", "OVERDUE_HOURS", "portal_escalation.reason_label",
                             "portal_ai_usage.usage_report", "portal_memory.STAGES_TABLE",
                             "portal_brain.TRACES_TABLE", "portal_intelligence.TABLE")), "-")
check("env knobs, not hardcode", all(t in SRC for t in (
    "OF_BI_SAMPLE_MAX", "OF_BI_EVENTS_MAX", "OF_BI_TZ_OFFSET_HOURS", "OF_BI_STALL_DAYS",
    "OF_BI_DELIVERY_SHARE", "OF_BI_HANDOFF_SHARE")), "-")

LIB = read(RIG13 + "lib/omniflow/portal.ts")
check("portal.ts BI client + types", all(t in LIB for t in (
    "export async function getBiReport", "export interface BiReport", "export interface BiProblem",
    '"api/v1/portal/bi/report?days="')), "-")
ROUTE = read(RIG13 + "app/api/omniflow/portal/bi/report/route.ts")
check("BFF bi/report (depth 6, days 7|30)", "getBiReport(accessToken, days)" in ROUTE
      and ('"' + "../" * 6 + 'lib/omniflow/portal"') in ROUTE and "rawDays === 30 ? 30 : 7" in ROUTE, "-")
PAGE = read(RIG13 + "app/dashboard/(portal)/insights/page.tsx")
CLIENT = read(RIG13 + "app/dashboard/(portal)/insights/InsightsClient.tsx")
check("Insights page + client: problems, topics, AI quality, journey, 7/30 toggle",
      "<InsightsClient />" in PAGE and "Business insights" in PAGE
      and all(t in CLIENT for t in ("/api/omniflow/portal/bi/report", "Problems worth fixing",
                                    "What customers talk about", "AI quality", "Customer journey",
                                    "Last {option} days", "Fix now", "Worth a look", "confidence",
                                    "Customers said", "No AI calls were used")), "-")
check("loading skeleton", "animate-pulse" in read(RIG13 + "app/dashboard/(portal)/insights/loading.tsx"), "-")
SIDEBAR = read(RIG13 + "app/dashboard/components/DashSidebar.tsx")
PALETTE = read(RIG13 + "app/dashboard/components/CommandPalette.tsx")
check("sidebar + command palette entries", '"/dashboard/insights"' in SIDEBAR and "Business insights" in SIDEBAR
      and '"/dashboard/insights"' in PALETTE, "-")
check("UI copy English + text-presentation glyphs only",
      "karein" not in CLIENT and "\\u25b6" not in CLIENT and "\\u2714" not in CLIENT
      and "\\u26a1" not in CLIENT and '"\\u2059"' in SIDEBAR, "-")


# ---- owner thresholds + tenant timezone (ops polish) ----
check("owner thresholds clamp + defaults", bi._clamp_threshold("handoff_share", 2.0) == 1.0
      and bi._clamp_threshold("gaps_min", 0) == 1.0
      and bi._clamp_threshold("csat_low", 9) == 5.0
      and set(bi.default_thresholds()) == set(bi.THRESHOLDS), "-")
check("topic_insights accepts tenant tz offset",
      bi.topic_insights([], tz_offset_hours=3)["tz_offset_hours"] == 3, "-")
check("detect_problems honours injected thresholds",
      bi.detect_problems({"topics": {"messages": 0, "topics": []}}, {}, {}, 7,
                         thresholds={**bi.THRESHOLDS, "gaps_min": 9999}) == [], "-")
LIB2 = read(RIG13 + "lib/omniflow/portal.ts")
check("portal.ts BI thresholds client", all(t in LIB2 for t in (
    "export async function getBiThresholds", "export async function saveBiThresholds",
    '"api/v1/portal/bi/thresholds"')), "-")
THR = read(RIG13 + "app/api/omniflow/portal/bi/thresholds/route.ts")
check("BFF bi/thresholds GET+PUT", "getBiThresholds" in THR and "saveBiThresholds" in THR
      and "export async function GET" in THR and "export async function PUT" in THR, "-")
CARD = read(RIG13 + "app/dashboard/(portal)/settings/BiThresholdsCard.tsx")
PAGE = read(RIG13 + "app/dashboard/(portal)/settings/page.tsx")
check("Settings BI thresholds card mounted", "<BiThresholdsCard />" in PAGE
      and "Business insights thresholds" in CARD
      and "/api/omniflow/portal/bi/thresholds" in CARD, "-")
check("thresholds endpoints on blueprint",
      '@bp.get("/bi/thresholds")' in SRC and '@bp.put("/bi/thresholds")' in SRC, "-")

raise SystemExit(1 if summary("bi") else 0)
