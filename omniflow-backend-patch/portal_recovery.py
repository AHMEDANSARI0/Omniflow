"""Revenue recovery + bounded negotiation + AI copy-gen (V2 B8).

Three revenue tools in one slim module, all owner-facing:

* RECOVERY - a deterministic scan finds money left on the table:
  abandoned checkout links (open too long), unconfirmed COD requests,
  price objections (recent "mehnga / discount / kam kar do" messages
  with no follow-up) and inactive high-value buyers. Detections land in
  portal_recovery_queue (deduped by UNIQUE(kind, ref_key)); the owner
  sends a ready-made Roman-Urdu follow-up per item or dismisses it.
  With auto_enabled the scan queues the follow-up itself the moment a
  detection is new - one follow-up per item, ever (status open ->
  contacted), never an LLM, always this module's fixed copy.

* NEGOTIATION - the owner sets the bounds (portal_negotiation_settings:
  min_price + max_discount_pct). The floor is COMPUTED, never asked:
  floor = max(min_price, price * (1 - pct/100)). The decision engine is
  deterministic (accept / counter at the floor / reject); the LLM only
  PHRASES the counter message, and its text is rejected unless it
  contains the exact counter price. Every round is logged in
  portal_negotiation_rounds.

* COPY-GEN - broadcast copy in ur / roman / en, two variants per call.
  Without an LLM key it falls back to fixed templates per language, so
  the feature always works. It returns TEXT ONLY - the owner edits and
  sends it through the normal broadcast flow (edit-before-send).

All endpoints are human-only (API keys get 403). The scan is lazy: it
runs when the dashboard asks for the recovery list - no background
worker, no new poll loop.
"""

import json
import logging
import os
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_db
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
)

logger = logging.getLogger("omniflow.portal-recovery")

bp = Blueprint("portal_recovery", __name__, url_prefix="/api/v1/portal")

QUEUE_TABLE = "portal_recovery_queue"
SETTINGS_TABLE = "portal_recovery_settings"
NEG_SETTINGS_TABLE = "portal_deal_settings"
NEG_ROUNDS_TABLE = "portal_deal_rounds"

COPY_LANGS = ("ur", "roman", "en")
MAX_COPY_CHARS = 600

_DDL_READY = False

_DDL = """
CREATE TABLE IF NOT EXISTS portal_recovery_queue (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  kind TEXT NOT NULL,
  ref_key TEXT NOT NULL,
  contact_id TEXT NOT NULL DEFAULT '',
  conversation_id BIGINT,
  priority INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'open',
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, kind, ref_key)
);
CREATE INDEX IF NOT EXISTS idx_portal_recovery_queue
  ON portal_recovery_queue (client_id, status, priority, id DESC);
CREATE TABLE IF NOT EXISTS portal_recovery_settings (
  client_id BIGINT PRIMARY KEY,
  auto_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  checkout_hours INTEGER NOT NULL DEFAULT 24,
  cod_hours INTEGER NOT NULL DEFAULT 12,
  inactive_days INTEGER NOT NULL DEFAULT 21,
  min_value NUMERIC NOT NULL DEFAULT 5000,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS portal_deal_settings (
  client_id BIGINT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  min_price NUMERIC NOT NULL DEFAULT 0,
  max_discount_pct NUMERIC NOT NULL DEFAULT 10,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS portal_deal_rounds (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  conversation_id BIGINT,
  contact_id TEXT NOT NULL DEFAULT '',
  asking_price NUMERIC NOT NULL,
  offer NUMERIC NOT NULL,
  decision TEXT NOT NULL,
  counter_price NUMERIC NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_deal_rounds
  ON portal_negotiation_rounds (client_id, conversation_id, id DESC);
"""

DEFAULT_SETTINGS: Dict[str, Any] = {
    "auto_enabled": False,
    "checkout_hours": 24,
    "cod_hours": 12,
    "inactive_days": 21,
    "min_value": 5000,
}


def _ensure_ddl(cur) -> None:
    """Create the recovery/negotiation tables once per process."""
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    _DDL_READY = True


def _principal_or_error():
    """Owner/staff session required (API keys cannot touch recovery)."""
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
# Recovery: detection scan + follow-ups
# ---------------------------------------------------------------------------

def _load_settings(cur, client_id: int) -> Dict[str, Any]:
    cur.execute(
        "SELECT auto_enabled, checkout_hours, cod_hours, inactive_days,"
        " min_value FROM " + portal_db._q(SETTINGS_TABLE) +
        " WHERE client_id = %s",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    if not rows:
        return dict(DEFAULT_SETTINGS)
    row = rows[0]
    return {"auto_enabled": bool(row.get("auto_enabled")),
            "checkout_hours": int(row.get("checkout_hours")
                                  or DEFAULT_SETTINGS["checkout_hours"]),
            "cod_hours": int(row.get("cod_hours")
                             or DEFAULT_SETTINGS["cod_hours"]),
            "inactive_days": int(row.get("inactive_days")
                                 or DEFAULT_SETTINGS["inactive_days"]),
            "min_value": float(row.get("min_value")
                               or DEFAULT_SETTINGS["min_value"])}


PRICE_PHRASES = ("%mehnga%", "%mehngai%", "%price zyada%", "%kam kar%",
                 "%discount%", "%ghat%")

#: One fixed Roman-Urdu follow-up per detection kind (never an LLM).
FOLLOWUP_COPY = {
    "abandoned_checkout":
        "Assalam-o-Alaikum! Aapka select kiya hua order abhi bhi pending"
        " he. Koi sawal ho to batayein - link dobara bhej deta hoon.",
    "unconfirmed_cod":
        "Aapka COD order abhi bhi confirm hona baqi he. 'haan' ya 'nahi'"
        " reply karein taake hum aap ka order process kar sakein.",
    "price_objection":
        "Ji main samajh sakta hoon price ki fikr he. Chalein aap ke liye"
        " behtareen option dekhte hain - batayein kaunsa item chahiye?",
    "inactive_high_value":
        "Assalam-o-Alaikum! Lambe arse baad yaad kiya - naye stock se"
        " koi khaas cheez bhej doon? Aap ke liye best rates hain.",
}


def scan_recoveries(cur, client_id: int) -> Tuple[List[Dict[str, Any]],
                                                  Dict[str, Any]]:
    """Run the four bounded detections, queue new ones, return items.

    The scan is idempotent (UNIQUE(kind, ref_key) + ON CONFLICT DO
    NOTHING) and auto-mode queues the follow-up for NEW items only.
    """
    _ensure_ddl(cur)
    settings = _load_settings(cur, client_id)
    found: List[Dict[str, Any]] = []

    cur.execute(
        "SELECT id, contact_id, total FROM " +
        portal_db._q("portal_checkout_links") +
        " WHERE client_id = %s AND status = 'open'"
        " AND updated_at < NOW() - (%s * INTERVAL '1 hour')"
        " ORDER BY updated_at DESC LIMIT 20",
        (client_id, settings["checkout_hours"]),
    )
    for row in portal_db.rows(cur):
        found.append({"kind": "abandoned_checkout",
                      "ref_key": "link:" + str(row.get("id")),
                      "contact_id": str(row.get("contact_id") or ""),
                      "conversation_id": None,
                      "priority": 2,
                      "note": "Checkout open for "
                              + str(settings["checkout_hours"]) + "h+"})

    cur.execute(
        "SELECT id, conversation_id, contact_id FROM " +
        portal_db._q("portal_cod_requests") +
        " WHERE client_id = %s AND status = 'pending'"
        " AND created_at < NOW() - (%s * INTERVAL '1 hour')"
        " ORDER BY id DESC LIMIT 20",
        (client_id, settings["cod_hours"]),
    )
    for row in portal_db.rows(cur):
        found.append({"kind": "unconfirmed_cod",
                      "ref_key": "cod:" + str(row.get("id")),
                      "contact_id": str(row.get("contact_id") or ""),
                      "conversation_id": row.get("conversation_id"),
                      "priority": 1,
                      "note": "COD pending " + str(settings["cod_hours"])
                              + "h+"})

    cur.execute(
        "SELECT DISTINCT ON (m.conversation_id) m.conversation_id AS cid,"
        " c.contact_id AS contact_id, m.created_at AS created_at"
        " FROM " + portal_db._q(portal_db.MSGS_TABLE) + " m"
        " JOIN " + portal_db._q(portal_db.CONV_TABLE) + " c"
        " ON c.id = m.conversation_id"
        " WHERE m.client_id = %s AND m.direction = 'in'"
        " AND m.created_at > NOW() - INTERVAL '7 days'"
        " AND (m.body ILIKE %s OR m.body ILIKE %s OR m.body ILIKE %s"
        " OR m.body ILIKE %s OR m.body ILIKE %s OR m.body ILIKE %s)"
        " ORDER BY m.conversation_id, m.id DESC LIMIT 20",
        (client_id,) + PRICE_PHRASES,
    )
    for row in portal_db.rows(cur):
        found.append({"kind": "price_objection",
                      "ref_key": "conv:" + str(row.get("cid")),
                      "contact_id": str(row.get("contact_id") or ""),
                      "conversation_id": row.get("cid"),
                      "priority": 1,
                      "note": "Customer hinted price is too high"})

    cur.execute(
        "SELECT contact_id, SUM(paid_amount) AS value,"
        " MAX(updated_at) AS last_order"
        " FROM " + portal_db._q("portal_checkout_links") +
        " WHERE client_id = %s AND status = 'paid'"
        " GROUP BY contact_id"
        " HAVING SUM(paid_amount) >= %s"
        " AND MAX(updated_at) < NOW() - (%s * INTERVAL '1 day')"
        " ORDER BY value DESC LIMIT 20",
        (client_id, settings["min_value"], settings["inactive_days"]),
    )
    for row in portal_db.rows(cur):
        found.append({"kind": "inactive_high_value",
                      "ref_key": "contact:" + str(row.get("contact_id")),
                      "contact_id": str(row.get("contact_id") or ""),
                      "conversation_id": None,
                      "priority": 3,
                      "note": "Paid buyer gone quiet "
                              + str(settings["inactive_days"]) + "d+"})

    new_items: List[Dict[str, Any]] = []
    for item in found:
        cur.execute(
            "INSERT INTO " + portal_db._q(QUEUE_TABLE) +
            " (client_id, kind, ref_key, contact_id, conversation_id,"
            " priority, note) VALUES (%s, %s, %s, %s, %s, %s, %s)"
            " ON CONFLICT (client_id, kind, ref_key) DO NOTHING"
            " RETURNING id",
            (client_id, item["kind"], item["ref_key"], item["contact_id"],
             item["conversation_id"], item["priority"], item["note"]),
        )
        inserted = portal_db.rows(cur)
        if inserted:
            new_items.append(item)

    if settings["auto_enabled"]:
        for item in new_items:
            _enqueue_followup(cur, client_id, item["kind"],
                              item["contact_id"], item["conversation_id"])
            cur.execute(
                "UPDATE " + portal_db._q(QUEUE_TABLE) +
                " SET status = 'contacted', updated_at = NOW()"
                " WHERE client_id = %s AND kind = %s AND ref_key = %s"
                " AND status = 'open'",
                (client_id, item["kind"], item["ref_key"]),
            )
        if new_items:
            portal_db.log_action(
                cur, client_id, "recovery.auto", "automation", None, None,
                ("Auto follow-ups queued: " + str(len(new_items)))[:200],
            )

    cur.execute(
        "SELECT id, kind, ref_key, contact_id, conversation_id, priority,"
        " status, note, created_at FROM " + portal_db._q(QUEUE_TABLE) +
        " WHERE client_id = %s AND status IN ('open', 'contacted')"
        " ORDER BY priority, id DESC LIMIT 20",
        (client_id,),
    )
    items = portal_db.rows(cur)
    return items, settings


def _enqueue_followup(cur, client_id: int, kind: str, contact_id: str,
                      conversation_id: Optional[int],
                      display_name: str = "") -> bool:
    """Queue ONE fixed follow-up send_message for a recovery item."""
    body = FOLLOWUP_COPY.get(kind)
    if not body or not contact_id:
        return False
    payload: Dict[str, Any] = {
        "external_user_id": contact_id,
        "body": body,
        "source": "recovery",
    }
    if conversation_id:
        payload["conversation_id"] = int(conversation_id)
    if display_name:
        payload["target_display_name"] = display_name
    cur.execute(
        "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
        " (client_id, channel, action, payload, status, requested_by,"
        " created_at, updated_at) "
        "VALUES (%s, 'whatsapp', 'send_message', CAST(%s AS JSONB),"
        " 'pending', NULL, NOW(), NOW()) RETURNING id",
        (client_id, json.dumps(payload)),
    )
    return True


# ---------------------------------------------------------------------------
# Negotiation: deterministic bounds + LLM phrasing
# ---------------------------------------------------------------------------

def _fmt_price(value: float) -> str:
    """950.0 -> "950", 949.5 -> "949.5" (human price strings)."""
    return str(int(value)) if float(value).is_integer() else str(value)


def negotiation_floor(price: float, settings: Dict[str, Any]) -> float:
    """The hard floor: owner min_price OR the max-discount bound."""
    floor = float(price) * (1.0 - float(settings["max_discount_pct"]) / 100.0)
    return round(max(floor, float(settings["min_price"])), 2)


def negotiation_decision(price: float, offer: float,
                         settings: Dict[str, Any]) -> Dict[str, Any]:
    """Deterministic accept / counter / reject against the floor."""
    floor = negotiation_floor(price, settings)
    if offer >= float(price):
        return {"decision": "accept", "counter_price": round(price, 2),
                "floor": floor}
    if offer >= floor:
        return {"decision": "accept", "counter_price": round(offer, 2),
                "floor": floor}
    if offer >= round(floor - float(price) * 0.05, 2):
        return {"decision": "counter", "counter_price": floor,
                "floor": floor}
    return {"decision": "reject", "counter_price": floor, "floor": floor}


def _counter_message(cur, client_id: int, decision: Dict[str, Any],
                     price: float, offer: float,
                     conversation_id: Optional[int],
                     contact_id: str) -> str:
    """Phrase the reply; the LLM may only word it, never re-price it."""
    counter = decision["counter_price"]
    if decision["decision"] == "accept":
        return ("Shukriya! Deal " + _fmt_price(counter) + " RS par final -"
                " abhi confirm karein, bhej dete hain.")
    if decision["decision"] == "reject":
        return ("Maazrat, is qeemat par mumkin nahi. Agar "
                + _fmt_price(decision["floor"])
                + " tak aa sakein to zaroor batayein.")
    fallback = ("Behtareen qeemat " + _fmt_price(counter) + " RS he - is par"
                " aaj hi bhej dete hain. Final he.")
    try:
        import portal_llm

        payload = portal_llm.chat_json(
            "You phrase ONE short Roman-Urdu WhatsApp message (max 2"
            " sentences) offering the COUNTER PRICE exactly as given."
            " NEVER mention any other price, never promise extra"
            ' discounts. Reply ONLY with JSON: {"message": "..."}',
            json.dumps({"asking_price": price, "customer_offer": offer,
                        "counter_price": counter,
                        "language": "roman"}),
            max_tokens=150,
        )
        message = str((payload or {}).get("message") or "").strip()
        if (message and len(message) <= 300
                and _fmt_price(counter) in message):
            return message
    except Exception as error:
        logger.warning("negotiation phrasing fell back: %s", error)
    return fallback


def floor_of(decision: Dict[str, Any]) -> Any:
    return decision.get("floor")


def log_round(cur, client_id: int, conversation_id: Optional[int],
              contact_id: str, price: float, offer: float,
              decision: Dict[str, Any], note: str) -> None:
    cur.execute(
        "INSERT INTO " + portal_db._q(NEG_ROUNDS_TABLE) +
        " (client_id, conversation_id, contact_id, asking_price, offer,"
        " decision, counter_price, note)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
        (client_id, conversation_id, contact_id, price, offer,
         decision["decision"], decision["counter_price"], note[:200]),
    )


# ---------------------------------------------------------------------------
# Copy-gen: broadcast variants with a deterministic fallback
# ---------------------------------------------------------------------------

COPY_FALLBACK = {
    "ur": ["{topic}! ابھی آرڈر کریں اور فائدہ اٹھائیں۔",
           "خصوصی موقع: {topic} — ابھی میسج کریں اور اپنا آرڈر مکمل کریں۔"],
    "roman": ["{topic} - abhi available he! Aaj hi order karein, jaldi"
              " karein.",
              "Sirf thodi dair: {topic}. Interest he to 'haan' likhein,"
              " details bhej dete hain."],
    "en": ["{topic} - available now! Reply today to order yours.",
           "Limited offer: {topic}. Message us and grab yours."],
}


def fallback_copy(topic: str, lang: str) -> List[str]:
    topic = str(topic or "").strip()[:120]
    return [t.replace("{topic}", topic)
            for t in COPY_FALLBACK.get(lang, COPY_FALLBACK["roman"])]


def generate_copy(cur, client_id: int, topic: str, lang: str) -> Dict[str, Any]:
    """Two broadcast variants; LLM when available, templates otherwise."""
    topic = str(topic or "").strip()[:120]
    lang = lang if lang in COPY_LANGS else "roman"
    variants: List[str] = []
    source = "fallback"
    try:
        import portal_llm

        payload = portal_llm.chat_json(
            "You write WhatsApp broadcast copy for a small Pakistani"
            " retail shop. Two SHORT variants (max 2 sentences each, no"
            " emojis, no promises of refunds/discounts/dates). Reply"
            ' ONLY with JSON: {"variants": ["...", "..."]}',
            json.dumps({"topic": topic, "language": lang,
                        "max_chars": MAX_COPY_CHARS}),
            max_tokens=300,
        )
        raw = (payload or {}).get("variants")
        if isinstance(raw, list):
            cleaned = [str(v or "").strip()[:MAX_COPY_CHARS]
                       for v in raw if str(v or "").strip()]
            if len(cleaned) >= 2:
                variants = cleaned[:2]
                source = "llm"
    except Exception as error:
        logger.warning("copy-gen fell back: %s", error)
    if len(variants) < 2:
        variants = fallback_copy(topic, lang)
        source = "fallback"
    portal_db.log_action(
        cur, client_id, "copygen.generated", "human", None, None,
        ("Broadcast copy (" + lang + ", " + source + "): " + topic)[:200],
    )
    return {"variants": variants, "source": source}


# ---------------------------------------------------------------------------
# Owner API
# ---------------------------------------------------------------------------

def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value) or None


@bp.get("/recovery")
def list_recoveries():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            items, settings = scan_recoveries(cur, client_id)
        conn.commit()
    finally:
        conn.close()
    out = [{"id": int(r.get("id") or 0),
            "kind": str(r.get("kind") or ""),
            "contact_id": str(r.get("contact_id") or ""),
            "conversation_id": r.get("conversation_id"),
            "priority": int(r.get("priority") or 5),
            "status": str(r.get("status") or "open"),
            "note": str(r.get("note") or ""),
            "created_at": _iso(r.get("created_at"))} for r in items]
    return jsonify({"items": out, "settings": settings}), 200


@bp.post("/recovery/followup")
def followup_recovery():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    payload = request.get_json(silent=True) or {}
    try:
        item_id = int(payload.get("id") or 0)
    except Exception:
        item_id = 0
    if item_id <= 0:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "id is required."}}), 400
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "SELECT id, kind, contact_id, conversation_id, status"
                " FROM " + portal_db._q(QUEUE_TABLE) +
                " WHERE id = %s AND client_id = %s LIMIT 1",
                (item_id, client_id),
            )
            rows = portal_db.rows(cur)
            item = rows[0] if rows else None
            if item is None:
                conn.rollback()
                return jsonify({"error": {"code": "not_found",
                                          "message": "No such recovery"
                                                     " item."}}), 404
            if (item.get("status") or "open") != "open":
                conn.rollback()
                return jsonify({"error": {"code": "conflict",
                                          "message": "Only open items can"
                                                     " get a follow-up."}}), \
                    409
            _enqueue_followup(cur, client_id, str(item.get("kind")),
                              str(item.get("contact_id") or ""),
                              item.get("conversation_id"))
            cur.execute(
                "UPDATE " + portal_db._q(QUEUE_TABLE) +
                " SET status = 'contacted', updated_at = NOW()"
                " WHERE id = %s AND client_id = %s",
                (item_id, client_id),
            )
            portal_db.log_action(
                cur, client_id, "recovery.followup", "human", None,
                item.get("conversation_id"),
                ("Follow-up sent: " + str(item.get("kind"))
                 + " -> " + str(item.get("contact_id")))[:200],
            )
            copy = FOLLOWUP_COPY.get(str(item.get("kind")), "")
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "copy": copy}), 200


@bp.post("/recovery/dismiss")
def dismiss_recovery():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    payload = request.get_json(silent=True) or {}
    try:
        item_id = int(payload.get("id") or 0)
    except Exception:
        item_id = 0
    if item_id <= 0:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "id is required."}}), 400
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "UPDATE " + portal_db._q(QUEUE_TABLE) +
                " SET status = 'dismissed', updated_at = NOW()"
                " WHERE id = %s AND client_id = %s AND status = 'open'",
                (item_id, client_id),
            )
            ok = bool(portal_db.rows(cur))
        conn.commit()
    finally:
        conn.close()
    if not ok:
        return jsonify({"error": {"code": "not_found",
                                  "message": "No open recovery item with"
                                             " that id."}}), 404
    return jsonify({"ok": True}), 200


def _clamp(value: Any, low: int, high: int, default: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


@bp.get("/recovery/settings")
def get_recovery_settings():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            settings = _load_settings(cur, int(principal["client_id"]))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"settings": settings}), 200


@bp.put("/recovery/settings")
def put_recovery_settings():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    payload = request.get_json(silent=True) or {}
    auto = payload.get("auto_enabled")
    if not isinstance(auto, bool):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "auto_enabled (boolean) is"
                                             " required."}}), 400
    settings = {"auto_enabled": auto,
                "checkout_hours": _clamp(payload.get("checkout_hours"),
                                         1, 168,
                                         DEFAULT_SETTINGS["checkout_hours"]),
                "cod_hours": _clamp(payload.get("cod_hours"), 1, 96,
                                    DEFAULT_SETTINGS["cod_hours"]),
                "inactive_days": _clamp(payload.get("inactive_days"),
                                        3, 90,
                                        DEFAULT_SETTINGS["inactive_days"])}
    try:
        min_value = round(float(payload.get("min_value")
                                or DEFAULT_SETTINGS["min_value"]), 2)
    except (TypeError, ValueError):
        min_value = DEFAULT_SETTINGS["min_value"]
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "INSERT INTO " + portal_db._q(SETTINGS_TABLE) +
                " (client_id, auto_enabled, checkout_hours, cod_hours,"
                " inactive_days, min_value, updated_at)"
                " VALUES (%s, %s, %s, %s, %s, %s, NOW())"
                " ON CONFLICT (client_id) DO UPDATE SET"
                " auto_enabled = EXCLUDED.auto_enabled,"
                " checkout_hours = EXCLUDED.checkout_hours,"
                " cod_hours = EXCLUDED.cod_hours,"
                " inactive_days = EXCLUDED.inactive_days,"
                " min_value = EXCLUDED.min_value, updated_at = NOW()",
                (client_id, auto, settings["checkout_hours"],
                 settings["cod_hours"], settings["inactive_days"],
                 min_value),
            )
            portal_db.log_action(
                cur, client_id, "recovery.settings", "human", None, None,
                "Recovery auto " + ("on" if auto else "off"),
            )
        conn.commit()
    finally:
        conn.close()
    settings["min_value"] = min_value
    return jsonify({"settings": settings}), 200


def _load_neg_settings(cur, client_id: int) -> Dict[str, Any]:
    cur.execute(
        "SELECT enabled, min_price, max_discount_pct FROM " +
        portal_db._q(NEG_SETTINGS_TABLE) + " WHERE client_id = %s",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    if not rows:
        return {"enabled": False, "min_price": 0.0,
                "max_discount_pct": 10.0}
    return {"enabled": bool(rows[0].get("enabled")),
            "min_price": float(rows[0].get("min_price") or 0),
            "max_discount_pct": float(rows[0].get("max_discount_pct")
                                      or 10)}


@bp.get("/negotiation/bounds")
def get_deal_bounds():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            settings = _load_neg_settings(cur, int(principal["client_id"]))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"settings": settings}), 200


@bp.put("/negotiation/bounds")
def put_deal_bounds():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    payload = request.get_json(silent=True) or {}
    enabled = payload.get("enabled")
    if not isinstance(enabled, bool):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "enabled (boolean) is"
                                             " required."}}), 400
    try:
        min_price = round(float(payload.get("min_price") or 0), 2)
        pct = round(float(payload.get("max_discount_pct") or 10), 2)
    except (TypeError, ValueError):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "min_price and"
                                             " max_discount_pct must be"
                                             " numbers."}}), 400
    if min_price < 0 or not 0 <= pct <= 90:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "min_price >= 0 and"
                                             " max_discount_pct within"
                                             " 0..90 are required."}}), 400
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "INSERT INTO " + portal_db._q(NEG_SETTINGS_TABLE) +
                " (client_id, enabled, min_price, max_discount_pct,"
                " updated_at) VALUES (%s, %s, %s, %s, NOW())"
                " ON CONFLICT (client_id) DO UPDATE SET"
                " enabled = EXCLUDED.enabled,"
                " min_price = EXCLUDED.min_price,"
                " max_discount_pct = EXCLUDED.max_discount_pct,"
                " updated_at = NOW()",
                (client_id, enabled, min_price, pct),
            )
            portal_db.log_action(
                cur, client_id, "negotiation.settings", "human", None,
                None,
                ("Bounds: min " + str(min_price) + " / max -"
                 + str(pct) + "%")[:200],
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"settings": {"enabled": enabled,
                                 "min_price": min_price,
                                 "max_discount_pct": pct}}), 200


@bp.post("/negotiation/decide")
def decide_negotiation():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    payload = request.get_json(silent=True) or {}
    try:
        price = round(float(payload.get("price")), 2)
        offer = round(float(payload.get("offer")), 2)
    except (TypeError, ValueError):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "price and offer (numbers)"
                                             " are required."}}), 400
    if price <= 0 or offer <= 0:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "price and offer must be"
                                             " greater than zero."}}), 400
    try:
        conversation_id = int(payload.get("conversation_id") or 0)
    except (TypeError, ValueError):
        conversation_id = 0
    contact_id = str(payload.get("contact_id") or "")[:100]
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            settings = _load_neg_settings(cur, client_id)
            if not settings["enabled"]:
                conn.rollback()
                return jsonify({"error": {"code": "forbidden",
                                          "message": "Negotiation is off"
                                                     " - set bounds in"
                                                     " Settings first."}}), \
                    403
            decision = negotiation_decision(price, offer, settings)
            note = decision["decision"]
            if decision["decision"] == "counter":
                message = _counter_message(cur, client_id, decision,
                                           price, offer,
                                           conversation_id or None,
                                           contact_id)
                note = "counter @ " + str(decision["counter_price"])
            elif decision["decision"] == "accept":
                message = ("Shukriya! Deal "
                           + _fmt_price(decision["counter_price"])
                           + " RS par final - abhi confirm karein.")
            else:
                message = ("Maazrat, is qeemat par mumkin nahi. Agar "
                           + _fmt_price(decision["floor"])
                           + " tak aa sakein to zaroor batayein.")
            log_round(cur, client_id, conversation_id or None, contact_id,
                      price, offer, decision, note)
            portal_db.log_action(
                cur, client_id, "negotiation.round", "human", None,
                conversation_id or None,
                ("Offer " + str(offer) + " on " + str(price) + " -> "
                 + decision["decision"])[:200],
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"decision": decision["decision"],
                    "counter_price": decision["counter_price"],
                    "floor": decision["floor"],
                    "message": message}), 200


@bp.post("/copygen/broadcast")
def copygen_broadcast():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    client_id = int(principal["client_id"])
    payload = request.get_json(silent=True) or {}
    topic = str(payload.get("topic") or "").strip()
    lang = str(payload.get("lang") or "roman")
    if not topic:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "topic is required."}}), 400
    if lang not in COPY_LANGS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "lang must be one of"
                                             " ur|roman|en."}}), 400
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            result = generate_copy(cur, client_id, topic, lang)
        conn.commit()
    finally:
        conn.close()
    return jsonify(result), 200
