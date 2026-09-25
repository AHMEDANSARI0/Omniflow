"""Saved catalog: reusable product/service entries in one place.

The catalog feeds checkout links (pick a saved item instead of retyping
name/price) and the recommendation engine (portal_reco reads the same
table). Items are per-client, capped, and archive instead of disappearing
so past recommendations and pickers stay stable. API contract matches the
existing web clients exactly: GET returns {items:[...]}; writes take
{item: {kind, name, price_text, notes, is_active}}.
"""

import logging
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db
import portal_brands

bp = Blueprint("portal_catalog", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

CATALOG_TABLE = "portal_catalog"

MAX_ITEMS = 200
NAME_MAX = 120
PRICE_TEXT_MAX = 40
NOTES_MAX = 160
KINDS = ("product", "service")

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


def _ensure_catalog_tables(conn) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(CATALOG_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " name TEXT NOT NULL,"
            " kind TEXT NOT NULL DEFAULT 'product',"
            " price_text TEXT NOT NULL DEFAULT '',"
            " notes TEXT NOT NULL DEFAULT '',"
            " is_active BOOLEAN NOT NULL DEFAULT TRUE,"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS portal_catalog_client_idx ON "
            + portal_db._q(CATALOG_TABLE) + " (client_id, is_active, id DESC)"
        )
        cur.execute(
            "ALTER TABLE " + portal_db._q(CATALOG_TABLE) +
            " ADD COLUMN IF NOT EXISTS price NUMERIC(12,2)"
            " NOT NULL DEFAULT 0,"
            " ADD COLUMN IF NOT EXISTS stock INTEGER NOT NULL DEFAULT 0,"
            " ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT '',"
            " ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT"
            " 'manual',"
            " ADD COLUMN IF NOT EXISTS external_id TEXT NOT NULL DEFAULT"
            " '',"
            " ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS portal_catalog_source_idx ON "
            + portal_db._q(CATALOG_TABLE) +
            " (client_id, source, external_id)"
        )
        cur.execute(
            "ALTER TABLE " + portal_db._q(CATALOG_TABLE) +
            " ADD COLUMN IF NOT EXISTS brand_id BIGINT"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS portal_catalog_brand_idx ON "
            + portal_db._q(CATALOG_TABLE) + " (client_id, brand_id)"
        )
    conn.commit()
    _DDL_READY = True


def validate_catalog_item(payload: Any) -> Tuple[Optional[Dict[str, Any]],
                                                 Optional[str]]:
    """Returns (clean, error)."""
    if not isinstance(payload, dict):
        return None, "item (object) is required."
    name = str(payload.get("name") or "").strip()
    if not name:
        return None, "Item name is required."
    if len(name) > NAME_MAX:
        return None, "Item name must be " + str(NAME_MAX) + " characters or fewer."
    kind = str(payload.get("kind") or "product").strip().lower()
    if kind not in KINDS:
        return None, "kind must be product or service."
    price_text = str(payload.get("price_text") or "").strip()
    if len(price_text) > PRICE_TEXT_MAX:
        return None, ("Price text must be " + str(PRICE_TEXT_MAX)
                      + " characters or fewer.")
    notes = str(payload.get("notes") or "").strip()
    if len(notes) > NOTES_MAX:
        return None, "Notes must be " + str(NOTES_MAX) + " characters or fewer."
    is_active = payload.get("is_active", True)
    if not isinstance(is_active, bool):
        return None, "is_active must be true or false."
    return ({"name": name, "kind": kind, "price_text": price_text,
             "notes": notes, "is_active": is_active,
             "price": _opt_number(payload, "price", 0.0, 10000000.0),
             "stock": _opt_int(payload, "stock", 0, 1000000),
             "image_url": _opt_text(payload, "image_url", 500),
             "brand_id": _opt_brand(payload)}), None


def _opt_brand(payload: Dict[str, Any]) -> Optional[int]:
    """Brand tag from the payload; junk -> None (the endpoint
    re-validates ownership against portal_brands with a cursor)."""
    raw = payload.get("brand_id")
    if raw is None or raw == "":
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _opt_number(payload: Dict[str, Any], key: str, low: float,
                high: float) -> float:
    raw = payload.get(key)
    if raw is None:
        return 0.0
    try:
        value = round(float(raw), 2)
    except (TypeError, ValueError):
        return 0.0
    return max(low, min(high, value))


def _opt_int(payload: Dict[str, Any], key: str, low: int,
             high: int) -> int:
    raw = payload.get(key)
    if raw is None:
        return 0
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return 0
    return max(low, min(high, value))


def _opt_text(payload: Dict[str, Any], key: str, cap: int) -> str:
    raw = payload.get(key)
    if not isinstance(raw, str):
        return ""
    return raw.strip()[:cap]


def _public(row: Dict[str, Any]) -> Dict[str, Any]:
    created = row.get("created_at")
    return {
        "id": int(row.get("id") or 0),
        "kind": str(row.get("kind") or "product"),
        "name": str(row.get("name") or ""),
        "price_text": str(row.get("price_text") or ""),
        "notes": str(row.get("notes") or ""),
        "is_active": row.get("is_active") is True,
        "price": round(float(row.get("price") or 0), 2),
        "stock": int(row.get("stock") or 0),
        "image_url": str(row.get("image_url") or ""),
        "source": str(row.get("source") or "manual"),
        "synced_at": (row.get("synced_at").isoformat()
                      if hasattr(row.get("synced_at"), "isoformat")
                      else None),
        "brand_id": (int(row["brand_id"]) if row.get("brand_id") else None),
        "brand_name": (str(row["brand_name"])
                       if row.get("brand_name") else None),
        "created_at": created.isoformat() if hasattr(created, "isoformat")
        else None,
    }


def _load_row(cur, client_id: int, item_id: int) -> Optional[Dict[str, Any]]:
    cur.execute(
        "SELECT id, kind, name, price_text, notes, is_active, price,"
        " stock, image_url, source, synced_at, created_at"
        " FROM " + portal_db._q(CATALOG_TABLE) +
        " WHERE id = %s AND client_id = %s LIMIT 1",
        (item_id, client_id),
    )
    rows = portal_db.rows(cur)
    return rows[0] if rows else None


@bp.get("/catalog")
def list_catalog():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_catalog_tables(conn)
            with conn.cursor() as cur:
                brand_filter = request.args.get("brand_id")
                brand_join = ""
                brand_where = ""
                list_args = [principal["client_id"]]
                if brand_filter not in (None, "", "all"):
                    brand_where = " AND " + portal_db._q(CATALOG_TABLE) \
                        + ".brand_id = %s"
                    list_args.append(int(brand_filter))
                if brand_filter is None:
                    brand_join = (" LEFT JOIN portal_brands ON"
                                  " portal_brands.id = "
                                  + portal_db._q(CATALOG_TABLE) +
                                  ".brand_id")
                cur.execute(
                    "SELECT " + portal_db._q(CATALOG_TABLE) +
                    ".id, kind, name, price_text, notes, is_active,"
                    " price, stock, image_url, source, synced_at,"
                    " created_at, " + portal_db._q(CATALOG_TABLE) +
                    ".brand_id, portal_brands.name AS brand_name"
                    " FROM " + portal_db._q(CATALOG_TABLE) + brand_join +
                    " WHERE " + portal_db._q(CATALOG_TABLE) +
                    ".client_id = %s" + brand_where +
                    " ORDER BY is_active DESC, "
                    + portal_db._q(CATALOG_TABLE) + ".id DESC LIMIT "
                    + str(MAX_ITEMS),
                    tuple(list_args),
                )
                rows = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("catalog list failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "catalog read")[0]), 503
    return jsonify({"items": [_public(row) for row in rows]}), 200


@bp.post("/catalog")
def create_catalog_item():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    raw = payload.get("item") if isinstance(payload.get("item"), dict) else payload
    clean, err = validate_catalog_item(raw)
    if err:
        return jsonify({"error": {"code": "bad_request", "message": err}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_catalog_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id FROM " + portal_db._q(CATALOG_TABLE) +
                    " WHERE client_id = %s AND lower(name) = lower(%s)"
                    " LIMIT 1",
                    (principal["client_id"], clean["name"]),
                )
                if portal_db.rows(cur):
                    return jsonify({"error": {"code": "conflict",
                                              "message": "An item with this"
                                                         " name already"
                                                         " exists."}}), 409
                cur.execute(
                    "SELECT COUNT(*) AS n FROM " + portal_db._q(CATALOG_TABLE) +
                    " WHERE client_id = %s AND is_active",
                    (principal["client_id"],),
                )
                counts = portal_db.rows(cur)
                if counts and int(counts[0].get("n") or 0) >= MAX_ITEMS:
                    return jsonify({"error": {"code": "bad_request",
                                              "message": "Up to "
                                                         + str(MAX_ITEMS)
                                                         + " active catalog"
                                                         " items are"
                                                         " supported."}}), 400
                brand_id = portal_brands.resolve_brand(
                    cur, principal["client_id"], clean.get("brand_id"))
                cur.execute(
                    "INSERT INTO " + portal_db._q(CATALOG_TABLE) +
                    " (client_id, name, kind, price_text, notes, is_active,"
                    " price, stock, image_url, brand_id)"
                    " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"
                    " RETURNING id, kind, name, price_text, notes, is_active,"
                    " created_at, brand_id",
                    (principal["client_id"], clean["name"], clean["kind"],
                     clean["price_text"], clean["notes"],
                     clean["is_active"], clean["price"], clean["stock"],
                     clean["image_url"], brand_id),
                )
                created = portal_db.rows(cur)
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "catalog.created",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Catalog item " + clean["name"])[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("catalog create failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "catalog create")[0]), 503
    return jsonify({"ok": True,
                    "item": _public(created[0] if created else {})}), 200


@bp.put("/catalog/<int:item_id>")
def update_catalog_item(item_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    raw = payload.get("item") if isinstance(payload.get("item"), dict) else payload
    clean, err = validate_catalog_item(raw)
    if err:
        return jsonify({"error": {"code": "bad_request", "message": err}}), 400
    updated: list = []
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_catalog_tables(conn)
            with conn.cursor() as cur:
                if _load_row(cur, principal["client_id"], item_id) is None:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Catalog item not"
                                                         " found."}}), 404
                cur.execute(
                    "SELECT id FROM " + portal_db._q(CATALOG_TABLE) +
                    " WHERE client_id = %s AND lower(name) = lower(%s)"
                    " AND id <> %s LIMIT 1",
                    (principal["client_id"], clean["name"], item_id),
                )
                if portal_db.rows(cur):
                    return jsonify({"error": {"code": "conflict",
                                              "message": "An item with this"
                                                         " name already"
                                                         " exists."}}), 409
                brand_id = portal_brands.resolve_brand(
                    cur, principal["client_id"], clean.get("brand_id"))
                cur.execute(
                    "UPDATE " + portal_db._q(CATALOG_TABLE) +
                    " SET name = %s, kind = %s, price_text = %s, notes = %s,"
                    " is_active = %s, price = %s, stock = %s,"
                    " image_url = %s, brand_id = %s, updated_at = NOW()"
                    " WHERE id = %s AND client_id = %s"
                    " RETURNING id, kind, name, price_text, notes,"
                    " is_active, price, stock, image_url, source,"
                    " synced_at, created_at, brand_id",
                    (clean["name"], clean["kind"], clean["price_text"],
                     clean["notes"], clean["is_active"], clean["price"],
                     clean["stock"], clean["image_url"], brand_id, item_id,
                     principal["client_id"]),
                )
                updated = portal_db.rows(cur)
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "catalog.updated",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    ("Catalog item " + clean["name"])[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("catalog update failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "catalog update")[0]), 503
    if not updated:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Catalog item not found."}}), 404
    return jsonify({"ok": True, "item": _public(updated[0])}), 200


@bp.delete("/catalog/<int:item_id>")
def delete_catalog_item(item_id: int):
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
            _ensure_catalog_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM " + portal_db._q(CATALOG_TABLE) +
                    " WHERE id = %s AND client_id = %s RETURNING id",
                    (item_id, principal["client_id"]),
                )
                removed = portal_db.rows(cur)
                if removed:
                    portal_db.log_action(
                        cur,
                        principal["client_id"],
                        "catalog.removed",
                        "customer_user",
                        principal.get("user_id"),
                        None,
                        ("Catalog item removed #" + str(item_id))[:200],
                    )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("catalog delete failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "catalog delete")[0]), 503
    if not removed:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Catalog item not found."}}), 404
    return jsonify({"ok": True}), 200


# ---------------------------------------------------------------------------
# Catalog sync (B16): one-way pull from WooCommerce or Shopify
# ---------------------------------------------------------------------------

SYNC_SOURCES = ("shopify", "woo")
SYNC_TABLE = "portal_catalog_sync"
SYNC_PAGE_LIMIT = 5          # max pages per sync run (100 items/page)
SYNC_HTTP_TIMEOUT = 25


def _ensure_sync_tables(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(SYNC_TABLE) +
            " (client_id BIGINT PRIMARY KEY,"
            " source TEXT NOT NULL DEFAULT '',"
            " base_url TEXT NOT NULL DEFAULT '',"
            " api_key TEXT NOT NULL DEFAULT '',"
            " api_secret TEXT NOT NULL DEFAULT '',"
            " last_sync_at TIMESTAMPTZ,"
            " last_sync_count INTEGER NOT NULL DEFAULT 0,"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
    conn.commit()


def _load_sync_settings(cur, client_id: int) -> Dict[str, Any]:
    cur.execute(
        "SELECT source, base_url, api_key, api_secret, last_sync_at,"
        " last_sync_count FROM " + portal_db._q(SYNC_TABLE) +
        " WHERE client_id = %s LIMIT 1",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    if not rows:
        return {"source": "", "base_url": "", "api_key": "",
                "api_secret": "", "last_sync_at": None,
                "last_sync_count": 0}
    row = rows[0]
    return {"source": str(row.get("source") or ""),
            "base_url": str(row.get("base_url") or ""),
            "api_key": str(row.get("api_key") or ""),
            "api_secret": str(row.get("api_secret") or ""),
            "last_sync_at": row.get("last_sync_at"),
            "last_sync_count": int(row.get("last_sync_count") or 0)}


@bp.get("/catalog/sync/settings")
def get_catalog_sync_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_sync_tables(conn)
            with conn.cursor() as cur:
                settings = _load_sync_settings(cur,
                                               int(principal["client_id"]))
        finally:
            conn.close()
    except Exception as error:
        logger.warning("sync settings read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "sync settings read")[0]), 503
    return jsonify({
        "source": settings["source"],
        "base_url": settings["base_url"],
        "api_key_masked": mask_text(settings["api_key"]),
        "api_secret_masked": mask_text(settings["api_secret"]),
        "last_sync_at": (settings["last_sync_at"].isoformat()
                         if hasattr(settings["last_sync_at"], "isoformat")
                         else None),
        "last_sync_count": settings["last_sync_count"],
    }), 200


@bp.put("/catalog/sync/settings")
def put_catalog_sync_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    if principal.get("via_api_key"):
        return jsonify({"error": {"code": "forbidden",
                                  "message": "Owner sign-in required."}}), 403
    payload = request.get_json(silent=True) or {}
    source = str(payload.get("source") or "").strip().lower()
    if source not in SYNC_SOURCES:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "source must be one of: "
                                             + ", ".join(SYNC_SOURCES)
                                             + "."}}), 400
    base_url = str(payload.get("base_url") or "").strip()[:300]
    if not base_url.startswith("http"):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "base_url must start with"
                                             " http."}}), 400
    api_key = str(payload.get("api_key") or "").strip()[:200]
    api_secret = str(payload.get("api_secret") or "").strip()[:200]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_sync_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(SYNC_TABLE) +
                    " (client_id, source, base_url, api_key, api_secret,"
                    " updated_at) VALUES (%s, %s, %s, %s, %s, NOW())"
                    " ON CONFLICT (client_id) DO UPDATE SET"
                    " source = EXCLUDED.source,"
                    " base_url = EXCLUDED.base_url,"
                    " api_key = CASE WHEN %s <> '' THEN EXCLUDED.api_key"
                    " ELSE " + portal_db._q(SYNC_TABLE) + ".api_key END,"
                    " api_secret = CASE WHEN %s <> '' THEN"
                    " EXCLUDED.api_secret ELSE "
                    + portal_db._q(SYNC_TABLE) + ".api_secret END,"
                    " updated_at = EXCLUDED.updated_at",
                    (int(principal["client_id"]), source, base_url,
                     api_key, api_secret, api_key, api_secret),
                )
                portal_db.log_action(
                    cur, int(principal["client_id"]), "catalog.sync.config",
                    "human", None, None,
                    "Catalog sync source " + source,
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("sync settings save failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "sync settings save")[0]), 503
    return jsonify({"ok": True, "source": source}), 200


def mask_text(value: str) -> str:
    value = value or ""
    if not value:
        return ""
    return "\u2022\u2022\u2022\u2022" + value[-4:] if len(value) > 4 \
        else "\u2022\u2022\u2022\u2022"


def _sync_http_json(url: str, headers: Dict[str, str]) -> Any:
    """One GET returning parsed JSON; raises ValueError on any failure
    so the sync endpoint can map it to a clean 502."""
    req = urllib.request.Request(url, method="GET")
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", "OmniFlow-Catalog-Sync/1.0")
    for key, value in headers.items():
        req.add_header(key, value)
    with urllib.request.urlopen(req, timeout=SYNC_HTTP_TIMEOUT) as resp:
        body = resp.read().decode("utf-8", "replace")
    import json as _json
    return _json.loads(body)


def _woo_headers(api_key: str, api_secret: str) -> Dict[str, str]:
    import base64
    token = base64.b64encode((api_key + ":" + api_secret)
                             .encode("utf-8")).decode("ascii")
    return {"Authorization": "Basic " + token}


def _fetch_woo_products(settings: Dict[str, Any]) -> List[Dict[str, Any]]:
    base = settings["base_url"].rstrip("/")
    products: List[Dict[str, Any]] = []
    for page in range(1, SYNC_PAGE_LIMIT + 1):
        url = (base + "/wp-json/wc/v3/products?per_page=100&page="
               + str(page))
        batch = _sync_http_json(url, _woo_headers(settings["api_key"],
                                                  settings["api_secret"]))
        if not isinstance(batch, list) or not batch:
            break
        for item in batch:
            if not isinstance(item, dict):
                continue
            images = item.get("images")
            image_url = ""
            if isinstance(images, list) and images \
                    and isinstance(images[0], dict):
                image_url = str(images[0].get("src") or "")[:500]
            try:
                woo_stock = max(int(item.get("stock_quantity") or 0), 0)
            except (TypeError, ValueError):
                woo_stock = 0
            products.append({
                "external_id": str(item.get("id") or ""),
                "name": str(item.get("name") or "")[:NAME_MAX],
                "price": str(item.get("price") or "0"),
                "stock": woo_stock,
                "image_url": image_url,
            })
        if len(batch) < 100:
            break
    return products


def _fetch_shopify_products(
        settings: Dict[str, Any]) -> List[Dict[str, Any]]:
    base = settings["base_url"].rstrip("/")
    products: List[Dict[str, Any]] = []
    since_id = ""
    for _page in range(SYNC_PAGE_LIMIT):
        url = (base + "/admin/api/2024-01/products.json?limit=100"
               + ("&since_id=" + since_id if since_id else ""))
        payload = _sync_http_json(
            url, {"X-Shopify-Access-Token": settings["api_key"]})
        batch = payload.get("products") if isinstance(payload, dict) \
            else None
        if not isinstance(batch, list) or not batch:
            break
        for item in batch:
            if not isinstance(item, dict):
                continue
            variants = item.get("variants")
            price = "0"
            sku_stock = 0
            if isinstance(variants, list) and variants \
                    and isinstance(variants[0], dict):
                price = str(variants[0].get("price") or "0")
                try:
                    sku_stock = int(variants[0].get("inventory_quantity")
                                    or 0)
                except (TypeError, ValueError):
                    sku_stock = 0
            image = item.get("image")
            image_url = ""
            if isinstance(image, dict):
                image_url = str(image.get("src") or "")[:500]
            products.append({
                "external_id": str(item.get("id") or ""),
                "name": str(item.get("title") or "")[:NAME_MAX],
                "price": price,
                "stock": max(sku_stock, 0),
                "image_url": image_url,
            })
        if len(batch) < 100:
            break
        try:
            since_id = str(batch[-1].get("id") or "")
        except AttributeError:
            break
        if not since_id:
            break
    return products


@bp.post("/catalog/sync")
def sync_catalog_now():
    """Sync-now: pull the remote catalog and upsert by external id.
    Manual items are never touched; re-syncing updates in place."""
    principal, error = _principal_or_error()
    if error:
        return error
    if principal.get("via_api_key"):
        return jsonify({"error": {"code": "forbidden",
                                  "message": "Owner sign-in required."}}), 403
    client_id = int(principal["client_id"])
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_sync_tables(conn)
            with conn.cursor() as cur:
                settings = _load_sync_settings(cur, client_id)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("sync read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "catalog sync")[0]), 503
    if settings["source"] not in SYNC_SOURCES:
        return jsonify({"error": {"code": "not_configured",
                                  "message": "Save a sync source first."}}), 409
    try:
        if settings["source"] == "woo":
            products = _fetch_woo_products(settings)
        else:
            products = _fetch_shopify_products(settings)
    except Exception as error:
        logger.warning("catalog sync pull failed: %s", error)
        return jsonify({"error": {"code": "sync_failed",
                                  "message": "Could not reach the store -"
                                             " check the URL and keys."}}), 502
    imported = updated = 0
    try:
        conn = portal_db._conn()
        try:
            _ensure_catalog_tables(conn)
            with conn.cursor() as cur:
                for product in products[:MAX_ITEMS]:
                    if not product["external_id"] or not product["name"]:
                        continue
                    try:
                        price = round(float(product["price"]), 2)
                    except (TypeError, ValueError):
                        price = 0.0
                    try:
                        stock = max(int(product["stock"] or 0), 0)
                    except (TypeError, ValueError):
                        stock = 0
                    cur.execute(
                        "SELECT id FROM " + portal_db._q(CATALOG_TABLE) +
                        " WHERE client_id = %s AND source = %s"
                        " AND external_id = %s LIMIT 1",
                        (client_id, settings["source"],
                         product["external_id"]),
                    )
                    existing = portal_db.rows(cur)
                    if existing:
                        cur.execute(
                            "UPDATE " + portal_db._q(CATALOG_TABLE) +
                            " SET name = %s, price = %s, stock = %s,"
                            " image_url = %s, synced_at = NOW(),"
                            " updated_at = NOW() WHERE id = %s",
                            (product["name"], price, stock,
                             product["image_url"],
                             int(existing[0]["id"] or 0)),
                        )
                        updated += 1
                    else:
                        cur.execute(
                            "INSERT INTO " + portal_db._q(CATALOG_TABLE) +
                            " (client_id, name, kind, price, stock,"
                            " image_url, source, external_id, synced_at,"
                            " is_active)"
                            " VALUES (%s, %s, 'product', %s, %s, %s, %s,"
                            " %s, NOW(), TRUE)",
                            (client_id, product["name"], price, stock,
                             product["image_url"], settings["source"],
                             product["external_id"]),
                        )
                        imported += 1
                cur.execute(
                    "UPDATE " + portal_db._q(SYNC_TABLE) +
                    " SET last_sync_at = NOW(), last_sync_count = %s"
                    " WHERE client_id = %s",
                    (len(products), client_id),
                )
                portal_db.log_action(
                    cur, client_id, "catalog.synced", "human",
                    None, None,
                    "Catalog sync (" + settings["source"] + "): "
                    + str(imported) + " new, " + str(updated) + " updated",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("catalog sync write failed: %s", error)
        return jsonify(portal_db.portal_unavailable(
            error, "catalog sync")[0]), 503
    return jsonify({"ok": True, "source": settings["source"],
                    "imported": imported, "updated": updated,
                    "pulled": len(products)}), 200
