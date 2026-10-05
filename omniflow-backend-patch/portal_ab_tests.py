"""Broadcast A/B tests (§234): send 2-4 versions of a broadcast to a random
slice of the audience, measure which one actually works, then send the
winner to everyone else - by the owner's click, or automatically when the
owner switched that on AND the result is clear.

Unify, do not duplicate (the audit-first law):

* sending IS the broadcast engine: recipients come from
  ``portal_growth._resolve_recipients`` (all / open / hot / saved segment),
  every message goes through ``portal_growth._send_command`` (connector
  queue, Telegram routing, opt-out guard), the 200-recipient cap is
  ``portal_growth.BROADCAST_MAX_RECIPIENTS`` and each send-out is checked
  against the plan's monthly broadcast limit (``portal_plans.enforce``);
* each version is an ordinary ``portal_broadcasts`` row (audience
  ``ab:<test>:<label>``), so Recent broadcasts, delivery counts, the plan
  counter and the calendar keep working unchanged;
* the automatic winner rides the EXISTING scheduled-broadcast slot: a row
  with audience ``ab:<test>:win`` and ``send_at`` = decision time. The
  connector tick already materialises due rows; for this one it calls
  :func:`materialize_winner` - so no new poller and zero extra queries on
  a tick with nothing due. Cancelling that scheduled row turns auto off;
* results are attributed per customer: each tested customer keeps the
  version they got (``portal_ab_assignments``); a reply = an inbound
  message from that customer, a paid order = a checkout order in paid /
  shipped / delivered (the dashboards' definition), both only inside the
  decision window after THEIR message. The winner test is a two-proportion
  z-test (leader vs every other version); "clear" needs a minimum number
  of customers per version, a minimum number of outcomes and the
  configured confidence. Below that the engine says so - it never guesses,
  and an automatic send is skipped (the owner is notified).

API (human principals):
  GET  /api/v1/portal/ab-tests                 config + recent tests, scored
  POST /api/v1/portal/ab-tests                 create (dry_run -> plan only)
  POST /api/v1/portal/ab-tests/<id>/winner     {variant} send it to the rest
  POST /api/v1/portal/ab-tests/<id>/cancel     stop (sent messages stay sent)

Env (all optional): OF_AB_MAX_VARIANTS (3) OF_AB_MIN_PER_VARIANT (20)
OF_AB_MIN_OUTCOMES (5) OF_AB_CONFIDENCE (95) OF_AB_MAX_RUNNING (5)
OF_AB_DEFAULT_PERCENT (30) OF_AB_DEFAULT_HOURS (24)
OF_AB_SQL_TIMEOUT_MS (8000).
"""

import json
import logging
import math
import os
import random
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_db
import portal_growth
import portal_plans
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)

logger = logging.getLogger("omniflow.portal-ab-tests")

bp = Blueprint("portal_ab_tests", __name__, url_prefix="/api/v1/portal")


def _env_int(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)) or default)
    except ValueError:
        value = default
    return min(max(value, low), high)


MAX_VARIANTS = _env_int("OF_AB_MAX_VARIANTS", 3, 2, 4)
MIN_PER_VARIANT = _env_int("OF_AB_MIN_PER_VARIANT", 20, 1, 1000)
MIN_OUTCOMES = _env_int("OF_AB_MIN_OUTCOMES", 5, 1, 1000)
CONFIDENCE = _env_int("OF_AB_CONFIDENCE", 95, 50, 99)
MAX_RUNNING = _env_int("OF_AB_MAX_RUNNING", 5, 1, 50)
DEFAULT_PERCENT = _env_int("OF_AB_DEFAULT_PERCENT", 30, 10, 100)
DEFAULT_HOURS = _env_int("OF_AB_DEFAULT_HOURS", 24, 1, 168)
SQL_TIMEOUT_MS = _env_int("OF_AB_SQL_TIMEOUT_MS", 8000, 1000, 60000)

TESTS_TABLE = "portal_ab_tests"
ASSIGN_TABLE = "portal_ab_assignments"
LABELS = ("A", "B", "C", "D")
METRICS = {"reply": "Replies", "order": "Paid orders"}
PAID = "('paid', 'shipped', 'delivered')"
MAX_NAME = 80
LIST_LIMIT = 20
MIN_PERCENT, MAX_PERCENT = 10, 100
MIN_HOURS, MAX_HOURS = 1, 168

_TABLES_READY = False


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------

def _phi(z: float) -> float:
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def confidence(x1: int, n1: int, x2: int, n2: int) -> Optional[float]:
    """One-sided two-proportion z-test: probability (0-1) that rate 1 is
    truly above rate 2. None when it cannot be computed."""
    if n1 <= 0 or n2 <= 0:
        return None
    pooled = (x1 + x2) / float(n1 + n2)
    spread = pooled * (1.0 - pooled) * (1.0 / n1 + 1.0 / n2)
    if spread <= 0:
        return None
    return _phi((x1 / float(n1) - x2 / float(n2)) / math.sqrt(spread))


def decide(variants: List[Dict[str, Any]], metric: str) -> Dict[str, Any]:
    """Pick a clear winner on ``metric`` (reply | order) or say why not.

    ``variants``: [{label, sent, replied, ordered}]. Returns {winner,
    leader, confidence (0-100 or None), clear, reason}."""
    key = "replied" if metric == "reply" else "ordered"
    noun = "replies" if metric == "reply" else "paid orders"
    out: Dict[str, Any] = {"winner": None, "leader": None,
                           "confidence": None, "clear": False, "reason": ""}
    rows = [v for v in variants if int(v.get("sent") or 0) > 0]
    if len(rows) < 2:
        out["reason"] = "Not every version has been sent yet."
        return out
    small = min(int(v["sent"]) for v in rows)
    if small < MIN_PER_VARIANT:
        out["reason"] = ("Too few customers to call it: each version needs"
                         " at least %d (smallest got %d)."
                         % (MIN_PER_VARIANT, small))
    total = sum(int(v.get(key) or 0) for v in rows)
    if total < MIN_OUTCOMES and not out["reason"]:
        out["reason"] = ("Too few %s so far to compare (%d of at least %d)."
                         % (noun, total, MIN_OUTCOMES))
    rates = sorted(((int(v.get(key) or 0) / float(v["sent"]), v)
                    for v in rows), key=lambda item: -item[0])
    if rates[0][0] == rates[1][0]:
        out["reason"] = out["reason"] or "The versions are tied."
        return out
    leader = rates[0][1]
    out["leader"] = leader["label"]
    worst = None
    for _rate, other in rates[1:]:
        value = confidence(int(leader.get(key) or 0), int(leader["sent"]),
                           int(other.get(key) or 0), int(other["sent"]))
        if value is None:
            worst = None
            break
        worst = value if worst is None else min(worst, value)
    if worst is not None:
        out["confidence"] = round(worst * 100.0, 1)
    if out["reason"]:
        return out
    if worst is None or worst * 100.0 < CONFIDENCE:
        out["reason"] = ("Version %s leads, but not clearly yet (%s"
                         " confidence, %d%% needed)."
                         % (leader["label"],
                            "unknown" if worst is None
                            else "%d%%" % int(worst * 100), CONFIDENCE))
        return out
    out.update({"winner": leader["label"], "clear": True,
                "reason": "Version %s wins on %s with %d%% confidence."
                % (leader["label"], noun, int(worst * 100))})
    return out


# ---------------------------------------------------------------------------
# Validation and the split
# ---------------------------------------------------------------------------

class TestError(Exception):
    def __init__(self, message: str, code: str = "bad_request",
                 status: int = 400):
        super().__init__(message)
        self.code = code
        self.status = status


def _int_in(raw: Any, default: int, low: int, high: int, name: str) -> int:
    if raw is None or raw == "":
        return default
    if isinstance(raw, bool):
        raise TestError(name + " must be a whole number.")
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise TestError(name + " must be a whole number.")
    if value != raw and not (isinstance(raw, str) and raw.strip().isdigit()):
        raise TestError(name + " must be a whole number.")
    if value < low or value > high:
        raise TestError("%s must be between %d and %d." % (name, low, high))
    return value


def validate(payload: Any) -> Dict[str, Any]:
    """Owner input -> a clean spec, or TestError."""
    if not isinstance(payload, dict):
        raise TestError("Send the test as a JSON object.")
    raw = payload.get("variants")
    if not isinstance(raw, list) or not 2 <= len(raw) <= MAX_VARIANTS:
        raise TestError("Give 2 to %d message versions." % MAX_VARIANTS)
    bodies: List[str] = []
    seen = set()
    for item in raw:
        body = item.get("body") if isinstance(item, dict) else item
        if not isinstance(body, str) or not body.strip():
            raise TestError("Every version needs message text.")
        body = body.strip()
        if len(body) > portal_growth.BROADCAST_MAX_BODY:
            raise TestError("Each version must be %d characters or fewer."
                            % portal_growth.BROADCAST_MAX_BODY)
        fingerprint = " ".join(body.lower().split())
        if fingerprint in seen:
            raise TestError("The versions must be different from each other.")
        seen.add(fingerprint)
        bodies.append(body)
    audience = str(payload.get("audience") or "all").strip().lower()
    if not portal_growth._valid_audience(audience):
        raise TestError("audience must be all, open, hot or a saved segment.")
    metric = str(payload.get("metric") or "reply").strip().lower()
    if metric not in METRICS:
        raise TestError("metric must be reply or order.")
    percent = _int_in(payload.get("test_percent"), DEFAULT_PERCENT,
                      MIN_PERCENT, MAX_PERCENT, "test_percent")
    hours = _int_in(payload.get("decide_hours"), DEFAULT_HOURS,
                    MIN_HOURS, MAX_HOURS, "decide_hours")
    auto = payload.get("auto_winner", False)
    if not isinstance(auto, bool):
        raise TestError("auto_winner must be true or false.")
    name = " ".join(str(payload.get("name") or "").split())[:MAX_NAME]
    return {"variants": bodies, "audience": audience, "metric": metric,
            "test_percent": percent, "decide_hours": hours,
            "auto_winner": bool(auto and percent < 100), "name": name}


def split(count: int, percent: int, versions: int) -> Tuple[int, int]:
    """(test group size, rest size) for ``count`` customers."""
    if percent >= 100:
        return count, 0
    size = max(versions, int(math.ceil(count * percent / 100.0)))
    size = min(size, count)
    return size, count - size


def assign(contacts: List[str], labels: List[str], seed: str
           ) -> List[Tuple[str, str]]:
    """Random, balanced assignment: shuffle, then deal round-robin."""
    order = list(contacts)
    random.Random(seed).shuffle(order)
    return [(contact, labels[index % len(labels)])
            for index, contact in enumerate(order)]


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

def _ensure_tables(cur) -> None:
    global _TABLES_READY
    if _TABLES_READY:
        return
    cur.execute(
        "CREATE TABLE IF NOT EXISTS " + portal_db._q(TESTS_TABLE) +
        " (id BIGSERIAL PRIMARY KEY,"
        " client_id BIGINT NOT NULL,"
        " name TEXT NOT NULL DEFAULT '',"
        " audience TEXT NOT NULL DEFAULT 'all',"
        " metric TEXT NOT NULL DEFAULT 'reply',"
        " test_percent INT NOT NULL DEFAULT 30,"
        " decide_hours INT NOT NULL DEFAULT 24,"
        " auto_winner BOOLEAN NOT NULL DEFAULT FALSE,"
        " status TEXT NOT NULL DEFAULT 'running',"
        " variants JSONB NOT NULL DEFAULT '[]'::jsonb,"
        " audience_size INT NOT NULL DEFAULT 0,"
        " test_size INT NOT NULL DEFAULT 0,"
        " winner_variant TEXT,"
        " winner_reason TEXT,"
        " auto_broadcast_id BIGINT,"
        " auto_note TEXT NOT NULL DEFAULT '',"
        " rest_sent INT NOT NULL DEFAULT 0,"
        " created_by BIGINT,"
        " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
        " decided_at TIMESTAMPTZ)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_portal_ab_tests_client ON "
                + portal_db._q(TESTS_TABLE) + " (client_id, id DESC)")
    cur.execute(
        "CREATE TABLE IF NOT EXISTS " + portal_db._q(ASSIGN_TABLE) +
        " (test_id BIGINT NOT NULL,"
        " client_id BIGINT NOT NULL,"
        " contact_id TEXT NOT NULL,"
        " variant TEXT NOT NULL,"
        " phase TEXT NOT NULL DEFAULT 'test',"
        " sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
        " PRIMARY KEY (test_id, contact_id))")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_portal_ab_assign_client ON "
                + portal_db._q(ASSIGN_TABLE) + " (client_id, test_id)")
    _TABLES_READY = True


def _tables_conn():
    """A connection whose A/B tables (and the broadcast schedule columns)
    exist - DDL committed on its own, like the other lazy tables."""
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_tables(cur)
        conn.commit()
        portal_growth._ensure_schedule_columns(conn)
    except Exception:
        global _TABLES_READY
        _TABLES_READY = False
        conn.close()
        raise
    return conn


def _variants(value: Any) -> List[Dict[str, Any]]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return []
    return [v for v in value if isinstance(v, dict)] \
        if isinstance(value, list) else []


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _audit(cur, client_id: int, action: str, actor: str, user_id,
           note: str) -> None:
    cur.execute("SAVEPOINT of_ab_audit")
    try:
        portal_db.log_action(cur, client_id, action, actor, user_id, None,
                             note[:500])
        cur.execute("RELEASE SAVEPOINT of_ab_audit")
    except Exception as error:
        cur.execute("ROLLBACK TO SAVEPOINT of_ab_audit")
        logger.warning("ab test audit skipped: %s", error)


def _guarded(cur, name: str, run, fallback):
    """Run ``run()`` under a savepoint; ``fallback`` if it fails (a missing
    optional table must not abort the caller's transaction)."""
    cur.execute("SAVEPOINT " + name)
    try:
        value = run()
        cur.execute("RELEASE SAVEPOINT " + name)
        return value
    except Exception as error:
        cur.execute("ROLLBACK TO SAVEPOINT " + name)
        logger.info("ab test %s fell back: %s", name, error)
        return fallback


def _recipients(cur, client_id: int, audience: str,
                exclude: Optional[set] = None) -> List[Dict[str, Any]]:
    """Audience members (broadcast resolver), opted-out customers and
    ``exclude`` removed, first occurrence wins."""
    rows = _guarded(cur, "of_ab_aud", lambda: portal_growth._resolve_recipients(
        cur, client_id, audience), [])
    picked: List[Dict[str, Any]] = []
    seen = set(exclude or ())
    for row in rows:
        contact = str(row.get("contact_id") or "").strip()
        if contact and contact not in seen:
            seen.add(contact)
            picked.append({"contact_id": contact,
                           "contact_name": str(row.get("contact_name") or "")})
    if not picked:
        return picked

    def optouts():
        cur.execute("SELECT contact_id FROM " + portal_db._q("portal_optouts")
                    + " WHERE client_id = %s AND contact_id = ANY(%s)",
                    (client_id, [p["contact_id"] for p in picked]))
        return {str(r.get("contact_id")) for r in portal_db.rows(cur)}

    blocked = _guarded(cur, "of_ab_opt", optouts, set())
    return [p for p in picked if p["contact_id"] not in blocked]


def _send(cur, client_id: int, people: List[Dict[str, Any]], body: str,
          broadcast_id: int) -> None:
    for person in people:
        display = person.get("contact_name") or ""
        portal_growth._send_command(
            cur, client_id, person["contact_id"], display,
            body.replace("{name}", portal_growth._first_name(display)),
            "broadcast", broadcast_id=broadcast_id)


def _record(cur, test_id: int, client_id: int,
            pairs: List[Tuple[str, str]], phase: str) -> None:
    if not pairs:
        return
    cur.execute(
        "INSERT INTO " + portal_db._q(ASSIGN_TABLE) +
        " (test_id, client_id, contact_id, variant, phase, sent_at)"
        " SELECT %s, %s, x.contact, x.variant, %s, NOW()"
        " FROM unnest(CAST(%s AS TEXT[]), CAST(%s AS TEXT[]))"
        " AS x(contact, variant) ON CONFLICT (test_id, contact_id) DO NOTHING",
        (test_id, client_id, phase, [c for c, _v in pairs],
         [v for _c, v in pairs]))


def _broadcast_row(cur, client_id: int, audience: str, body: str,
                   count: int, send_in_hours: Optional[int] = None) -> int:
    if send_in_hours is None:
        cur.execute(
            "INSERT INTO " + portal_db._q(portal_growth.BROADCASTS_TABLE) +
            " (client_id, audience, body, recipient_count)"
            " VALUES (%s, %s, %s, %s) RETURNING id",
            (client_id, audience, body, count))
    else:
        cur.execute(
            "INSERT INTO " + portal_db._q(portal_growth.BROADCASTS_TABLE) +
            " (client_id, audience, body, recipient_count, send_at)"
            " VALUES (%s, %s, %s, %s, NOW() + make_interval(hours => %s))"
            " RETURNING id",
            (client_id, audience, body, count, send_in_hours))
    return int(portal_db.rows(cur)[0]["id"])


def _auto_body(name: str, metric: str) -> str:
    return ("A/B test winner for '%s' - sent automatically to the rest of"
            " the audience only if one version clearly wins on %s."
            % (name, METRICS[metric].lower()))


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

def _exists(cur, table: str) -> bool:
    cur.execute("SELECT to_regclass(%s) AS t", (table,))
    found = portal_db.rows(cur)
    return bool(found and found[0].get("t"))


def results(cur, client_id: int, test_ids: List[int]
            ) -> Dict[int, Dict[str, Dict[str, Any]]]:
    """{test_id: {label: {sent, replied, ordered, sales}}} for the TEST
    phase, each outcome inside the test's decision window after that
    customer's own message."""
    if not test_ids:
        return {}
    orders = _exists(cur, portal_db._q("portal_checkout_links"))
    window = ("a.sent_at + make_interval(hours => t.decide_hours)")
    order_sql = (
        " LEFT JOIN LATERAL (SELECT COUNT(*) AS n, COALESCE(SUM(l.total), 0)"
        " AS total FROM " + portal_db._q("portal_checkout_links") + " l"
        " WHERE l.client_id = a.client_id AND l.contact_id = a.contact_id"
        " AND l.status IN " + PAID + " AND l.created_at > a.sent_at"
        " AND l.created_at <= " + window + ") o ON TRUE"
        if orders else
        " LEFT JOIN LATERAL (SELECT 0 AS n, 0 AS total) o ON TRUE")
    cur.execute(
        "SELECT a.test_id, a.variant, COUNT(*) AS sent,"
        " COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "
        + portal_db._q(portal_db.CONV_TABLE) + " c JOIN "
        + portal_db._q("portal_messages") + " m ON m.conversation_id = c.id"
        " WHERE c.client_id = a.client_id AND c.contact_id = a.contact_id"
        " AND m.client_id = a.client_id AND m.direction = 'in'"
        " AND m.created_at > a.sent_at AND m.created_at <= " + window + "))"
        " AS replied,"
        " COUNT(*) FILTER (WHERE o.n > 0) AS ordered,"
        " COALESCE(SUM(o.total), 0) AS sales"
        " FROM " + portal_db._q(ASSIGN_TABLE) + " a JOIN "
        + portal_db._q(TESTS_TABLE) + " t ON t.id = a.test_id"
        " AND t.client_id = a.client_id" + order_sql +
        " WHERE a.client_id = %s AND a.test_id = ANY(%s) AND a.phase = 'test'"
        " GROUP BY a.test_id, a.variant",
        (client_id, list(test_ids)))
    out: Dict[int, Dict[str, Dict[str, Any]]] = {}
    for row in portal_db.rows(cur):
        out.setdefault(int(row["test_id"]), {})[str(row["variant"])] = {
            "sent": int(row.get("sent") or 0),
            "replied": int(row.get("replied") or 0),
            "ordered": int(row.get("ordered") or 0),
            "sales": float(row.get("sales") or 0),
        }
    return out


def _delivery(cur, client_id: int, broadcast_ids: List[int]
              ) -> Dict[int, Dict[str, int]]:
    if not broadcast_ids:
        return {}
    cur.execute(
        "SELECT payload->>'broadcast_id' AS broadcast_id, status,"
        " COUNT(*) AS total FROM " + portal_db._q(portal_db.CMD_TABLE) +
        " WHERE client_id = %s AND action = 'send_message'"
        " AND payload->>'broadcast_id' = ANY(%s) GROUP BY 1, 2",
        (client_id, [str(b) for b in broadcast_ids]))
    out: Dict[int, Dict[str, int]] = {}
    for row in portal_db.rows(cur):
        try:
            bid = int(row.get("broadcast_id") or 0)
        except ValueError:
            continue
        bucket = out.setdefault(bid, {"delivered": 0, "failed": 0,
                                      "pending": 0})
        status = str(row.get("status") or "")
        key = {"done": "delivered", "failed": "failed"}.get(status, "pending")
        bucket[key] += int(row.get("total") or 0)
    return out


def _scored(test: Dict[str, Any], scores: Dict[str, Dict[str, Any]],
            delivery: Dict[int, Dict[str, int]]) -> List[Dict[str, Any]]:
    rows = []
    for variant in _variants(test.get("variants")):
        label = str(variant.get("label") or "")
        score = scores.get(label, {})
        sent = int(score.get("sent") or 0)
        bid = int(variant.get("broadcast_id") or 0)
        rows.append({
            "label": label, "body": str(variant.get("body") or ""),
            "broadcast_id": bid, "sent": sent,
            "delivered": delivery.get(bid, {}).get("delivered", 0),
            "failed": delivery.get(bid, {}).get("failed", 0),
            "replied": int(score.get("replied") or 0),
            "ordered": int(score.get("ordered") or 0),
            "sales": round(float(score.get("sales") or 0), 2),
            "reply_rate": round(100.0 * int(score.get("replied") or 0)
                                / sent, 1) if sent else None,
            "order_rate": round(100.0 * int(score.get("ordered") or 0)
                                / sent, 1) if sent else None,
        })
    return rows


def _public(test: Dict[str, Any], variants: List[Dict[str, Any]],
            auto_pending: bool, now_over: bool) -> Dict[str, Any]:
    metric = str(test.get("metric") or "reply")
    status = str(test.get("status") or "running")
    decision = decide(variants, metric)
    rest = max(int(test.get("audience_size") or 0)
               - int(test.get("test_size") or 0), 0)
    return {
        "id": int(test.get("id") or 0),
        "name": str(test.get("name") or ""),
        "audience": str(test.get("audience") or "all"),
        "metric": metric,
        "test_percent": int(test.get("test_percent") or 0),
        "decide_hours": int(test.get("decide_hours") or 0),
        "auto_winner": bool(test.get("auto_winner")),
        "auto_pending": auto_pending and status == "running",
        "auto_note": str(test.get("auto_note") or ""),
        "status": status,
        "window_over": bool(now_over),
        "audience_size": int(test.get("audience_size") or 0),
        "test_size": int(test.get("test_size") or 0),
        "rest_size": rest,
        "rest_sent": int(test.get("rest_sent") or 0),
        "winner": test.get("winner_variant") or None,
        "winner_reason": test.get("winner_reason") or None,
        "created_at": _iso(test.get("created_at")),
        "decide_at": _iso(test.get("decide_at")),
        "decided_at": _iso(test.get("decided_at")),
        "variants": variants,
        "decision": decision,
    }


_TEST_COLUMNS = (
    "t.id, t.name, t.audience, t.metric, t.test_percent, t.decide_hours,"
    " t.auto_winner, t.status, t.variants, t.audience_size, t.test_size,"
    " t.winner_variant, t.winner_reason, t.auto_broadcast_id, t.auto_note,"
    " t.rest_sent, t.created_at, t.decided_at,"
    " t.created_at + make_interval(hours => t.decide_hours) AS decide_at,"
    " (t.created_at + make_interval(hours => t.decide_hours) <= NOW())"
    " AS window_over")


def _score_tests(cur, client_id: int, tests: List[Dict[str, Any]]
                 ) -> List[Dict[str, Any]]:
    ids = [int(t["id"]) for t in tests]
    scores = results(cur, client_id, ids)
    bids = [int(v.get("broadcast_id") or 0) for t in tests
            for v in _variants(t.get("variants"))]
    delivery = _delivery(cur, client_id, [b for b in bids if b])
    autos = [int(t["auto_broadcast_id"]) for t in tests
             if t.get("auto_broadcast_id")]
    pending = set()
    if autos:
        cur.execute(
            "SELECT id FROM " + portal_db._q(portal_growth.BROADCASTS_TABLE) +
            " WHERE client_id = %s AND id = ANY(%s)"
            " AND send_at IS NOT NULL AND materialized_at IS NULL",
            (client_id, autos))
        pending = {int(r["id"]) for r in portal_db.rows(cur)}
    out = []
    for test in tests:
        variants = _scored(test, scores.get(int(test["id"]), {}), delivery)
        out.append(_public(test, variants,
                           int(test.get("auto_broadcast_id") or 0) in pending,
                           bool(test.get("window_over"))))
    return out


# ---------------------------------------------------------------------------
# Sending the winner (manual click and the scheduled auto slot)
# ---------------------------------------------------------------------------

def _send_winner(cur, client_id: int, test: Dict[str, Any], label: str,
                 reason: str, actor: str, user_id,
                 slot_id: Optional[int]) -> int:
    """Send version ``label`` to the audience members who were not in the
    test (resolved now, opt-outs removed, broadcast cap kept) and close the
    test. ``slot_id`` = the auto slot row to reuse. Returns the count."""
    test_id = int(test["id"])
    body = next((str(v.get("body") or "") for v in _variants(test["variants"])
                 if v.get("label") == label), "")
    people: List[Dict[str, Any]] = []
    if int(test.get("test_percent") or 100) < 100:
        cur.execute("SELECT contact_id FROM " + portal_db._q(ASSIGN_TABLE) +
                    " WHERE test_id = %s AND client_id = %s",
                    (test_id, client_id))
        tested = {str(r["contact_id"]) for r in portal_db.rows(cur)}
        people = _recipients(cur, client_id, str(test["audience"]),
                             exclude=tested)
        people = people[:portal_growth.BROADCAST_MAX_RECIPIENTS]
    if people:
        audience = "ab:%d:win" % test_id
        if slot_id:
            cur.execute(
                "UPDATE " + portal_db._q(portal_growth.BROADCASTS_TABLE) +
                " SET body = %s, recipient_count = %s, materialized_at = NOW()"
                " WHERE id = %s AND client_id = %s",
                (body, len(people), slot_id, client_id))
            broadcast_id = slot_id
        else:
            broadcast_id = _broadcast_row(cur, client_id, audience, body,
                                          len(people))
        _send(cur, client_id, people, body, broadcast_id)
        _record(cur, test_id, client_id,
                [(p["contact_id"], label) for p in people], "winner")
        _audit(cur, client_id, "broadcast.sent", actor, user_id,
               "A/B test '%s': winning version %s sent to %d customers."
               % (test.get("name") or test_id, label, len(people)))
    elif slot_id:
        _drop_slot(cur, client_id, {"auto_broadcast_id": slot_id})
    cur.execute(
        "UPDATE " + portal_db._q(TESTS_TABLE) +
        " SET status = 'completed', winner_variant = %s, winner_reason = %s,"
        " rest_sent = %s, decided_at = NOW() WHERE id = %s AND client_id = %s",
        (label, reason, len(people), test_id, client_id))
    _audit(cur, client_id, "abtest.winner_chosen", actor, user_id,
           json.dumps({"test": test_id, "winner": label, "reason": reason,
                       "sent": len(people)}))
    return len(people)


def _drop_slot(cur, client_id: int, test: Dict[str, Any]) -> None:
    """Remove a still-pending auto slot (it never sent anything)."""
    slot = int(test.get("auto_broadcast_id") or 0)
    if slot:
        cur.execute(
            "DELETE FROM " + portal_db._q(portal_growth.BROADCASTS_TABLE) +
            " WHERE id = %s AND client_id = %s AND materialized_at IS NULL",
            (slot, client_id))


def _notify(client_id: int, title: str, detail: str, test_id: int,
            outcome: str) -> None:
    try:
        import portal_notify

        portal_notify.notify(client_id, "insights", title, detail,
                             dedupe_key="abtest:%d:%s" % (test_id, outcome))
    except Exception as error:
        logger.info("ab test notify skipped: %s", error)


def materialize_winner(cur, client_id: int, row: Dict[str, Any]) -> int:
    """The auto slot (audience ``ab:<id>:win``) came due on the connector
    tick: send the clear winner, or skip and tell the owner. Runs inside
    the tick's transaction (the caller holds a savepoint)."""
    slot_id = int(row.get("id") or 0)
    try:
        test_id = int(str(row.get("audience") or "").split(":")[1])
    except (IndexError, ValueError):
        test_id = 0
    cur.execute("SELECT " + _TEST_COLUMNS + " FROM " +
                portal_db._q(TESTS_TABLE) + " t WHERE t.id = %s"
                " AND t.client_id = %s FOR UPDATE", (test_id, client_id))
    found = portal_db.rows(cur)
    test = found[0] if found else None
    if (test is None or test.get("status") != "running"
            or int(test.get("auto_broadcast_id") or 0) != slot_id):
        cur.execute(
            "UPDATE " + portal_db._q(portal_growth.BROADCASTS_TABLE) +
            " SET recipient_count = 0, materialized_at = NOW()"
            " WHERE id = %s AND client_id = %s", (slot_id, client_id))
        return 0
    scores = results(cur, client_id, [test_id]).get(test_id, {})
    variants = _scored(test, scores, {})
    verdict = decide(variants, str(test.get("metric") or "reply"))
    name = str(test.get("name") or ("A/B test %d" % test_id))
    if verdict["clear"]:
        sent = _send_winner(cur, client_id, test, verdict["winner"], "auto",
                            "system", None, slot_id)
        _notify(client_id, "A/B test '%s': version %s won"
                % (name, verdict["winner"]),
                verdict["reason"] + " Sent to %d more customers." % sent,
                test_id, "sent")
        return sent
    note = "Automatic send skipped: " + verdict["reason"]
    cur.execute(
        "UPDATE " + portal_db._q(portal_growth.BROADCASTS_TABLE) +
        " SET recipient_count = 0, materialized_at = NOW(),"
        " body = LEFT(body || ' (not sent: no clear winner)', 1000)"
        " WHERE id = %s AND client_id = %s", (slot_id, client_id))
    cur.execute("UPDATE " + portal_db._q(TESTS_TABLE) +
                " SET auto_note = %s WHERE id = %s AND client_id = %s",
                (note[:300], test_id, client_id))
    _audit(cur, client_id, "abtest.auto_skipped", "system", None,
           json.dumps({"test": test_id, "reason": verdict["reason"]}))
    _notify(client_id, "A/B test '%s' needs your decision" % name,
            note + " Open Broadcasts to pick a version.", test_id, "skipped")
    return 0


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

def _error(message: str, code: str, status: int):
    return jsonify({"error": {"code": code, "message": message}}), status


def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable:
        return None, _error("Auth is unavailable, try again.",
                            "portal_unavailable", 503)
    if not principal:
        return None, _error("Sign in required.", "unauthorized", 401)
    forbidden = ensure_human_principal(principal)
    if forbidden:
        return None, forbidden
    return principal, None


def _plan_block(cur, client_id: int):
    """The broadcast plan limit (portal_plans.enforce: one send-out = one
    broadcast). Savepoint-guarded: enforce fails open on a missing table,
    but its failed SELECT would otherwise abort this transaction."""
    return _guarded(cur, "of_ab_plan", lambda: portal_plans.enforce(
        cur, client_id, "broadcasts_per_month", "Monthly broadcast"), None)


def _segments(cur, client_id: int) -> List[Dict[str, Any]]:
    def read():
        cur.execute("SELECT id, name FROM " + portal_db._q("portal_segments")
                    + " WHERE client_id = %s ORDER BY name LIMIT 50",
                    (client_id,))
        return [{"key": "segment:%d" % int(r["id"]),
                 "label": str(r.get("name") or "Segment")}
                for r in portal_db.rows(cur)]

    return _guarded(cur, "of_ab_seg", read, [])


def _currency() -> str:
    """One money label for the workspace UI (the analytics setting)."""
    try:
        import portal_nl_analytics

        return portal_nl_analytics.CURRENCY or "Rs"
    except Exception:
        return "Rs"


def config(segments: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "currency": _currency(),
        "max_variants": MAX_VARIANTS, "min_per_variant": MIN_PER_VARIANT,
        "min_outcomes": MIN_OUTCOMES, "confidence": CONFIDENCE,
        "default_percent": DEFAULT_PERCENT, "default_hours": DEFAULT_HOURS,
        "max_recipients": portal_growth.BROADCAST_MAX_RECIPIENTS,
        "max_body": portal_growth.BROADCAST_MAX_BODY,
        "max_running": MAX_RUNNING,
        "metrics": [{"key": k, "label": v} for k, v in METRICS.items()],
        "audiences": [{"key": k, "label": portal_growth.AUDIENCE_LABELS[k]
                       .capitalize()} for k in portal_growth.AUDIENCES]
        + segments,
    }


@bp.get("/ab-tests")
def list_tests():
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    try:
        conn = _tables_conn()
        try:
            with conn.cursor() as cur:
                cur.execute("SET LOCAL statement_timeout = %s",
                            (str(SQL_TIMEOUT_MS),))
                segments = _segments(cur, client_id)
                cur.execute("SELECT " + _TEST_COLUMNS + " FROM "
                            + portal_db._q(TESTS_TABLE) + " t"
                            " WHERE t.client_id = %s ORDER BY t.id DESC"
                            " LIMIT %s", (client_id, LIST_LIMIT))
                tests = _score_tests(cur, client_id, portal_db.rows(cur))
            conn.rollback()
        finally:
            conn.close()
    except Exception as exc:
        return jsonify(portal_db.portal_unavailable(exc, "ab tests")[0]), 503
    return jsonify({"tests": tests, "config": config(segments)}), 200


@bp.post("/ab-tests")
def create_test():
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True)
    try:
        spec = validate(payload)
    except TestError as exc:
        return _error(str(exc), exc.code, exc.status)
    dry_run = isinstance(payload, dict) and payload.get("dry_run") is True
    labels = list(LABELS[:len(spec["variants"])])
    try:
        conn = _tables_conn()
        try:
            with conn.cursor() as cur:
                people = _recipients(cur, client_id, spec["audience"])
                count = len(people)
                problem = None
                if not count:
                    problem = ("No customers match this audience yet.",
                               "no_recipients", 400)
                elif count > portal_growth.BROADCAST_MAX_RECIPIENTS:
                    problem = ("Audience has more than %d customers. Narrow"
                               " it down (open chats, hot leads or a"
                               " segment)." % portal_growth
                               .BROADCAST_MAX_RECIPIENTS,
                               "too_many_recipients", 400)
                elif count < len(labels):
                    problem = ("Each version needs at least one customer:"
                               " %d versions, %d customers."
                               % (len(labels), count),
                               "too_few_recipients", 400)
                if problem:
                    conn.rollback()
                    return _error(*problem)
                size, rest = split(count, spec["test_percent"], len(labels))
                if rest == 0:
                    spec["auto_winner"] = False
                per = size // len(labels)
                plan = {"audience_size": count, "test_size": size,
                        "per_variant": per, "rest_size": rest,
                        "auto_winner": spec["auto_winner"],
                        "warnings": []}
                if per < MIN_PER_VARIANT:
                    plan["warnings"].append(
                        "Each version reaches about %d customers - fewer"
                        " than the %d needed to call a clear winner. You can"
                        " still compare the numbers and pick one yourself."
                        % (per, MIN_PER_VARIANT))
                if rest == 0:
                    plan["warnings"].append(
                        "Everyone is in the test, so there is no 'rest' to"
                        " send the winner to - the result is for learning.")
                if dry_run:
                    conn.rollback()
                    return jsonify({"plan": plan}), 200
                cur.execute("SELECT COUNT(*) AS n FROM "
                            + portal_db._q(TESTS_TABLE) +
                            " WHERE client_id = %s AND status = 'running'",
                            (client_id,))
                if int(portal_db.rows(cur)[0]["n"] or 0) >= MAX_RUNNING:
                    conn.rollback()
                    return _error("You already have %d A/B tests running."
                                  " Finish or cancel one first."
                                  % MAX_RUNNING, "conflict", 409)
                blocked = _plan_block(cur, client_id)
                if blocked is not None:
                    conn.rollback()
                    return blocked
                name = spec["name"] or "A/B test"
                cur.execute(
                    "INSERT INTO " + portal_db._q(TESTS_TABLE) +
                    " (client_id, name, audience, metric, test_percent,"
                    " decide_hours, auto_winner, audience_size, test_size,"
                    " created_by) VALUES (%s, %s, %s, %s, %s, %s, %s, %s,"
                    " %s, %s) RETURNING id",
                    (client_id, name, spec["audience"], spec["metric"],
                     spec["test_percent"], spec["decide_hours"],
                     spec["auto_winner"], count, size,
                     principal.get("user_id")))
                test_id = int(portal_db.rows(cur)[0]["id"])
                pairs = assign([p["contact_id"] for p in people], labels,
                               "%d:%d" % (client_id, test_id))[:size]
                by_contact = {p["contact_id"]: p for p in people}
                variants = []
                for label, body in zip(labels, spec["variants"]):
                    group = [by_contact[c] for c, v in pairs if v == label]
                    bid = _broadcast_row(cur, client_id,
                                         "ab:%d:%s" % (test_id, label),
                                         body, len(group))
                    _send(cur, client_id, group, body, bid)
                    variants.append({"label": label, "body": body,
                                     "broadcast_id": bid,
                                     "recipients": len(group)})
                _record(cur, test_id, client_id, pairs, "test")
                slot = None
                if spec["auto_winner"]:
                    slot = _broadcast_row(
                        cur, client_id, "ab:%d:win" % test_id,
                        _auto_body(name, spec["metric"]), rest,
                        send_in_hours=spec["decide_hours"])
                cur.execute(
                    "UPDATE " + portal_db._q(TESTS_TABLE) +
                    " SET variants = CAST(%s AS JSONB), auto_broadcast_id = %s"
                    " WHERE id = %s AND client_id = %s",
                    (json.dumps(variants, ensure_ascii=False), slot, test_id,
                     client_id))
                _audit(cur, client_id, "broadcast.sent", "customer_user",
                       principal.get("user_id"),
                       "A/B test '%s': %d versions sent to %d customers (%s)."
                       % (name, len(labels), size, spec["audience"]))
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        return jsonify(portal_db.portal_unavailable(exc, "ab test start")[0]), 503
    return jsonify({"ok": True, "id": test_id, "plan": plan}), 200


def _load_for_update(cur, client_id: int, test_id: int):
    cur.execute("SELECT " + _TEST_COLUMNS + " FROM " +
                portal_db._q(TESTS_TABLE) + " t WHERE t.id = %s"
                " AND t.client_id = %s FOR UPDATE", (test_id, client_id))
    found = portal_db.rows(cur)
    return found[0] if found else None


@bp.post("/ab-tests/<int:test_id>/winner")
def choose_winner(test_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True)
    label = str((payload or {}).get("variant") or "").strip().upper() \
        if isinstance(payload, dict) else ""
    try:
        conn = _tables_conn()
        try:
            with conn.cursor() as cur:
                test = _load_for_update(cur, client_id, test_id)
                if test is None:
                    conn.rollback()
                    return _error("A/B test not found.", "not_found", 404)
                if test.get("status") != "running":
                    conn.rollback()
                    return _error("This test is already %s."
                                  % test.get("status"), "conflict", 409)
                if label not in {v.get("label")
                                 for v in _variants(test["variants"])}:
                    conn.rollback()
                    return _error("Pick one of the test's versions.",
                                  "bad_request", 400)
                slot = None
                if test.get("auto_broadcast_id"):
                    cur.execute(
                        "SELECT id FROM " +
                        portal_db._q(portal_growth.BROADCASTS_TABLE) +
                        " WHERE id = %s AND client_id = %s"
                        " AND materialized_at IS NULL",
                        (int(test["auto_broadcast_id"]), client_id))
                    pending = portal_db.rows(cur)
                    slot = int(pending[0]["id"]) if pending else None
                if slot is None and int(test.get("test_percent") or 100) < 100:
                    blocked = _plan_block(cur, client_id)
                    if blocked is not None:
                        conn.rollback()
                        return blocked
                sent = _send_winner(cur, client_id, test, label, "manual",
                                    "customer_user", principal.get("user_id"),
                                    slot)
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        return jsonify(portal_db.portal_unavailable(exc, "ab test winner")[0]), 503
    return jsonify({"ok": True, "winner": label, "sent": sent}), 200


@bp.post("/ab-tests/<int:test_id>/cancel")
def cancel_test(test_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    try:
        conn = _tables_conn()
        try:
            with conn.cursor() as cur:
                test = _load_for_update(cur, client_id, test_id)
                if test is None:
                    conn.rollback()
                    return _error("A/B test not found.", "not_found", 404)
                if test.get("status") != "running":
                    conn.rollback()
                    return _error("This test is already %s."
                                  % test.get("status"), "conflict", 409)
                _drop_slot(cur, client_id, test)
                cur.execute("UPDATE " + portal_db._q(TESTS_TABLE) +
                            " SET status = 'cancelled', decided_at = NOW()"
                            " WHERE id = %s AND client_id = %s",
                            (test_id, client_id))
                _audit(cur, client_id, "abtest.cancelled", "customer_user",
                       principal.get("user_id"),
                       json.dumps({"test": test_id}))
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        return jsonify(portal_db.portal_unavailable(exc, "ab test cancel")[0]), 503
    return jsonify({"ok": True, "id": test_id}), 200
