"""Smart checkout v0: shareable order-summary links the merchant can send to
a customer. Tokenized public view (no auth), server-computed totals,
merchant-marked statuses. No payments provider — the link closes the loop
over chat."""

import csv
import io
import json
import logging
import datetime
import secrets
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request, Response

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db
import portal_growth

bp = Blueprint("portal_checkout", __name__, url_prefix="/api/v1/portal")
public_bp = Blueprint("portal_checkout_public", __name__,
                      url_prefix="/api/v1/public")


@public_bp.get("/checkout/<token>")
def public_checkout_route(token: str):
    payload, status = public_checkout(token)
    if status == 200 and isinstance(payload, dict):
        payload["phone_verification"] = phone_verification_on()
    return jsonify(payload), status

logger = logging.getLogger(__name__)

LINKS_TABLE = "portal_checkout_links"

STATUSES = ("open", "paid", "cancelled", "shipped", "delivered", "returned")
SETTINGS_TABLE = "portal_checkout_settings"
RETURN_REASONS = ("size", "fit", "damaged", "late", "changed_mind", "other")
RETURNS_TABLE = "portal_return_requests"
_RETURNS_DDL_READY = False
NOTIFY_STATUSES = ("paid", "shipped", "delivered", "returned")
DEFAULT_TEMPLATES = {
    "paid": "Payment received for '{title}'. Thank you! Your order is"
            " being prepared.",
    "shipped": "Good news - your order '{title}' has been shipped and is on"
               " its way.",
    "delivered": "Your order '{title}' has been delivered. Thank you for"
                 " shopping with us!",
    "returned": "Your return for '{title}' has been registered. Our team"
                " will contact you shortly about the refund.",
}
_SETTINGS_DDL_READY = False
CART_TABLE = "portal_cart_reminders"
_CART_DDL_READY = False
CART_SEND_CAP = 5
CART_GAP_DEFAULTS = {1: 2, 2: 24, 3: 48}
DEFAULT_CART_TEMPLATES = {
    1: "Assalam o alaikum! You left '{title}' ({total}) in your cart."
       " Complete your order before it runs out of stock.",
    2: "Still thinking about '{title}'? It is reserved for you - reply"
       " here and we will confirm your order right away.",
    3: "Last reminder: your cart '{title}' ({total}) expires soon. Pay"
       " via the checkout link or reply here to place your order.",
}
MAX_ITEMS = 20
MAX_QTY = 99
MAX_TITLE = 120
MONEY_ROLES = ("owner", "admin")
OTP_TABLE = "portal_checkout_otps"
OTP_TTL_MINUTES = 10
OTP_MAX_SENDS = 3
OTP_MAX_ATTEMPTS = 5
_OTP_DDL_READY = False


def _ensure_otp_table(conn) -> None:
    """portal_checkout_otps lands lazily (phone verification at pay)."""
    global _OTP_DDL_READY
    if _OTP_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(OTP_TABLE) + " ("
            " token TEXT PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " contact_id TEXT NOT NULL,"
            " code_hash TEXT NOT NULL,"
            " attempts INT NOT NULL DEFAULT 0,"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"
            ")"
        )
    _OTP_DDL_READY = True


def _otp_hash(token: str, code: str) -> str:
    import hashlib
    return hashlib.sha256((token + ":" + code).encode("utf8")).hexdigest()


def phone_verification_on() -> bool:
    """The platform switch (admin panel), fail-soft off."""
    try:
        import platform_settings
        return platform_settings.flag("phone_verification")
    except Exception:
        return False


def ensure_money_principal(principal: Dict[str, Any],
                           message: Optional[str] = None) -> Optional[Any]:
    """Money guard: only owners/admins may record advances or discounts.
    Agents (and anything else) get a 403 - the server is the boundary."""
    if str(principal.get("role") or "") not in MONEY_ROLES:
        return jsonify({"error": {"code": "forbidden",
                                  "message": message or "Only owners can"
                                                        " record advances"
                                                        " or discounts."}}), 403
    return None

_CHECKOUT_DDL_READY = False


def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": str(error)}}), 503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}), 401)
    return principal, None


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    try:
        return value.isoformat()
    except AttributeError:
        return None


def _ensure_checkout_tables(conn) -> None:
    global _CHECKOUT_DDL_READY
    if _CHECKOUT_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(LINKS_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " contact_id TEXT NOT NULL,"
            " token TEXT NOT NULL UNIQUE,"
            " title TEXT NOT NULL DEFAULT '',"
            " items JSONB NOT NULL DEFAULT '[]'::jsonb,"
            " total NUMERIC(12,2) NOT NULL DEFAULT 0,"
            " status TEXT NOT NULL DEFAULT 'open',"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS portal_checkout_links_client_idx ON "
            + portal_db._q(LINKS_TABLE) + " (client_id, id DESC)"
        )
        cur.execute(
            "ALTER TABLE " + portal_db._q(LINKS_TABLE) +
            " ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,"
            " ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0,"
            " ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(12,2)"
            " NOT NULL DEFAULT 0,"
            " ADD COLUMN IF NOT EXISTS discount NUMERIC(12,2)"
            " NOT NULL DEFAULT 0,"
            " ADD COLUMN IF NOT EXISTS courier TEXT NOT NULL DEFAULT '',"
            " ADD COLUMN IF NOT EXISTS tracking_number"
            " TEXT NOT NULL DEFAULT '',"
            " ADD COLUMN IF NOT EXISTS advance_percent"
            " INTEGER NOT NULL DEFAULT 0,"
            " ADD COLUMN IF NOT EXISTS brand_id BIGINT"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS portal_checkout_brand_idx ON "
            + portal_db._q(LINKS_TABLE) + " (client_id, brand_id)"
        )
    conn.commit()
    _CHECKOUT_DDL_READY = True


def _ensure_settings_table(conn) -> None:
    global _SETTINGS_DDL_READY
    if _SETTINGS_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(SETTINGS_TABLE) +
            " (client_id BIGINT PRIMARY KEY,"
            " notify_enabled BOOLEAN NOT NULL DEFAULT TRUE,"
            " tpl_paid TEXT NOT NULL DEFAULT '',"
            " tpl_shipped TEXT NOT NULL DEFAULT '',"
            " tpl_delivered TEXT NOT NULL DEFAULT '',"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        for column in (
            "cart_enabled BOOLEAN NOT NULL DEFAULT FALSE",
            "cart_gap_1 INTEGER NOT NULL DEFAULT 2",
            "cart_gap_2 INTEGER NOT NULL DEFAULT 24",
            "cart_gap_3 INTEGER NOT NULL DEFAULT 48",
            "cart_tpl_1 TEXT NOT NULL DEFAULT ''",
            "cart_tpl_2 TEXT NOT NULL DEFAULT ''",
            "cart_tpl_3 TEXT NOT NULL DEFAULT ''",
            "tpl_returned TEXT NOT NULL DEFAULT ''",
        ):
            cur.execute(
                "ALTER TABLE " + portal_db._q(SETTINGS_TABLE) +
                " ADD COLUMN IF NOT EXISTS " + column
            )
    conn.commit()
    _SETTINGS_DDL_READY = True


def _load_settings(cur, client_id):
    """Notify settings for the client. Absent row or unreadable table ->
    defaults (enabled, blank templates)."""
    try:
        cur.execute(
            "SELECT notify_enabled, tpl_paid, tpl_shipped, tpl_delivered,"
            " tpl_returned FROM " + portal_db._q(SETTINGS_TABLE) +
            " WHERE client_id = %s",
            (client_id,),
        )
        rows = portal_db.rows(cur)
    except Exception:
        rows = []
    row = rows[0] if rows else {}
    settings = {"notify_enabled": bool(row.get("notify_enabled", True))}
    for key in ("paid", "shipped", "delivered", "returned"):
        settings["tpl_" + key] = str(row.get("tpl_" + key) or "").strip()[:500]
    return settings


def _contact_name(cur, client_id, contact_id):
    """Best-effort display name from the newest conversation with this
    contact; any failure -> empty string (never blocks the update)."""
    try:
        cur.execute(
            "SELECT contact_name FROM " + portal_db._q(portal_db.CONV_TABLE) +
            " WHERE client_id = %s AND contact_id = %s"
            " ORDER BY id DESC LIMIT 1",
            (client_id, contact_id),
        )
        rows = portal_db.rows(cur)
    except Exception:
        return ""
    if not rows:
        return ""
    return str(rows[0].get("contact_name") or "").strip()


def _money(value) -> str:
    """Compact rupee amount: 250.0 -> "250", 99.55 -> "99.55"."""
    try:
        text = str(round(float(value), 2))
    except (TypeError, ValueError):
        return "0"
    if text.endswith(".0"):
        text = text[:-2]
    return text


def _render_body(settings, status, contact_name, title, total, row=None):
    """Fill {name}/{title}/{total}; blank custom template -> default.

    When the link still carries an outstanding balance (advance-COD), the
    paid/shipped/delivered confirmation appends the amount due on delivery
    so the customer is never surprised by the collection."""
    template = str(settings.get("tpl_" + str(status)) or "").strip()
    if not template:
        template = DEFAULT_TEMPLATES.get(str(status), "")
    clean_name = str(contact_name or "").strip()
    first_name = clean_name.split(" ")[0] if clean_name else ""
    body = (template
            .replace("{name}", first_name)
            .replace("{title}", str(title or ""))
            .replace("{total}", str(total if total is not None else "")))
    if row is not None and str(status) in ("paid", "shipped", "delivered"):
        try:
            row_total = round(float(row.get("total") or 0), 2)
            paid = round(float(row.get("paid_amount") or 0), 2)
        except (TypeError, ValueError):
            row_total = paid = 0.0
        balance = max(round(row_total - paid, 2), 0.0)
        if balance > 0:
            body = (body + " Rs " + _money(balance)
                    + " will be collected on delivery.")
    return body[:1000]


def _ensure_cart_table(conn) -> None:
    global _CART_DDL_READY
    if _CART_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(CART_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " link_id BIGINT NOT NULL,"
            " step INTEGER NOT NULL,"
            " sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " UNIQUE (client_id, link_id, step))"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS portal_cart_reminders_client_idx ON "
            + portal_db._q(CART_TABLE) + " (client_id, link_id, step)"
        )
    conn.commit()
    _CART_DDL_READY = True


def _load_cart_settings(cur, client_id):
    """Cart recovery settings. Absent row or unreadable table -> defaults
    (recovery OFF until the merchant turns it on)."""
    try:
        cur.execute(
            "SELECT cart_enabled, cart_gap_1, cart_gap_2, cart_gap_3,"
            " cart_tpl_1, cart_tpl_2, cart_tpl_3 FROM "
            + portal_db._q(SETTINGS_TABLE) + " WHERE client_id = %s",
            (client_id,),
        )
        rows = portal_db.rows(cur)
    except Exception:
        rows = []
    row = rows[0] if rows else {}

    def _gap(key):
        try:
            value = int(row.get(key))
        except (TypeError, ValueError):
            return None
        return value if 1 <= value <= 168 else None

    settings = {
        "cart_enabled": bool(row.get("cart_enabled", False)) if rows else False,
        "cart_gap_1": _gap("cart_gap_1") or CART_GAP_DEFAULTS[1],
        "cart_gap_2": _gap("cart_gap_2") or CART_GAP_DEFAULTS[2],
        "cart_gap_3": _gap("cart_gap_3") or CART_GAP_DEFAULTS[3],
    }
    for key in ("cart_tpl_1", "cart_tpl_2", "cart_tpl_3"):
        settings[key] = str(row.get(key) or "").strip()[:500]
    return settings


def _render_cart_body(settings, step, title, total, name=""):
    """Fill {name}/{title}/{total}; blank custom template -> default."""
    template = str(settings.get("cart_tpl_" + str(step)) or "").strip()
    if not template:
        template = DEFAULT_CART_TEMPLATES.get(int(step), "")
    clean_name = str(name or "").strip()
    first_name = clean_name.split(" ")[0] if clean_name else ""
    return (template
            .replace("{name}", first_name)
            .replace("{title}", str(title or ""))
            .replace("{total}", str(total if total is not None else "")))[:1000]


def materialize_cart_reminders(cur, client_id, conn) -> int:
    """Time-based cart recovery: up to 3 WhatsApp reminders per open
    checkout link, riding the connector tick (like scheduled broadcasts).
    Returns the number of reminders queued. Never raises for missing
    tables - recovery silently stays off on fresh workspaces."""
    settings = _load_cart_settings(cur, client_id)
    if not settings["cart_enabled"]:
        return 0
    _ensure_cart_table(conn)
    sent = 0
    for step in (1, 2, 3):
        if sent >= CART_SEND_CAP:
            break
        gap = settings["cart_gap_" + str(step)]
        cur.execute(
            "SELECT l.id, l.contact_id, l.title, l.total"
            " FROM " + portal_db._q(LINKS_TABLE) + " l"
            " WHERE l.client_id = %s AND l.status = 'open'"
            " AND l.created_at <= NOW() - (%s || ' hours')::interval"
            " AND NOT EXISTS (SELECT 1 FROM " + portal_db._q(CART_TABLE) +
            " r WHERE r.client_id = l.client_id AND r.link_id = l.id"
            " AND r.step = %s)"
            " ORDER BY l.id ASC LIMIT %s",
            (client_id, str(gap), step, CART_SEND_CAP - sent),
        )
        due_rows = portal_db.rows(cur)
        for row in due_rows:
            if sent >= CART_SEND_CAP:
                break
            contact_id = str(row.get("contact_id") or "").strip()
            if not contact_id:
                continue
            name = _contact_name(cur, client_id, contact_id)
            body = _render_cart_body(
                settings, step, row.get("title"), row.get("total"), name)
            portal_growth._send_command(
                cur, client_id, contact_id, name, body, "cart_recovery",
            )
            cur.execute(
                "INSERT INTO " + portal_db._q(CART_TABLE) +
                " (client_id, link_id, step) VALUES (%s, %s, %s)"
                " ON CONFLICT (client_id, link_id, step) DO NOTHING",
                (client_id, int(row.get("id") or 0), step),
            )
            portal_db.log_action(
                cur,
                client_id,
                "cart.recovery_step_" + str(step),
                "system",
                None,
                None,
                ("Cart reminder " + str(step) + " queued")[:200],
            )
            sent += 1
    if sent:
        conn.commit()
    return sent


def _ensure_returns_table(conn) -> None:
    global _RETURNS_DDL_READY
    if _RETURNS_DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(RETURNS_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " link_id BIGINT NOT NULL,"
            " contact_id TEXT NOT NULL,"
            " reason TEXT NOT NULL DEFAULT 'other',"
            " note TEXT NOT NULL DEFAULT '',"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " UNIQUE (client_id, link_id))"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS portal_return_requests_client_idx ON "
            + portal_db._q(RETURNS_TABLE) + " (client_id, id DESC)"
        )
    conn.commit()
    _RETURNS_DDL_READY = True


def _normalize_items(raw: Any) -> Tuple[Optional[List[Dict[str, Any]]], Optional[str]]:
    """Returns (items, error)."""
    if not isinstance(raw, list) or not raw:
        return None, "items (non-empty list) is required."
    if len(raw) > MAX_ITEMS:
        return None, "Max " + str(MAX_ITEMS) + " items per link."
    items: List[Dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            return None, "Each item must be an object."
        name = str(entry.get("name") or "").strip()[:100]
        qty = entry.get("qty", 1)
        price = entry.get("price")
        if not name:
            return None, "Every item needs a name."
        if isinstance(qty, bool) or not isinstance(qty, int) or not (
                1 <= qty <= MAX_QTY):
            return None, "qty must be 1-" + str(MAX_QTY) + "."
        if isinstance(price, bool) or not isinstance(price, (int, float)) or price < 0:
            return None, "price must be 0 or more."
        items.append({"name": name, "qty": qty, "price": round(float(price), 2)})
    return items, None


def _advance_due(row: Dict[str, Any]) -> float:
    """Amount the customer pays now when the link carries an advance."""
    try:
        percent = int(row.get("advance_percent") or 0)
    except (TypeError, ValueError):
        percent = 0
    if percent <= 0:
        return 0.0
    total = round(float(row.get("total") or 0)
                  - float(row.get("paid_amount") or 0), 2)
    return max(round(total * percent / 100.0, 2), 0.0)


def _cod_balance(row: Dict[str, Any]) -> float:
    """Rest that stays collectable on delivery."""
    try:
        percent = int(row.get("advance_percent") or 0)
    except (TypeError, ValueError):
        percent = 0
    if percent <= 0:
        return 0.0
    total = round(float(row.get("total") or 0)
                  - float(row.get("paid_amount") or 0), 2)
    return max(round(total - _advance_due(row), 2), 0.0)


def _public(row: Dict[str, Any]) -> Dict[str, Any]:
    items = row.get("items")
    if not isinstance(items, list):
        items = []
    return {
        "id": int(row.get("id") or 0),
        "token": str(row.get("token") or ""),
        "contact_id": row.get("contact_id"),
        "title": str(row.get("title") or ""),
        "items": [
            {
                "name": str(item.get("name") or ""),
                "qty": int(item.get("qty") or 1),
                "price": float(item.get("price") or 0),
            }
            for item in items if isinstance(item, dict)
        ],
        "total": float(row.get("total") or 0),
        "status": row.get("status") or "open",
        "created_at": _iso(row.get("created_at")),
        "expires_at": _iso(row.get("expires_at")),
        "view_count": int(row.get("view_count") or 0),
        "discount": round(float(row.get("discount") or 0), 2),
        "coupon_code": str(row.get("coupon_code") or ""),
        "coupon_discount": round(float(row.get("coupon_discount") or 0), 2),
        "courier": str(row.get("courier") or ""),
        "tracking_number": str(row.get("tracking_number") or ""),
        "paid_amount": round(float(row.get("paid_amount") or 0), 2),
        "advance_percent": int(row.get("advance_percent") or 0),
        "brand_id": (int(row["brand_id"]) if row.get("brand_id") else None),
        "brand_name": (str(row["brand_name"])
                       if row.get("brand_name") else None),
        "advance_due": _advance_due(row),
        "cod_balance": _cod_balance(row),
        "due": max(
            round(float(row.get("total") or 0)
                  - float(row.get("paid_amount") or 0), 2),
            0.0,
        ),
    }


@bp.post("/checkout/links")
def create_checkout_link():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    contact = str(payload.get("contact_id") or "").strip()[:100]
    title = str(payload.get("title") or "").strip()[:MAX_TITLE]
    items, err = _normalize_items(payload.get("items"))
    if err:
        return jsonify({"error": {"code": "bad_request",
                                  "message": err}}), 400
    if not contact:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contact_id is required."}}), 400
    subtotal = round(sum(item["qty"] * item["price"] for item in items), 2)
    discount_amount = payload.get("discount_amount")
    if discount_amount is not None:
        try:
            discount_amount = round(float(discount_amount), 2)
        except (TypeError, ValueError):
            discount_amount = -1
        if not 0 <= discount_amount <= 100000:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Discount must be between"
                                                 " 0 and 100000."}}), 400
    else:
        discount_amount = 0
    if discount_amount and discount_amount > 0:
        forbidden = ensure_money_principal(principal)
        if forbidden is not None:
            return forbidden
    advance_percent = payload.get("advance_percent")
    if advance_percent is not None:
        try:
            advance_percent = int(advance_percent)
        except (TypeError, ValueError):
            advance_percent = -1
        if not 0 <= advance_percent <= 90:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Advance percent must be"
                                                 " between 0 and 90."}}), 400
    else:
        advance_percent = 0
    total = max(round(subtotal - discount_amount, 2), 0)
    expires_days = payload.get("expires_in_days")
    if expires_days is not None:
        try:
            expires_days = int(expires_days)
        except (TypeError, ValueError):
            expires_days = -1
        if not 1 <= expires_days <= 60:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Expiry must be between"
                                                 " 1 and 60 days."}}), 400
    else:
        expires_days = None
    token = secrets.token_urlsafe(16)
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                import portal_brands

                brand_id = portal_brands.resolve_brand(
                    cur, principal["client_id"],
                    payload.get("brand_id"))
                cur.execute(
                    "INSERT INTO " + portal_db._q(LINKS_TABLE) +
                    " (client_id, contact_id, token, title, items, total,"
                    " discount, expires_at, advance_percent, brand_id)"
                    " VALUES (%s, %s, %s, %s, CAST(%s AS JSONB), %s, %s,"
                    " CASE WHEN %s IS NULL THEN NULL"
                    " ELSE NOW() + (%s * INTERVAL '1 day') END, %s, %s)"
                    " RETURNING id, token, contact_id, title, items, total,"
                    " status, created_at, expires_at, view_count, discount,"
                    " paid_amount, advance_percent, brand_id",
                    (principal["client_id"], contact, token, title,
                     json.dumps(items), total, discount_amount,
                     expires_days, expires_days, advance_percent, brand_id),
                )
                created = portal_db.rows(cur)
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "checkout.created",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Checkout link " + token[:8] + " (" + str(total)
                     + (", advance " + str(advance_percent) + "%"
                        if advance_percent else "") + ")")[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout create failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "checkout create")[0]), 503
    return jsonify({"ok": True, "link": _public(created[0] if created else {})}), 200


@bp.get("/checkout/links")
def list_checkout_links():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                brand_filter = request.args.get("brand_id")
                brand_join = ""
                brand_where = ""
                list_args = [principal["client_id"]]
                if brand_filter not in (None, "", "all"):
                    brand_where = " AND " + portal_db._q(LINKS_TABLE) \
                        + ".brand_id = %s"
                    list_args.append(int(brand_filter))
                if brand_filter is None:
                    brand_join = (" LEFT JOIN portal_brands ON"
                                  " portal_brands.id = "
                                  + portal_db._q(LINKS_TABLE) + ".brand_id")
                cur.execute(
                    "SELECT " + portal_db._q(LINKS_TABLE) +
                    ".id, token, contact_id, title, items, total,"
                    " status, created_at, expires_at, view_count, discount,"
                    " courier, tracking_number, coupon_code,"
                    " coupon_discount, paid_amount, advance_percent,"
                    + portal_db._q(LINKS_TABLE) +
                    ".brand_id, portal_brands.name AS brand_name"
                    " FROM " + portal_db._q(LINKS_TABLE) + brand_join +
                    " WHERE " + portal_db._q(LINKS_TABLE) +
                    ".client_id = %s" + brand_where +
                    " ORDER BY " + portal_db._q(LINKS_TABLE) +
                    ".id DESC LIMIT 30",
                    tuple(list_args),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout list failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "checkout list")[0]), 503
    return jsonify({"links": [_public(row) for row in rows]}), 200


@bp.patch("/checkout/links/<int:link_id>")
def update_checkout_link(link_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    status = payload.get("status")
    if status not in STATUSES:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Pick open, paid, cancelled,"
                                             " shipped, delivered or"
                                             " returned."}}), 400
    return_reason = str(payload.get("reason") or "").strip()
    return_note = str(payload.get("note") or "").strip()[:300]
    if status == "returned" and return_reason not in RETURN_REASONS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Pick a return reason"
                                             " (size, fit, damaged, late,"
                                             " changed_mind or"
                                             " other)."}}), 400
    if status == "paid":
        forbidden = ensure_money_principal(
            principal, "Only owners can mark links paid.")
        if forbidden is not None:
            return forbidden
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(LINKS_TABLE) +
                    " SET status = %s, updated_at = NOW()"
                    " WHERE id = %s AND client_id = %s"
                    " RETURNING token, contact_id, title, total,"
                    " paid_amount, advance_percent",
                    (status, link_id, principal["client_id"]),
                )
                updated = portal_db.rows(cur)
                if not updated:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Link not"
                                                         " found."}}), 404
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "checkout." + str(status),
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Checkout " + str(updated[0].get("token"))[:8]
                     + " -> " + str(status))[:200],
                )
                if status == "returned":
                    try:
                        _ensure_returns_table(conn)
                        cur.execute(
                            "INSERT INTO " + portal_db._q(RETURNS_TABLE) +
                            " (client_id, link_id, contact_id, reason, note)"
                            " VALUES (%s, %s, %s, %s, %s)"
                            " ON CONFLICT (client_id, link_id) DO UPDATE"
                            " SET reason = EXCLUDED.reason,"
                            " note = EXCLUDED.note, created_at = NOW()",
                            (principal["client_id"], link_id,
                             updated[0].get("contact_id"), return_reason,
                             return_note),
                        )
                    except Exception as return_error:
                        logger.warning(
                            "return record failed: %s", return_error)
                notified = False
                if status in NOTIFY_STATUSES:
                    try:
                        settings = _load_settings(cur, principal["client_id"])
                        if settings["notify_enabled"]:
                            name = _contact_name(
                                cur, principal["client_id"],
                                updated[0].get("contact_id"))
                            body = _render_body(
                                settings, str(status), name,
                                updated[0].get("title"),
                                updated[0].get("total"),
                                updated[0])
                            portal_growth._send_command(
                                cur, principal["client_id"],
                                updated[0].get("contact_id"), name, body,
                                "checkout_update",
                            )
                            portal_db.log_action(
                                cur,
                                principal["client_id"],
                                "checkout.notified",
                                "customer_user",
                                principal.get("user_id"),
                                None,
                                ("Order update queued: "
                                 + str(status))[:200],
                            )
                            notified = True
                    except Exception as notify_error:
                        logger.warning(
                            "checkout notify failed: %s", notify_error)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout update failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "checkout update")[0]), 503
    return jsonify({"ok": True, "status": status,
                    "notified": bool(notified)}), 200


@bp.patch("/checkout/links/<int:link_id>/edit")
def edit_checkout_link(link_id: int):
    """Edit title/items of an OPEN checkout link (totals recomputed).
    Paid/shipped/delivered/cancelled links are history - never editable."""
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    title = str(payload.get("title") or "").strip()[:MAX_TITLE]
    items, err = _normalize_items(payload.get("items"))
    if err:
        return jsonify({"error": {"code": "bad_request",
                                  "message": err}}), 400
    if not items:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "At least one item is"
                                             " required."}}), 400
    subtotal = round(sum(item["qty"] * item["price"] for item in items), 2)
    discount_amount = payload.get("discount_amount")
    if discount_amount is not None:
        try:
            discount_amount = round(float(discount_amount), 2)
        except (TypeError, ValueError):
            discount_amount = -1
        if not 0 <= discount_amount <= 100000:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Discount must be between"
                                                 " 0 and 100000."}}), 400
    else:
        discount_amount = 0
    if discount_amount and discount_amount > 0:
        forbidden = ensure_money_principal(principal)
        if forbidden is not None:
            return forbidden
    total = max(round(subtotal - discount_amount, 2), 0)
    expires_days = payload.get("expires_in_days")
    if expires_days is not None:
        try:
            expires_days = int(expires_days)
        except (TypeError, ValueError):
            expires_days = -1
        if not 0 <= expires_days <= 60:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Expiry must be 0 (never)"
                                                 " or 1-60 days."}}), 400
    else:
        expires_days = None
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                set_sql = (
                    "UPDATE " + portal_db._q(LINKS_TABLE) +
                    " SET title = %s, items = CAST(%s AS JSONB),"
                    " total = %s, discount = %s, updated_at = NOW()"
                )
                params = [title, json.dumps(items), total, discount_amount]
                if expires_days is not None:
                    if expires_days == 0:
                        set_sql += ", expires_at = NULL"
                    else:
                        set_sql += (", expires_at = NOW() +"
                                    " (%s * INTERVAL '1 day')")
                        params.append(expires_days)
                set_sql += (" WHERE id = %s AND client_id = %s"
                            " AND status = 'open' RETURNING id")
                params.extend([link_id, principal["client_id"]])
                cur.execute(set_sql, tuple(params))
                updated = portal_db.rows(cur)
                if not updated:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Only open links"
                                                         " can be"
                                                         " edited."}}), 404
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "checkout.edited",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Checkout link " + str(link_id) + " edited ("
                     + str(total) + ")")[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout edit failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "checkout edit")[0]), 503
    return jsonify({"ok": True, "total": total}), 200


@bp.post("/checkout/links/<int:link_id>/duplicate")
def duplicate_checkout_link(link_id: int):
    """Duplicate any checkout link into a NEW open link (re-orders)."""
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT contact_id, title, items, total, discount FROM "
                    + portal_db._q(LINKS_TABLE) +
                    " WHERE id = %s AND client_id = %s",
                    (link_id, principal["client_id"]),
                )
                found = portal_db.rows(cur)
                if not found:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Link not"
                                                         " found."}}), 404
                source = found[0]
                token = secrets.token_urlsafe(16)
                cur.execute(
                    "INSERT INTO " + portal_db._q(LINKS_TABLE) +
                    " (client_id, contact_id, token, title, items, total,"
                    " discount)"
                    " VALUES (%s, %s, %s, %s, %s, %s, %s)"
                    " RETURNING id, token, contact_id, title, items, total,"
                    " status, created_at",
                    (principal["client_id"], source.get("contact_id"),
                     token, source.get("title"), source.get("items"),
                     source.get("total"), source.get("discount")),
                )
                created = portal_db.rows(cur)
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "checkout.duplicated",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Checkout link " + str(link_id) + " duplicated -> "
                     + str((created[0] or {}).get("token"))[:8])[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout duplicate failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "checkout duplicate")[0]), 503
    return jsonify({"ok": True,
                    "link": _public(created[0] if created else {})}), 200


@bp.post("/checkout/links/<int:link_id>/advance")
def add_checkout_advance(link_id: int):
    """Record an advance (partial payment) on an OPEN checkout link.
    The link flips to paid once the advance covers the total."""
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    forbidden = ensure_money_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    try:
        amount = round(float(payload.get("amount")), 2)
    except (TypeError, ValueError):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Enter a valid amount."}}), 400
    if amount <= 0:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Enter an amount greater"
                                             " than zero."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(LINKS_TABLE) +
                    " SET paid_amount = COALESCE(paid_amount, 0) + %s,"
                    " status = CASE WHEN COALESCE(paid_amount, 0) + %s"
                    " >= total THEN 'paid' ELSE status END,"
                    " updated_at = NOW()"
                    " WHERE id = %s AND client_id = %s AND status = 'open'"
                    " RETURNING paid_amount, total, status, contact_id,"
                    " title",
                    (amount, amount, link_id, principal["client_id"]),
                )
                updated = portal_db.rows(cur)
                if not updated:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Only open links"
                                                         " can take an"
                                                         " advance."}}), 404
                new_paid = round(float(updated[0].get("paid_amount") or 0), 2)
                new_total = round(float(updated[0].get("total") or 0), 2)
                if new_paid >= new_total and updated[0].get("contact_id"):
                    try:
                        import portal_memory

                        portal_memory.note_purchase(
                            cur, principal["client_id"],
                            str(updated[0].get("contact_id")),
                        )
                    except Exception:
                        pass
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "checkout.advance",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Advance " + str(amount) + " on link "
                     + str(link_id) + " (paid " + str(new_paid) + "/"
                     + str(new_total) + ")"
                     + (" FULLY PAID"
                        if new_paid >= new_total else ""))[:200],
                )
                if updated[0].get("contact_id"):
                    try:
                        settings = _load_settings(
                            cur, principal["client_id"])
                        if settings["notify_enabled"]:
                            name = _contact_name(
                                cur, principal["client_id"],
                                updated[0].get("contact_id"))
                            if new_paid >= new_total:
                                body = _render_body(
                                    settings, "paid", name,
                                    updated[0].get("title"), new_total)
                            else:
                                due_now = max(
                                    round(new_total - new_paid, 2), 0.0)
                                body = ("Rs " + _money(amount)
                                        + " received for '"
                                        + str(updated[0].get("title") or "")
                                        + "'. Rs " + _money(due_now)
                                        + " will be collected on"
                                          " delivery.")
                            portal_growth._send_command(
                                cur, principal["client_id"],
                                updated[0].get("contact_id"), name, body,
                                "checkout_advance",
                            )
                            portal_db.log_action(
                                cur,
                                principal["client_id"],
                                "checkout.notified",
                                "customer_user",
                                principal.get("user_id"),
                                None,
                                ("Advance confirmation queued (paid "
                                 + str(new_paid) + "/" + str(new_total)
                                 + ").")[:200],
                            )
                    except Exception as notify_error:
                        logger.warning(
                            "advance notify failed: %s", notify_error)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout advance failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "checkout advance")[0]), 503
    new_status = updated[0].get("status") or "open"
    return jsonify({"ok": True, "paid_amount": new_paid,
                    "due": max(round(new_total - new_paid, 2), 0.0),
                    "status": new_status}), 200


@bp.post("/checkout/links/<int:link_id>/share")
def share_checkout_link(link_id: int):
    """Send the checkout link to the customer on WhatsApp (connector queue).
    The message is composed by the dashboard (it owns the public URL)."""
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    message = str(payload.get("message") or "").strip()[:1000]
    if not message:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Write a short message first."
                                  }}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, contact_id, title, status FROM "
                    + portal_db._q(LINKS_TABLE) +
                    " WHERE id = %s AND client_id = %s LIMIT 1",
                    (link_id, principal["client_id"]),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Link not"
                                                         " found."}}), 404
                contact_id = str(rows[0].get("contact_id") or "").strip()
                if not contact_id:
                    return jsonify({"error": {"code": "bad_request",
                                              "message": "This link has no"
                                                         " customer"
                                                         " contact."}}), 400
                name = _contact_name(cur, principal["client_id"],
                                     contact_id)
                portal_growth._send_command(
                    cur, principal["client_id"], contact_id, name,
                    message, "checkout_share",
                )
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "checkout.shared",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Checkout link " + str(link_id) + " sent to "
                     + contact_id[-4:])[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout share failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "checkout share")[0]), 503
    return jsonify({"ok": True}), 200


@bp.patch("/checkout/links/<int:link_id>/tracking")
def set_checkout_tracking(link_id: int):
    """Record courier + tracking number on a checkout link (COD trips)."""
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    courier = str(payload.get("courier") or "").strip()[:40]
    tracking_number = str(payload.get("tracking_number") or "").strip()[:60]
    if not tracking_number:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Enter the tracking"
                                             " number."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(LINKS_TABLE) +
                    " SET courier = %s, tracking_number = %s,"
                    " updated_at = NOW()"
                    " WHERE id = %s AND client_id = %s RETURNING id",
                    (courier, tracking_number, link_id,
                     principal["client_id"]),
                )
                updated = portal_db.rows(cur)
                if not updated:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Link not"
                                                         " found."}}), 404
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "checkout.tracking",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Tracking " + tracking_number[:20] + " via "
                     + (courier or "courier"))[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout tracking failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "checkout tracking")[0]), 503
    return jsonify({"ok": True}), 200


@bp.get("/checkout/settings")
def get_checkout_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_settings_table(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT notify_enabled, tpl_paid, tpl_shipped,"
                    " tpl_delivered, tpl_returned, cart_enabled,"
                    " cart_gap_1, cart_gap_2, cart_gap_3, cart_tpl_1,"
                    " cart_tpl_2, cart_tpl_3 FROM "
                    + portal_db._q(SETTINGS_TABLE) +
                    " WHERE client_id = %s",
                    (principal["client_id"],),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout settings read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "checkout settings")[0]), 503
    row = rows[0] if rows else {}

    def _gap_out(key):
        try:
            value = int(row.get(key))
        except (TypeError, ValueError):
            return None
        return value if 1 <= value <= 168 else None

    cart = {
        "enabled": bool(row.get("cart_enabled", False)),
        "gap_1": _gap_out("cart_gap_1") or CART_GAP_DEFAULTS[1],
        "gap_2": _gap_out("cart_gap_2") or CART_GAP_DEFAULTS[2],
        "gap_3": _gap_out("cart_gap_3") or CART_GAP_DEFAULTS[3],
        "tpl_1": str(row.get("cart_tpl_1") or "").strip()[:500],
        "tpl_2": str(row.get("cart_tpl_2") or "").strip()[:500],
        "tpl_3": str(row.get("cart_tpl_3") or "").strip()[:500],
    }
    return jsonify({
        "ok": True,
        "settings": {
            "notify_enabled": bool(row.get("notify_enabled", True))
                              if rows else True,
            "tpl_paid": str(row.get("tpl_paid") or "").strip()[:500],
            "tpl_shipped": str(row.get("tpl_shipped") or "").strip()[:500],
            "tpl_delivered": str(row.get("tpl_delivered") or "").strip()[:500],
            "tpl_returned": str(row.get("tpl_returned") or "").strip()[:500],
            "cart": cart if rows else {
                "enabled": False,
                "gap_1": CART_GAP_DEFAULTS[1],
                "gap_2": CART_GAP_DEFAULTS[2],
                "gap_3": CART_GAP_DEFAULTS[3],
                "tpl_1": "", "tpl_2": "", "tpl_3": "",
            },
        },
    }), 200


@bp.put("/checkout/settings")
def save_checkout_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    settings_in = payload.get("settings")
    settings_in = settings_in if isinstance(settings_in, dict) else {}
    notify_enabled = settings_in.get("notify_enabled")
    if not isinstance(notify_enabled, bool):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "notify_enabled must be true"
                                             " or false."}}), 400
    templates = {}
    for key in ("paid", "shipped", "delivered", "returned"):
        value = str(settings_in.get("tpl_" + key) or "").strip()
        if len(value) > 500:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Templates are capped at"
                                                 " 500 characters."}}), 400
        templates[key] = value
    cart_in = settings_in.get("cart")
    cart_provided = isinstance(cart_in, dict)
    cart_in = cart_in if cart_provided else {}
    cart_enabled = cart_in.get("enabled") is True
    gaps = {}
    for key in (1, 2, 3):
        if not cart_provided:
            gaps[key] = CART_GAP_DEFAULTS[key]
            continue
        try:
            gap = int(cart_in.get("gap_" + str(key)))
        except (TypeError, ValueError):
            gap = 0
        if not 1 <= gap <= 168:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Reminder gaps are 1 to"
                                                 " 168 hours."}}), 400
        gaps[key] = gap
    cart_templates = {}
    for key in (1, 2, 3):
        value = str(cart_in.get("tpl_" + str(key)) or "").strip()
        if len(value) > 500:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "Templates are capped at"
                                                 " 500 characters."}}), 400
        cart_templates[key] = value
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_settings_table(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(SETTINGS_TABLE) +
                    " (client_id, notify_enabled, tpl_paid, tpl_shipped,"
                    " tpl_delivered, tpl_returned, cart_enabled,"
                    " cart_gap_1, cart_gap_2, cart_gap_3, cart_tpl_1,"
                    " cart_tpl_2, cart_tpl_3, updated_at)"
                    " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,"
                    " %s, %s, NOW())"
                    " ON CONFLICT (client_id) DO UPDATE SET"
                    " notify_enabled = EXCLUDED.notify_enabled,"
                    " tpl_paid = EXCLUDED.tpl_paid,"
                    " tpl_shipped = EXCLUDED.tpl_shipped,"
                    " tpl_delivered = EXCLUDED.tpl_delivered,"
                    " tpl_returned = EXCLUDED.tpl_returned,"
                    " cart_enabled = EXCLUDED.cart_enabled,"
                    " cart_gap_1 = EXCLUDED.cart_gap_1,"
                    " cart_gap_2 = EXCLUDED.cart_gap_2,"
                    " cart_gap_3 = EXCLUDED.cart_gap_3,"
                    " cart_tpl_1 = EXCLUDED.cart_tpl_1,"
                    " cart_tpl_2 = EXCLUDED.cart_tpl_2,"
                    " cart_tpl_3 = EXCLUDED.cart_tpl_3,"
                    " updated_at = NOW()",
                    (principal["client_id"], notify_enabled,
                     templates["paid"], templates["shipped"],
                     templates["delivered"], templates["returned"],
                     cart_enabled,
                     gaps[1], gaps[2], gaps[3],
                     cart_templates[1], cart_templates[2],
                     cart_templates[3]),
                )
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "checkout.settings",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Order update settings: notify="
                     + ("on" if notify_enabled else "off"))[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout settings save failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "checkout settings")[0]), 503
    return jsonify({"ok": True}), 200


def public_checkout(token: str) -> Tuple[Optional[Dict[str, Any]], Optional[int]]:
    """Public (unauthenticated) token lookup. Returns (payload, status)."""
    token = str(token or "").strip()[:64]
    if not token:
        return {"error": {"code": "bad_request",
                          "message": "token is required."}}, 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_checkout_tables(conn)
            with conn.cursor() as cur:
                try:
                    import portal_ratelimit

                    if not portal_ratelimit.allow(
                        cur,
                        "checkout:" + token,
                        portal_ratelimit.checkout_limit(),
                        60,
                    ):
                        conn.commit()
                        return ({"error": {
                            "code": "rate_limited",
                            "message": "Too many requests; try again"
                                       " shortly.",
                        }}, 429)
                except Exception:
                    pass
                cur.execute(
                    "SELECT l.id, l.token, l.contact_id, l.title, l.items,"
                    " l.total, l.status, l.created_at, l.expires_at,"
                    " l.view_count, l.discount, l.courier,"
                    " l.tracking_number, l.coupon_code, l.coupon_discount,"
                    " l.paid_amount, l.advance_percent, l.brand_id,"
                    " b.name AS brand_name"
                    " FROM " + portal_db._q(LINKS_TABLE) + " l"
                    " LEFT JOIN portal_brands b ON b.id = l.brand_id"
                    " WHERE l.token = %s LIMIT 1",
                    (token,),
                )
                rows = portal_db.rows(cur)
                if rows and (rows[0].get("status")
                             or "open") == "open":
                    cur.execute(
                        "UPDATE " + portal_db._q(LINKS_TABLE) +
                        " SET view_count = COALESCE(view_count, 0) + 1"
                        " WHERE token = %s",
                        (token,),
                    )
                    conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout public read failed: %s", error)
        return {"error": {"code": "portal_unavailable",
                          "message": "Try again shortly."}}, 503
    if not rows:
        return {"error": {"code": "not_found",
                          "message": "This order link is not valid."}}, 404
    row = rows[0]
    expires_at = row.get("expires_at")
    if (row.get("status") or "open") == "open" and expires_at is not None:
        now = datetime.datetime.now(datetime.timezone.utc)
        try:
            expired = expires_at < now
        except TypeError:
            expired = str(expires_at) < now.isoformat()
        if expired:
            return {"error": {"code": "not_found",
                              "message": "This order link has"
                                         " expired."}}, 404
    view = _public(row)
    view.pop("contact_id", None)
    view.pop("id", None)
    return view, 200


@bp.get("/checkout/returns")
def list_checkout_returns():
    """Recent returns (newest first, 50) with the linked order summary."""
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_returns_table(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT r.id, r.link_id, r.reason, r.note, r.created_at,"
                    " l.title, l.total FROM " + portal_db._q(RETURNS_TABLE) +
                    " r LEFT JOIN " + portal_db._q(LINKS_TABLE) +
                    " l ON l.id = r.link_id AND l.client_id = r.client_id"
                    " WHERE r.client_id = %s"
                    " ORDER BY r.id DESC LIMIT 50",
                    (principal["client_id"],),
                )
                rows = portal_db.rows(cur)
                cur.execute(
                    "SELECT COUNT(*) AS total FROM "
                    + portal_db._q(RETURNS_TABLE) +
                    " WHERE client_id = %s",
                    (principal["client_id"],),
                )
                count_rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("returns read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "returns read")[0]), 503
    items = []
    for row in rows:
        item = {
            "id": int(row.get("id") or 0),
            "link_id": int(row.get("link_id") or 0),
            "reason": str(row.get("reason") or "other"),
            "note": str(row.get("note") or ""),
            "created_at": _iso(row.get("created_at")),
            "title": str(row.get("title") or ""),
            "total": float(row.get("total") or 0),
        }
        items.append(item)
    total = 0
    if count_rows:
        try:
            total = int(count_rows[0].get("total") or 0)
        except (TypeError, ValueError):
            total = 0
    return jsonify({"ok": True, "returns": items,
                    "counts": {"total": total}}), 200


@bp.get("/checkout/returns/export")
def returns_export():
    """Returns ledger (newest first, 2000) as a CSV download."""
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_returns_table(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT r.created_at, l.title, l.total, r.reason, r.note"
                    " FROM " + portal_db._q(RETURNS_TABLE) + " r"
                    " LEFT JOIN " + portal_db._q(LINKS_TABLE) +
                    " l ON l.id = r.link_id AND l.client_id = r.client_id"
                    " WHERE r.client_id = %s"
                    " ORDER BY r.id DESC LIMIT 2000",
                    (principal["client_id"],),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("returns export failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "returns export")[0]), 503
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["date", "order", "amount", "reason", "note"])
    for row in found:
        writer.writerow([
            row.get("created_at").date().isoformat()
            if row.get("created_at") else "",
            row.get("title"),
            row.get("total"),
            row.get("reason"),
            row.get("note"),
        ])
    return Response(
        buffer.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition":
                 "attachment; filename=omniflow-returns.csv"},
    )


@public_bp.post("/checkout/<token>/otp")
def public_checkout_otp(token: str):
    """Send the order-verification code to the customer on WhatsApp."""
    if not phone_verification_on():
        return jsonify({"error": {"code": "feature_off",
                                  "message": "Phone verification is not"
                                             " enabled."}}), 409
    token = str(token or "").strip()[:64]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_checkout_tables(conn)
            _ensure_otp_table(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, client_id, contact_id, status FROM "
                    + portal_db._q(LINKS_TABLE) +
                    " WHERE token = %s LIMIT 1",
                    (token,),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "This order link"
                                                         " is not"
                                                         " valid."}}), 404
                link = rows[0]
                if (link.get("status") or "open") != "open":
                    return jsonify({"error": {"code": "bad_request",
                                              "message": "This order is"
                                                         " already"
                                                         " settled."}}), 400
                contact_id = str(link.get("contact_id") or "")
                if not contact_id:
                    return jsonify({"error": {"code": "bad_request",
                                              "message": "This order has"
                                                         " no customer"
                                                         " contact."}}), 400
                cur.execute(
                    "SELECT COUNT(*) AS n FROM " + portal_db._q(OTP_TABLE)
                    + " WHERE token = %s AND created_at > NOW()"
                    " - INTERVAL '15 minutes'", (token,),
                )
                recent = int(portal_db.rows(cur)[0]["n"])
                if recent >= OTP_MAX_SENDS:
                    return jsonify({"error": {"code": "rate_limited",
                                              "message": "Too many codes"
                                                         " - wait a few"
                                                         " minutes."}}), 429
                code = "".join(str(secrets.randbelow(10))
                               for _ in range(6))
                cur.execute(
                    "INSERT INTO " + portal_db._q(OTP_TABLE) +
                    " (token, client_id, contact_id, code_hash, attempts,"
                    " created_at) VALUES (%s, %s, %s, %s, 0, NOW())"
                    " ON CONFLICT (token) DO UPDATE SET code_hash ="
                    " EXCLUDED.code_hash, attempts = 0, created_at ="
                    " NOW()",
                    (token, link.get("client_id"), contact_id,
                     _otp_hash(token, code)),
                )
                name = _contact_name(cur, link.get("client_id"),
                                     contact_id)
                portal_growth._send_command(
                    cur, link.get("client_id"), contact_id, name,
                    "Your verification code is " + code
                    + " (valid " + str(OTP_TTL_MINUTES)
                    + " minutes). Do not share it.",
                    "phone_otp",
                )
                portal_db.log_action(
                    cur, link.get("client_id"), "checkout.otp_sent",
                    "system", None, None,
                    ("Phone OTP sent for link token "
                     + token[:8])[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout otp send failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "phone verification")[0]), 503
    return jsonify({"ok": True, "sent": True}), 200


@public_bp.post("/checkout/<token>/otp/verify")
def public_checkout_otp_verify(token: str):
    """Verify the code the customer typed (attempts capped)."""
    if not phone_verification_on():
        return jsonify({"error": {"code": "feature_off",
                                  "message": "Phone verification is not"
                                             " enabled."}}), 409
    token = str(token or "").strip()[:64]
    payload = request.get_json(silent=True) or {}
    code = str(payload.get("code") or "").strip()
    if not code.isdigit() or len(code) != 6:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Enter the 6-digit code."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_otp_table(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT code_hash, attempts, created_at FROM "
                    + portal_db._q(OTP_TABLE) +
                    " WHERE token = %s LIMIT 1", (token,),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Request a code"
                                                         " first."}}), 404
                row = rows[0]
                if int(row.get("attempts") or 0) >= OTP_MAX_ATTEMPTS:
                    return jsonify({"error": {"code": "rate_limited",
                                              "message": "Too many tries"
                                                         " - request a new"
                                                         " code."}}), 429
                cur.execute(
                    "UPDATE " + portal_db._q(OTP_TABLE) +
                    " SET attempts = attempts + 1 WHERE token = %s",
                    (token,),
                )
                valid = (
                    _otp_hash(token, code) == str(row.get("code_hash"))
                    and str(row.get("created_at")) != ""
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("checkout otp verify failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "phone verification")[0]), 503
    if not valid:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "That code is not right -"
                                             " check the WhatsApp"
                                             " message."}}), 400
    return jsonify({"ok": True, "verified": True}), 200
