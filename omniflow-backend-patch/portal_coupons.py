"""Coupon codes: customer-facing discounts on checkout links.

The owner defines codes (percent or fixed, optional minimum spend, usage
limit and expiry) in Settings. The customer applies a code on the public
order page; the link's total is reduced server-side and every application
is counted, so usage limits hold even if codes are shared in family
WhatsApp groups. Removing a coupon restores the previous total. Owner-set
discounts and coupons are tracked separately (discount vs coupon_discount)
and combine additively, never below zero.
"""

import logging
import re

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db
import portal_checkout
from typing import Any, Dict, Optional, Tuple

bp = Blueprint("portal_coupons", __name__, url_prefix="/api/v1/portal")
public_bp = Blueprint("portal_coupons_public", __name__,
                      url_prefix="/api/v1/public")

logger = logging.getLogger(__name__)

COUPONS_TABLE = "portal_coupons"
CODE_RE = re.compile(r"^[A-Z0-9]{3,24}$")
KINDS = ("percent", "fixed")
MAX_PERCENT = 90
MAX_VALUE = 100000
MAX_EXPIRY_DAYS = 365
LIST_LIMIT = 100

_DDL_READY = False


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


def _ensure_coupons_tables(conn) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(COUPONS_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " code TEXT NOT NULL,"
            " kind TEXT NOT NULL,"
            " value NUMERIC(12,2) NOT NULL,"
            " min_total NUMERIC(12,2) NOT NULL DEFAULT 0,"
            " usage_limit INTEGER,"
            " used_count INTEGER NOT NULL DEFAULT 0,"
            " expires_at TIMESTAMPTZ,"
            " is_active BOOLEAN NOT NULL DEFAULT TRUE,"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " UNIQUE (client_id, code))"
        )
        cur.execute(
            "ALTER TABLE " + portal_db._q(portal_checkout.LINKS_TABLE) +
            " ADD COLUMN IF NOT EXISTS coupon_code TEXT NOT NULL DEFAULT '',"
            " ADD COLUMN IF NOT EXISTS coupon_discount NUMERIC(12,2)"
            " NOT NULL DEFAULT 0"
        )
    conn.commit()
    _DDL_READY = True


def _iso(value: Any) -> Optional[str]:
    return value.isoformat() if hasattr(value, "isoformat") else None


def _num(value: Any) -> float:
    try:
        return round(float(value or 0), 2)
    except (TypeError, ValueError):
        return 0.0


def _public(row: Dict[str, Any]) -> Dict[str, Any]:
    limit = row.get("usage_limit")
    return {
        "id": int(row.get("id") or 0),
        "code": str(row.get("code") or ""),
        "kind": str(row.get("kind") or "fixed"),
        "value": _num(row.get("value")),
        "minTotal": _num(row.get("min_total")),
        "usageLimit": int(limit) if limit is not None else None,
        "usedCount": int(row.get("used_count") or 0),
        "expiresAt": _iso(row.get("expires_at")),
        "isActive": row.get("is_active") is True,
    }


def validate_coupon(payload: Any) -> Tuple[Optional[Dict[str, Any]],
                                           Optional[str]]:
    """Returns (clean, error)."""
    if not isinstance(payload, dict):
        return None, "code, kind and value are required."
    code = str(payload.get("code") or "").strip().upper()
    if not CODE_RE.match(code):
        return None, "Code must be 3-24 letters or numbers."
    kind = str(payload.get("kind") or "").strip().lower()
    if kind not in KINDS:
        return None, "kind must be percent or fixed."
    value = payload.get("value")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None, "value must be a number."
    value = round(float(value), 2)
    if kind == "percent" and not 1 <= value <= MAX_PERCENT:
        return None, ("Percent must be between 1 and "
                      + str(MAX_PERCENT) + ".")
    if kind == "fixed" and not 0.5 <= value <= MAX_VALUE:
        return None, "Amount must be between 0.5 and " + str(MAX_VALUE) + "."
    min_total = payload.get("min_total", 0)
    if isinstance(min_total, bool) or not isinstance(min_total, (int, float)) \
            or not 0 <= float(min_total) <= MAX_VALUE:
        return None, "min_total must be between 0 and " + str(MAX_VALUE) + "."
    usage_limit = payload.get("usage_limit")
    if usage_limit is not None:
        if isinstance(usage_limit, bool) or not isinstance(usage_limit, int) \
                or not 1 <= usage_limit <= MAX_VALUE:
            return None, "usage_limit must be a whole number 1 or more."
    expires_in_days = payload.get("expires_in_days")
    if expires_in_days is not None:
        if isinstance(expires_in_days, bool) \
                or not isinstance(expires_in_days, int) \
                or not 1 <= expires_in_days <= MAX_EXPIRY_DAYS:
            return None, ("expires_in_days must be a whole number between 1"
                          " and " + str(MAX_EXPIRY_DAYS) + ".")
    return ({"code": code, "kind": kind, "value": value,
             "min_total": round(float(min_total), 2),
             "usage_limit": usage_limit,
             "expires_in_days": expires_in_days}), None


@bp.get("/coupons")
def list_coupons():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_coupons_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, code, kind, value, min_total, usage_limit,"
                    " used_count, expires_at, is_active FROM "
                    + portal_db._q(COUPONS_TABLE) +
                    " WHERE client_id = %s ORDER BY id DESC LIMIT "
                    + str(LIST_LIMIT),
                    (principal["client_id"],),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("coupons list failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "coupons read")[0]), 503
    return jsonify({"coupons": [_public(row) for row in rows]}), 200


@bp.post("/coupons")
def create_coupon():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    clean, err = validate_coupon(request.get_json(silent=True) or {})
    if err:
        return jsonify({"error": {"code": "bad_request", "message": err}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_coupons_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id FROM " + portal_db._q(COUPONS_TABLE) +
                    " WHERE client_id = %s AND code = %s LIMIT 1",
                    (principal["client_id"], clean["code"]),
                )
                if portal_db.rows(cur):
                    return jsonify({"error": {"code": "conflict",
                                              "message": "A coupon with this"
                                                         " code already"
                                                         " exists."}}), 409
                cur.execute(
                    "INSERT INTO " + portal_db._q(COUPONS_TABLE) +
                    " (client_id, code, kind, value, min_total, usage_limit,"
                    " expires_at)"
                    " VALUES (%s, %s, %s, %s, %s, %s,"
                    " CASE WHEN %s IS NULL THEN NULL"
                    " ELSE NOW() + (%s * INTERVAL '1 day') END)"
                    " RETURNING id, code, kind, value, min_total,"
                    " usage_limit, used_count, expires_at, is_active",
                    (principal["client_id"], clean["code"], clean["kind"],
                     clean["value"], clean["min_total"], clean["usage_limit"],
                     clean["expires_in_days"], clean["expires_in_days"]),
                )
                created = portal_db.rows(cur)
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "coupon.created",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Coupon " + clean["code"] + " ("
                     + clean["kind"] + " " + str(clean["value"]) + ")")[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("coupon create failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "coupon create")[0]), 503
    return jsonify({"ok": True,
                    "coupon": _public(created[0] if created else {})}), 200


@bp.patch("/coupons/<int:coupon_id>")
def update_coupon(coupon_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    if "is_active" not in payload or not isinstance(payload.get("is_active"), bool):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "is_active must be true or"
                                             " false."}}), 400
    updated: list = []
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_coupons_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(COUPONS_TABLE) +
                    " SET is_active = %s, updated_at = NOW()"
                    " WHERE id = %s AND client_id = %s"
                    " RETURNING id, code, kind, value, min_total,"
                    " usage_limit, used_count, expires_at, is_active",
                    (payload.get("is_active"), coupon_id,
                     principal["client_id"]),
                )
                updated = portal_db.rows(cur)
                if updated:
                    portal_db.log_action(
                        cur,
                        principal["client_id"],
                        "coupon.updated",
                        "customer_user",
                        principal.get("user_id"),
                        None,
                        ("Coupon " + str(updated[0].get("code")) + " "
                         + ("enabled" if payload.get("is_active")
                            else "paused"))[:200],
                    )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("coupon update failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "coupon update")[0]), 503
    if not updated:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Coupon not found."}}), 404
    return jsonify({"ok": True, "coupon": _public(updated[0])}), 200


@bp.delete("/coupons/<int:coupon_id>")
def delete_coupon(coupon_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    removed: list = []
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_coupons_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM " + portal_db._q(COUPONS_TABLE) +
                    " WHERE id = %s AND client_id = %s RETURNING id, code",
                    (coupon_id, principal["client_id"]),
                )
                removed = portal_db.rows(cur)
                if removed:
                    portal_db.log_action(
                        cur,
                        principal["client_id"],
                        "coupon.removed",
                        "customer_user",
                        principal.get("user_id"),
                        None,
                        ("Coupon removed " + str(removed[0].get("code")))[:200],
                    )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("coupon delete failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "coupon delete")[0]), 503
    if not removed:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Coupon not found."}}), 404
    return jsonify({"ok": True}), 200


def _coupon_problem(coupon: Dict[str, Any], link_total: float) -> Optional[str]:
    """Validation shared by the public apply path."""
    if coupon.get("is_active") is not True:
        return "This coupon is no longer active."
    expires_at = coupon.get("expires_at")
    if expires_at is not None:
        try:
            if expires_at < datetime_utcnow():
                return "This coupon has expired."
        except TypeError:
            pass
    limit = coupon.get("usage_limit")
    if limit is not None and int(coupon.get("used_count") or 0) >= int(limit):
        return "This coupon has reached its usage limit."
    if link_total < _num(coupon.get("min_total")):
        return ("Spend at least " + str(_num(coupon.get("min_total")))
                + " to use this coupon.")
    return None


def datetime_utcnow():
    import datetime

    return datetime.datetime.now(datetime.timezone.utc)


def _load_link(cur, token: str) -> Optional[Dict[str, Any]]:
    cur.execute(
        "SELECT id, client_id, total, coupon_code, coupon_discount, status,"
        " expires_at FROM " + portal_db._q(portal_checkout.LINKS_TABLE) +
        " WHERE token = %s LIMIT 1",
        (token,),
    )
    rows = portal_db.rows(cur)
    return rows[0] if rows else None


def _revert_previous(cur, link: Dict[str, Any]) -> float:
    """Undo a previous coupon on the link; returns the restored total."""
    restored = _num(link.get("total")) + _num(link.get("coupon_discount"))
    previous = str(link.get("coupon_code") or "")
    if previous:
        cur.execute(
            "SELECT id FROM " + portal_db._q(COUPONS_TABLE) +
            " WHERE client_id = %s AND code = %s LIMIT 1",
            (link.get("client_id"), previous),
        )
        if portal_db.rows(cur):
            cur.execute(
                "UPDATE " + portal_db._q(COUPONS_TABLE) +
                " SET used_count = GREATEST(used_count - 1, 0)"
                " WHERE client_id = %s AND code = %s",
                (link.get("client_id"), previous),
            )
    return round(restored, 2)


@public_bp.post("/checkout/<token>/coupon")
def apply_coupon(token: str):
    token = str(token or "").strip()[:64]
    payload = request.get_json(silent=True) or {}
    code = str(payload.get("code") or "").strip().upper()[:24]
    if not token or not code:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "token and code are"
                                             " required."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_coupons_tables(conn)
            with conn.cursor() as cur:
                try:
                    import portal_ratelimit

                    if not portal_ratelimit.allow(
                        cur,
                        "coupon:" + token,
                        portal_ratelimit.checkout_post_limit(),
                        60,
                    ):
                        conn.commit()
                        return jsonify({"error": {
                            "code": "rate_limited",
                            "message": "Too many requests; try again shortly.",
                        }}), 429
                except Exception:
                    pass
                link = _load_link(cur, token)
                if link is None:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "This order link is"
                                                         " not valid."}}), 404
                if (link.get("status") or "open") != "open":
                    return jsonify({"error": {"code": "bad_request",
                                              "message": "This order is"
                                                         " already closed."}}), 400
                cur.execute(
                    "SELECT id, code, kind, value, min_total, usage_limit,"
                    " used_count, expires_at, is_active FROM "
                    + portal_db._q(COUPONS_TABLE) +
                    " WHERE client_id = %s AND code = %s LIMIT 1",
                    (link.get("client_id"), code),
                )
                coupons = portal_db.rows(cur)
                if not coupons:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "This coupon code is"
                                                         " not valid."}}), 404
                coupon = coupons[0]
                problem = _coupon_problem(coupon, _num(link.get("total")))
                if problem is not None:
                    return jsonify({"error": {"code": "bad_request",
                                              "message": problem}}), 400
                base_total = _revert_previous(cur, link)
                if str(coupon.get("kind")) == "percent":
                    discount = round(base_total
                                     * _num(coupon.get("value")) / 100.0, 2)
                else:
                    discount = _num(coupon.get("value"))
                discount = min(discount, base_total)
                new_total = round(base_total - discount, 2)
                cur.execute(
                    "UPDATE " + portal_db._q(portal_checkout.LINKS_TABLE) +
                    " SET total = %s, coupon_code = %s,"
                    " coupon_discount = %s, updated_at = NOW()"
                    " WHERE id = %s RETURNING id",
                    (new_total, code, discount, link.get("id")),
                )
                if not portal_db.rows(cur):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "This order link is"
                                                         " not valid."}}), 404
                cur.execute(
                    "UPDATE " + portal_db._q(COUPONS_TABLE) +
                    " SET used_count = used_count + 1 WHERE id = %s",
                    (coupon.get("id"),),
                )
                portal_db.log_action(
                    cur,
                    link.get("client_id"),
                    "coupon.applied",
                    "customer",
                    None,
                    None,
                    ("Coupon " + code + " applied on " + token[:8]
                     + " (-" + str(discount) + ")")[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("coupon apply failed: %s", error)
        return jsonify({"error": {"code": "portal_unavailable",
                                  "message": "Try again shortly."}}), 503
    return jsonify({"ok": True, "code": code,
                    "discount": discount, "total": new_total}), 200


@public_bp.delete("/checkout/<token>/coupon")
def remove_coupon(token: str):
    token = str(token or "").strip()[:64]
    if not token:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "token is required."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_coupons_tables(conn)
            with conn.cursor() as cur:
                link = _load_link(cur, token)
                if link is None:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "This order link is"
                                                         " not valid."}}), 404
                if not str(link.get("coupon_code") or ""):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "No coupon is applied"
                                                         " on this order."}}), 404
                restored = _revert_previous(cur, link)
                cur.execute(
                    "UPDATE " + portal_db._q(portal_checkout.LINKS_TABLE) +
                    " SET total = %s, coupon_code = '', coupon_discount = 0,"
                    " updated_at = NOW() WHERE id = %s RETURNING id",
                    (restored, link.get("id")),
                )
                portal_db.log_action(
                    cur,
                    link.get("client_id"),
                    "coupon.cleared",
                    "customer",
                    None,
                    None,
                    ("Coupon removed from " + token[:8])[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("coupon remove failed: %s", error)
        return jsonify({"error": {"code": "portal_unavailable",
                                  "message": "Try again shortly."}}), 503
    return jsonify({"ok": True, "total": restored}), 200
