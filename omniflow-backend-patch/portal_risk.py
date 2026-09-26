"""COD intelligence + address intelligence (V2 B9).

One module, two jobs, everything deterministic and owner-facing:

* RTO SCORE (0-100) - the risk a COD parcel comes back uncollected.
  Pure math over the tenant's own data (portal_checkout_links statuses
  delivered/returned, portal_cod_requests confirm times, an optional
  owner-curated city table) - no LLM anywhere in the score. Every
  point is explained: the response carries a factors list
  [{key, points, note}] so the owner sees the WHY, not just the
  number. Bands vs the configurable threshold (portal_risk_settings):
    score <  threshold-20  -> proceed
    score <  threshold     -> collect_advance
    score >= threshold     -> hold  (+ a staff task when staff_tasks
                              is on; ADVISORY-ONLY by default, which
                              is also the rollback switch)

* ADDRESS INTELLIGENCE - normalize_address() cleans free-text
  Pakistani addresses (whitespace/commas, common abbreviations),
  extracts the phone number and the city (built-in city list +
  the tenant's own city table), lists what is missing and generates
  the exact Roman-Urdu questions to ask the customer - the ask flow
  the owner (or a future automation) can send verbatim.

All endpoints are human-only (API keys get 403).
"""

import json
import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_db
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
)

logger = logging.getLogger("omniflow.portal-risk")

bp = Blueprint("portal_risk", __name__, url_prefix="/api/v1/portal")

SETTINGS_TABLE = "portal_risk_settings"
CITY_TABLE = "portal_city_rates"
TASKS_TABLE = "portal_risk_tasks"

DEFAULT_SETTINGS: Dict[str, Any] = {
    "score_threshold": 70,
    "staff_tasks": False,
    "city_default_pct": 30,
}

#: Cities recognised inside free-text addresses (lowercase fragments).
KNOWN_CITIES = (
    "karachi", "lahore", "islamabad", "rawalpindi", "faisalabad",
    "multan", "peshawar", "quetta", "sialkot", "gujranwala",
    "hyderabad", "sukkur", "bahawalpur", "sahiwal", "sargodha",
    "abbottabad", "mardan", "mirpur", "gujrat", "jhang", "kasur",
    "rahim yar khan", "okara", "wah cant", "taxila", "larkana",
    "muzaffarabad", "dera ghazi khan", "sheikhupura", "nowshera",
)

PHONE_RE = re.compile(r"(?:\+?92[\-\s]?|0)3\d{2}[\-\s]?\d{7}")

_DDL_READY = False

_DDL = """
CREATE TABLE IF NOT EXISTS portal_risk_settings (
  client_id BIGINT PRIMARY KEY,
  score_threshold INTEGER NOT NULL DEFAULT 70,
  staff_tasks BOOLEAN NOT NULL DEFAULT FALSE,
  city_default_pct INTEGER NOT NULL DEFAULT 30,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS portal_city_rates (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  city TEXT NOT NULL,
  return_pct INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, city)
);
CREATE TABLE IF NOT EXISTS portal_risk_tasks (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  contact_id TEXT NOT NULL,
  conversation_id BIGINT,
  score INTEGER NOT NULL,
  factors JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_risk_tasks
  ON portal_risk_tasks (client_id, status, id DESC);
"""


def _ensure_ddl(cur) -> None:
    """Create the risk tables once per process (lazy DDL)."""
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    _DDL_READY = True


def _principal_or_error():
    """Owner/staff session required (API keys cannot touch risk)."""
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": str(error)}}), 503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}),
                      401)
    if principal.get("via_api_key"):
        return None, (jsonify({"error": {"code": "forbidden",
                                         "message": "Owner sign-in required."}}),
                      403)
    return principal, None


# ---------------------------------------------------------------------------
# Settings + city rates
# ---------------------------------------------------------------------------

def _load_settings(cur, client_id: int) -> Dict[str, Any]:
    cur.execute(
        "SELECT score_threshold, staff_tasks, city_default_pct FROM " +
        portal_db._q(SETTINGS_TABLE) + " WHERE client_id = %s",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    if not rows:
        return dict(DEFAULT_SETTINGS)
    return {"score_threshold":
            int(rows[0].get("score_threshold")
                or DEFAULT_SETTINGS["score_threshold"]),
            "staff_tasks": bool(rows[0].get("staff_tasks")),
            "city_default_pct":
            int(rows[0].get("city_default_pct")
                or DEFAULT_SETTINGS["city_default_pct"])}


def _load_city_pct(cur, client_id: int, city: str,
                   settings: Dict[str, Any]) -> Optional[int]:
    """The owner's return-rate for a city (None when unknown)."""
    city = (city or "").strip().lower()
    if not city:
        return None
    cur.execute(
        "SELECT return_pct FROM " + portal_db._q(CITY_TABLE) +
        " WHERE client_id = %s AND city = %s LIMIT 1",
        (client_id, city),
    )
    rows = portal_db.rows(cur)
    if rows:
        return int(rows[0].get("return_pct") or 0)
    return None


def _replace_cities(cur, client_id: int,
                    cities: List[Dict[str, Any]]) -> int:
    """Full replace of the tenant's city table (kept small by design)."""
    cur.execute("DELETE FROM " + portal_db._q(CITY_TABLE) +
                " WHERE client_id = %s", (client_id,))
    count = 0
    for entry in cities[:50]:
        name = str(entry.get("city") or "").strip().lower()[:40]
        try:
            pct = int(entry.get("return_pct"))
        except (TypeError, ValueError):
            continue
        if not name or not 0 <= pct <= 100:
            continue
        cur.execute(
            "INSERT INTO " + portal_db._q(CITY_TABLE) +
            " (client_id, city, return_pct) VALUES (%s, %s, %s)"
            " ON CONFLICT (client_id, city) DO NOTHING",
            (client_id, name, pct),
        )
        count += 1
    return count


# ---------------------------------------------------------------------------
# RTO scoring (pure math + explicit factors = the WHY)
# ---------------------------------------------------------------------------

def build_history(cur, client_id: int,
                  contact_id: str) -> Dict[str, Any]:
    """Delivered/returned/value history + COD confirm speed."""
    out: Dict[str, Any] = {"delivered": 0, "returned": 0, "cancelled": 0,
                           "open": 0, "avg_value": 0.0,
                           "confirm_hours": None}
    contact_id = (contact_id or "").strip()
    if not contact_id:
        return out
    cur.execute(
        "SELECT status, COUNT(*) AS n, COALESCE(AVG(total), 0) AS avg_total"
        " FROM " + portal_db._q("portal_checkout_links") +
        " WHERE client_id = %s AND contact_id = %s"
        " GROUP BY status",
        (client_id, contact_id),
    )
    counts: Dict[str, int] = {}
    values: Dict[str, float] = {}
    for row in portal_db.rows(cur):
        status = str(row.get("status") or "")
        counts[status] = int(row.get("n") or 0)
        values[status] = float(row.get("avg_total") or 0)
    out["delivered"] = counts.get("delivered", 0)
    out["returned"] = counts.get("returned", 0)
    out["cancelled"] = counts.get("cancelled", 0)
    out["open"] = counts.get("open", 0)
    known = [values[s] for s in ("delivered", "returned")
             if counts.get(s)]
    out["avg_value"] = round(sum(known) / len(known), 2) if known else 0.0
    cur.execute(
        "SELECT created_at, answered_at FROM " +
        portal_db._q("portal_cod_requests") +
        " WHERE client_id = %s AND contact_id = %s"
        " ORDER BY id DESC LIMIT 3",
        (client_id, contact_id),
    )
    hours: List[float] = []
    for row in portal_db.rows(cur):
        created = row.get("created_at")
        answered = row.get("answered_at")
        if created is None or answered is None:
            continue
        try:
            delta = (answered - created).total_seconds() / 3600.0
        except (TypeError, AttributeError):
            continue
        if 0 <= delta < 24 * 30:
            hours.append(delta)
    out["confirm_hours"] = round(sum(hours) / len(hours), 1) if hours \
        else None
    return out


def compute_risk(history: Dict[str, Any], settings: Dict[str, Any],
                 city_pct: Optional[int],
                 order_total: float = 0.0) -> Tuple[int, List[Dict[str, Any]],
                                                    str]:
    """Deterministic 0-100 score with a full WHY breakdown."""
    factors: List[Dict[str, Any]] = []
    score = 35
    factors.append({"key": "base", "points": 35,
                    "note": "starting point for every COD parcel"})

    delivered = int(history.get("delivered") or 0)
    returned = int(history.get("returned") or 0)
    if delivered + returned == 0:
        score += 10
        factors.append({"key": "new_customer", "points": 10,
                        "note": "no delivered or returned orders yet"})
    else:
        ratio = returned / float(delivered + returned)
        points = int(round(ratio * 30))
        score += points
        factors.append({"key": "return_history", "points": points,
                        "note": str(returned) + " returned of "
                                + str(delivered + returned) + " finished"
                                " orders"})

    pct = city_pct if city_pct is not None else \
        int(settings.get("city_default_pct") or 0)
    points = int(round(pct * 0.25))
    score += points
    factors.append({"key": "city_rate", "points": points,
                    "note": ("city return rate " + str(pct) + "%"
                             if city_pct is not None
                             else "city unknown - default "
                                  + str(pct) + "% assumed")})

    total = float(order_total or history.get("avg_value") or 0)
    if total >= 50000:
        score += 12
        factors.append({"key": "order_value", "points": 12,
                        "note": "high value order (" + str(int(total))
                                + ")"})
    elif total >= 20000:
        score += 8
        factors.append({"key": "order_value", "points": 8,
                        "note": "above-average order (" + str(int(total))
                                + ")"})

    hours = history.get("confirm_hours")
    if hours is None:
        score += 5
        factors.append({"key": "confirm_speed", "points": 5,
                        "note": "no COD confirmation history"})
    elif hours < 2:
        score -= 5
        factors.append({"key": "confirm_speed", "points": -5,
                        "note": "replies fast (" + str(hours) + "h avg)"})
    elif hours <= 24:
        factors.append({"key": "confirm_speed", "points": 0,
                        "note": "normal confirm time ("
                                + str(hours) + "h avg)"})
    elif hours <= 48:
        score += 8
        factors.append({"key": "confirm_speed", "points": 8,
                        "note": "slow to confirm (" + str(hours)
                                + "h avg)"})
    else:
        score += 12
        factors.append({"key": "confirm_speed", "points": 12,
                        "note": "very slow to confirm (" + str(hours)
                                + "h avg)"})

    score = max(0, min(100, score))
    threshold = int(settings.get("score_threshold") or 70)
    if score >= threshold:
        recommendation = "hold"
    elif score >= threshold - 20:
        recommendation = "collect_advance"
    else:
        recommendation = "proceed"
    return score, factors, recommendation


# ---------------------------------------------------------------------------
# Address intelligence (normalize + missing-detection ask flow)
# ---------------------------------------------------------------------------

_ABBREVIATIONS = (
    ("h.no", "house no"), ("h no", "house no"), ("hno", "house no"),
    ("house#", "house no"), ("#", "house no "),
    ("blk", "block"), ("sec", "sector"), ("soc", "society"),
    ("moh", "mohallah"), ("rd", "road"), ("st", "street"),
)


def normalize_address(text: str,
                      extra_cities: Optional[List[str]] = None
                      ) -> Dict[str, Any]:
    """Clean one free-text address and derive the ask-flow prompts."""
    raw = str(text or "").strip()
    compact = re.sub(r"[\u200b]", "", raw)
    compact = re.sub(r"\s*,\s*", ", ", compact)
    compact = re.sub(r"(, )+", ", ", compact)
    compact = re.sub(r"\s+", " ", compact)

    phone = PHONE_RE.search(compact)
    phone = phone.group(0) if phone else None
    body = compact.replace(phone, "") if phone else compact
    body = re.sub(r"\s+", " ", body).strip(" ,.-")

    lowered = body.lower()
    for src, dst in _ABBREVIATIONS:
        lowered = re.sub(r"(?<![a-z])" + re.escape(src) + r"(?![a-z])",
                         dst, lowered)
    lowered = re.sub(r"\s+", " ", lowered).strip(" ,.-")

    cities = list(KNOWN_CITIES) + [c.lower() for c in (extra_cities or [])]
    city = None
    for candidate in cities:
        if candidate and re.search(r"(?<![a-z])" + re.escape(candidate)
                                   + r"(?![a-z])", lowered):
            city = candidate
            break

    issues: List[str] = []
    prompts: List[str] = []
    if not lowered:
        issues.append("empty")
        prompts.append("Apna poora pata bhej dein - house/street, area"
                       " aur city?")
    else:
        if not re.search(r"\d", lowered):
            issues.append("no_house_number")
            prompts.append("House ya street ka number bhi bata dein?")
        if len(lowered) < 15:
            issues.append("too_short")
            prompts.append("Thora detail me pata dein - area aur nearest"
                           " landmark ke sath?")
        if city is None:
            issues.append("no_city")
            prompts.append("Aap kis city me hain? Delivery ke liye zaroori"
                           " he.")
        if phone is None:
            issues.append("no_phone")
            prompts.append("Koi dusra contact number bhi de dein?")
    return {"normalized": lowered, "city": city, "phone": phone,
            "issues": issues, "ask_prompts": prompts}


# ---------------------------------------------------------------------------
# Owner API
# ---------------------------------------------------------------------------

@bp.get("/risk/score")
def get_risk_score():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    contact = (request.args.get("contact") or "").strip()[:100]
    if not contact:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contact is required."}}), 400
    try:
        total = round(float(request.args.get("total") or 0), 2)
    except (TypeError, ValueError):
        total = 0.0
    address = request.args.get("address") or ""
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            settings = _load_settings(cur, client_id)
            history = build_history(cur, client_id, contact)
            city = None
            if address:
                city = normalize_address(address).get("city")
            city_pct = _load_city_pct(cur, client_id, city or "",
                                      settings) if city else None
            score, factors, recommendation = compute_risk(
                history, settings, city_pct, total)
            task_created = False
            if (recommendation == "hold" and settings["staff_tasks"]):
                cur.execute(
                    "SELECT 1 FROM " + portal_db._q(TASKS_TABLE) +
                    " WHERE client_id = %s AND contact_id = %s"
                    " AND status = 'open' LIMIT 1",
                    (client_id, contact),
                )
                if not portal_db.rows(cur):
                    cur.execute(
                        "INSERT INTO " + portal_db._q(TASKS_TABLE) +
                        " (client_id, contact_id, score, factors)"
                        " VALUES (%s, %s, %s, CAST(%s AS JSONB))",
                        (client_id, contact, score,
                         json.dumps(factors)),
                    )
                    portal_db.log_action(
                        cur, client_id, "risk.task", "automation", None,
                        None,
                        ("Staff task: RTO " + str(score)
                         + " for " + contact), 
                    )
                    task_created = True
            cur.execute(
                "SELECT return_pct FROM " + portal_db._q(CITY_TABLE) +
                " WHERE client_id = %s ORDER BY city LIMIT 50",
                (client_id,),
            )
            cities = portal_db.rows(cur)
        conn.commit()
    finally:
        conn.close()
    return jsonify({"score": score, "factors": factors,
                    "recommendation": recommendation,
                    "threshold": settings["score_threshold"],
                    "task_created": task_created,
                    "city_rates": cities}), 200


@bp.get("/risk/settings")
def get_risk_settings():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            settings = _load_settings(cur, int(principal["client_id"]))
            cur.execute(
                "SELECT city, return_pct FROM " +
                portal_db._q(CITY_TABLE) +
                " WHERE client_id = %s ORDER BY city LIMIT 50",
                (int(principal["client_id"]),),
            )
            cities = portal_db.rows(cur)
        conn.commit()
    finally:
        conn.close()
    return jsonify({"settings": settings, "city_rates": cities}), 200


@bp.put("/risk/settings")
def put_risk_settings():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    payload = request.get_json(silent=True) or {}
    try:
        threshold = int(payload.get("score_threshold"))
    except (TypeError, ValueError):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "score_threshold (integer)"
                                             " is required."}}), 400
    staff = payload.get("staff_tasks")
    if not isinstance(staff, bool):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "staff_tasks (boolean) is"
                                             " required."}}), 400
    try:
        city_default = int(payload.get("city_default_pct")
                           or DEFAULT_SETTINGS["city_default_pct"])
    except (TypeError, ValueError):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "city_default_pct must be"
                                             " a number."}}), 400
    threshold = max(50, min(95, threshold))
    city_default = max(0, min(100, city_default))
    cities = payload.get("city_rates")
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "INSERT INTO " + portal_db._q(SETTINGS_TABLE) +
                " (client_id, score_threshold, staff_tasks,"
                " city_default_pct, updated_at)"
                " VALUES (%s, %s, %s, %s, NOW())"
                " ON CONFLICT (client_id) DO UPDATE SET"
                " score_threshold = EXCLUDED.score_threshold,"
                " staff_tasks = EXCLUDED.staff_tasks,"
                " city_default_pct = EXCLUDED.city_default_pct,"
                " updated_at = NOW()",
                (client_id, threshold, staff, city_default),
            )
            replaced = 0
            if isinstance(cities, list):
                replaced = _replace_cities(cur, client_id, cities)
            portal_db.log_action(
                cur, client_id, "risk.settings", "human", None, None,
                ("Threshold " + str(threshold) + ", tasks "
                 + ("on" if staff else "off"))[:200],
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"settings": {"score_threshold": threshold,
                                 "staff_tasks": staff,
                                 "city_default_pct": city_default},
                    "cities_saved": replaced if isinstance(cities, list)
                    else None}), 200


@bp.get("/risk/tasks")
def list_risk_tasks():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "SELECT id, contact_id, conversation_id, score, factors,"
                " status, created_at FROM " + portal_db._q(TASKS_TABLE) +
                " WHERE client_id = %s AND status = 'open'"
                " ORDER BY id DESC LIMIT 20",
                (client_id,),
            )
            rows = portal_db.rows(cur)
        conn.commit()
    finally:
        conn.close()
    tasks = [{"id": int(r.get("id") or 0),
              "contact_id": str(r.get("contact_id") or ""),
              "conversation_id": r.get("conversation_id"),
              "score": int(r.get("score") or 0),
              "factors": r.get("factors") or [],
              "created_at": None if r.get("created_at") is None
              else str(r.get("created_at"))} for r in rows]
    return jsonify({"tasks": tasks}), 200


@bp.post("/risk/tasks")
def complete_risk_task():
    """Mark one staff task done ({\"id\": N})."""
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    payload = request.get_json(silent=True) or {}
    try:
        task_id = int(payload.get("id") or 0)
    except (TypeError, ValueError):
        task_id = 0
    if task_id <= 0:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "id is required."}}), 400
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "UPDATE " + portal_db._q(TASKS_TABLE) +
                " SET status = 'done', updated_at = NOW()"
                " WHERE id = %s AND client_id = %s AND status = 'open'"
                " RETURNING id",
                (task_id, client_id),
            )
            ok = bool(portal_db.rows(cur))
        conn.commit()
    finally:
        conn.close()
    if not ok:
        return jsonify({"error": {"code": "not_found",
                                  "message": "No open task with that"
                                             " id."}}), 404
    return jsonify({"ok": True}), 200


@bp.post("/address/normalize")
def normalize_address_route():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    payload = request.get_json(silent=True) or {}
    address = str(payload.get("address") or "")
    if not address.strip():
        return jsonify({"error": {"code": "bad_request",
                                  "message": "address is required."}}), 400
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "SELECT city FROM " + portal_db._q(CITY_TABLE) +
                " WHERE client_id = %s LIMIT 50",
                (int(principal["client_id"]),),
            )
            extra = [str(r.get("city") or "") for r in portal_db.rows(cur)]
        conn.commit()
    finally:
        conn.close()
    return jsonify(normalize_address(address, extra)), 200
