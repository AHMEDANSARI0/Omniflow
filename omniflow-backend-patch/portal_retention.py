"""Retention & loyalty hub (§238): tiers, personal offers, timed reorder /
win-back messages and their results.

The signals already existed in separate read-only tools (win-back queue,
churn radar, customer value, coupons, recovery follow-ups). This module
joins them into one retention layer:

* PURCHASE - one definition for every retention number: a checkout link in
  PURCHASED_STATUSES (paid, shipped, delivered). Orders used to drop out of
  the win-back / value / churn / VIP counts once they were marked shipped.
* LOYALTY TIERS - owner-defined (up to MAX_TIERS): label + minimum orders +
  minimum spend, optionally one existing coupon as the tier's offer. The
  customer's tier is the highest one whose minimums are both met.
* AUTOMATIC MESSAGES - opt-in per kind (reorder due / win-back), default
  OFF. The connector tick runs at most every OF_RETENTION_EVERY_MINUTES,
  only inside the owner's send window, at most daily_cap messages per 24h.
  A contact is skipped when opted out, when it has an open cart (recovery
  owns carts), when it is in an active sequence, or when any outreach
  (win-back, retention, recovery) reached it within cooldown_days. The
  "who is due" rule is the win-back queue's own (portal_winback.build_entry).
* OFFERS - the message text is the owner's template; an offer line is added
  only when the tier has a coupon that is active, unexpired and under its
  usage limit. The assistant itself never offers codes or discounts.
* RESULTS - every retention / manual win-back send is logged; a purchase by
  that contact within OF_RETENTION_ATTRIBUTION_DAYS counts as "came back".

Fail-soft: optional reads sit in savepoints; a missing table means "none".
"""

import json
import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_db
import portal_txn
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)

logger = logging.getLogger("omniflow.portal-retention")

bp = Blueprint("portal_retention", __name__, url_prefix="/api/v1/portal")

SETTINGS_TABLE = "portal_loyalty_settings"
SENDS_TABLE = "portal_loyalty_sends"
LINKS_TABLE = "portal_checkout_links"

#: What counts as a purchase for every retention number.
PURCHASED_STATUSES = ("paid", "shipped", "delivered")
PURCHASED_SQL = "(" + ", ".join("'" + item + "'" for item in PURCHASED_STATUSES) + ")"

#: Outreach sources that share the per-contact cooldown.
OUTREACH_SOURCES = ("winback", "retention", "recovery")
AUTO_KINDS = ("reorder", "winback")


def _env_int(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(os.environ.get(name, "") or default)
    except ValueError:
        value = default
    return max(low, min(high, value))


EVERY_MINUTES = _env_int("OF_RETENTION_EVERY_MINUTES", 60, 5, 1440)
CHECK_SECONDS = _env_int("OF_RETENTION_CHECK_SECONDS", 60, 0, 3600)
POOL_ROWS = _env_int("OF_RETENTION_POOL_ROWS", 5000, 100, 50000)
RUN_MAX = _env_int("OF_RETENTION_RUN_MAX", 50, 1, 500)
CAP_MAX = _env_int("OF_RETENTION_CAP_MAX", 200, 1, 2000)
ATTRIBUTION_DAYS = _env_int("OF_RETENTION_ATTRIBUTION_DAYS", 14, 1, 90)
OVERVIEW_DAYS = _env_int("OF_RETENTION_OVERVIEW_DAYS", 30, 1, 365)
EDIT_ROLES = tuple(
    item.strip() for item in
    (os.environ.get("OF_RETENTION_ROLES", "owner,admin") or "owner,admin").split(",")
    if item.strip())

MAX_TIERS = 5
LABEL_MAX = 30
TEMPLATE_MAX = 500
MESSAGE_MAX = 700
PLACEHOLDERS = ("name", "item", "tier", "offer", "code", "value")
_PLACEHOLDER_RE = re.compile(r"\{([a-z_]*)\}")

DEFAULT_TIERS: List[Dict[str, Any]] = [
    {"key": "new_buyer", "label": "New buyer", "min_orders": 1, "min_spend": 0, "coupon": ""},
    {"key": "repeat_buyer", "label": "Repeat buyer", "min_orders": 2, "min_spend": 0, "coupon": ""},
    {"key": "vip", "label": "VIP", "min_orders": 3, "min_spend": 0, "coupon": ""},
]

#: Customer-facing defaults (Roman Urdu); the owner may replace each one.
DEFAULT_TEMPLATES = {
    "reorder": ("Assalam-o-Alaikum {name}! Umeed hai {item} pasand aaya hoga."
                " Dobara mangwana ho to bas reply kar dein.{offer}"),
    "winback": ("Assalam-o-Alaikum {name}! Kaafi din ho gaye - naya stock aa"
                " chuka hai. Kuch chahiye ho to reply kar dein.{offer}"),
    "offer": " {tier} customer ke liye code {code} se {value} off.",
}
FALLBACK_ITEM = "aap ka order"

DEFAULT_SETTINGS: Dict[str, Any] = {
    "auto_reorder": False,
    "auto_winback": False,
    "brain_context": True,
    "daily_cap": 20,
    "cooldown_days": 7,
    "window_start": 10,
    "window_end": 20,
    "tpl_reorder": "",
    "tpl_winback": "",
    "tpl_offer": "",
    "tiers": DEFAULT_TIERS,
    "last_run_at": None,
}

_DDL = (
    "CREATE TABLE IF NOT EXISTS " + SETTINGS_TABLE + " ("
    " client_id BIGINT PRIMARY KEY,"
    " auto_reorder BOOLEAN NOT NULL DEFAULT FALSE,"
    " auto_winback BOOLEAN NOT NULL DEFAULT FALSE,"
    " brain_context BOOLEAN NOT NULL DEFAULT TRUE,"
    " daily_cap INT NOT NULL DEFAULT 20,"
    " cooldown_days INT NOT NULL DEFAULT 7,"
    " window_start INT NOT NULL DEFAULT 10,"
    " window_end INT NOT NULL DEFAULT 20,"
    " tpl_reorder TEXT NOT NULL DEFAULT '',"
    " tpl_winback TEXT NOT NULL DEFAULT '',"
    " tpl_offer TEXT NOT NULL DEFAULT '',"
    " tiers JSONB,"
    " last_run_at TIMESTAMPTZ,"
    " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());"
    "CREATE TABLE IF NOT EXISTS " + SENDS_TABLE + " ("
    " id BIGSERIAL PRIMARY KEY,"
    " client_id BIGINT NOT NULL,"
    " contact_id TEXT NOT NULL,"
    " contact_name TEXT NOT NULL DEFAULT '',"
    " kind TEXT NOT NULL,"
    " tier TEXT NOT NULL DEFAULT '',"
    " coupon_code TEXT NOT NULL DEFAULT '',"
    " mode TEXT NOT NULL DEFAULT 'auto',"
    " command_id BIGINT,"
    " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());"
    "CREATE INDEX IF NOT EXISTS portal_loyalty_sends_recent_idx ON "
    + SENDS_TABLE + " (client_id, created_at DESC)"
)


def _ensure_ddl(cur) -> None:
    """Create the tables when missing (no commit - safe inside the tick).
    Checked every call, never cached (a rolled-back first transaction must
    not leave a "ready" flag behind)."""
    cur.execute("SELECT to_regclass(%s) IS NOT NULL AND to_regclass(%s) IS NOT NULL AS ready",
                (SETTINGS_TABLE, SENDS_TABLE))
    if not _first(cur.fetchone()):
        cur.execute(_DDL)


def _first(row: Any) -> Any:
    if row is None:
        return None
    if isinstance(row, dict):
        return next(iter(row.values()), None)
    return row[0] if len(row) else None


def _exists(cur, table: str) -> bool:
    cur.execute("SELECT to_regclass(%s) AS t", (table,))
    return bool(_first(cur.fetchone()))


def _read(cur, fn, fallback):
    """One optional read in its own savepoint (missing table -> fallback)."""
    try:
        with portal_txn.savepoint(cur, None, "of_retention") as guard:
            value = fn()
        return fallback if guard.failed else value
    except Exception as error:
        logger.info("retention read skipped: %s", error)
        return fallback


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _ts(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _iso(value: Any) -> Optional[str]:
    stamp = _ts(value)
    return stamp.isoformat() if stamp else None


def _money(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if number == number and number > 0 else 0.0


def _items(value: Any) -> List[Any]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return []
    return value if isinstance(value, list) else []


def _amount_text(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else ("%.2f" % value)


# ---------------------------------------------------------------------------
# Settings + tiers
# ---------------------------------------------------------------------------

def _slug(label: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")[:30] or "tier"


def clean_tiers(raw: Any) -> Tuple[Optional[List[Dict[str, Any]]], str]:
    """Validated tiers (ascending) or (None, reason)."""
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_TIERS:
        return None, "Add between 1 and " + str(MAX_TIERS) + " tiers."
    tiers: List[Dict[str, Any]] = []
    keys = set()
    for entry in raw:
        if not isinstance(entry, dict):
            return None, "Each tier needs a label, minimum orders and minimum spend."
        label = str(entry.get("label") or "").strip()
        if not label or len(label) > LABEL_MAX:
            return None, "Tier labels are 1-" + str(LABEL_MAX) + " characters."
        if isinstance(entry.get("min_orders"), bool) or isinstance(entry.get("min_spend"), bool):
            return None, "Minimum orders and spend must be numbers."
        try:
            orders = int(entry.get("min_orders"))
            spend = float(entry.get("min_spend") or 0)
        except (TypeError, ValueError):
            return None, "Minimum orders and spend must be numbers."
        if orders != entry.get("min_orders") and str(orders) != str(entry.get("min_orders")).strip():
            return None, "Minimum orders must be a whole number."
        if not 1 <= orders <= 10000:
            return None, "Minimum orders must be between 1 and 10000."
        if not 0 <= spend <= 1e9:
            return None, "Minimum spend must be between 0 and 1,000,000,000."
        coupon = str(entry.get("coupon") or "").strip().upper()[:40]
        key = _slug(label)
        if key in keys:
            return None, "Tier labels must be different."
        keys.add(key)
        tiers.append({"key": key, "label": label, "min_orders": orders,
                      "min_spend": round(spend, 2), "coupon": coupon})
    for low, high in zip(tiers, tiers[1:]):
        if high["min_orders"] < low["min_orders"] or high["min_spend"] < low["min_spend"] \
                or (high["min_orders"] == low["min_orders"] and high["min_spend"] == low["min_spend"]):
            return None, "List tiers from lowest to highest; each needs higher minimums."
    return tiers, ""


def clean_template(raw: Any, needs: str = "") -> Tuple[Optional[str], str]:
    """A message template ('' = default) or (None, reason)."""
    text = str(raw or "").strip()
    if not text:
        return "", ""
    if len(text) > TEMPLATE_MAX:
        return None, "Messages are at most " + str(TEMPLATE_MAX) + " characters."
    unknown = [name for name in _PLACEHOLDER_RE.findall(text) if name not in PLACEHOLDERS]
    if unknown:
        return None, "Unknown placeholder {" + unknown[0] + "}."
    if needs and "{" + needs + "}" not in text:
        return None, "The offer line must contain {" + needs + "}."
    return text, ""


def load_settings(cur, client_id: int) -> Dict[str, Any]:
    def _load():
        cur.execute(
            "SELECT auto_reorder, auto_winback, brain_context, daily_cap, cooldown_days,"
            " window_start, window_end, tpl_reorder, tpl_winback, tpl_offer, tiers, last_run_at"
            " FROM " + SETTINGS_TABLE + " WHERE client_id = %s", (client_id,))
        rows = portal_db.rows(cur)
        return rows[0] if rows else None

    row = _read(cur, _load, None)
    settings = dict(DEFAULT_SETTINGS)
    if not row:
        return settings
    for key in ("auto_reorder", "auto_winback", "brain_context"):
        settings[key] = row.get(key) is True
    for key in ("daily_cap", "cooldown_days", "window_start", "window_end"):
        if row.get(key) is not None:
            settings[key] = int(row.get(key))
    for key in ("tpl_reorder", "tpl_winback", "tpl_offer"):
        settings[key] = str(row.get(key) or "")
    tiers, _reason = clean_tiers(_tiers_value(row.get("tiers")))
    settings["tiers"] = tiers or DEFAULT_TIERS
    settings["last_run_at"] = row.get("last_run_at")
    return settings


def _tiers_value(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return None
    return value


def tier_for(orders: int, spend: float,
             tiers: List[Dict[str, Any]]) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """(current tier or None, next tier or None) - both minimums must be met."""
    current = None
    upcoming = None
    for tier in tiers:
        if orders >= tier["min_orders"] and spend >= tier["min_spend"]:
            current = tier
            upcoming = None
        elif upcoming is None:
            upcoming = tier
    return current, upcoming


def stats_of(links: List[Dict[str, Any]], now: datetime) -> Dict[str, Any]:
    """One contact's purchases -> orders, spend, favourite item, last order."""
    spend = 0.0
    counts: Dict[str, Dict[str, Any]] = {}
    stamps: List[datetime] = []
    for link in links:
        spend += _money(link.get("total"))
        stamp = _ts(link.get("created_at"))
        if stamp:
            stamps.append(stamp)
        for item in _items(link.get("items")):
            if isinstance(item, dict) and str(item.get("name") or "").strip():
                name = str(item.get("name")).strip()
                entry = counts.setdefault(name.lower(), {"name": name, "count": 0})
                entry["count"] += 1
    favourite = ""
    if counts:
        favourite = sorted(counts.values(), key=lambda e: (-e["count"], e["name"].lower()))[0]["name"]
    last = max(stamps) if stamps else None
    return {
        "orders": len(links),
        "spend": round(spend, 2),
        "favourite": favourite,
        "last_order_days": max(0, int((now - last).total_seconds() // 86400)) if last else None,
    }


# ---------------------------------------------------------------------------
# Offers + message text
# ---------------------------------------------------------------------------

def active_coupons(cur, client_id: int) -> Dict[str, Dict[str, Any]]:
    """CODE -> {code, kind, value} for coupons that can be used right now."""
    def _load():
        if not _exists(cur, "portal_coupons"):
            return {}
        cur.execute(
            "SELECT code, kind, value FROM portal_coupons"
            " WHERE client_id = %s AND is_active IS TRUE"
            " AND (expires_at IS NULL OR expires_at > NOW())"
            " AND (usage_limit IS NULL OR used_count < usage_limit)"
            " ORDER BY code LIMIT 200", (client_id,))
        return {str(row.get("code") or "").upper(): {
            "code": str(row.get("code") or "").upper(),
            "kind": str(row.get("kind") or "fixed"),
            "value": _money(row.get("value"))} for row in portal_db.rows(cur)}

    return _read(cur, _load, {})


def offer_for(tier: Optional[Dict[str, Any]],
              coupons: Dict[str, Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not tier or not tier.get("coupon"):
        return None
    coupon = coupons.get(str(tier["coupon"]).upper())
    if not coupon or coupon["value"] <= 0:
        return None
    value = _amount_text(coupon["value"]) + ("%" if coupon["kind"] == "percent" else "")
    return {"code": coupon["code"], "value": value}


def render(template: str, values: Dict[str, str]) -> str:
    """Fill known placeholders; tidy the gaps a blank value leaves."""
    text = _PLACEHOLDER_RE.sub(lambda m: values.get(m.group(1), ""), template)
    text = re.sub(r"[ \t]+([!?.,])", r"\1", text)
    text = re.sub(r"[ \t]{2,}", " ", text).strip()
    return text[:MESSAGE_MAX]


def compose(settings: Dict[str, Any], kind: str, name: str, item: str,
            tier: Optional[Dict[str, Any]], offer: Optional[Dict[str, Any]]) -> str:
    first = next((part for part in str(name or "").split() if part), "")[:40]
    values = {"name": first, "item": item or FALLBACK_ITEM,
              "tier": tier["label"] if tier else "", "code": "", "value": "", "offer": ""}
    if offer:
        values.update(code=offer["code"], value=offer["value"])
        values["offer"] = " " + render(settings.get("tpl_offer") or DEFAULT_TEMPLATES["offer"], values)
    template = settings.get("tpl_" + kind) or DEFAULT_TEMPLATES[kind]
    return render(template, values)


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------

def purchased_links(cur, client_id: int, contact_id: str = "") -> Dict[str, List[Dict[str, Any]]]:
    """contact -> purchases (oldest first), newest POOL_ROWS rows at most."""
    def _load():
        if not _exists(cur, LINKS_TABLE):
            return {}
        sql = ("SELECT contact_id, created_at, items, total FROM " + LINKS_TABLE +
               " WHERE client_id = %s AND status IN " + PURCHASED_SQL +
               " AND COALESCE(contact_id, '') <> ''")
        params: List[Any] = [client_id]
        if contact_id:
            sql += " AND contact_id = %s"
            params.append(contact_id)
        sql += " ORDER BY created_at DESC, id DESC LIMIT %s"
        params.append(POOL_ROWS)
        cur.execute(sql, tuple(params))
        grouped: Dict[str, List[Dict[str, Any]]] = {}
        for row in portal_db.rows(cur):
            grouped.setdefault(str(row.get("contact_id")), []).append(
                {"created_at": row.get("created_at"), "items": _items(row.get("items")),
                 "total": row.get("total")})
        for links in grouped.values():
            links.reverse()
        return grouped

    return _read(cur, _load, {})


def _contact_info(cur, client_id: int, contacts: List[str]) -> Dict[str, Dict[str, Any]]:
    if not contacts:
        return {}

    def _load():
        cur.execute(
            "SELECT contact_id, MAX(COALESCE(contact_name, '')) AS name,"
            " MAX(last_message_at) AS last_at, MAX(id) AS conversation_id FROM "
            + portal_db._q(portal_db.CONV_TABLE) +
            " WHERE client_id = %s AND contact_id = ANY(%s) GROUP BY contact_id",
            (client_id, contacts))
        found = {str(row.get("contact_id")): row for row in portal_db.rows(cur)}
        # the newest message either way (the win-back queue's own rule);
        # last_message_at alone follows inbound messages only
        cur.execute(
            "SELECT c.contact_id AS contact_id, MAX(m.created_at) AS last_at FROM "
            + portal_db._q(portal_db.MSGS_TABLE) + " m JOIN "
            + portal_db._q(portal_db.CONV_TABLE) + " c ON c.id = m.conversation_id"
            " WHERE c.client_id = %s AND c.contact_id = ANY(%s) GROUP BY c.contact_id",
            (client_id, contacts))
        for row in portal_db.rows(cur):
            entry = found.get(str(row.get("contact_id")))
            stamp = _ts(row.get("last_at"))
            if entry is not None and stamp and (not _ts(entry.get("last_at")) or stamp > _ts(entry.get("last_at"))):
                entry["last_at"] = stamp
        return found

    return _read(cur, _load, {})


def _contact_set(cur, sql: str, params: tuple, table: str = "") -> set:
    def _load():
        if table and not _exists(cur, table):
            return set()
        cur.execute(sql, params)
        return {str(_first(row) or "") for row in cur.fetchall()}

    return _read(cur, _load, set())


def blocked(cur, client_id: int, contacts: List[str], cooldown_days: int) -> Dict[str, set]:
    """Who must not get an automatic message right now, by reason."""
    if not contacts:
        return {"opted_out": set(), "open_cart": set(), "in_sequence": set(), "cooldown": set()}
    result = {
        "opted_out": _contact_set(
            cur, "SELECT contact_id FROM portal_optouts WHERE client_id = %s AND contact_id = ANY(%s)",
            (client_id, contacts)),
        "open_cart": _contact_set(
            cur, "SELECT DISTINCT contact_id FROM " + LINKS_TABLE +
            " WHERE client_id = %s AND status = 'open' AND contact_id = ANY(%s)",
            (client_id, contacts), LINKS_TABLE),
        "in_sequence": _contact_set(
            cur, "SELECT DISTINCT contact_id FROM portal_sequence_enrollments"
            " WHERE client_id = %s AND status = 'active' AND contact_id = ANY(%s)",
            (client_id, contacts), "portal_sequence_enrollments"),
        "cooldown": _contact_set(
            cur, "SELECT DISTINCT payload->>'external_user_id' FROM " + portal_db._q(portal_db.CMD_TABLE) +
            " WHERE client_id = %s AND action = 'send_message'"
            " AND payload->>'source' = ANY(%s)"
            " AND created_at > NOW() - make_interval(days => %s)",
            (client_id, list(OUTREACH_SOURCES), int(cooldown_days))),
    }
    return result


def recently_contacted(cur, client_id: int, contact_id: str, days: int) -> bool:
    """Did any outreach source reach this contact within `days`? (shared
    with recovery's automatic follow-ups)."""
    found = blocked(cur, client_id, [contact_id], days)["cooldown"]
    return contact_id in found


# ---------------------------------------------------------------------------
# Planning + sending
# ---------------------------------------------------------------------------

def plan(cur, client_id: int, settings: Dict[str, Any],
         kinds: Tuple[str, ...] = AUTO_KINDS) -> Dict[str, Any]:
    """Who is due a reorder / win-back message and who is held back (why)."""
    import portal_winback

    now = _now()
    grouped = purchased_links(cur, client_id)
    contacts = sorted(grouped)
    info = _contact_info(cur, client_id, contacts)
    holds = blocked(cur, client_id, contacts, settings["cooldown_days"])
    coupons = active_coupons(cur, client_id)
    due = {kind: 0 for kind in AUTO_KINDS}
    skipped = {"opted_out": 0, "open_cart": 0, "in_sequence": 0, "cooldown": 0, "no_chat": 0}
    ready: List[Dict[str, Any]] = []
    tiers: Dict[str, Dict[str, Any]] = {}
    for contact in contacts:
        links = grouped[contact]
        stats = stats_of(links, now)
        tier, _next = tier_for(stats["orders"], stats["spend"], settings["tiers"])
        if tier:
            bucket = tiers.setdefault(tier["key"], {"customers": 0, "spend": 0.0})
            bucket["customers"] += 1
            bucket["spend"] += stats["spend"]
        row = info.get(contact) or {}
        entry = portal_winback.build_entry(
            [], links[-portal_winback.MAX_PAID:], {"created_at": row.get("last_at")},
            contact, str(row.get("name") or ""), now)
        if not entry or entry["kind"] not in kinds:
            continue
        due[entry["kind"]] += 1
        reason = next((name for name in ("opted_out", "open_cart", "in_sequence", "cooldown")
                       if contact in holds[name]), "" if row else "no_chat")
        if reason:
            skipped[reason] += 1
            continue
        offer = offer_for(tier, coupons)
        ready.append({
            "contact_id": contact,
            "name": str(row.get("name") or ""),
            "conversation_id": row.get("conversation_id"),
            "kind": entry["kind"],
            "days": entry.get("days") or 0,
            "item": entry.get("item") or "",
            "tier": tier["label"] if tier else "",
            "coupon": offer["code"] if offer else "",
            "message": compose(settings, entry["kind"], str(row.get("name") or ""),
                               entry.get("item") or stats["favourite"], tier, offer),
        })
    ready.sort(key=lambda e: (AUTO_KINDS.index(e["kind"]), -e["days"], e["name"].lower()))
    return {"ready": ready, "due": due, "skipped": skipped, "tiers": tiers,
            "customers": len(contacts)}


def sent_last_day(cur, client_id: int) -> int:
    """Retention messages in the last 24h (the daily cap; win-back queue
    sends by a person are logged as mode 'queue' and do not count)."""
    cur.execute("SELECT COUNT(*) FROM " + SENDS_TABLE +
                " WHERE client_id = %s AND mode IN ('auto', 'manual')"
                " AND created_at > NOW() - INTERVAL '24 hours'",
                (client_id,))
    return int(_first(cur.fetchone()) or 0)


def record_send(cur, client_id: int, contact_id: str, kind: str, mode: str,
                command_id: Optional[int], name: str = "", tier: str = "",
                coupon: str = "", ensure: bool = True) -> None:
    """Log one outreach for the results view (also used by win-back queue
    sends, mode 'queue')."""
    if ensure:
        _ensure_ddl(cur)
    cur.execute(
        "INSERT INTO " + SENDS_TABLE +
        " (client_id, contact_id, contact_name, kind, tier, coupon_code, mode, command_id)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
        (client_id, contact_id[:100], name[:120], kind[:20], tier[:LABEL_MAX], coupon[:40],
         mode[:10], command_id))


def _queue(cur, client_id: int, entry: Dict[str, Any]) -> int:
    import portal_channels

    payload: Dict[str, Any] = {"external_user_id": entry["contact_id"], "body": entry["message"],
                               "source": "retention", "retention_kind": entry["kind"]}
    if entry.get("conversation_id"):
        payload["conversation_id"] = int(entry["conversation_id"])
    if entry.get("name"):
        payload["target_display_name"] = entry["name"][:120]
    cur.execute(
        "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
        " (client_id, channel, action, payload, status, requested_by, created_at, updated_at)"
        " VALUES (%s, %s, 'send_message', CAST(%s AS JSONB), 'pending', NULL, NOW(), NOW())"
        " RETURNING id",
        (client_id, portal_channels.channel_for_contact(entry["contact_id"]), json.dumps(payload)))
    return int(_first(cur.fetchone()) or 0)


def run(cur, client_id: int, settings: Dict[str, Any], mode: str = "auto",
        dry_run: bool = False, actor_user_id: Any = None) -> Dict[str, Any]:
    """Queue due messages within the daily cap; dry_run only lists them."""
    _ensure_ddl(cur)
    kinds = tuple(kind for kind in AUTO_KINDS if mode != "auto" or settings["auto_" + kind])
    planned = plan(cur, client_id, settings, kinds)
    room = max(0, min(RUN_MAX, int(settings["daily_cap"]) - sent_last_day(cur, client_id)))
    chosen = planned["ready"][:room]
    sent = 0
    if not dry_run:
        for entry in chosen:
            command_id = _queue(cur, client_id, entry)
            record_send(cur, client_id, entry["contact_id"], entry["kind"], mode, command_id,
                        entry["name"], entry["tier"], entry["coupon"], ensure=False)
            sent += 1
        if sent:
            portal_db.log_action(cur, client_id, "retention." + mode,
                                 "automation" if mode == "auto" else "customer_user",
                                 actor_user_id, None,
                                 ("Retention messages queued: " + str(sent))[:200])
    return {"sent": sent, "room": room, "would_send": chosen, "due": planned["due"],
            "skipped": planned["skipped"], "dry_run": dry_run}


def local_hour(cur, client_id: int) -> int:
    offset = 0
    try:
        import portal_bi

        offset = int(portal_bi.timezone_offset_hours(cur, client_id))
    except Exception:
        offset = 0
    return (_now() + timedelta(hours=offset)).hour


def in_window(hour: int, start: int, end: int) -> bool:
    if start == end:
        return True
    if start < end:
        return start <= hour < end
    return hour >= start or hour < end


_NEXT_CHECK: Dict[int, float] = {}


def kick(cur, client_id: int, conn=None) -> int:
    """Connector-tick step: send due automatic messages when switched on,
    at most every EVERY_MINUTES, inside the send window. Commits its own
    work when given the connection (like the other tick steps)."""
    clock = time.time()
    if _NEXT_CHECK.get(client_id, 0) > clock:
        return 0
    _NEXT_CHECK[client_id] = clock + CHECK_SECONDS
    if not _exists(cur, SETTINGS_TABLE):
        return 0
    cur.execute(
        "UPDATE " + SETTINGS_TABLE + " SET last_run_at = NOW()"
        " WHERE client_id = %s AND (auto_reorder OR auto_winback)"
        " AND (last_run_at IS NULL OR last_run_at < NOW() - make_interval(mins => %s))"
        " RETURNING client_id", (client_id, EVERY_MINUTES))
    if not cur.fetchall():
        return 0
    settings = load_settings(cur, client_id)
    sent = 0
    if in_window(local_hour(cur, client_id), settings["window_start"], settings["window_end"]):
        sent = run(cur, client_id, settings, "auto")["sent"]
    if conn is not None:
        conn.commit()
    return sent


# ---------------------------------------------------------------------------
# Brain context
# ---------------------------------------------------------------------------

def context_for(cur, client_id: int, contact_id: str) -> Optional[Dict[str, Any]]:
    """LOYALTY note for the assistant (tier, orders, favourite) or None."""
    if not contact_id:
        return None
    settings = load_settings(cur, client_id)
    if not settings["brain_context"]:
        return None
    links = purchased_links(cur, client_id, contact_id).get(contact_id) or []
    if not links:
        return None
    stats = stats_of(links, _now())
    tier, _next = tier_for(stats["orders"], stats["spend"], settings["tiers"])
    return {"tier": tier["label"] if tier else "", "orders": stats["orders"],
            "favourite": stats["favourite"], "last_order_days": stats["last_order_days"]}


LOYALTY_RULES = (
    " CONTEXT may include LOYALTY for this customer (their tier, number of past"
    " orders, favourite item, days since the last order). Use it only to be warm"
    " and personal - thank a returning customer, remember their favourite."
    " Never mention tiers as a benefit, never invent offers, codes or discounts."
)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def _error(message: str, code: str, status: int):
    return jsonify({"error": {"code": code, "message": message}}), status


def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable:
        return None, _error("Auth is unavailable, try again.", "portal_unavailable", 503)
    if not principal:
        return None, _error("Sign in required.", "unauthorized", 401)
    forbidden = ensure_human_principal(principal)
    if forbidden:
        return None, forbidden
    return principal, None


def _can_edit(principal: Dict[str, Any]) -> bool:
    return str(principal.get("role") or "") in EDIT_ROLES


def _with_conn(fn):
    portal_db.ensure_tables()
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            result = fn(cur)
        conn.commit()
        return result
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def _settings_view(settings: Dict[str, Any]) -> Dict[str, Any]:
    view = {key: settings[key] for key in DEFAULT_SETTINGS if key != "last_run_at"}
    view["last_run_at"] = _iso(settings.get("last_run_at"))
    return view


@bp.get("/retention/settings")
def get_retention_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal["client_id"])
    try:
        def _load(cur):
            return load_settings(cur, client_id), active_coupons(cur, client_id)
        settings, coupons = _with_conn(_load)
    except Exception as exc:
        logger.warning("retention settings failed: %s", exc)
        return _error("Retention settings are unavailable right now.", "portal_unavailable", 503)
    return jsonify({
        "settings": _settings_view(settings),
        "defaults": DEFAULT_TEMPLATES,
        "placeholders": list(PLACEHOLDERS),
        "coupons": sorted(coupons.values(), key=lambda c: c["code"]),
        "can_edit": _can_edit(principal),
        "every_minutes": EVERY_MINUTES,
        "cap_max": CAP_MAX,
    }), 200


@bp.put("/retention/settings")
def put_retention_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    if not _can_edit(principal):
        return _error("Only owners and admins can change retention settings.", "forbidden", 403)
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return _error("Send a JSON object.", "bad_request", 400)
    changes: Dict[str, Any] = {}
    for key in ("auto_reorder", "auto_winback", "brain_context"):
        if key in body:
            if not isinstance(body[key], bool):
                return _error(key + " must be true or false.", "bad_request", 400)
            changes[key] = body[key]
    limits = {"daily_cap": (0, CAP_MAX), "cooldown_days": (1, 90),
              "window_start": (0, 23), "window_end": (0, 23)}
    for key, (low, high) in limits.items():
        if key in body:
            value = body[key]
            if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
                return _error(key + " must be a whole number " + str(low) + "-" + str(high) + ".",
                              "bad_request", 400)
            changes[key] = value
    for key, needs in (("tpl_reorder", ""), ("tpl_winback", ""), ("tpl_offer", "code")):
        if key in body:
            text, reason = clean_template(body[key], needs)
            if text is None:
                return _error(reason, "bad_request", 400)
            changes[key] = text
    if "tiers" in body:
        tiers, reason = clean_tiers(body["tiers"])
        if tiers is None:
            return _error(reason, "bad_request", 400)
        changes["tiers"] = tiers
    if not changes:
        return _error("Nothing to change.", "bad_request", 400)
    client_id = int(principal["client_id"])

    def _save(cur):
        if changes.get("tiers"):
            known = active_coupons(cur, client_id)
            missing = [t["coupon"] for t in changes["tiers"] if t["coupon"] and t["coupon"] not in known]
            if missing:
                return None, missing[0]
        columns = sorted(changes)
        values = [json.dumps(changes[c]) if c == "tiers" else changes[c] for c in columns]
        cur.execute(
            "INSERT INTO " + SETTINGS_TABLE + " (client_id, " + ", ".join(columns) + ", updated_at)"
            " VALUES (%s, " + ", ".join("CAST(%s AS JSONB)" if c == "tiers" else "%s" for c in columns)
            + ", NOW()) ON CONFLICT (client_id) DO UPDATE SET "
            + ", ".join(c + " = EXCLUDED." + c for c in columns) + ", updated_at = NOW()",
            tuple([client_id] + values))
        portal_db.log_action(cur, client_id, "retention.settings", "customer_user",
                             principal.get("user_id"), None, ", ".join(columns)[:200])
        return load_settings(cur, client_id), ""

    try:
        settings, missing = _with_conn(_save)
    except Exception as exc:
        logger.warning("retention settings save failed: %s", exc)
        return _error("Retention settings could not be saved right now.", "portal_unavailable", 503)
    if settings is None:
        return _error("Coupon " + missing + " is not an active coupon.", "bad_request", 400)
    return jsonify({"settings": _settings_view(settings)}), 200


@bp.get("/retention/overview")
def get_retention_overview():
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal["client_id"])

    def _load(cur):
        settings = load_settings(cur, client_id)
        planned = plan(cur, client_id, settings)
        links = _read(cur, lambda: _exists(cur, LINKS_TABLE), False)
        outcome = (
            ", (SELECT COUNT(*) FROM " + LINKS_TABLE + " l WHERE l.client_id = s.client_id"
            " AND l.contact_id = s.contact_id AND l.status IN " + PURCHASED_SQL +
            " AND l.created_at > s.created_at"
            " AND l.created_at <= s.created_at + make_interval(days => %s)) AS orders,"
            " (SELECT COALESCE(SUM(l.total), 0) FROM " + LINKS_TABLE + " l"
            " WHERE l.client_id = s.client_id AND l.contact_id = s.contact_id"
            " AND l.status IN " + PURCHASED_SQL + " AND l.created_at > s.created_at"
            " AND l.created_at <= s.created_at + make_interval(days => %s)) AS revenue"
        ) if links else ", 0 AS orders, 0 AS revenue"
        params = ([ATTRIBUTION_DAYS, ATTRIBUTION_DAYS] if links else []) + [client_id, OVERVIEW_DAYS]
        cur.execute(
            "SELECT s.contact_id, s.contact_name, s.kind, s.tier, s.coupon_code, s.mode, s.created_at"
            + outcome + " FROM " + SENDS_TABLE + " s WHERE s.client_id = %s"
            " AND s.created_at > NOW() - make_interval(days => %s)"
            " ORDER BY s.id DESC LIMIT 500", tuple(params))
        return settings, planned, portal_db.rows(cur), sent_last_day(cur, client_id)

    try:
        settings, planned, sends, last_day = _with_conn(_load)
    except Exception as exc:
        logger.warning("retention overview failed: %s", exc)
        return _error("Retention overview is unavailable right now.", "portal_unavailable", 503)
    results: Dict[str, Dict[str, Any]] = {}
    for row in sends:
        bucket = results.setdefault(str(row.get("kind")), {"sent": 0, "returned": 0, "revenue": 0.0})
        bucket["sent"] += 1
        if int(row.get("orders") or 0) > 0:
            bucket["returned"] += 1
            bucket["revenue"] += _money(row.get("revenue"))
    totals = {"sent": sum(b["sent"] for b in results.values()),
              "returned": sum(b["returned"] for b in results.values()),
              "revenue": round(sum(b["revenue"] for b in results.values()), 2)}
    tiers = [{"key": t["key"], "label": t["label"],
              "customers": planned["tiers"].get(t["key"], {}).get("customers", 0),
              "spend": round(planned["tiers"].get(t["key"], {}).get("spend", 0.0), 2)}
             for t in settings["tiers"]]
    return jsonify({
        "days": OVERVIEW_DAYS,
        "attribution_days": ATTRIBUTION_DAYS,
        "customers": planned["customers"],
        "tiers": tiers,
        "due": planned["due"],
        "ready": len(planned["ready"]),
        "skipped": planned["skipped"],
        "sent_last_day": last_day,
        "daily_cap": settings["daily_cap"],
        "auto": {"reorder": settings["auto_reorder"], "winback": settings["auto_winback"]},
        "last_run_at": _iso(settings.get("last_run_at")),
        "results": {kind: {"sent": b["sent"], "returned": b["returned"],
                           "revenue": round(b["revenue"], 2)} for kind, b in results.items()},
        "totals": totals,
        "recent": [{"contact_id": str(r.get("contact_id") or ""),
                    "name": str(r.get("contact_name") or ""),
                    "kind": str(r.get("kind") or ""), "tier": str(r.get("tier") or ""),
                    "coupon": str(r.get("coupon_code") or ""), "mode": str(r.get("mode") or ""),
                    "created_at": _iso(r.get("created_at")),
                    "returned": int(r.get("orders") or 0) > 0}
                   for r in sends[:20]],
    }), 200


@bp.get("/retention/customer")
def get_retention_customer():
    principal, error = _principal_or_error()
    if error:
        return error
    contact = str(request.args.get("contact_id") or "").strip()[:100]
    if not contact:
        return _error("contact_id is required.", "bad_request", 400)
    client_id = int(principal["client_id"])

    def _load(cur):
        import portal_winback

        settings = load_settings(cur, client_id)
        links = purchased_links(cur, client_id, contact).get(contact) or []
        info = _contact_info(cur, client_id, [contact]).get(contact) or {}
        holds = blocked(cur, client_id, [contact], settings["cooldown_days"])
        coupons = active_coupons(cur, client_id)
        cur.execute("SELECT kind, mode, created_at FROM " + SENDS_TABLE +
                    " WHERE client_id = %s AND contact_id = %s ORDER BY id DESC LIMIT 1",
                    (client_id, contact))
        last = portal_db.rows(cur)
        now = _now()
        entry = portal_winback.build_entry(
            [], links[-portal_winback.MAX_PAID:], {"created_at": info.get("last_at")},
            contact, str(info.get("name") or ""), now) if links else None
        return settings, links, info, holds, coupons, (last[0] if last else None), entry, now

    try:
        settings, links, info, holds, coupons, last, entry, now = _with_conn(_load)
    except Exception as exc:
        logger.warning("retention customer failed: %s", exc)
        return _error("Loyalty details are unavailable right now.", "portal_unavailable", 503)
    stats = stats_of(links, now)
    tier, upcoming = tier_for(stats["orders"], stats["spend"], settings["tiers"])
    due = None
    if entry and entry["kind"] in AUTO_KINDS:
        offer = offer_for(tier, coupons)
        due = {"kind": entry["kind"], "item": entry.get("item") or "",
               "message": compose(settings, entry["kind"], str(info.get("name") or ""),
                                  entry.get("item") or stats["favourite"], tier, offer),
               "held": next((name for name in ("opted_out", "open_cart", "in_sequence", "cooldown")
                             if contact in holds[name]), "")}
    return jsonify({
        "contact_id": contact,
        "orders": stats["orders"],
        "spend": stats["spend"],
        "favourite": stats["favourite"],
        "last_order_days": stats["last_order_days"],
        "tier": {"key": tier["key"], "label": tier["label"]} if tier else None,
        "next": ({"label": upcoming["label"],
                  "orders_needed": max(0, upcoming["min_orders"] - stats["orders"]),
                  "spend_needed": round(max(0.0, upcoming["min_spend"] - stats["spend"]), 2)}
                 if upcoming else None),
        "opted_out": contact in holds["opted_out"],
        "due": due,
        "last_send": ({"kind": str(last.get("kind") or ""), "mode": str(last.get("mode") or ""),
                       "created_at": _iso(last.get("created_at"))} if last else None),
    }), 200


@bp.post("/retention/run")
def post_retention_run():
    """Preview (dry_run) or send now - owners / admins; respects the cap,
    opt-outs and cooldowns (not the send window: a person pressed it)."""
    principal, error = _principal_or_error()
    if error:
        return error
    if not _can_edit(principal):
        return _error("Only owners and admins can send retention messages.", "forbidden", 403)
    body = request.get_json(silent=True)
    body = body if isinstance(body, dict) else {}
    dry_run = body.get("dry_run") is not False
    client_id = int(principal["client_id"])
    try:
        result = _with_conn(lambda cur: run(cur, client_id, load_settings(cur, client_id),
                                            "manual", dry_run, principal.get("user_id")))
    except Exception as exc:
        logger.warning("retention run failed: %s", exc)
        return _error("Retention messages could not be prepared right now.", "portal_unavailable", 503)
    return jsonify({
        "dry_run": result["dry_run"],
        "sent": result["sent"],
        "room": result["room"],
        "due": result["due"],
        "skipped": result["skipped"],
        "messages": [{"contact_id": e["contact_id"], "name": e["name"], "kind": e["kind"],
                      "tier": e["tier"], "coupon": e["coupon"], "message": e["message"]}
                     for e in result["would_send"]],
    }), 200
