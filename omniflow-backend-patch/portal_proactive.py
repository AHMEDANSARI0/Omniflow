"""Proactive business alerts (§242, gap analysis row 16).

The weekly problems report (``portal_bi``) describes the past; this module
watches recent customer messages and tells the owner AS SOON AS a business
pattern appears:

* ``demand_unavailable``  several customers ask for a product that is
  paused in the catalog, or for something the catalog does not list;
* ``repeat_complainer``   one customer complains on several separate
  occasions;
* ``product_complaints``  several customers complain about the same
  catalog product;
* ``complaint_spike``     complaints in the last 24 hours are well above
  the usual daily number.

How it runs
-----------
The connector tick calls ``kick(client_id)``: at most every
OF_PROACTIVE_EVERY_MINUTES (also checked against ``last_run_at`` in the
database, so many processes do not multiply the work) a background thread
with its own connection reads the recent inbound messages once and runs
every enabled rule over them. Owners can also press "Check now".

Every new alert is
  - a row in ``portal_proactive_events`` (history; the same rule + subject
    is not raised again until its look-back window has passed),
  - an event on the platform outbox (``portal_action_log`` action
    ``proactive.<rule>``, see ``portal_event_catalog``), so webhooks and
    workflows can react to it,
  - a notification through ``portal_notify`` (kind ``proactive``: bell,
    email opt-in, rate limits, templates).

Rules
-----
* Topics come from ``portal_bi.topics_for`` and product matching from
  ``portal_sales.match_products`` - no second lexicon or matcher.
* A stock count of 0 means "not tracked" across OmniFlow, so "unavailable"
  means PAUSED in the catalog (``is_active`` false), never stock = 0.
* Alerts never quote customer messages; titles name catalog products, a
  short asked-for phrase (letters only) or the contact name.
* Settings: owners / admins (OF_NOTIFY_ROLES) edit; every team member can
  read and run a check. API keys get 403. OF_PROACTIVE=0 turns it off.
"""

import json
import logging
import os
import re
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_db
import portal_txn
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)

bp = Blueprint("portal_proactive", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

SETTINGS_TABLE = "portal_proactive_settings"
EVENTS_TABLE = "portal_proactive_events"
MESSAGES_TABLE = "portal_messages"
CATALOG_TABLE = "portal_catalog"
INBOUND_SQL = "direction IN ('in', 'inbound')"
NOTIFY_KIND = "proactive"
TROUBLE_TOPICS = ("complaint", "returns")
#: a message asks for a product when it is ONLY about availability / price
ASK_TOPICS = frozenset(("availability", "price"))


def _env_int(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(str(os.environ.get(name, "")).strip() or default)
    except ValueError:
        value = default
    return max(low, min(high, value))


ENABLED = os.environ.get("OF_PROACTIVE", "1").strip().lower() not in (
    "0", "false", "no", "off")
EVERY_MINUTES = _env_int("OF_PROACTIVE_EVERY_MINUTES", 30, 5, 1440)
MAX_MESSAGES = _env_int("OF_PROACTIVE_MAX_MESSAGES", 5000, 200, 50000)
MAX_ALERTS = _env_int("OF_PROACTIVE_MAX_ALERTS", 10, 1, 50)
CATALOG_MAX = _env_int("OF_PROACTIVE_CATALOG_MAX", 2000, 10, 10000)
RECENT_LIMIT = 20
MAX_WINDOW_HOURS = 168
#: complaints closer together than this are one occasion (a burst of lines)
EPISODE_GAP_MINUTES = 30
SPIKE_HOURS = 24
SPIKE_BASELINE_DAYS = 7
SPIKE_MIN_BASELINE_DAYS = 3
MAX_PHRASES = 3
MAX_TEXT = 300
MAX_TITLE = 200
MAX_NAME = 60

#: rule key -> metadata; params are (default, min, max, label), whole numbers
RULES: Dict[str, Dict[str, Any]] = {
    "demand_unavailable": {
        "label": "Demand for products you don't sell right now",
        "description": "Several customers ask for a product that is paused in"
                       " your catalog, or for something your catalog does not"
                       " list.",
        "severity": "normal",
        "params": {
            "window_hours": (48, 6, MAX_WINDOW_HOURS, "Look back (hours)"),
            "min_customers": (3, 2, 50, "Customers asking"),
        }},
    "repeat_complainer": {
        "label": "Customer complaining repeatedly",
        "description": "One customer sends complaint or return messages on"
                       " several separate occasions.",
        "severity": "normal",
        "params": {
            "window_hours": (72, 6, MAX_WINDOW_HOURS, "Look back (hours)"),
            "min_times": (3, 2, 20, "Separate complaints"),
        }},
    "product_complaints": {
        "label": "Complaints about one product",
        "description": "Several customers complain about the same catalog"
                       " product.",
        "severity": "high",
        "params": {
            "window_hours": (MAX_WINDOW_HOURS, 24, MAX_WINDOW_HOURS,
                             "Look back (hours)"),
            "min_customers": (3, 2, 50, "Customers complaining"),
        }},
    "complaint_spike": {
        "label": "Complaint spike",
        "description": "Complaints in the last 24 hours are well above your"
                       " usual daily number.",
        "severity": "high",
        "params": {
            "min_count": (5, 2, 500, "At least this many complaints"),
            "factor": (2, 2, 10, "Times the usual daily number"),
        }},
}
RULE_KEYS = tuple(RULES)

#: words that never name a product (asked-for phrases skip them)
_FILLER = frozenset("""
the and for with new set pack size color colour wala wali small large any
have has you your yours this that these those are there what which how much
price rate also please plz pls bhai bhi sir madam mam hello salam aoa assalam
hai hain kya kia kiya aap apka apki apke mein main mujhe humein hume chahiye
chahye chaiye chahie available availability availab stock milega milegi mil
jayega jayegi jaye jaega sakta sakti sake hoga hogi hon hota hoti kab tak abhi
kal aaj restock khatam variant karo kardo kar dein dena send pic pics picture
photo photos image video link order buy need want looking get got can could
will would should does did yes nah nahi nahin nhi koi kuch yeh woh wo ye bata
batao batayen batain bataen detail details info inform information ready aya
aaya aye aaye wapas phir dobara again still more some other kitna kitne kitni
qeemat keemat ka ki ke ko se par per ho hy han haan ok okay thanks thank shukriya
""".split())
_WORD_RE = re.compile(r"(?<![a-z0-9])[a-z]{3,20}(?![a-z0-9])")
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")

_DDL_READY = False
_LOCK = threading.Lock()
_LAST: Dict[int, float] = {}
_RUNNING: set = set()
LOCK_CLASS = 24201  # pg advisory lock namespace for one run per tenant


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

def _ensure_ddl(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(
        "CREATE TABLE IF NOT EXISTS " + portal_db._q(SETTINGS_TABLE) +
        " (client_id BIGINT PRIMARY KEY,"
        " enabled BOOLEAN NOT NULL DEFAULT TRUE,"
        " rules JSONB NOT NULL DEFAULT '{}'::jsonb,"
        " last_run_at TIMESTAMPTZ,"
        " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())")
    cur.execute(
        "CREATE TABLE IF NOT EXISTS " + portal_db._q(EVENTS_TABLE) +
        " (id BIGSERIAL PRIMARY KEY,"
        " client_id BIGINT NOT NULL,"
        " rule TEXT NOT NULL,"
        " subject TEXT NOT NULL,"
        " severity TEXT NOT NULL DEFAULT 'normal',"
        " title TEXT NOT NULL,"
        " detail TEXT NOT NULL DEFAULT '',"
        " href TEXT NOT NULL DEFAULT '',"
        " conversation_id BIGINT,"
        " data JSONB NOT NULL DEFAULT '{}'::jsonb,"
        " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())")
    cur.execute(
        "CREATE INDEX IF NOT EXISTS portal_proactive_events_subject_idx ON "
        + portal_db._q(EVENTS_TABLE) + " (client_id, rule, subject, created_at DESC)")
    _DDL_READY = True


def _exists(cur, table: str) -> bool:
    cur.execute("SELECT to_regclass(%s) AS t", (table,))
    row = cur.fetchone()
    value = row.get("t") if isinstance(row, dict) else (row[0] if row else None)
    return bool(value)


def _json(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    try:
        parsed = json.loads(value) if isinstance(value, str) else {}
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _iso(value: Any) -> Optional[str]:
    return value.isoformat() if hasattr(value, "isoformat") else (str(value) if value else None)


def _whole(value: Any) -> Optional[int]:
    """A real whole number (never a bool / float / text)."""
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def default_rules() -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    for key, spec in RULES.items():
        out[key] = {"enabled": True}
        for name, (default, _low, _high, _label) in spec["params"].items():
            out[key][name] = default
    return out


def shape_rules(stored: Any) -> Dict[str, Dict[str, Any]]:
    """Stored JSON -> every rule with every param (bad / out-of-range values
    fall back to the default; unknown keys are dropped)."""
    data = _json(stored)
    out = default_rules()
    for key, spec in RULES.items():
        saved = data.get(key)
        if not isinstance(saved, dict):
            continue
        if isinstance(saved.get("enabled"), bool):
            out[key]["enabled"] = saved["enabled"]
        for name, (_default, low, high, _label) in spec["params"].items():
            value = _whole(saved.get(name))
            if value is not None and low <= value <= high:
                out[key][name] = value
    return out


def load_settings(cur, client_id: int) -> Dict[str, Any]:
    settings = {"enabled": True, "rules": default_rules(), "last_run_at": None}
    if not _exists(cur, SETTINGS_TABLE):
        return settings
    cur.execute(
        "SELECT enabled, rules, last_run_at FROM " + portal_db._q(SETTINGS_TABLE) +
        " WHERE client_id = %s", (client_id,))
    rows = portal_db.rows(cur)
    if rows:
        settings.update({"enabled": rows[0].get("enabled") is not False,
                         "rules": shape_rules(rows[0].get("rules")),
                         "last_run_at": _iso(rows[0].get("last_run_at"))})
    return settings


def validate_settings(payload: Any, current: Dict[str, Any]
                      ) -> Tuple[Optional[Dict[str, Any]], str]:
    """Owner input -> (merged settings, "") or (None, problem). Strict:
    unknown rules / params and out-of-range numbers are refused."""
    if not isinstance(payload, dict):
        return None, "A JSON object is required."
    merged = {"enabled": current["enabled"],
              "rules": {key: dict(value) for key, value in current["rules"].items()}}
    if "enabled" in payload:
        if not isinstance(payload["enabled"], bool):
            return None, "enabled must be true or false."
        merged["enabled"] = payload["enabled"]
    rules = payload.get("rules", {})
    if not isinstance(rules, dict):
        return None, "rules must be an object."
    for key, change in rules.items():
        spec = RULES.get(key)
        if spec is None:
            return None, "Unknown rule: " + str(key)[:40] + "."
        if not isinstance(change, dict):
            return None, spec["label"] + ": settings must be an object."
        for name, value in change.items():
            if name == "enabled":
                if not isinstance(value, bool):
                    return None, spec["label"] + ": enabled must be true or false."
                merged["rules"][key]["enabled"] = value
                continue
            param = spec["params"].get(name)
            if param is None:
                return None, spec["label"] + ": unknown setting " + str(name)[:40] + "."
            _default, low, high, label = param
            number = _whole(value)
            if number is None or not low <= number <= high:
                return None, (spec["label"] + ": " + label + " must be a whole number from "
                              + str(low) + " to " + str(high) + ".")
            merged["rules"][key][name] = number
    return merged, ""


def save_settings(cur, client_id: int, settings: Dict[str, Any]) -> None:
    cur.execute(
        "INSERT INTO " + portal_db._q(SETTINGS_TABLE) +
        " (client_id, enabled, rules, updated_at) VALUES (%s, %s, %s::jsonb, NOW())"
        " ON CONFLICT (client_id) DO UPDATE SET enabled = EXCLUDED.enabled,"
        " rules = EXCLUDED.rules, updated_at = NOW()",
        (client_id, settings["enabled"], json.dumps(settings["rules"])))


def recent_events(cur, client_id: int, limit: int = RECENT_LIMIT) -> List[Dict[str, Any]]:
    if not _exists(cur, EVENTS_TABLE):
        return []
    cur.execute(
        "SELECT id, rule, severity, title, detail, href, conversation_id, created_at"
        " FROM " + portal_db._q(EVENTS_TABLE) +
        " WHERE client_id = %s ORDER BY id DESC LIMIT %s", (client_id, limit))
    return [_shape_event(row) for row in portal_db.rows(cur)]


def _shape_event(row: Dict[str, Any]) -> Dict[str, Any]:
    rule = str(row.get("rule") or "")
    return {"id": int(row.get("id") or 0), "rule": rule,
            "rule_label": (RULES.get(rule) or {}).get("label", rule),
            "severity": str(row.get("severity") or "normal"),
            "title": str(row.get("title") or ""), "detail": str(row.get("detail") or ""),
            "href": str(row.get("href") or ""),
            "conversation_id": int(row["conversation_id"]) if row.get("conversation_id") else None,
            "created_at": _iso(row.get("created_at"))}


def public_rules(rules: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [{
        "key": key, "label": spec["label"], "description": spec["description"],
        "severity": spec["severity"], "enabled": rules[key]["enabled"],
        "params": [{"key": name, "label": label, "value": rules[key][name],
                    "min": low, "max": high}
                   for name, (_default, low, high, label) in spec["params"].items()],
    } for key, spec in RULES.items()]


# ---------------------------------------------------------------------------
# Detectors (pure: prepared messages + catalog -> candidate alerts)
# ---------------------------------------------------------------------------

def _plural(count: int, word: str) -> str:
    return str(count) + " " + word + ("" if count == 1 else "s")


def _norm(text: Any) -> str:
    return " ".join(str(text or "").lower().split())


def _match(text: str, items: List[Dict[str, Any]], limit: int = 50) -> List[Dict[str, Any]]:
    import portal_sales

    return portal_sales.match_products(text, items, limit=limit) if items else []


def phrases(text: str) -> List[str]:
    """Short asked-for phrases: words of letters only (no digits, no
    filler), alone and in adjacent pairs."""
    words = _WORD_RE.findall(_norm(text)[:MAX_TEXT])
    keep = [(w if w not in _FILLER else None) for w in words]
    found: List[str] = []
    for index, word in enumerate(keep):
        if word is None:
            continue
        if len(word) >= 4 and word not in found:
            found.append(word)
        if index + 1 < len(keep) and keep[index + 1]:
            pair = word + " " + keep[index + 1]
            if pair not in found:
                found.append(pair)
    return found


def _within(msgs: List[Dict[str, Any]], hours: int) -> List[Dict[str, Any]]:
    return [m for m in msgs if m["age"] < hours]


def _trouble(message: Dict[str, Any]) -> bool:
    return any(topic in message["topics"] for topic in TROUBLE_TOPICS)


def detect_demand(msgs: List[Dict[str, Any]], items: List[Dict[str, Any]],
                  params: Dict[str, Any]) -> List[Dict[str, Any]]:
    hours, need = params["window_hours"], params["min_customers"]
    if not items:
        return []  # without a catalog nothing is "paused" or "not listed"
    active = [i for i in items if i["active"]]
    # a paused duplicate of an active product never alerts: the active
    # match below skips the message first
    paused = [i for i in items if not i["active"]]
    by_item: Dict[int, set] = {}
    by_phrase: Dict[str, set] = {}
    for message in _within(msgs, hours):
        if _match(message["text"], active, 1):
            continue  # they asked for something you sell
        hit = _match(message["text"], paused, 1)
        if hit:
            by_item.setdefault(hit[0]["id"], set()).add(message["conv"])
            continue
        if message["topics"] and message["topics"] <= ASK_TOPICS:
            for phrase in phrases(message["text"]):
                by_phrase.setdefault(phrase, set()).add(message["conv"])
    out = []
    window = _plural(hours, "hour")
    for item in paused:
        convs = by_item.get(item["id"]) or set()
        if len(convs) >= need:
            out.append({
                "rule": "demand_unavailable", "subject": "item:" + str(item["id"]),
                "count": len(convs), "conversation_id": None,
                "title": _plural(len(convs), "customer") + " asked for " + item["name"]
                         + " (paused in your catalog)",
                "detail": "Asked in the last " + window + ". Turn it back on if you"
                          " have it, or tell the assistant when it returns.",
                "href": "/dashboard/settings",
                "data": {"item_id": item["id"], "customers": len(convs)}})
    picked: List[str] = []
    ranked = sorted(((p, c) for p, c in by_phrase.items() if len(c) >= need),
                    key=lambda pc: (-len(pc[1]), -len(pc[0].split()), pc[0]))
    for phrase, convs in ranked:
        words = set(phrase.split())
        if any(words & set(other.split()) for other in picked):
            continue  # one alert per thing ("black abaya", not also "abaya")
        picked.append(phrase)
        out.append({
            "rule": "demand_unavailable", "subject": "ask:" + phrase,
            "count": len(convs), "conversation_id": None,
            "title": _plural(len(convs), "customer") + " asked for \"" + phrase
                     + "\" - not in your catalog",
            "detail": "Asked in the last " + window + ". Add it to the catalog if"
                      " you sell it, or a knowledge answer if you don't.",
            "href": "/dashboard/settings",
            "data": {"phrase": phrase, "customers": len(convs)}})
        if len(picked) >= MAX_PHRASES:
            break
    return out


def detect_repeat(msgs: List[Dict[str, Any]], params: Dict[str, Any]) -> List[Dict[str, Any]]:
    hours, need = params["window_hours"], params["min_times"]
    ages: Dict[int, List[float]] = {}
    for message in _within(msgs, hours):
        if _trouble(message):
            ages.setdefault(message["conv"], []).append(message["age"])
    out = []
    for conv, values in ages.items():
        times, last = 0, None
        for age in sorted(values, reverse=True):  # oldest first
            if last is None or (last - age) * 60 >= EPISODE_GAP_MINUTES:
                times += 1
                last = age
        if times >= need:
            out.append({
                "rule": "repeat_complainer", "subject": "conv:" + str(conv),
                "count": times, "conversation_id": conv,
                "title": "A customer complained " + str(times) + " separate times in "
                         + _plural(hours, "hour"),
                "detail": "Complaint or return messages on " + str(times)
                          + " occasions. Open the chat and reply personally.",
                "href": "/dashboard/conversations/" + str(conv),
                "data": {"times": times}})
    return out


def detect_product_complaints(msgs: List[Dict[str, Any]], items: List[Dict[str, Any]],
                              params: Dict[str, Any]) -> List[Dict[str, Any]]:
    hours, need = params["window_hours"], params["min_customers"]
    by_item: Dict[int, set] = {}
    for message in _within(msgs, hours):
        if not _trouble(message):
            continue
        hit = _match(message["text"], items, 1)
        if hit:
            by_item.setdefault(hit[0]["id"], set()).add(message["conv"])
    out = []
    for item in items:
        convs = by_item.get(item["id"]) or set()
        if len(convs) >= need:
            out.append({
                "rule": "product_complaints", "subject": "item:" + str(item["id"]),
                "count": len(convs), "conversation_id": None,
                "title": _plural(len(convs), "customer") + " complained about " + item["name"],
                "detail": "Complaints or return requests in the last " + _plural(hours, "hour")
                          + ". Check this product's quality, photos and description.",
                "href": "/dashboard/conversations",
                "data": {"item_id": item["id"], "customers": len(convs)}})
    return out


def detect_spike(msgs: List[Dict[str, Any]], params: Dict[str, Any],
                 coverage_hours: float) -> List[Dict[str, Any]]:
    """Last 24h vs the average day before it. Only days the data fully
    covers count (a new workspace or a capped read never fakes a spike)."""
    days = min(SPIKE_BASELINE_DAYS, int((coverage_hours - SPIKE_HOURS) // 24))
    if days < SPIKE_MIN_BASELINE_DAYS:
        return []
    trouble = [m for m in msgs if _trouble(m)]
    today = sum(1 for m in trouble if m["age"] < SPIKE_HOURS)
    before = sum(1 for m in trouble if SPIKE_HOURS <= m["age"] < SPIKE_HOURS + 24 * days)
    usual = before / days
    if today < params["min_count"] or today < params["factor"] * max(usual, 1.0):
        return []
    return [{
        "rule": "complaint_spike", "subject": "all", "count": today, "conversation_id": None,
        "title": "Complaints spiked: " + str(today) + " in the last 24 hours",
        "detail": "Usually about " + ("%.1f" % usual).rstrip("0").rstrip(".") + " a day (last "
                  + _plural(days, "day") + "). Check deliveries, stock and recent changes first.",
        "href": "/dashboard/conversations",
        "data": {"today": today, "usual_per_day": round(usual, 2), "baseline_days": days}}]


def evaluate(settings: Dict[str, Any], msgs: List[Dict[str, Any]],
             items: List[Dict[str, Any]], coverage_hours: float) -> List[Dict[str, Any]]:
    rules = settings["rules"]
    out: List[Dict[str, Any]] = []
    if rules["demand_unavailable"]["enabled"]:
        out += detect_demand(msgs, items, rules["demand_unavailable"])
    if rules["repeat_complainer"]["enabled"]:
        out += detect_repeat(msgs, rules["repeat_complainer"])
    if rules["product_complaints"]["enabled"]:
        out += detect_product_complaints(msgs, items, rules["product_complaints"])
    if rules["complaint_spike"]["enabled"]:
        out += detect_spike(msgs, rules["complaint_spike"], coverage_hours)
    for item in out:
        item["severity"] = RULES[item["rule"]]["severity"]
        item["cooldown_hours"] = rules[item["rule"]].get("window_hours", SPIKE_HOURS)
    out.sort(key=lambda c: (c["severity"] != "high", -c["count"], c["rule"], c["subject"]))
    return out


def fetch_hours(settings: Dict[str, Any]) -> int:
    rules = settings["rules"]
    hours = [rules[k]["window_hours"] for k in RULE_KEYS
             if rules[k]["enabled"] and "window_hours" in rules[k]]
    if rules["complaint_spike"]["enabled"]:
        hours.append(SPIKE_HOURS * (SPIKE_BASELINE_DAYS + 1))
    return max(hours) if hours else 0


# ---------------------------------------------------------------------------
# Data + run
# ---------------------------------------------------------------------------

def _topics(text: str) -> set:
    try:
        import portal_bi

        return set(portal_bi.topics_for(text))
    except Exception:
        return set()


def gather(cur, client_id: int, hours: int) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], float]:
    """(inbound messages newest first, catalog items, hours the read covers)."""
    import portal_sales

    cur.execute(
        "SELECT conversation_id, body, EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600.0 AS age"
        " FROM " + portal_db._q(MESSAGES_TABLE) +
        " WHERE client_id = %s AND " + INBOUND_SQL +
        " AND created_at > NOW() - (%s * INTERVAL '1 hour') AND COALESCE(body, '') <> ''"
        " ORDER BY created_at DESC LIMIT %s",
        (client_id, hours, MAX_MESSAGES))
    msgs = []
    for row in portal_db.rows(cur):
        if not row.get("conversation_id"):
            continue
        text = str(row.get("body") or "")[:MAX_TEXT]
        msgs.append({"conv": int(row["conversation_id"]), "text": text,
                     "age": max(0.0, float(row.get("age") or 0)), "topics": _topics(text)})
    items: List[Dict[str, Any]] = []
    try:
        with portal_txn.savepoint(cur, None, "of_proactive_catalog") as guard:
            if _exists(cur, CATALOG_TABLE):
                cur.execute(
                    "SELECT id, name, is_active FROM " + portal_db._q(CATALOG_TABLE) +
                    " WHERE client_id = %s ORDER BY is_active DESC, id DESC LIMIT %s",
                    (client_id, CATALOG_MAX))
                for row in portal_db.rows(cur):
                    name = " ".join(str(row.get("name") or "").split())[:120]
                    if not name:
                        continue
                    tokens = [t for t in portal_sales._TOKEN_RE.findall(name.lower())
                              if t not in portal_sales._STOP]
                    items.append({"id": int(row["id"]), "name": name,
                                  "active": row.get("is_active") is not False,
                                  "_tokens": tokens})
        if guard.failed:
            items = []
    except Exception as error:
        logger.info("proactive catalog read skipped: %s", error)
        items = []
    coverage = max((m["age"] for m in msgs), default=0.0)
    return msgs, items, coverage


def _contact_names(cur, client_id: int, conv_ids: List[int]) -> Dict[int, str]:
    if not conv_ids:
        return {}
    try:
        with portal_txn.savepoint(cur, None, "of_proactive_names") as guard:
            cur.execute(
                "SELECT id, contact_name FROM " + portal_db._q(portal_db.CONV_TABLE) +
                " WHERE client_id = %s AND id = ANY(%s)", (client_id, conv_ids))
            found = {int(r["id"]): _CTRL_RE.sub("", " ".join(
                str(r.get("contact_name") or "").split()))[:MAX_NAME]
                for r in portal_db.rows(cur)}
        return {} if guard.failed else found
    except Exception as error:
        logger.info("proactive names skipped: %s", error)
        return {}


def _cooling(cur, client_id: int, candidate: Dict[str, Any]) -> bool:
    cur.execute(
        "SELECT 1 AS hit FROM " + portal_db._q(EVENTS_TABLE) +
        " WHERE client_id = %s AND rule = %s AND subject = %s"
        " AND created_at > NOW() - (%s * INTERVAL '1 hour') LIMIT 1",
        (client_id, candidate["rule"], candidate["subject"], candidate["cooldown_hours"]))
    return bool(portal_db.rows(cur))


def run(client_id: int, manual: bool = False) -> Dict[str, Any]:
    """One check for one workspace (own connection). Never raises."""
    result: Dict[str, Any] = {"ran": False, "reason": "", "checked": 0, "alerts": []}
    if not ENABLED:
        result["reason"] = "off"
        return result
    fresh: List[Dict[str, Any]] = []
    conn = None
    try:
        conn = portal_db._conn()
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            conn.commit()  # tables stay even when this run rolls back
            settings = load_settings(cur, client_id)
            if not settings["enabled"]:
                conn.rollback()
                result["reason"] = "disabled"
                return result
            cur.execute("SELECT pg_try_advisory_xact_lock(%s, %s) AS ok",
                        (LOCK_CLASS, client_id % 2147483647))
            row = cur.fetchone()
            if not (row.get("ok") if isinstance(row, dict) else (row and row[0])):
                conn.rollback()
                result["reason"] = "busy"
                return result
            if not manual:
                cur.execute(
                    "SELECT 1 AS hit FROM " + portal_db._q(SETTINGS_TABLE) +
                    " WHERE client_id = %s AND last_run_at > NOW() - (%s * INTERVAL '1 minute')",
                    (client_id, EVERY_MINUTES))
                if portal_db.rows(cur):
                    conn.rollback()
                    result["reason"] = "recent"
                    return result
            hours = fetch_hours(settings)
            msgs, items, coverage = gather(cur, client_id, hours) if hours else ([], [], 0.0)
            result["checked"] = len(msgs)
            candidates = evaluate(settings, msgs, items, coverage)
            fresh = [c for c in candidates if not _cooling(cur, client_id, c)][:MAX_ALERTS]
            names = _contact_names(cur, client_id, [c["conversation_id"] for c in fresh
                                                    if c["conversation_id"]])
            for item in fresh:
                name = names.get(item["conversation_id"] or 0)
                if item["rule"] == "repeat_complainer" and name:
                    item["title"] = name + item["title"][len("A customer"):]
                item["title"] = item["title"][:MAX_TITLE]
                cur.execute(
                    "INSERT INTO " + portal_db._q(EVENTS_TABLE) +
                    " (client_id, rule, subject, severity, title, detail, href,"
                    " conversation_id, data) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)"
                    " RETURNING id, rule, severity, title, detail, href, conversation_id, created_at",
                    (client_id, item["rule"], item["subject"][:200], item["severity"],
                     item["title"], item["detail"], item["href"], item["conversation_id"],
                     json.dumps(item["data"])))
                item["event"] = _shape_event(portal_db.rows(cur)[0])
                try:
                    with portal_txn.savepoint(cur, conn, "of_proactive_log"):
                        portal_db.log_action(cur, client_id, "proactive." + item["rule"],
                                             "system", None, item["conversation_id"],
                                             item["title"])
                except Exception as error:
                    logger.info("proactive event log skipped: %s", error)
            cur.execute(
                "INSERT INTO " + portal_db._q(SETTINGS_TABLE) +
                " (client_id, last_run_at) VALUES (%s, NOW())"
                " ON CONFLICT (client_id) DO UPDATE SET last_run_at = NOW()", (client_id,))
        conn.commit()
        result["ran"] = True
    except Exception as error:
        logger.warning("proactive run failed: %s", error)
        result["reason"] = "error"
        fresh = []
        try:
            if conn is not None:
                conn.rollback()
        except Exception:
            pass
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
    for item in fresh:
        result["alerts"].append(item["event"])
        try:
            import portal_notify

            portal_notify.notify(
                client_id, NOTIFY_KIND, item["title"], item["detail"], item["severity"],
                dedupe_key="proactive:" + item["rule"] + ":" + item["subject"][:120],
                conversation_id=item["conversation_id"])
        except Exception as error:
            logger.warning("proactive notify failed: %s", error)
    return result


def _job(client_id: int) -> None:
    try:
        run(client_id)
    finally:
        with _LOCK:
            _RUNNING.discard(client_id)


def kick(client_id: Any) -> bool:
    """Connector-tick hook: start a background check for the workspace, at
    most once per OF_PROACTIVE_EVERY_MINUTES per process and one at a time
    (run() re-checks last_run_at in the database). True = started."""
    if not ENABLED:
        return False
    try:
        client_id = int(client_id or 0)
    except Exception:
        return False
    if client_id <= 0:
        return False
    now = time.monotonic()
    with _LOCK:
        if client_id in _RUNNING or now - _LAST.get(client_id, -1e18) < EVERY_MINUTES * 60:
            return False
        _RUNNING.add(client_id)
        _LAST[client_id] = now
    try:
        threading.Thread(target=_job, args=(client_id,),
                         name="proactive-" + str(client_id), daemon=True).start()
    except Exception:
        with _LOCK:
            _RUNNING.discard(client_id)
        return False
    return True


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

DOWN = {"error": {"code": "portal_unavailable",
                  "message": "Proactive alerts are unavailable right now."}}


def _human_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": str(error)}}), 503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}), 401)
    forbidden = ensure_human_principal(principal)
    if forbidden:
        return None, forbidden
    return principal, None


def _can_edit(principal: Dict[str, Any]) -> bool:
    import portal_notify

    return portal_notify.can_edit(principal)


def _payload(settings: Dict[str, Any], recent: List[Dict[str, Any]],
             principal: Dict[str, Any]) -> Dict[str, Any]:
    return {"enabled": settings["enabled"], "available": ENABLED,
            "rules": public_rules(settings["rules"]), "recent": recent,
            "last_run_at": settings["last_run_at"], "every_minutes": EVERY_MINUTES,
            "can_edit": _can_edit(principal)}


@bp.get("/proactive")
def get_proactive():
    """Settings + rule registry + recent alerts (read-only)."""
    principal, error = _human_or_error()
    if error:
        return error
    client_id = int(principal["client_id"])
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                settings = load_settings(cur, client_id)
                recent = recent_events(cur, client_id)
        finally:
            try:
                conn.rollback()
            finally:
                conn.close()
    except Exception as error:
        logger.warning("proactive read failed: %s", error)
        return jsonify(DOWN), 503
    return jsonify(_payload(settings, recent, principal)), 200


@bp.put("/proactive")
def put_proactive():
    principal, error = _human_or_error()
    if error:
        return error
    if not _can_edit(principal):
        return jsonify({"error": {"code": "forbidden", "message":
                                  "Only owners and admins can change proactive alerts."}}), 403
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "A JSON object is required."}}), 400
    client_id = int(principal["client_id"])
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                conn.commit()  # a refused change must not roll the tables back
                current = load_settings(cur, client_id)
                merged, problem = validate_settings(payload, current)
                if merged is None:
                    conn.rollback()
                    return jsonify({"error": {"code": "bad_request", "message": problem}}), 400
                save_settings(cur, client_id, merged)
                on = [RULES[k]["label"] for k in RULE_KEYS if merged["rules"][k]["enabled"]]
                portal_db.log_action(
                    cur, client_id, "proactive_settings.saved", "customer_user",
                    principal.get("user_id"), None,
                    ("On" if merged["enabled"] else "Off") + "; rules on: "
                    + (", ".join(on) if on else "none"))
                settings = load_settings(cur, client_id)
                recent = recent_events(cur, client_id)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("proactive save failed: %s", error)
        return jsonify(DOWN), 503
    return jsonify(dict(_payload(settings, recent, principal), ok=True)), 200


@bp.post("/proactive/run")
def run_proactive():
    """Check now (synchronous; skips only the every-N-minutes wait)."""
    principal, error = _human_or_error()
    if error:
        return error
    if not ENABLED:
        return jsonify({"error": {"code": "disabled", "message":
                                  "Proactive alerts are turned off on this server."}}), 409
    result = run(int(principal["client_id"]), manual=True)
    if result["reason"] == "disabled":
        return jsonify({"error": {"code": "disabled", "message":
                                  "Turn proactive alerts on first."}}), 409
    if result["reason"] == "busy":
        return jsonify({"error": {"code": "busy", "message":
                                  "A check is already running. Try again in a moment."}}), 409
    if not result["ran"]:
        return jsonify(DOWN), 503
    return jsonify({"ok": True, "checked": result["checked"], "alerts": result["alerts"]}), 200
