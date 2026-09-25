"""Brands (V2 B18) - multi-brand prep.

A workspace can define the businesses/brands it sells under. Everything
else (KB entries, catalog items, checkout links) gains an optional
brand tag; untagged rows behave exactly as before, so this is pure
prep - nothing changes until the owner actually creates brands.

Brands are owner-only, plan-capped (the "brands" limit key) and fully
audited. Deleting a brand leaves its data: tagged rows simply fall
back to untagged (brand_id NULL).
"""
import json
import logging
import os
import secrets
from typing import Any, Dict, Optional, Tuple

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db
import portal_plans

bp = Blueprint("portal_brands", __name__, url_prefix="/api/v1/portal")
store_bp = Blueprint("portal_brands_public", __name__,
                     url_prefix="/api/v1/public")
logger = logging.getLogger(__name__)

TABLE = "portal_brands"

NAME_MAX = 60
SLUG_MAX = 60
MAX_BRANDS = 50

_DDL_READY = False

_DDL = """
CREATE TABLE IF NOT EXISTS portal_brands (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS portal_brands_client_idx
  ON portal_brands (client_id, is_active, id DESC);
"""


def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": "Try again shortly."}}),
                      503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}),
                      401)
    if principal.get("via_api_key"):
        return None, (jsonify({"error": {"code": "forbidden",
                                         "message": "Owner sign-in"
                                                    " required."}}),
                      403)
    return principal, None


def _ensure_ddl(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    cur.execute(
        "ALTER TABLE " + portal_db._q(TABLE) +
        " ADD COLUMN IF NOT EXISTS slug TEXT"
    )
    cur.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS portal_brands_slug_idx ON "
        + portal_db._q(TABLE) + " (client_id, slug)"
    )
    _DDL_READY = True


def slugify(name: str) -> str:
    """'Studio A' -> 'studio-a'; ASCII-safe, storefront-URL friendly."""
    import re as _re
    text = _re.sub(r"[^a-z0-9]+", "-", str(name or "").lower()).strip("-")
    return text[:SLUG_MAX] or "brand"


def _clean_slug(raw: Any) -> str:
    import re as _re
    text = _re.sub(r"[^a-z0-9-]+", "", str(raw or "").lower())
    return text.strip("-")[:SLUG_MAX]


def _slug_taken(cur, client_id: int, slug: str, exclude_id=None) -> bool:
    sql = ("SELECT 1 FROM " + portal_db._q(TABLE) +
           " WHERE client_id = %s AND slug = %s")
    params = [client_id, slug]
    if exclude_id is not None:
        sql += " AND id <> %s"
        params.append(exclude_id)
    cur.execute(sql + " LIMIT 1", tuple(params))
    return bool(portal_db.rows(cur))


def _unique_slug(cur, client_id: int, name: str) -> str:
    base = slugify(name)
    slug = base
    n = 2
    while _slug_taken(cur, client_id, slug):
        suffix = "-" + str(n)
        slug = base[:SLUG_MAX - len(suffix)] + suffix
        n += 1
    return slug


def _public(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": int(row.get("id") or 0),
        "name": str(row.get("name") or ""),
        "slug": str(row.get("slug") or "") or None,
        "is_active": row.get("is_active") is True,
        "created_at": str(row.get("created_at") or "") or None,
    }


def _clean_name(raw: Any) -> str:
    return str(raw or "").strip()[:NAME_MAX]


def resolve_brand(cur, client_id: int, raw: Any) -> Optional[int]:
    """Map a payload brand_id onto this client's brands; junk -> None.

    Never raises and never 4xxs - an unknown or foreign id simply reads
    as untagged so a stale form can never block a save."""
    if raw is None or raw == "":
        return None
    try:
        brand_id = int(raw)
    except (TypeError, ValueError):
        return None
    if brand_id <= 0:
        return None
    try:
        cur.execute(
            "SELECT 1 FROM " + portal_db._q(TABLE) +
            " WHERE id = %s AND client_id = %s LIMIT 1",
            (brand_id, client_id),
        )
    except Exception:
        return None
    return brand_id if portal_db.rows(cur) else None


def _dup_exists(cur, client_id: int, name: str, exclude_id=None) -> bool:
    sql = ("SELECT 1 FROM " + portal_db._q(TABLE) +
           " WHERE client_id = %s AND lower(name) = lower(%s)")
    args = [client_id, name]
    if exclude_id is not None:
        sql += " AND id <> %s"
        args.append(exclude_id)
    sql += " LIMIT 1"
    cur.execute(sql, tuple(args))
    return bool(portal_db.rows(cur))


@bp.get("/brands")
def list_brands():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                cur.execute(
                    "SELECT id, name, slug, is_active, created_at FROM "
                    + portal_db._q(TABLE) +
                    " WHERE client_id = %s"
                    " ORDER BY is_active DESC, id DESC LIMIT "
                    + str(MAX_BRANDS),
                    (principal["client_id"],),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("brands list failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "brands read")[0]), 503
    return jsonify({"brands": [_public(row) for row in rows]}), 200


@bp.post("/brands")
def create_brand():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    name = _clean_name(payload.get("name"))
    if not name:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Brand name is required."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                blocked = portal_plans.enforce(cur, principal["client_id"],
                                               "brands", "Brand")
                if blocked is not None:
                    return blocked
                if _dup_exists(cur, principal["client_id"], name):
                    return jsonify({"error": {"code": "conflict",
                                              "message": "A brand with this"
                                                         " name already"
                                                         " exists."}}), 409
                slug = _unique_slug(cur, principal["client_id"], name)
                cur.execute(
                    "INSERT INTO " + portal_db._q(TABLE) +
                    " (client_id, name, slug) VALUES (%s, %s, %s)"
                    " RETURNING id, name, slug, is_active, created_at",
                    (principal["client_id"], name, slug),
                )
                created = portal_db.rows(cur)
                portal_db.log_action(
                    cur, principal["client_id"], "brands.created",
                    "human", principal.get("user_id"), None,
                    "Brand " + name,
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("brand create failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "brand create")[0]), 503
    return jsonify({"ok": True,
                    "brand": _public(created[0] if created else {})}), 200


@bp.patch("/brands/<int:brand_id>")
def update_brand(brand_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    raw_name = payload.get("name")
    name = _clean_name(raw_name) if raw_name is not None else None
    if name == "":
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Brand name is required."}}), 400
    is_active = payload.get("is_active")
    if is_active is not None and not isinstance(is_active, bool):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "is_active must be true or"
                                             " false."}}), 400
    slug = None
    if payload.get("slug") is not None:
        slug = _clean_slug(payload.get("slug"))
        if not slug:
            return jsonify({"error": {"code": "bad_request",
                                      "message": "slug can use lowercase"
                                                 " letters, numbers and"
                                                 " dashes."}}), 400
    if name is None and is_active is None and slug is None:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Nothing to update."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                sets = ["updated_at = NOW()"]
                args: list = []
                if name is not None:
                    if _dup_exists(cur, principal["client_id"], name,
                                   exclude_id=brand_id):
                        return jsonify({"error": {"code": "conflict",
                                                  "message": "A brand with"
                                                             " this name"
                                                             " already"
                                                             " exists."}}), 409
                    sets.append("name = %s")
                    args.append(name)
                if is_active is not None:
                    sets.append("is_active = %s")
                    args.append(is_active)
                if slug is not None:
                    if _slug_taken(cur, principal["client_id"], slug,
                                   exclude_id=brand_id):
                        return jsonify({"error": {"code": "conflict",
                                                  "message": "Another brand"
                                                             " already uses"
                                                             " this store"
                                                             " link."}}), 409
                    sets.append("slug = %s")
                    args.append(slug)
                args.extend([brand_id, principal["client_id"]])
                cur.execute(
                    "UPDATE " + portal_db._q(TABLE) + " SET " +
                    ", ".join(sets) +
                    " WHERE id = %s AND client_id = %s"
                    " RETURNING id, name, slug, is_active, created_at",
                    tuple(args),
                )
                updated = portal_db.rows(cur)
                if not updated:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Brand not"
                                                         " found."}}), 404
                portal_db.log_action(
                    cur, principal["client_id"], "brands.updated",
                    "human", principal.get("user_id"), None,
                    ("Brand " + str(updated[0].get("name") or ""))[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("brand update failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "brand update")[0]), 503
    return jsonify({"ok": True,
                    "brand": _public(updated[0] if updated else {})}), 200


@bp.delete("/brands/<int:brand_id>")
def delete_brand(brand_id: int):
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
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                cur.execute(
                    "DELETE FROM " + portal_db._q(TABLE) +
                    " WHERE id = %s AND client_id = %s RETURNING name",
                    (brand_id, principal["client_id"]),
                )
                deleted = portal_db.rows(cur)
                if not deleted:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Brand not"
                                                         " found."}}), 404
                # Prep keeps data: tagged rows fall back to untagged.
                for table in ("portal_kb_entries", "portal_catalog",
                              "portal_checkout_links"):
                    try:
                        cur.execute(
                            "UPDATE " + portal_db._q(table) +
                            " SET brand_id = NULL"
                            " WHERE client_id = %s AND brand_id = %s",
                            (principal["client_id"], brand_id),
                        )
                    except Exception:
                        pass
                portal_db.log_action(
                    cur, principal["client_id"], "brands.deleted",
                    "human", principal.get("user_id"), None,
                    ("Brand " + str(deleted[0].get("name") or "")
                     + " removed")[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("brand delete failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "brand delete")[0]), 503
    return jsonify({"ok": True}), 200


# ---------------------------------------------------------------------------
# Public storefront (multi-brand, B22): the brand's catalog lives at
# /api/v1/public/store/<slug>; a customer orders an item and the checkout
# link lands on their WhatsApp.
# ---------------------------------------------------------------------------

STORE_ITEMS_LIMIT = 100
STORE_MAX_QTY = 99


def _normalize_contact(raw: str) -> str:
    """'92 300-1234567' / '+923001234567' -> '923001234567@c.us'.

    A bare digit jid (923001234567@c.us) passes through untouched.
    """
    import re as _re
    text = _re.sub(r"[\s\-()]", "", str(raw or "")).strip()
    text = text.lstrip("+")
    if not text:
        return ""
    if "@" in text:
        local = text.split("@", 1)[0]
        if local.isdigit() and 10 <= len(local) <= 15:
            return text
        return ""
    if not text.isdigit() or not 10 <= len(text) <= 15:
        return ""
    return text + "@c.us"


@store_bp.get("/store/<slug>")
def public_store(slug: str):
    """The brand's public catalog: active items only."""
    slug = _clean_slug(slug)
    if not slug:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Store not found."}}), 404
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                cur.execute(
                    "SELECT id, client_id, name, slug FROM "
                    + portal_db._q(TABLE) +
                    " WHERE slug = %s AND is_active IS TRUE LIMIT 1",
                    (slug,),
                )
                brands = portal_db.rows(cur)
                if not brands:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Store not"
                                                         " found."}}), 404
                brand = brands[0]
                cur.execute(
                    "SELECT c.id, c.kind, c.name, c.price_text, c.notes,"
                    " c.price, c.stock, c.image_url FROM "
                    + portal_db._q("portal_catalog") + " c"
                    " WHERE c.client_id = %s AND c.brand_id = %s"
                    " AND c.is_active IS TRUE"
                    " ORDER BY c.id DESC LIMIT "
                    + str(STORE_ITEMS_LIMIT),
                    (brand["client_id"], brand["id"]),
                )
                items = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("store read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "store")[0]), 503
    return jsonify({
        "brand": {"name": str(brand.get("name") or ""),
                  "slug": str(brand.get("slug") or slug)},
        "items": [{
            "id": int(row.get("id") or 0),
            "kind": str(row.get("kind") or "product"),
            "name": str(row.get("name") or ""),
            "price_text": str(row.get("price_text") or ""),
            "notes": str(row.get("notes") or ""),
            "price": round(float(row.get("price") or 0), 2),
            "image_url": str(row.get("image_url") or ""),
        } for row in items],
    }), 200


@store_bp.post("/store/<slug>/order")
def public_store_order(slug: str):
    """Customer order from the storefront: creates a checkout link
    tagged with the brand and sends it to their WhatsApp."""
    slug = _clean_slug(slug)
    payload = request.get_json(silent=True) or {}
    phone_raw = str(payload.get("phone") or "").strip()
    name = str(payload.get("name") or "").strip()[:80]
    contact_id = _normalize_contact(phone_raw)
    if not contact_id:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Enter a valid WhatsApp"
                                             " number, e.g. 923001234567."
                                  }}), 400
    try:
        item_id = int(payload.get("item_id") or 0)
    except Exception:
        item_id = 0
    if item_id <= 0:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "item_id is required."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                try:
                    import portal_ratelimit

                    if not portal_ratelimit.allow(
                        cur,
                        "storeorder:" + contact_id,
                        3,
                        600,
                    ):
                        return jsonify({"error": {
                            "code": "rate_limited",
                            "message": "Too many orders - try again"
                                       " shortly.",
                        }}), 429
                except Exception:
                    pass
                _ensure_ddl(cur)
                cur.execute(
                    "SELECT id, client_id, name FROM "
                    + portal_db._q(TABLE) +
                    " WHERE slug = %s AND is_active IS TRUE LIMIT 1",
                    (slug,),
                )
                brands = portal_db.rows(cur)
                if not brands:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Store not"
                                                         " found."}}), 404
                brand = brands[0]
                cur.execute(
                    "SELECT id, name, price_text, price FROM "
                    + portal_db._q("portal_catalog") +
                    " WHERE id = %s AND client_id = %s AND brand_id = %s"
                    " AND is_active IS TRUE LIMIT 1",
                    (item_id, brand["client_id"], brand["id"]),
                )
                items = portal_db.rows(cur)
                if not items:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "That item is not"
                                                         " available."}}), 404
                item = items[0]
                unit_price = round(float(item.get("price") or 0), 2)
                title = str(item.get("name") or "")[:120]
                items_json = json.dumps([{
                    "name": title,
                    "qty": 1,
                    "price": unit_price,
                }])
                total = unit_price
                token = secrets.token_urlsafe(16)
                cur.execute(
                    "INSERT INTO "
                    + portal_db._q("portal_checkout_links") +
                    " (client_id, contact_id, token, title, items,"
                    " total, brand_id) VALUES (%s, %s, %s, %s,"
                    " %s::jsonb, %s, %s) RETURNING id",
                    (brand["client_id"], contact_id, token, title,
                     items_json, total, brand["id"]),
                )
                portal_db.log_action(
                    cur, brand["client_id"], "store.order", "customer",
                    None, None,
                    ("Store order " + slug + " item " + str(item_id)
                     + " for " + contact_id[-4:])[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("store order failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "store order")[0]), 503
    site = (os.environ.get("OMNIFLOW_SITE_URL", "").strip()
            or request.host_url.rstrip("/"))
    url = site + "/c/" + token
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                import portal_growth

                portal_growth._send_command(
                    cur, brand["client_id"], contact_id, name,
                    "Thank you" + (" " + name if name else "")
                    + "! Your order '" + title + "' is one step away -"
                    " confirm it here: " + url,
                    "store_order",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        logger.warning("store order send failed", exc_info=True)
    return jsonify({"ok": True, "url": url}), 200
