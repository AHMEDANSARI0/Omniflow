"""Sales agent (§237): qualify, objections, compare, quotes, lead updates.

The pieces already existed separately (negotiation limits, product
recommendations, checkout links + share, recovery follow-ups, the CRM
pipeline, agent personas). This module joins them into one sales layer:

* QUALIFY - a deterministic read of the customer's recent messages:
  product (matched against the active catalog), quantity, city
  (OF_SALES_CITIES), budget, timeline and payment preference, plus the
  shared intelligence purchase intent and any quote / purchase. Score
  0-100 (hot / warm / cold) and the next detail worth asking
  (settings.qualifiers order). Stored per conversation in
  portal_sales_leads by the ingest hook (inbound messages only).
* OBJECTIONS - nine concern kinds (price, trust, delivery time, delivery
  cost, cash on delivery, size / fit, quality, compare, later) detected in
  English + Roman Urdu. The owner writes one APPROVED ANSWER per kind
  (portal_sales_playbook); a suggestion is shown but never used until the
  owner saves and enables it.
* AI - the brain gets a short SALES note (stage, known / missing details,
  ask_next, the current concern + the owner's approved answer, a product
  comparison when two catalog items are mentioned). Prices come only from
  the catalog and discounts are never offered (brain policy unchanged).
* QUOTES - POST /sales/quotes prices items from the catalog (never typed),
  keeps a discount within the owner's negotiation limit (owners / admins
  only, like every checkout discount) and creates a normal checkout link,
  so recovery already follows up when it is not paid.
* LEAD UPDATES - with auto_stage on, the pipeline moves forward only
  (new -> interested -> negotiating); won / lost stay the owner's.

Fail-soft: every optional read sits in its own savepoint; a missing table
means "unknown", never an error.
"""

import json
import logging
import os
import re
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

logger = logging.getLogger("omniflow.portal-sales")

bp = Blueprint("portal_sales", __name__, url_prefix="/api/v1/portal")

SETTINGS_TABLE = "portal_sales_settings"
PLAYBOOK_TABLE = "portal_sales_playbook"
LEADS_TABLE = "portal_sales_leads"


def _env_int(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(os.environ.get(name, "") or default)
    except ValueError:
        value = default
    return max(low, min(high, value))


MESSAGES = _env_int("OF_SALES_MESSAGES", 20, 3, 60)
OBJECTION_MESSAGES = _env_int("OF_SALES_OBJECTION_MESSAGES", 6, 1, 20)
CATALOG_TTL = _env_int("OF_SALES_CATALOG_TTL", 300, 0, 3600)
CATALOG_MAX = _env_int("OF_SALES_CATALOG_MAX", 300, 10, 2000)
QUOTE_CATALOG = _env_int("OF_SALES_QUOTE_CATALOG", 50, 5, 200)
QUOTE_DAYS = _env_int("OF_SALES_QUOTE_DAYS", 3, 1, 60)
QUOTE_LOOKBACK_DAYS = _env_int("OF_SALES_QUOTE_LOOKBACK_DAYS", 14, 1, 120)
OVERVIEW_DAYS = _env_int("OF_SALES_OVERVIEW_DAYS", 30, 1, 365)
OVERVIEW_LEADS = _env_int("OF_SALES_OVERVIEW_LEADS", 30, 5, 200)
REPLY_MAX = _env_int("OF_SALES_REPLY_MAX", 600, 40, 2000)
HOT_AT = _env_int("OF_SALES_HOT_AT", 70, 1, 100)
WARM_AT = _env_int("OF_SALES_WARM_AT", 40, 1, 100)
EDIT_ROLES = tuple(
    item.strip() for item in
    (os.environ.get("OF_SALES_ROLES", "owner,admin") or "owner,admin").split(",")
    if item.strip())

QUALIFIERS = ("product", "quantity", "city", "budget", "timeline", "payment")
DEFAULT_QUALIFIERS = ["product", "quantity", "city"]
QUALIFIER_LABELS = {
    "product": "Product", "quantity": "Quantity", "city": "City",
    "budget": "Budget", "timeline": "When needed", "payment": "Payment",
}

DEFAULT_CITIES = (
    "karachi,lahore,islamabad,rawalpindi,faisalabad,multan,peshawar,quetta,"
    "hyderabad,sialkot,gujranwala,sukkur,bahawalpur,abbottabad,sargodha,"
    "sahiwal,mardan,larkana,rahim yar khan,okara,gujrat,jhelum,mirpur,"
    "muzaffarabad,dera ghazi khan,sheikhupura,kasur,nawabshah,gilgit,chitral")
CITIES = tuple(
    item.strip().lower() for item in
    (os.environ.get("OF_SALES_CITIES", DEFAULT_CITIES) or DEFAULT_CITIES).split(",")
    if item.strip())

#: Concern kinds (English + Roman Urdu patterns, matched on word starts).
OBJECTIONS: Dict[str, Dict[str, Any]] = {
    "price": {"label": "Price is too high", "patterns": (
        r"mehn?g", r"mahn?g", r"expensive", r"costly", r"too much",
        r"price (?:zyada|ziada|high|kam)", r"rate kam", r"kam kar",
        r"discount", r"last price", r"final price", r"best price", r"ghat")},
    "trust": {"label": "Is it genuine / can I trust you", "patterns": (
        r"original", r"asli", r"fake", r"nakli", r"copy hai", r"genuine",
        r"trust", r"bharosa", r"scam", r"fraud", r"dhoka")},
    "delivery_time": {"label": "How long is delivery", "patterns": (
        r"kitne din", r"kitnay din", r"kab tak", r"kab mil", r"delivery time",
        r"how long", r"how many days", r"when will i get")},
    "delivery_cost": {"label": "Delivery charges", "patterns": (
        r"delivery charge", r"shipping charge", r"delivery fee",
        r"free delivery", r"delivery free", r"shipping cost")},
    "cod": {"label": "Cash on delivery / advance", "patterns": (
        r"cash on delivery", r"\bcod\b", r"advance (?:kyun|kyu|kiu|why)",
        r"pehle payment", r"payment pehle", r"pay first")},
    "size_fit": {"label": "Size / fit", "patterns": (
        r"size", r"fitting", r"\bfit\b", r"measurement", r"naap",
        r"chota", r"bara ho")},
    "quality": {"label": "Quality / material", "patterns": (
        r"quality", r"material", r"kapra", r"kapda", r"durable", r"pakka hai",
        r"warranty", r"guarantee")},
    "compare": {"label": "Cheaper elsewhere / comparing", "patterns": (
        r"dusri jagah", r"doosri jagah", r"other shop", r"sasta mil",
        r"cheaper", r"daraz", r"market mein kam", r"compare")},
    "later": {"label": "Will think / buy later", "patterns": (
        r"soch k", r"soch ke", r"sochta", r"sochti", r"baad mein", r"bad mein",
        r"later", r"think about", r"abhi nahi", r"phir bataun")},
}
OBJECTION_KINDS = tuple(OBJECTIONS)
_OBJECTION_RE = {
    kind: re.compile(r"(?<![a-z0-9])(?:" + "|".join(spec["patterns"]) + r")")
    for kind, spec in OBJECTIONS.items()}

#: Starter answers the owner may adopt (shown as a suggestion, never used by
#: the AI until the owner saves them). Safe wording: no prices, no promises.
SUGGESTIONS = {
    "price": "Ji price ki fikr samajh sakte hain. Is item mein jo quality aur"
             " finishing he woh isi rate ke qabil he. Chahein to aap ko kuch"
             " aur options bhi dikha dete hain.",
    "trust": "Bilkul jaiz sawal he. Hum asal product hi bhejte hain - aap"
             " hamare purane customers ke reviews dekh sakte hain.",
    "delivery_time": "Order confirm hone ke baad delivery ka waqt aap ke shehar"
                     " par depend karta he - hum aap ko confirm kar ke batate"
                     " hain.",
    "delivery_cost": "Delivery charges aap ke shehar aur order ke hisab se"
                     " lagte hain - order confirm karte waqt total bata dete"
                     " hain.",
    "cod": "Payment ke options order confirm karte waqt bata dete hain -"
           " aap ko jo aasan ho.",
    "size_fit": "Size chart bhej dete hain - apna naap bata dein to sahi size"
                " suggest kar dete hain.",
    "quality": "Material aur quality ki tafseel bhej dete hain, sath pictures"
               " bhi.",
    "compare": "Shukriya batane ka. Hamare product ki quality aur service ka"
               " farq aap khud mehsoos karenge - koi sawal ho to zaroor"
               " poochein.",
    "later": "Koi masla nahi, aaram se soch lein. Koi sawal ho to hum yahin"
             " hain.",
}

_NUMBER_WORDS = {"ek": 1, "aik": 1, "do": 2, "teen": 3, "char": 4, "chaar": 4,
                 "paanch": 5, "panch": 5, "che": 6, "chay": 6, "saat": 7,
                 "aath": 8, "nau": 9, "das": 10}
_UNITS = (r"pcs|pc|pieces?|qty|units?|items?|wale|wali|dozen|darjan|packs?|"
          r"boxes?|bottles?|sets?|pairs?|jore|joray|kg|kilo")
_QTY_RE = re.compile(r"(?<![\d,.])(\d{1,3})\s*(?:x\s*)?(?:" + _UNITS + r")\b")
_QTY_KEY_RE = re.compile(r"\b(?:qty|quantity)\s*[:=]?\s*(\d{1,3})\b")
_QTY_WORD_RE = re.compile(
    r"\b(" + "|".join(_NUMBER_WORDS) + r")\s+(?:" + _UNITS + r")\b")
_BUDGET_RE = re.compile(
    r"\b(?:budget|under|within|max|maximum)\s*(?:is|hai|he|of|tak)?\s*"
    r"(?:rs\.?|pkr|rupees?)?\s*(\d[\d,]{2,8})")
_BUDGET_TAK_RE = re.compile(
    r"(\d[\d,]{2,8})\s*(?:rs\.?|pkr|rupees?)?\s*(?:tak|ke andar|se kam|under)\b")
_URGENT = ("urgent", "jaldi", "asap", "aaj", "today", "abhi chahiye",
           "kal tak", "tomorrow", "kal chahiye")
_SOON = ("is hafte", "this week", "agle hafte", "next week", "eid",
         "shadi", "wedding", "is mahine")
_COD_WORDS = ("cash on delivery", "delivery pe payment", "delivery par payment")
_ONLINE_WORDS = ("online", "easypaisa", "easy paisa", "jazzcash", "jazz cash",
                 "bank transfer", "card", "raast")
_STOP = frozenset(("the", "and", "for", "with", "new", "set", "pack", "size",
                   "color", "colour", "wala", "wali", "small", "large"))
_TOKEN_RE = re.compile(r"[a-z0-9]{3,}")

BOUGHT_STATUSES = ("paid", "advance_paid", "shipped", "delivered")
STAGE_ORDER = {"new": 0, "interested": 1, "negotiating": 2}

_CATALOG_CACHE: Dict[int, Tuple[float, List[Dict[str, Any]]]] = {}


def _table(module: str, attr: str, default: str) -> str:
    """Another feature's (configurable) table name, imported lazily."""
    try:
        return str(getattr(__import__(module), attr))
    except Exception:
        return default

_DDL = (
    "CREATE TABLE IF NOT EXISTS " + SETTINGS_TABLE + " ("
    " client_id BIGINT PRIMARY KEY,"
    " auto_stage BOOLEAN NOT NULL DEFAULT FALSE,"
    " brain_context BOOLEAN NOT NULL DEFAULT TRUE,"
    " qualifiers JSONB NOT NULL DEFAULT '[\"product\", \"quantity\", \"city\"]'::jsonb,"
    " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());"
    "CREATE TABLE IF NOT EXISTS " + PLAYBOOK_TABLE + " ("
    " client_id BIGINT NOT NULL,"
    " kind TEXT NOT NULL,"
    " reply TEXT NOT NULL DEFAULT '',"
    " enabled BOOLEAN NOT NULL DEFAULT TRUE,"
    " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
    " PRIMARY KEY (client_id, kind));"
    "CREATE TABLE IF NOT EXISTS " + LEADS_TABLE + " ("
    " client_id BIGINT NOT NULL,"
    " conversation_id BIGINT NOT NULL,"
    " contact_id TEXT NOT NULL DEFAULT '',"
    " score INT NOT NULL DEFAULT 0,"
    " label TEXT NOT NULL DEFAULT 'cold',"
    " stage_hint TEXT NOT NULL DEFAULT 'new',"
    " qualifiers JSONB NOT NULL DEFAULT '{}'::jsonb,"
    " objections JSONB NOT NULL DEFAULT '{}'::jsonb,"
    " bought BOOLEAN NOT NULL DEFAULT FALSE,"
    " last_message_id BIGINT NOT NULL DEFAULT 0,"
    " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
    " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
    " PRIMARY KEY (client_id, conversation_id));"
    "CREATE INDEX IF NOT EXISTS portal_sales_leads_score_idx ON "
    + LEADS_TABLE + " (client_id, updated_at DESC)"
)


def _ensure_ddl(cur) -> None:
    """Create the tables when missing (no commit - safe inside the ingest
    transaction). Checked every call, never cached: a rolled-back first
    transaction must not leave a "ready" flag behind."""
    cur.execute("SELECT to_regclass(%s) IS NOT NULL AND to_regclass(%s) IS NOT NULL"
                " AND to_regclass(%s) IS NOT NULL AS ready",
                (SETTINGS_TABLE, PLAYBOOK_TABLE, LEADS_TABLE))
    row = cur.fetchone()
    ready = row.get("ready") if isinstance(row, dict) else (row[0] if row else False)
    if not ready:
        cur.execute(_DDL)


def _exists(cur, table: str) -> bool:
    cur.execute("SELECT to_regclass(%s) AS t", (table,))
    row = cur.fetchone()
    value = row.get("t") if isinstance(row, dict) else (row[0] if row else None)
    return bool(value)


def _read(cur, fn, fallback):
    """One optional read in its own savepoint (missing table -> fallback)."""
    try:
        with portal_txn.savepoint(cur, None, "of_sales") as guard:
            value = fn()
        return fallback if guard.failed else value
    except Exception as error:
        logger.info("sales read skipped: %s", error)
        return fallback


def _norm(text: Any) -> str:
    return " ".join(str(text or "").lower().split())


def _money(value: Any) -> Optional[float]:
    try:
        number = float(str(value).replace(",", ""))
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


# ---------------------------------------------------------------------------
# Settings + playbook
# ---------------------------------------------------------------------------

def clean_qualifiers(raw: Any) -> Optional[List[str]]:
    if not isinstance(raw, list):
        return None
    out: List[str] = []
    for item in raw:
        if item in QUALIFIERS and item not in out:
            out.append(item)
    return out


def load_settings(cur, client_id: int) -> Dict[str, Any]:
    cur.execute("SELECT auto_stage, brain_context, qualifiers FROM " + SETTINGS_TABLE
                + " WHERE client_id = %s", (client_id,))
    rows = portal_db.rows(cur)
    row = rows[0] if rows else {}
    qualifiers = row.get("qualifiers")
    if isinstance(qualifiers, str):
        try:
            qualifiers = json.loads(qualifiers)
        except ValueError:
            qualifiers = None
    return {"auto_stage": row.get("auto_stage") is True,
            "brain_context": row.get("brain_context") is not False,
            "qualifiers": clean_qualifiers(qualifiers) if qualifiers is not None
            else list(DEFAULT_QUALIFIERS)}


def load_playbook(cur, client_id: int) -> Dict[str, Dict[str, Any]]:
    cur.execute("SELECT kind, reply, enabled, updated_at FROM " + PLAYBOOK_TABLE
                + " WHERE client_id = %s", (client_id,))
    return {str(row["kind"]): row for row in portal_db.rows(cur)
            if row.get("kind") in OBJECTIONS}


def playbook_view(saved: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    out = []
    for kind in OBJECTION_KINDS:
        row = saved.get(kind) or {}
        reply = str(row.get("reply") or "")
        out.append({"kind": kind, "label": OBJECTIONS[kind]["label"],
                    "reply": reply,
                    "enabled": bool(reply) and row.get("enabled") is not False,
                    "suggestion": SUGGESTIONS.get(kind, "")})
    return out


def approved_answer(saved: Dict[str, Dict[str, Any]], kind: str) -> str:
    row = saved.get(kind) or {}
    reply = str(row.get("reply") or "").strip()
    return reply if reply and row.get("enabled") is not False else ""


# ---------------------------------------------------------------------------
# Qualification (deterministic)
# ---------------------------------------------------------------------------

def catalog(cur, client_id: int) -> List[Dict[str, Any]]:
    """Active catalog items (cached per process for OF_SALES_CATALOG_TTL)."""
    now = time.time()
    hit = _CATALOG_CACHE.get(client_id)
    if hit and CATALOG_TTL and now - hit[0] < CATALOG_TTL:
        return hit[1]

    def fetch():
        table = _table("portal_catalog", "CATALOG_TABLE", "portal_catalog")
        if not _exists(cur, table):
            return []
        cur.execute(
            "SELECT id, name, price, price_text, stock, notes FROM " + portal_db._q(table) +
            " WHERE client_id = %s AND is_active IS TRUE ORDER BY id DESC LIMIT %s",
            (client_id, CATALOG_MAX))
        items = []
        for row in portal_db.rows(cur):
            name = str(row.get("name") or "").strip()
            if not name:
                continue
            tokens = [t for t in _TOKEN_RE.findall(name.lower()) if t not in _STOP]
            items.append({"id": int(row["id"]), "name": name,
                          "price": _money(row.get("price")),
                          "price_text": str(row.get("price_text") or ""),
                          "stock": int(row.get("stock") or 0),
                          "notes": str(row.get("notes") or "")[:160],
                          "_tokens": tokens})
        return items

    items = _read(cur, fetch, [])
    _CATALOG_CACHE[client_id] = (now, items)
    return items


def match_products(text: str, items: List[Dict[str, Any]], limit: int = 3) -> List[Dict[str, Any]]:
    """Catalog items the text mentions: the full name, or every significant
    word of the name. Longer names first (more specific)."""
    low = " " + _norm(text) + " "
    words = set(_TOKEN_RE.findall(low))
    found = []
    for item in items:
        name = _norm(item["name"])
        full = (" " + name + " ") in low or (len(name) >= 4 and re.search(
            r"(?<![a-z0-9])" + re.escape(name) + r"(?![a-z0-9])", low))
        tokens = item.get("_tokens") or []
        if full or (tokens and all(t in words for t in tokens)):
            found.append(item)
    found.sort(key=lambda item: -len(item["name"]))
    return found[:limit]


def extract(texts: List[str]) -> Dict[str, Any]:
    """Qualifiers found in the customer's messages (newest wins)."""
    out: Dict[str, Any] = {}
    for raw in texts:  # oldest -> newest
        low = _norm(raw)
        if not low:
            continue
        qty = None
        for regex in (_QTY_KEY_RE, _QTY_RE):
            match = regex.search(low)
            if match:
                qty = int(match.group(1))
                break
        if qty is None:
            match = _QTY_WORD_RE.search(low)
            if match:
                qty = _NUMBER_WORDS.get(match.group(1))
        if qty and 0 < qty <= 999:
            out["quantity"] = qty
        for city in CITIES:
            if re.search(r"(?<![a-z])" + re.escape(city) + r"(?![a-z])", low):
                out["city"] = city.title()
                break
        match = _BUDGET_RE.search(low) or _BUDGET_TAK_RE.search(low)
        if match:
            amount = _money(match.group(1))
            if amount and amount >= 100:
                out["budget"] = amount
        if any(word in low for word in _URGENT):
            out["timeline"] = "urgent"
        elif any(word in low for word in _SOON) and out.get("timeline") != "urgent":
            out["timeline"] = "soon"
        if re.search(r"(?<![a-z])cod(?![a-z])", low) or any(w in low for w in _COD_WORDS):
            out["payment"] = "cod"
        elif any(re.search(r"(?<![a-z])" + re.escape(w) + r"(?![a-z])", low)
                 for w in _ONLINE_WORDS):
            out["payment"] = "online"
    return out


def objections_in(text: str) -> List[str]:
    low = _norm(text)
    return [kind for kind in OBJECTION_KINDS if _OBJECTION_RE[kind].search(low)]


def score(signals: Dict[str, Any]) -> int:
    points = {"high": 40, "medium": 25, "low": 10}.get(
        str(signals.get("purchase_intent") or ""), 0)
    qualifiers = signals.get("qualifiers") or {}
    points += 20 if qualifiers.get("product") else 0
    points += 10 if qualifiers.get("quantity") else 0
    points += 10 if qualifiers.get("city") else 0
    points += 5 if qualifiers.get("budget") else 0
    points += {"urgent": 10, "soon": 5}.get(str(qualifiers.get("timeline") or ""), 0)
    points += 5 if qualifiers.get("payment") else 0
    points += 10 if signals.get("quote_open") else 0
    if signals.get("bought"):
        points = 100
    return max(0, min(100, points))


def label_for(value: int) -> str:
    return "hot" if value >= HOT_AT else "warm" if value >= WARM_AT else "cold"


def stage_hint(signals: Dict[str, Any]) -> str:
    if signals.get("bought"):
        return "won"
    if signals.get("quote_open") or "price" in (signals.get("objection_kinds") or []):
        return "negotiating"
    if (signals.get("qualifiers") or {}).get("product") or str(
            signals.get("purchase_intent") or "") in ("medium", "high"):
        return "interested"
    return "new"


def ask_next(signals: Dict[str, Any], wanted: List[str]) -> Optional[str]:
    """The first configured detail still unknown - only for a buying chat."""
    buying = (signals.get("qualifiers") or {}).get("product") or str(
        signals.get("purchase_intent") or "") in ("medium", "high") or signals.get(
        "objection_kinds")
    if not buying or signals.get("bought"):
        return None
    known = signals.get("qualifiers") or {}
    for key in wanted:
        if not known.get(key):
            return key
    return None


def analyze(cur, client_id: int, conversation_id: int,
            contact_id: str = "") -> Optional[Dict[str, Any]]:
    """Fresh sales signals for one conversation (None = unknown chat)."""
    cur.execute("SELECT contact_id, contact_name FROM " + portal_db._q(portal_db.CONV_TABLE)
                + " WHERE id = %s AND client_id = %s", (conversation_id, client_id))
    rows = portal_db.rows(cur)
    if not rows:
        return None
    contact_id = str(rows[0].get("contact_id") or contact_id or "")
    cur.execute(
        "SELECT id, body, created_at FROM " + portal_db._q(portal_db.MSGS_TABLE) +
        " WHERE client_id = %s AND conversation_id = %s AND direction = 'in'"
        " ORDER BY id DESC LIMIT %s", (client_id, conversation_id, MESSAGES))
    inbound = list(reversed(portal_db.rows(cur)))
    texts = [str(m.get("body") or "") for m in inbound]
    qualifiers = extract(texts)
    items = catalog(cur, client_id)
    products: List[Dict[str, Any]] = []
    for text in reversed(texts):  # newest mention first
        for item in match_products(text, items):
            if all(p["id"] != item["id"] for p in products):
                products.append(item)
        if len(products) >= 3:
            break
    if products:
        qualifiers["product"] = ", ".join(p["name"] for p in products[:3])

    objections: Dict[str, Dict[str, Any]] = {}
    for message in inbound[-OBJECTION_MESSAGES:]:
        for kind in objections_in(message.get("body") or ""):
            entry = objections.setdefault(kind, {"count": 0, "last_message_id": 0})
            entry["count"] += 1
            entry["last_message_id"] = int(message["id"])
    latest_kinds = objections_in(texts[-1]) if texts else []

    def intent():
        table = _table("portal_intelligence", "TABLE", "portal_intelligence")
        if not _exists(cur, table):
            return ""
        cur.execute("SELECT purchase_intent FROM " + portal_db._q(table) +
                    " WHERE client_id = %s AND conversation_id = %s",
                    (client_id, conversation_id))
        found = portal_db.rows(cur)
        return str((found[0] if found else {}).get("purchase_intent") or "")

    def links():
        table = _table("portal_checkout", "LINKS_TABLE", "portal_checkout_links")
        if not contact_id or not _exists(cur, table):
            return []
        cur.execute(
            "SELECT id, title, total, status, token, created_at FROM " + portal_db._q(table) +
            " WHERE client_id = %s AND contact_id = %s"
            " AND created_at > NOW() - make_interval(days => %s)"
            " ORDER BY id DESC LIMIT 5", (client_id, contact_id, QUOTE_LOOKBACK_DAYS))
        return portal_db.rows(cur)

    purchase_intent = _read(cur, intent, "")
    recent = _read(cur, links, [])
    bought = any(str(r.get("status") or "") in BOUGHT_STATUSES for r in recent)
    quote_open = any(str(r.get("status") or "") == "open" for r in recent)
    signals: Dict[str, Any] = {
        "conversation_id": conversation_id,
        "contact_id": contact_id,
        "contact_name": str(rows[0].get("contact_name") or ""),
        "qualifiers": qualifiers,
        "products": [{k: v for k, v in p.items() if not k.startswith("_")} for p in products],
        "purchase_intent": purchase_intent,
        "objections": objections,
        "objection_kinds": sorted(objections),
        "current_objections": latest_kinds,
        "quote_open": quote_open,
        "bought": bought,
        "quotes": [{"id": int(r["id"]), "title": str(r.get("title") or ""),
                    "total": float(r.get("total") or 0), "status": str(r.get("status") or ""),
                    "token": str(r.get("token") or "")} for r in recent[:3]],
        "last_message_id": int(inbound[-1]["id"]) if inbound else 0,
    }
    signals["score"] = score(signals)
    signals["label"] = label_for(signals["score"])
    signals["stage_hint"] = stage_hint(signals)
    return signals


def store(cur, client_id: int, signals: Dict[str, Any]) -> None:
    cur.execute(
        "INSERT INTO " + LEADS_TABLE + " (client_id, conversation_id, contact_id, score,"
        " label, stage_hint, qualifiers, objections, bought, last_message_id)"
        " VALUES (%s, %s, %s, %s, %s, %s, CAST(%s AS JSONB), CAST(%s AS JSONB), %s, %s)"
        " ON CONFLICT (client_id, conversation_id) DO UPDATE SET"
        " contact_id = EXCLUDED.contact_id, score = EXCLUDED.score,"
        " label = EXCLUDED.label, stage_hint = EXCLUDED.stage_hint,"
        " qualifiers = EXCLUDED.qualifiers,"
        # concerns accumulate across the whole chat ({kind: last message id})
        " objections = " + LEADS_TABLE + ".objections || EXCLUDED.objections,"
        " bought = " + LEADS_TABLE + ".bought OR EXCLUDED.bought,"
        " last_message_id = EXCLUDED.last_message_id, updated_at = NOW()",
        (client_id, signals["conversation_id"], signals["contact_id"], signals["score"],
         signals["label"], signals["stage_hint"],
         json.dumps(signals["qualifiers"], default=str),
         json.dumps({k: v["last_message_id"] for k, v in signals["objections"].items()}),
         bool(signals["bought"]), signals["last_message_id"]))


_STAGE_DDL = (
    # same table as portal_pipeline._ensure_stage_table (no commit here)
    "CREATE TABLE IF NOT EXISTS portal_contact_stage (id BIGSERIAL PRIMARY KEY,"
    " client_id BIGINT NOT NULL, contact_id TEXT NOT NULL,"
    " stage TEXT NOT NULL DEFAULT 'new',"
    " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (client_id, contact_id))")


def advance_stage(cur, client_id: int, contact_id: str, target: str) -> bool:
    """Move the pipeline forward only (never back, never from won / lost)."""
    if not contact_id or target not in ("interested", "negotiating"):
        return False
    if not _exists(cur, "portal_contact_stage"):
        cur.execute(_STAGE_DDL)
    lower = [stage for stage, rank in STAGE_ORDER.items() if rank < STAGE_ORDER[target]]
    cur.execute(
        "INSERT INTO portal_contact_stage (client_id, contact_id, stage)"
        " VALUES (%s, %s, %s) ON CONFLICT (client_id, contact_id) DO UPDATE"
        " SET stage = EXCLUDED.stage, updated_at = NOW()"
        " WHERE portal_contact_stage.stage = ANY(%s) RETURNING id",
        (client_id, contact_id, target, lower))
    moved = bool(portal_db.rows(cur))
    if moved:
        # same note shape as the board move (workflow triggers parse it)
        portal_db.log_action(cur, client_id, "pipeline.stage_changed", "system", None,
                             None, "Contact moved to '" + target + "': " + contact_id + ".")
    return moved


def on_inbound(cur, client_id: int, conversation_id: Optional[int],
               contact_id: str = "") -> Optional[Dict[str, Any]]:
    """Ingest hook (inbound messages): refresh the lead, maybe move the
    pipeline. Runs inside the caller's savepoint; never commits."""
    if not conversation_id:
        return None
    _ensure_ddl(cur)
    signals = analyze(cur, client_id, int(conversation_id), contact_id)
    if not signals:
        return None
    store(cur, client_id, signals)
    settings = load_settings(cur, client_id)
    if settings["auto_stage"] and signals["stage_hint"] in ("interested", "negotiating"):
        signals["stage_moved"] = _read(cur, lambda: advance_stage(
            cur, client_id, signals["contact_id"], signals["stage_hint"]), False)
    return signals


# ---------------------------------------------------------------------------
# Brain context
# ---------------------------------------------------------------------------

def context_for(cur, client_id: int, conversation_id: int, contact_id: str,
                message_text: str) -> Optional[Dict[str, Any]]:
    """The SALES note for the brain, or None (switched off / not a sale)."""
    _ensure_ddl(cur)
    settings = load_settings(cur, client_id)
    if not settings["brain_context"]:
        return None
    signals = analyze(cur, client_id, conversation_id, contact_id)
    if not signals:
        return None
    current = objections_in(message_text) or signals["current_objections"]
    nxt = ask_next(signals, settings["qualifiers"])
    if not (signals["qualifiers"] or current or nxt or signals["quote_open"]):
        return None
    note: Dict[str, Any] = {
        "stage": signals["stage_hint"],
        "known": {key: value for key, value in signals["qualifiers"].items()},
        "ask_next": QUALIFIER_LABELS.get(nxt, "") if nxt else "",
        "quote_sent": signals["quote_open"],
    }
    if current:
        saved = load_playbook(cur, client_id)
        kind = current[0]
        note["objection"] = {"kind": kind, "concern": OBJECTIONS[kind]["label"],
                             "approved_answer": approved_answer(saved, kind)}
    mentioned = match_products(message_text, catalog(cur, client_id), limit=3)
    if len(mentioned) >= 2:
        note["compare"] = [compare_row(item) for item in mentioned]
    return note


def compare_row(item: Dict[str, Any]) -> Dict[str, Any]:
    return {"name": item["name"],
            "price": item["price"] if item["price"] is not None else (item["price_text"] or None),
            "in_stock": item["stock"] > 0 if item["stock"] else None,
            "notes": item["notes"]}


SALES_RULES = (
    " CONTEXT may include SALES notes for this chat: the stage, what the customer"
    " already told you (known), the one detail worth asking next (ask_next), the"
    " concern they raised (objection) with the OWNER'S APPROVED ANSWER, and a"
    " product comparison (compare). Answer the customer's question first; then,"
    " if ask_next is set, ask for that ONE detail only - never re-ask a known one."
    " When objection.approved_answer is present, address the concern with that"
    " answer in the customer's language and add no new claims. When compare is"
    " present, compare only the listed fields. Never state a price that is not in"
    " CONTEXT and never offer a discount."
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


@bp.get("/sales/settings")
def get_sales_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        data = _with_conn(lambda cur: (load_settings(cur, principal["client_id"]),
                                       load_playbook(cur, principal["client_id"])))
    except Exception as err:
        return jsonify(portal_db.portal_unavailable(err, "sales settings")[0]), 503
    settings, saved = data
    return jsonify({"settings": settings, "playbook": playbook_view(saved),
                    "qualifiers": [{"key": k, "label": QUALIFIER_LABELS[k]} for k in QUALIFIERS],
                    "can_edit": _can_edit(principal)}), 200


@bp.put("/sales/settings")
def put_sales_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    if not _can_edit(principal):
        return _error("Only owners and admins can change sales settings.", "forbidden", 403)
    payload = request.get_json(silent=True) or {}
    for key in ("auto_stage", "brain_context"):
        if key in payload and not isinstance(payload[key], bool):
            return _error(key + " must be true or false.", "bad_request", 400)
    qualifiers = None
    if "qualifiers" in payload:
        qualifiers = clean_qualifiers(payload["qualifiers"])
        if qualifiers is None or len(qualifiers) != len(payload["qualifiers"]):
            return _error("qualifiers must be a list of: " + ", ".join(QUALIFIERS) + ".",
                          "bad_request", 400)
    client_id = principal["client_id"]

    def save(cur):
        current = load_settings(cur, client_id)
        merged = {"auto_stage": payload.get("auto_stage", current["auto_stage"]),
                  "brain_context": payload.get("brain_context", current["brain_context"]),
                  "qualifiers": qualifiers if qualifiers is not None else current["qualifiers"]}
        cur.execute(
            "INSERT INTO " + SETTINGS_TABLE + " (client_id, auto_stage, brain_context, qualifiers)"
            " VALUES (%s, %s, %s, CAST(%s AS JSONB)) ON CONFLICT (client_id) DO UPDATE SET"
            " auto_stage = EXCLUDED.auto_stage, brain_context = EXCLUDED.brain_context,"
            " qualifiers = EXCLUDED.qualifiers, updated_at = NOW()",
            (client_id, merged["auto_stage"], merged["brain_context"],
             json.dumps(merged["qualifiers"])))
        portal_db.log_action(cur, client_id, "sales.settings", "customer_user",
                             principal.get("user_id"), None,
                             ("Sales settings: auto stage %s, AI notes %s, ask %s" % (
                                 "on" if merged["auto_stage"] else "off",
                                 "on" if merged["brain_context"] else "off",
                                 ", ".join(merged["qualifiers"]) or "nothing"))[:200])
        return merged

    try:
        merged = _with_conn(save)
    except Exception as err:
        return jsonify(portal_db.portal_unavailable(err, "sales settings save")[0]), 503
    return jsonify({"ok": True, "settings": merged}), 200


@bp.put("/sales/playbook/<kind>")
def put_sales_playbook(kind: str):
    principal, error = _principal_or_error()
    if error:
        return error
    if kind not in OBJECTIONS:
        return _error("Unknown concern.", "not_found", 404)
    if not _can_edit(principal):
        return _error("Only owners and admins can change approved answers.", "forbidden", 403)
    payload = request.get_json(silent=True) or {}
    reply = " ".join(str(payload.get("reply") or "").split())
    enabled = payload.get("enabled", True)
    if not isinstance(enabled, bool):
        return _error("enabled must be true or false.", "bad_request", 400)
    if len(reply) > REPLY_MAX:
        return _error("Keep the answer under %d characters." % REPLY_MAX, "bad_request", 400)
    client_id = principal["client_id"]

    def save(cur):
        cur.execute(
            "INSERT INTO " + PLAYBOOK_TABLE + " (client_id, kind, reply, enabled)"
            " VALUES (%s, %s, %s, %s) ON CONFLICT (client_id, kind) DO UPDATE SET"
            " reply = EXCLUDED.reply, enabled = EXCLUDED.enabled, updated_at = NOW()",
            (client_id, kind, reply, enabled))
        portal_db.log_action(cur, client_id, "sales.playbook", "customer_user",
                             principal.get("user_id"), None,
                             ("Approved answer for '%s' %s" % (
                                 OBJECTIONS[kind]["label"],
                                 "cleared" if not reply else
                                 ("saved" if enabled else "saved (off)")))[:200])
        return playbook_view(load_playbook(cur, client_id))

    try:
        view = _with_conn(save)
    except Exception as err:
        return jsonify(portal_db.portal_unavailable(err, "sales playbook save")[0]), 503
    return jsonify({"ok": True, "playbook": view}), 200


def _negotiation_max(cur, client_id: int) -> int:
    """The owner's negotiation ceiling (portal_negotiation; same defaults).
    Unreadable -> 0, so a quote can never carry a discount by accident."""
    def read():
        import portal_negotiation

        if not _exists(cur, portal_negotiation.NEGOTIATION_TABLE):
            return int(portal_negotiation.DEFAULT_MAX)
        return int(portal_negotiation._load_settings(cur, client_id)["max_percent"])
    return _read(cur, read, 0)


def _lead_view(signals: Dict[str, Any], settings: Dict[str, Any],
               saved: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    nxt = ask_next(signals, settings["qualifiers"])
    concerns = []
    for kind in signals["objection_kinds"]:
        concerns.append({"kind": kind, "label": OBJECTIONS[kind]["label"],
                         "count": signals["objections"][kind]["count"],
                         "current": kind in signals["current_objections"],
                         "approved_answer": approved_answer(saved, kind),
                         "suggestion": SUGGESTIONS.get(kind, "")})
    known = []
    for key in QUALIFIERS:
        if signals["qualifiers"].get(key):
            known.append({"key": key, "label": QUALIFIER_LABELS[key],
                          "value": signals["qualifiers"][key]})
    missing = [{"key": key, "label": QUALIFIER_LABELS[key]} for key in settings["qualifiers"]
               if not signals["qualifiers"].get(key)]
    return {"conversation_id": signals["conversation_id"], "contact_id": signals["contact_id"],
            "contact_name": signals["contact_name"], "score": signals["score"],
            "label": signals["label"], "stage_hint": signals["stage_hint"],
            "purchase_intent": signals["purchase_intent"], "known": known,
            "missing": missing, "ask_next": QUALIFIER_LABELS.get(nxt, "") if nxt else "",
            "concerns": concerns, "products": signals["products"],
            "quotes": signals["quotes"], "bought": signals["bought"]}


@bp.get("/sales/conversations/<int:conversation_id>")
def get_sales_conversation(conversation_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = principal["client_id"]

    def work(cur):
        signals = analyze(cur, client_id, conversation_id)
        if not signals:
            return None
        store(cur, client_id, signals)
        settings = load_settings(cur, client_id)
        saved = load_playbook(cur, client_id)
        items = catalog(cur, client_id)
        mentioned = {p["id"] for p in signals["products"]}
        choices = sorted((i for i in items if i["price"] is not None),
                         key=lambda i: (i["id"] not in mentioned, i["name"].lower()))
        return {"lead": _lead_view(signals, settings, saved),
                "catalog": [{"id": i["id"], "name": i["name"], "price": i["price"],
                             "stock": i["stock"]} for i in choices[:QUOTE_CATALOG]],
                "max_discount_percent": _negotiation_max(cur, client_id),
                "can_discount": _can_money(principal),
                "quote_days": QUOTE_DAYS}

    try:
        data = _with_conn(work)
    except Exception as err:
        return jsonify(portal_db.portal_unavailable(err, "sales lead")[0]), 503
    if data is None:
        return _error("Conversation not found.", "not_found", 404)
    return jsonify(data), 200


def _can_money(principal: Dict[str, Any]) -> bool:
    try:
        import portal_checkout

        return str(principal.get("role") or "") in portal_checkout.MONEY_ROLES
    except Exception:
        return False


@bp.get("/sales/overview")
def get_sales_overview():
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = principal["client_id"]

    def work(cur):
        # a link paid after the last message counts too (live, not stored)
        links = _table("portal_checkout", "LINKS_TABLE", "portal_checkout_links")
        bought = "l.bought"
        if _exists(cur, links):
            bought = ("(l.bought OR EXISTS (SELECT 1 FROM " + portal_db._q(links) + " k"
                      " WHERE k.client_id = l.client_id AND k.contact_id = l.contact_id"
                      " AND k.status = ANY(%(paid)s) AND k.created_at > l.created_at"
                      " - make_interval(days => %(look)s)))")
        params = {"cid": client_id, "days": OVERVIEW_DAYS, "limit": OVERVIEW_LEADS,
                  "paid": list(BOUGHT_STATUSES), "look": QUOTE_LOOKBACK_DAYS}
        where = (" WHERE l.client_id = %(cid)s"
                 " AND l.updated_at > NOW() - make_interval(days => %(days)s)")
        cur.execute(
            "SELECT l.conversation_id, l.contact_id, l.score, l.label, l.stage_hint,"
            " l.qualifiers, l.objections, " + bought + " AS bought, l.updated_at,"
            " c.contact_name FROM " + LEADS_TABLE + " l JOIN " + portal_db._q(portal_db.CONV_TABLE) +
            " c ON c.id = l.conversation_id AND c.client_id = l.client_id"
            + where + " ORDER BY 8 ASC, l.score DESC, l.updated_at DESC LIMIT %(limit)s", params)
        leads = portal_db.rows(cur)
        cur.execute(
            "SELECT o.key AS kind, COUNT(*) AS chats,"
            " COUNT(*) FILTER (WHERE " + bought + ") AS bought"
            " FROM " + LEADS_TABLE + " l, jsonb_each(l.objections) o"
            + where + " GROUP BY o.key", params)
        concerns = {str(r["kind"]): r for r in portal_db.rows(cur)}
        cur.execute(
            "SELECT l.label, COUNT(*) AS n, COUNT(*) FILTER (WHERE " + bought + ") AS bought"
            " FROM " + LEADS_TABLE + " l" + where + " GROUP BY l.label", params)
        counts = {str(r["label"]): r for r in portal_db.rows(cur)}
        saved = load_playbook(cur, client_id)
        return leads, concerns, counts, saved

    try:
        leads, concerns, counts, saved = _with_conn(work)
    except Exception as err:
        return jsonify(portal_db.portal_unavailable(err, "sales overview")[0]), 503
    out_leads = []
    for row in leads:
        qualifiers = row.get("qualifiers") if isinstance(row.get("qualifiers"), dict) else {}
        objections = row.get("objections") if isinstance(row.get("objections"), dict) else {}
        out_leads.append({
            "conversation_id": int(row["conversation_id"]),
            "contact_name": str(row.get("contact_name") or row.get("contact_id") or ""),
            "score": int(row.get("score") or 0), "label": str(row.get("label") or "cold"),
            "stage_hint": str(row.get("stage_hint") or "new"),
            "product": str(qualifiers.get("product") or ""),
            "concerns": [OBJECTIONS[k]["label"] for k in objections if k in OBJECTIONS],
            "bought": row.get("bought") is True,
            "updated_at": row["updated_at"].isoformat() if row.get("updated_at") else None})
    stats = []
    for kind in OBJECTION_KINDS:
        row = concerns.get(kind)
        if not row:
            continue
        chats = int(row.get("chats") or 0)
        bought = int(row.get("bought") or 0)
        stats.append({"kind": kind, "label": OBJECTIONS[kind]["label"], "chats": chats,
                      "bought": bought,
                      "rate": round(bought * 100.0 / chats) if chats else 0,
                      "has_answer": bool(approved_answer(saved, kind))})
    stats.sort(key=lambda s: -s["chats"])
    totals = {label: {"chats": int((counts.get(label) or {}).get("n") or 0),
                      "bought": int((counts.get(label) or {}).get("bought") or 0)}
              for label in ("hot", "warm", "cold")}
    return jsonify({"days": OVERVIEW_DAYS, "leads": out_leads, "concerns": stats,
                    "totals": totals}), 200


@bp.post("/sales/quotes")
def create_sales_quote():
    """A catalog-priced checkout link for this chat (recovery follows up)."""
    principal, error = _principal_or_error()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    try:
        conversation_id = int(payload.get("conversation_id"))
    except (TypeError, ValueError):
        return _error("conversation_id is required.", "bad_request", 400)
    raw_items = payload.get("items")
    if not isinstance(raw_items, list) or not raw_items or len(raw_items) > 10:
        return _error("Pick 1 to 10 products.", "bad_request", 400)
    wanted: List[Tuple[int, int]] = []
    for entry in raw_items:
        try:
            item_id = int((entry or {}).get("catalog_id"))
            qty = int((entry or {}).get("qty", 1))
        except (TypeError, ValueError, AttributeError):
            return _error("Each product needs catalog_id and qty.", "bad_request", 400)
        if not 1 <= qty <= 99:
            return _error("Quantity must be 1 to 99.", "bad_request", 400)
        wanted.append((item_id, qty))
    discount_pct = payload.get("discount_percent", 0)
    if isinstance(discount_pct, bool) or not isinstance(discount_pct, (int, float)) \
            or not 0 <= discount_pct <= 90:
        return _error("discount_percent must be 0 to 90.", "bad_request", 400)
    days = payload.get("expires_in_days", QUOTE_DAYS)
    if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= 60:
        return _error("expires_in_days must be 1 to 60.", "bad_request", 400)
    if discount_pct > 0 and not _can_money(principal):
        return _error("Only owners and admins can give a discount.", "forbidden", 403)
    client_id = principal["client_id"]

    def work(cur):
        import portal_checkout
        import secrets

        # its own DDL commits - run it before anything else in this request
        portal_checkout._ensure_checkout_tables(cur.connection)
        cur.execute("SELECT contact_id FROM " + portal_db._q(portal_db.CONV_TABLE)
                    + " WHERE id = %s AND client_id = %s", (conversation_id, client_id))
        conv = portal_db.rows(cur)
        if not conv:
            return ("not_found", None)
        contact_id = str(conv[0].get("contact_id") or "")
        table = _table("portal_catalog", "CATALOG_TABLE", "portal_catalog")
        if not _exists(cur, table):
            return ("bad", "Your catalog is empty.")
        ids = [item_id for item_id, _ in wanted]
        cur.execute("SELECT id, name, price FROM " + portal_db._q(table) +
                    " WHERE client_id = %s AND id = ANY(%s) AND is_active IS TRUE",
                    (client_id, ids))
        found = {int(r["id"]): r for r in portal_db.rows(cur)}
        items = []
        for item_id, qty in wanted:
            row = found.get(item_id)
            if not row:
                return ("bad", "A product is not in your active catalog.")
            price = _money(row.get("price"))
            if price is None:
                return ("bad", "Set a price for '%s' in the catalog first." % row.get("name"))
            items.append({"name": str(row["name"])[:80], "qty": qty, "price": round(price, 2)})
        limit = _negotiation_max(cur, client_id)
        if discount_pct > limit:
            return ("bad", "The discount is above your negotiation limit (%d%%)." % limit)
        subtotal = round(sum(i["qty"] * i["price"] for i in items), 2)
        discount = round(subtotal * float(discount_pct) / 100.0, 2)
        total = max(round(subtotal - discount, 2), 0)
        title = str(payload.get("title") or "").strip()[:80] or (
            "Quote: " + ", ".join(i["name"] for i in items))[:80]
        token = secrets.token_urlsafe(16)
        cur.execute(
            "INSERT INTO " + portal_db._q(portal_checkout.LINKS_TABLE) + " (client_id, contact_id, token, title, items,"
            " total, discount, expires_at)"
            " VALUES (%s, %s, %s, %s, CAST(%s AS JSONB), %s, %s,"
            " NOW() + (%s * INTERVAL '1 day'))"
            " RETURNING id, token, contact_id, title, items, total, status, created_at,"
            " expires_at, view_count, discount, paid_amount, advance_percent",
            (client_id, contact_id, token, title, json.dumps(items), total, discount, days))
        created = portal_db.rows(cur)[0]
        portal_db.log_action(cur, client_id, "sales.quote", "customer_user",
                             principal.get("user_id"), conversation_id,
                             ("Quote %s for %s (%s%s)" % (
                                 token[:8], contact_id, total,
                                 ", %s%% off" % discount_pct if discount_pct else ""))[:200])
        signals = analyze(cur, client_id, conversation_id, contact_id)
        if signals:
            store(cur, client_id, signals)
            if load_settings(cur, client_id)["auto_stage"]:
                _read(cur, lambda: advance_stage(cur, client_id, contact_id, "negotiating"),
                      False)
        return ("ok", portal_checkout._public(created))

    try:
        status, data = _with_conn(work)
    except Exception as err:
        return jsonify(portal_db.portal_unavailable(err, "sales quote")[0]), 503
    if status == "not_found":
        return _error("Conversation not found.", "not_found", 404)
    if status == "bad":
        return _error(data, "bad_request", 400)
    return jsonify({"ok": True, "link": data}), 200
