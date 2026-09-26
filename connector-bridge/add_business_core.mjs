// add_business_core.mjs — Phase 5: Business Core v0 (zero AI cost).
//
// 1. Structured products/services catalog: businesses list products and
//    services (name, price, notes) on the Business profile page.
// 2. Industry starter presets: one click seeds the knowledge base with
//    proven starter answers (EN + Roman Urdu keywords) for the business
//    type — clothing, food, beauty salon, electronics, general retail.
// 3. Action audit log: every meaningful automation/action (instant answer,
//    reply queued, status change, follow-up delivery, preset applied,
//    catalog change) is recorded and shown as a Recent activity card on
//    the Overview page.
// 4. Sidebar: enables the live Business profile and Settings links.
//
// Backend : portal_catalog.py (catalog CRUD + presets + activity),
//           portal_db lazy DDL + log_action helper, audit hooks in
//           portal_conversations / portal_followups / portal_kb,
//           migration 013 record.
// Website : portal.ts helpers, BFF routes (catalog, catalog/[id], presets,
//           activity), CatalogSection on Business profile, Recent activity
//           on Overview, sidebar links enabled.
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_business_core.mjs
//
// Requires Phase 4 (add_knowledge_base.mjs) to be applied first.
//
// CRLF-tolerant, idempotent, backups: *.pre_bc.bak

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MODULE_PATH = "OmniFlow-Control-Plane/portal_catalog.py";
const MIGRATION_PATH = "OmniFlow-Control-Plane/migrations/013_business_core.sql";
const BFF_CATALOG_PATH = "Omniflow/app/api/omniflow/portal/catalog/route.ts";
const BFF_CATALOG_ID_PATH = "Omniflow/app/api/omniflow/portal/catalog/[id]/route.ts";
const BFF_PRESETS_PATH = "Omniflow/app/api/omniflow/portal/presets/route.ts";
const BFF_ACTIVITY_PATH = "Omniflow/app/api/omniflow/portal/activity/route.ts";
const CATALOG_SECTION_PATH =
  "Omniflow/app/dashboard/(portal)/profile/CatalogSection.tsx";

const MODULE_FILE = `"""Portal business core (catalog, industry presets, activity feed).

Businesses list their products and services (name, price, notes) as
structured catalog items. Industry starter presets seed the knowledge base
with proven starter answers in one click. Every meaningful action across
the platform (instant answers, queued replies, status changes, follow-up
deliveries, preset/catalog changes) is appended to the action audit log and
surfaced as a recent-activity feed. Deterministic and zero AI cost.
"""

import logging
from typing import Any, Dict

from flask import Blueprint, jsonify, request

from portal_auth import PortalAuthUnavailable, authenticate_portal_request
import portal_db


logger = logging.getLogger("omniflow.portal-catalog")

bp = Blueprint("portal_catalog", __name__, url_prefix="/api/v1")

CATALOG_TABLE = "portal_catalog"
KB_TABLE = "portal_kb_entries"
ACTIVITY_TABLE = "portal_action_log"
MAX_LIST_ITEMS = 200

# Starter knowledge-base answers per industry. Keywords mix English and
# Roman Urdu; {name} becomes the customer's first name. Applied entries are
# marked category "starter" and can be edited or deleted like any entry.
INDUSTRY_PRESETS = {
    "clothing_fashion": {
        "label": "Clothing & fashion",
        "description": "Sizing, exchange policy, delivery and cash on delivery.",
        "entries": [
            {
                "title": "Delivery time",
                "keywords": "delivery, delivery time, kitne din, shipping",
                "content": (
                    "Hi {name}! We deliver in 2-3 working days across major "
                    "cities. You will receive a tracking message once your "
                    "order is dispatched."
                ),
            },
            {
                "title": "Cash on delivery",
                "keywords": "cod, cash on delivery, payment, advance",
                "content": (
                    "Hi {name}! Yes, cash on delivery is available. You pay "
                    "the rider when your parcel arrives. Advance payment is "
                    "not required."
                ),
            },
            {
                "title": "Exchange policy",
                "keywords": "exchange, return, wapas, refund, size change",
                "content": (
                    "Hi {name}! We offer a 7-day exchange. If the size does "
                    "not fit, message us here and we will arrange the "
                    "exchange — the item must be unworn with tags attached."
                ),
            },
            {
                "title": "Sizes available",
                "keywords": "size, sizes, fitting, measurement",
                "content": (
                    "Hi {name}! We stock sizes S to XXL. Share your usual "
                    "size or measurements and we will confirm availability "
                    "right away."
                ),
            },
            {
                "title": "New arrivals",
                "keywords": "new arrival, latest, stock, available",
                "content": (
                    "Hi {name}! Fresh stock arrives every week. Tell us what "
                    "you are looking for and we will share the latest "
                    "available designs and prices."
                ),
            },
        ],
    },
    "food_restaurant": {
        "label": "Food & restaurant",
        "description": "Menu, timings, delivery areas and deals.",
        "entries": [
            {
                "title": "Delivery time",
                "keywords": "delivery, delivery time, kitna time, kitne din",
                "content": (
                    "Hi {name}! Orders are delivered hot within 40-60 "
                    "minutes inside our delivery area."
                ),
            },
            {
                "title": "Opening hours",
                "keywords": "timing, timings, open, band, khula, hours",
                "content": (
                    "Hi {name}! We are open daily from 12:00 PM to 12:00 "
                    "AM. Late-night orders are welcome until midnight."
                ),
            },
            {
                "title": "Delivery areas",
                "keywords": "area, deliver, address, location, pohnchenge",
                "content": (
                    "Hi {name}! We deliver across the main city area. Share "
                    "your location and we will confirm right away."
                ),
            },
            {
                "title": "Today's deals",
                "keywords": "deal, deals, discount, offer, price",
                "content": (
                    "Hi {name}! Today's deal gives you 20% off on family "
                    "combos. Want us to send the full menu with prices?"
                ),
            },
            {
                "title": "Ordering steps",
                "keywords": "order, kaise, how, book",
                "content": (
                    "Hi {name}! Ordering is simple: send us the items you "
                    "want with your address, and we confirm the total and "
                    "delivery time right here on WhatsApp."
                ),
            },
        ],
    },
    "beauty_salon": {
        "label": "Beauty & salon",
        "description": "Services, rates, appointments and timings.",
        "entries": [
            {
                "title": "Book an appointment",
                "keywords": "appointment, booking, book, time, slot",
                "content": (
                    "Hi {name}! We would love to book you in. Share your "
                    "preferred day and time and we will confirm the slot "
                    "right away."
                ),
            },
            {
                "title": "Services and rates",
                "keywords": "rate, rates, price, charges, service, package",
                "content": (
                    "Hi {name}! Our most-loved packages start from basic "
                    "grooming to full bridal. Tell us which service you are "
                    "interested in and we will share the rates."
                ),
            },
            {
                "title": "Opening hours",
                "keywords": "timing, timings, open, closed, hours, khula",
                "content": (
                    "Hi {name}! We are open Monday to Sunday, 10:00 AM to "
                    "9:00 PM. Walk-ins are welcome; booked slots get "
                    "priority."
                ),
            },
            {
                "title": "Location",
                "keywords": "location, address, where, kahan",
                "content": (
                    "Hi {name}! We are located centrally — share your area "
                    "and we will send exact directions on WhatsApp."
                ),
            },
            {
                "title": "Home service",
                "keywords": "home service, ghar, home, visit",
                "content": (
                    "Hi {name}! Yes, we offer home service for bridal and "
                    "party bookings. Share your date and location for a "
                    "quote."
                ),
            },
        ],
    },
    "electronics_mobiles": {
        "label": "Electronics & mobiles",
        "description": "Prices, warranty, delivery and stock checks.",
        "entries": [
            {
                "title": "Warranty details",
                "keywords": "warranty, guarantee, claim, zimmedari",
                "content": (
                    "Hi {name}! All our products come with an official "
                    "warranty. Keep your receipt and message us here for "
                    "any warranty claim — we handle it end to end."
                ),
            },
            {
                "title": "Delivery time",
                "keywords": "delivery, delivery time, kitne din, shipping",
                "content": (
                    "Hi {name}! We deliver in 2-4 working days with "
                    "cash-on-delivery available nationwide."
                ),
            },
            {
                "title": "Price list",
                "keywords": "price, rate, price list, kitna, cost",
                "content": (
                    "Hi {name}! Prices change with stock, so we share the "
                    "latest confirmed price for each model. Which product "
                    "are you interested in?"
                ),
            },
            {
                "title": "Original products",
                "keywords": "original, copy, first copy, pta, fake",
                "content": (
                    "Hi {name}! We deal in 100% original, PTA-approved "
                    "products only. Every order includes a check-on-delivery "
                    "option for your peace of mind."
                ),
            },
            {
                "title": "Return policy",
                "keywords": "return, exchange, wapas, fault, fault, refund",
                "content": (
                    "Hi {name}! If a product has a fault, message us within "
                    "7 days and we will replace it or fix it under warranty "
                    "— no hassle."
                ),
            },
        ],
    },
    "general_retail": {
        "label": "General retail",
        "description": "Delivery, payment, availability and support basics.",
        "entries": [
            {
                "title": "Delivery time",
                "keywords": "delivery, delivery time, kitne din, shipping",
                "content": (
                    "Hi {name}! We deliver in 2-3 working days. You will get "
                    "a confirmation message as soon as your order ships."
                ),
            },
            {
                "title": "Cash on delivery",
                "keywords": "cod, cash on delivery, payment, advance",
                "content": (
                    "Hi {name}! Cash on delivery is available. You only pay "
                    "when your order reaches you."
                ),
            },
            {
                "title": "Stock availability",
                "keywords": "stock, available, available, mojood",
                "content": (
                    "Hi {name}! Tell us exactly which item you need and we "
                    "will confirm availability and the latest price right "
                    "away."
                ),
            },
            {
                "title": "Support hours",
                "keywords": "timing, hours, open, reply, jawab",
                "content": (
                    "Hi {name}! Our team replies daily from 10:00 AM to "
                    "10:00 PM — leave a message anytime and we will get "
                    "back to you first thing."
                ),
            },
            {
                "title": "Exchange policy",
                "keywords": "exchange, return, wapas, refund",
                "content": (
                    "Hi {name}! We accept exchanges within 7 days if the "
                    "item is unused and in original condition. Just message "
                    "us here to start one."
                ),
            },
        ],
    },
}


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


def _item_json(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": int(row.get("id") or 0),
        "kind": str(row.get("kind") or "product"),
        "name": str(row.get("name") or ""),
        "price_text": str(row.get("price_text") or ""),
        "notes": str(row.get("notes") or ""),
        "is_active": row.get("is_active") is True,
    }


def _clean_item_payload(raw):
    """Validate a catalog item payload. Returns (fields, error)."""
    if not isinstance(raw, dict):
        return None, (jsonify({"error": {"code": "bad_request",
                                         "message": "item object is required."}}), 400)
    kind = str(raw.get("kind") or "product").strip()
    name = str(raw.get("name") or "").strip()
    price_text = str(raw.get("price_text") or "").strip()
    notes = str(raw.get("notes") or "").strip()
    is_active_raw = raw.get("is_active")
    if is_active_raw is None:
        is_active = True
    else:
        is_active = is_active_raw is True or str(is_active_raw).lower() == "true"
    if kind not in ("product", "service"):
        return None, (jsonify({"error": {"code": "bad_request",
                                         "message": "kind must be product or service."}}), 400)
    if not name or len(name) > 200:
        return None, (jsonify({"error": {"code": "bad_request",
                                         "message": "Name is required (max 200 characters)."}}), 400)
    if len(price_text) > 100:
        return None, (jsonify({"error": {"code": "bad_request",
                                         "message": "Price must be 100 characters or fewer."}}), 400)
    if len(notes) > 1000:
        return None, (jsonify({"error": {"code": "bad_request",
                                         "message": "Notes must be 1000 characters or fewer."}}), 400)
    return {
        "kind": kind,
        "name": name,
        "price_text": price_text,
        "notes": notes,
        "is_active": is_active,
    }, None


@bp.get("/portal/catalog")
def get_catalog():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, kind, name, price_text, notes, is_active"
                    " FROM " + portal_db._q(CATALOG_TABLE) +
                    " WHERE client_id = %s"
                    " ORDER BY kind, name LIMIT %s",
                    (principal["client_id"], MAX_LIST_ITEMS),
                )
                item_rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal catalog")[0]), 503
    return jsonify({"items": [_item_json(row) for row in item_rows]}), 200


@bp.post("/portal/catalog")
def create_catalog_item():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    payload = request.get_json(silent=True) or {}
    fields, item_error = _clean_item_payload(payload.get("item"))
    if item_error is not None:
        return item_error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(CATALOG_TABLE) +
                    " (client_id, kind, name, price_text, notes, is_active)"
                    " VALUES (%s, %s, %s, %s, %s, %s)"
                    " RETURNING id, kind, name, price_text, notes, is_active",
                    (principal["client_id"], fields["kind"], fields["name"],
                     fields["price_text"], fields["notes"], fields["is_active"]),
                )
                created = portal_db.rows(cur)
                if created:
                    portal_db.log_action(
                        cur,
                        principal["client_id"],
                        "catalog.changed",
                        "customer_user",
                        principal.get("user_id"),
                        None,
                        "Added " + fields["kind"] + ": " + fields["name"][:120],
                    )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal catalog create")[0]), 503
    return jsonify({"ok": True, "item": _item_json(created[0] if created else {})}), 200


@bp.put("/portal/catalog/<int:item_id>")
def update_catalog_item(item_id):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    payload = request.get_json(silent=True) or {}
    fields, item_error = _clean_item_payload(payload.get("item"))
    if item_error is not None:
        return item_error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(CATALOG_TABLE) +
                    " SET kind = %s, name = %s, price_text = %s, notes = %s,"
                    " is_active = %s, updated_at = NOW()"
                    " WHERE id = %s AND client_id = %s"
                    " RETURNING id, kind, name, price_text, notes, is_active",
                    (fields["kind"], fields["name"], fields["price_text"],
                     fields["notes"], fields["is_active"],
                     item_id, principal["client_id"]),
                )
                updated = portal_db.rows(cur)
                if updated:
                    portal_db.log_action(
                        cur,
                        principal["client_id"],
                        "catalog.changed",
                        "customer_user",
                        principal.get("user_id"),
                        None,
                        "Updated " + fields["kind"] + ": " + fields["name"][:120],
                    )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal catalog update")[0]), 503
    if not updated:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Catalog item not found."}}), 404
    return jsonify({"ok": True, "item": _item_json(updated[0])}), 200


@bp.delete("/portal/catalog/<int:item_id>")
def delete_catalog_item(item_id):
    principal, error = _principal_or_error()
    if error is not None:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM " + portal_db._q(CATALOG_TABLE) +
                    " WHERE id = %s AND client_id = %s RETURNING id",
                    (item_id, principal["client_id"]),
                )
                deleted = portal_db.rows(cur)
                if deleted:
                    portal_db.log_action(
                        cur,
                        principal["client_id"],
                        "catalog.changed",
                        "customer_user",
                        principal.get("user_id"),
                        None,
                        "Removed a catalog item.",
                    )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal catalog delete")[0]), 503
    if not deleted:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Catalog item not found."}}), 404
    return jsonify({"ok": True}), 200


@bp.get("/portal/presets")
def get_presets():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    presets = [
        {
            "id": key,
            "label": value["label"],
            "description": value["description"],
            "entryCount": len(value["entries"]),
        }
        for key, value in INDUSTRY_PRESETS.items()
    ]
    return jsonify({"presets": presets}), 200


@bp.post("/portal/presets/apply")
def apply_preset():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    payload = request.get_json(silent=True) or {}
    industry = str(payload.get("industry") or "").strip()
    preset = INDUSTRY_PRESETS.get(industry)
    if preset is None:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Unknown industry."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                applied = 0
                skipped = 0
                for entry in preset["entries"]:
                    cur.execute(
                        "SELECT 1 FROM " + portal_db._q(KB_TABLE) +
                        " WHERE client_id = %s AND title = %s LIMIT 1",
                        (principal["client_id"], entry["title"]),
                    )
                    if portal_db.rows(cur):
                        skipped += 1
                        continue
                    cur.execute(
                        "INSERT INTO " + portal_db._q(KB_TABLE) +
                        " (client_id, title, category, keywords, content,"
                        " is_active) VALUES (%s, %s, 'starter', %s, %s, TRUE)",
                        (principal["client_id"], entry["title"],
                         entry["keywords"], entry["content"]),
                    )
                    applied += 1
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "preset.applied",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    preset["label"] + " (added " + str(applied) + ")",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal preset apply")[0]), 503
    return jsonify({"ok": True, "applied": applied, "skipped": skipped}), 200


@bp.get("/portal/activity")
def get_activity():
    principal, error = _principal_or_error()
    if error is not None:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, action, actor_kind, note, conversation_id,"
                    " created_at FROM " + portal_db._q(ACTIVITY_TABLE) +
                    " WHERE client_id = %s ORDER BY id DESC LIMIT 50",
                    (principal["client_id"],),
                )
                activity_rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal activity")[0]), 503
    items = [
        {
            "id": int(row.get("id") or 0),
            "action": str(row.get("action") or ""),
            "actor_kind": str(row.get("actor_kind") or ""),
            "note": str(row.get("note") or ""),
            "conversation_id": row.get("conversation_id"),
            "created_at": row.get("created_at"),
        }
        for row in activity_rows
    ]
    return jsonify({"items": items}), 200
`;

const MIGRATION_FILE = `-- 013: business core (catalog, action audit log)
-- Applied automatically by portal_db.ensure_tables(); kept here as the
-- canonical migration record (001-013).
CREATE TABLE IF NOT EXISTS portal_catalog (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'product',
  name TEXT NOT NULL,
  price_text TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_catalog
  ON portal_catalog (client_id, kind, is_active);
CREATE TABLE IF NOT EXISTS portal_action_log (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  action TEXT NOT NULL,
  actor_kind TEXT NOT NULL DEFAULT 'customer_user',
  actor_user_id BIGINT,
  conversation_id BIGINT,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_action_log
  ON portal_action_log (client_id, id DESC);
`;

const BFF_CATALOG_FILE = `import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  createCatalogItem,
  getCatalog,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const data = await getCatalog(accessToken);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(data, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}

function parseItemInput(payload: {
  item?: {
    kind?: unknown;
    name?: unknown;
    priceText?: unknown;
    notes?: unknown;
    isActive?: unknown;
  };
} | null):
  | { kind: "ok"; item: { kind: "product" | "service"; name: string; priceText: string; notes: string; isActive: boolean } }
  | { kind: "error"; message: string } {
  const input = payload?.item;
  if (!input) {
    return { kind: "error", message: "item object is required." };
  }
  const kind = input.kind === "service" ? "service" : "product";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const priceText = typeof input.priceText === "string" ? input.priceText.trim() : "";
  const notes = typeof input.notes === "string" ? input.notes.trim() : "";
  const isActive = input.isActive !== false;
  if (!name || name.length > 200) {
    return { kind: "error", message: "Name is required (max 200 characters)." };
  }
  if (priceText.length > 100) {
    return { kind: "error", message: "Price must be 100 characters or fewer." };
  }
  if (notes.length > 1000) {
    return { kind: "error", message: "Notes must be 1000 characters or fewer." };
  }
  return { kind: "ok", item: { kind, name, priceText, notes, isActive } };
}

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as Parameters<
    typeof parseItemInput
  >[0];
  const parsed = parseItemInput(payload);
  if (parsed.kind === "error") {
    return safeJson(
      { error: { code: "bad_request", message: parsed.message } },
      400
    );
  }

  try {
    const ok = await createCatalogItem(accessToken, parsed.item);
    if (!ok) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true }, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
`;

const BFF_CATALOG_ID_FILE = `import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  deleteCatalogItem,
  requirePortalAccessToken,
  updateCatalogItem,
} from "../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../lib/omniflow/request-security";


interface RouteContext {
  params: Promise<{ id: string }>;
}

function parseItemInput(payload: {
  item?: {
    kind?: unknown;
    name?: unknown;
    priceText?: unknown;
    notes?: unknown;
    isActive?: unknown;
  };
} | null):
  | { kind: "ok"; item: { kind: "product" | "service"; name: string; priceText: string; notes: string; isActive: boolean } }
  | { kind: "error"; message: string } {
  const input = payload?.item;
  if (!input) {
    return { kind: "error", message: "item object is required." };
  }
  const kind = input.kind === "service" ? "service" : "product";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const priceText = typeof input.priceText === "string" ? input.priceText.trim() : "";
  const notes = typeof input.notes === "string" ? input.notes.trim() : "";
  const isActive = input.isActive !== false;
  if (!name || name.length > 200) {
    return { kind: "error", message: "Name is required (max 200 characters)." };
  }
  if (priceText.length > 100) {
    return { kind: "error", message: "Price must be 100 characters or fewer." };
  }
  if (notes.length > 1000) {
    return { kind: "error", message: "Notes must be 1000 characters or fewer." };
  }
  return { kind: "ok", item: { kind, name, priceText, notes, isActive } };
}

export async function PUT(request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await context.params;
  const itemId = Number(id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid item id." } },
      400
    );
  }

  const payload = (await request.json().catch(() => null)) as Parameters<
    typeof parseItemInput
  >[0];
  const parsed = parseItemInput(payload);
  if (parsed.kind === "error") {
    return safeJson(
      { error: { code: "bad_request", message: parsed.message } },
      400
    );
  }

  try {
    const ok = await updateCatalogItem(accessToken, itemId, parsed.item);
    if (!ok) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true }, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await context.params;
  const itemId = Number(id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid item id." } },
      400
    );
  }

  try {
    const ok = await deleteCatalogItem(accessToken, itemId);
    if (!ok) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true }, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
`;

const BFF_PRESETS_FILE = `import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  applyIndustryPreset,
  getIndustryPresets,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const data = await getIndustryPresets(accessToken);
    if (data === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson(data, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    industry?: unknown;
  } | null;
  const industry =
    typeof payload?.industry === "string" ? payload.industry.trim() : "";
  if (!industry) {
    return safeJson(
      { error: { code: "bad_request", message: "industry is required." } },
      400
    );
  }

  try {
    const result = await applyIndustryPreset(accessToken, industry);
    if (result === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    if (result.kind === "bad_request") {
      return safeJson(
        { error: { code: "bad_request", message: "Unknown industry." } },
        400
      );
    }
    return safeJson(
      { ok: true, applied: result.applied, skipped: result.skipped },
      200
    );
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
`;

const BFF_ACTIVITY_FILE = `import { ControlPlaneRequestError } from "../../../../../lib/omniflow/control-plane";
import {
  getRecentActivity,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../lib/omniflow/request-security";


export async function GET() {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  try {
    const items = await getRecentActivity(accessToken);
    if (items === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ items }, 200);
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
`;

const CATALOG_SECTION_FILE = `"use client";

import { useCallback, useEffect, useState } from "react";
import type { CatalogItem, IndustryPreset } from "../../../../lib/omniflow/portal";

const inputClass =
  "w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40";

const labelClass = "mb-1.5 block text-xs font-medium text-slate-400";

const primaryBtn =
  "rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50";

const ghostBtn =
  "rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-xs font-medium text-slate-300 transition-colors duration-300 hover:bg-white/[0.05] disabled:opacity-50";

const chipClass =
  "rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-slate-500";

interface ItemFormState {
  id: number | null;
  kind: "product" | "service";
  name: string;
  priceText: string;
  notes: string;
  isActive: boolean;
}

const EMPTY_FORM: ItemFormState = {
  id: null,
  kind: "product",
  name: "",
  priceText: "",
  notes: "",
  isActive: true,
};

export default function CatalogSection() {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [presets, setPresets] = useState<IndustryPreset[]>([]);
  const [industry, setIndustry] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState<ItemFormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null
  );

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/catalog", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        items?: CatalogItem[];
      } | null;
      if (payload && Array.isArray(payload.items)) {
        setItems(payload.items);
      }
    } catch {
      // Transient network issue — the next action retries.
    }
  }, []);

  useEffect(() => {
    let alive = true;

    async function loadAll() {
      try {
        const [catalogResponse, presetsResponse] = await Promise.all([
          fetch("/api/omniflow/portal/catalog", {
            credentials: "same-origin",
            cache: "no-store",
          }),
          fetch("/api/omniflow/portal/presets", {
            credentials: "same-origin",
            cache: "no-store",
          }),
        ]);
        if (!alive) return;
        if (catalogResponse.ok) {
          const payload = (await catalogResponse.json().catch(() => null)) as {
            items?: CatalogItem[];
          } | null;
          if (payload && Array.isArray(payload.items)) setItems(payload.items);
        }
        if (presetsResponse.ok) {
          const payload = (await presetsResponse.json().catch(() => null)) as {
            presets?: IndustryPreset[];
          } | null;
          if (payload && Array.isArray(payload.presets)) {
            setPresets(payload.presets);
            setIndustry(payload.presets[0]?.id ?? "");
          }
        }
      } catch {
        // Transient network issue — the next action retries.
      } finally {
        if (alive) setLoaded(true);
      }
    }

    void loadAll();
    return () => {
      alive = false;
    };
  }, []);

  async function applyPreset() {
    if (busy || !industry) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/omniflow/portal/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ industry }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        applied?: number;
        skipped?: number;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({
          kind: "ok",
          text:
            "Starter pack loaded — " +
            String(payload.applied ?? 0) +
            " answers added to your knowledge base" +
            (payload.skipped
              ? " (" + String(payload.skipped) + " already existed)"
              : "") +
            ". Review them on the Knowledge base page.",
        });
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not load the pack. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  async function saveForm() {
    if (busy || !form) return;
    const name = form.name.trim();
    if (!name) {
      setMessage({ kind: "error", text: "Name is required." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        form.id === null
          ? "/api/omniflow/portal/catalog"
          : "/api/omniflow/portal/catalog/" + String(form.id),
        {
          method: form.id === null ? "POST" : "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            item: {
              kind: form.kind,
              name,
              priceText: form.priceText.trim(),
              notes: form.notes.trim(),
              isActive: form.isActive,
            },
          }),
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMessage({
          kind: "ok",
          text: form.id === null ? "Item added." : "Item updated.",
        });
        setForm(null);
        await refresh();
      } else {
        setMessage({
          kind: "error",
          text: payload?.error?.message || "Could not save. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(itemId: number) {
    if (busy) return;
    if (!window.confirm("Delete this item from your catalog?")) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/catalog/" + String(itemId),
        {
          method: "DELETE",
          credentials: "same-origin",
        }
      );
      if (response.ok) {
        setMessage({ kind: "ok", text: "Item deleted." });
        await refresh();
      } else {
        setMessage({
          kind: "error",
          text: "Could not delete. Try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <h2 className="text-sm font-semibold text-white">Quick setup</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          Pick your business type and we will load proven starter answers
          (delivery, payments, policies) into your knowledge base. You can
          edit or remove them anytime.
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <select
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            aria-label="Business type"
            className={inputClass + " sm:max-w-xs"}
          >
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label} — {preset.entryCount} answers
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => applyPreset()}
            disabled={busy || presets.length === 0}
            className={primaryBtn}
          >
            {busy ? "Loading..." : "Load starter pack"}
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-white">
              Products &amp; services
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              Your offering at a glance — what you sell and at what price.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setForm({ ...EMPTY_FORM });
              setMessage(null);
            }}
            className={primaryBtn}
          >
            Add item
          </button>
        </div>

        {message && (
          <div
            className={
              "mt-4 rounded-xl border px-4 py-3 text-xs leading-relaxed " +
              (message.kind === "ok"
                ? "border-emerald-400/20 bg-emerald-400/[0.05] text-emerald-200/90"
                : "border-red-400/20 bg-red-400/[0.05] text-red-200/90")
            }
          >
            {message.text}
          </div>
        )}

        {form && (
          <div className="mt-4 rounded-2xl border border-cyan-400/15 bg-white/[0.02] p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="itemKind" className={labelClass}>
                  Type
                </label>
                <select
                  id="itemKind"
                  value={form.kind}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      kind: e.target.value === "service" ? "service" : "product",
                    })
                  }
                  className={inputClass}
                >
                  <option value="product">Product</option>
                  <option value="service">Service</option>
                </select>
              </div>
              <div>
                <label htmlFor="itemName" className={labelClass}>
                  Name
                </label>
                <input
                  id="itemName"
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Lawn 3-piece suit"
                  className={inputClass}
                />
              </div>
            </div>
            <div className="mt-4">
              <label htmlFor="itemPrice" className={labelClass}>
                Price
              </label>
              <input
                id="itemPrice"
                type="text"
                value={form.priceText}
                onChange={(e) => setForm({ ...form, priceText: e.target.value })}
                placeholder="PKR 4,500 (negotiable)"
                className={inputClass}
              />
            </div>
            <div className="mt-4">
              <label htmlFor="itemNotes" className={labelClass}>
                Notes
              </label>
              <textarea
                id="itemNotes"
                rows={3}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Sizes S-XXL, 6 colours in stock..."
                className={inputClass}
              />
            </div>
            <div className="mt-4 flex items-center justify-between gap-4">
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) =>
                    setForm({ ...form, isActive: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-white/20 bg-white/[0.03]"
                />
                Active
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setForm(null)}
                  className={ghostBtn}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => saveForm()}
                  disabled={busy}
                  className={primaryBtn}
                >
                  {busy ? "Saving..." : "Save item"}
                </button>
              </div>
            </div>
          </div>
        )}

        {!loaded ? (
          <p className="mt-4 text-xs text-slate-600">Loading catalog...</p>
        ) : items.length === 0 ? (
          <p className="mt-4 text-xs leading-relaxed text-slate-600">
            No items yet — add your first product or service above.
          </p>
        ) : (
          <div className="mt-5 space-y-3">
            {items.map((item) => (
              <div
                key={item.id}
                className="rounded-xl border border-white/[0.05] bg-white/[0.01] p-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-medium text-white">
                        {item.name}
                      </h3>
                      <span className={chipClass}>{item.kind}</span>
                      {!item.isActive && (
                        <span className="rounded-md border border-amber-400/20 bg-amber-400/[0.05] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-amber-300/80">
                          Hidden
                        </span>
                      )}
                    </div>
                    {item.priceText && (
                      <p className="mt-1 text-xs text-slate-400">
                        {item.priceText}
                      </p>
                    )}
                    {item.notes && (
                      <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
                        {item.notes}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setForm({
                          id: item.id,
                          kind: item.kind,
                          name: item.name,
                          priceText: item.priceText,
                          notes: item.notes,
                          isActive: item.isActive,
                        });
                        setMessage(null);
                      }}
                      className={ghostBtn}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => removeItem(item.id)}
                      disabled={busy}
                      className="rounded-xl border border-red-400/15 bg-red-400/[0.04] px-4 py-2 text-xs font-medium text-red-300/80 transition-colors duration-300 hover:bg-red-400/[0.09] disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
`;

const TARGETS = [
  // ---------------------------------------------------------------- backend
  {
    file: "OmniFlow-Control-Plane/portal_db.py",
    swaps: [
      {
        name: "lazy business-core tables",
        from: `CREATE INDEX IF NOT EXISTS idx_portal_kb_entries
  ON portal_kb_entries (client_id, is_active, updated_at DESC);
"""`,
        to: `CREATE INDEX IF NOT EXISTS idx_portal_kb_entries
  ON portal_kb_entries (client_id, is_active, updated_at DESC);
CREATE TABLE IF NOT EXISTS portal_catalog (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'product',
  name TEXT NOT NULL,
  price_text TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_catalog
  ON portal_catalog (client_id, kind, is_active);
CREATE TABLE IF NOT EXISTS portal_action_log (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  action TEXT NOT NULL,
  actor_kind TEXT NOT NULL DEFAULT 'customer_user',
  actor_user_id BIGINT,
  conversation_id BIGINT,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_action_log
  ON portal_action_log (client_id, id DESC);
"""`,
      },
      {
        name: "log_action helper",
        from: `    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def portal_unavailable(error: Exception, context: str) -> Any:`,
        to: `    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def log_action(cur, client_id, action, actor_kind="customer_user",
               actor_user_id=None, conversation_id=None, note=""):
    """Append one row to the action audit log (portal_action_log)."""
    cur.execute(
        "INSERT INTO " + _q("portal_action_log") +
        " (client_id, action, actor_kind, actor_user_id, conversation_id,"
        " note, created_at) VALUES (%s, %s, %s, %s, %s, %s, NOW())",
        (client_id, action, actor_kind, actor_user_id, conversation_id, note),
    )


def portal_unavailable(error: Exception, context: str) -> Any:`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/app.py",
    swaps: [
      {
        name: "import catalog blueprint",
        from: `from portal_kb import bp as portal_kb_bp  # noqa: E402`,
        to: `from portal_kb import bp as portal_kb_bp  # noqa: E402
from portal_catalog import bp as portal_catalog_bp  # noqa: E402`,
      },
      {
        name: "register catalog blueprint",
        from: `aux_app.register_blueprint(portal_kb_bp)`,
        to: `aux_app.register_blueprint(portal_kb_bp)
aux_app.register_blueprint(portal_catalog_bp)`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/connector_api.py",
    swaps: [],
  },
  {
    file: "OmniFlow-Control-Plane/portal_conversations.py",
    swaps: [
      {
        name: "audit: status change",
        from: `                    (status, conversation_id, principal["client_id"]),
                )
                updated = portal_db.rows(cur)
            conn.commit()`,
        to: `                    (status, conversation_id, principal["client_id"]),
                )
                updated = portal_db.rows(cur)
                if updated:
                    portal_db.log_action(
                        cur,
                        principal["client_id"],
                        "conversation.status_changed",
                        "customer_user",
                        principal.get("user_id"),
                        conversation_id,
                        "Status set to " + str(status) + ".",
                    )
            conn.commit()`,
      },
      {
        name: "audit: reply enqueued",
        from: `                inserted = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal message enqueue")[0]), 503`,
        to: `                inserted = portal_db.rows(cur)
                if inserted:
                    portal_db.log_action(
                        cur,
                        principal["client_id"],
                        "message.enqueued",
                        "customer_user",
                        principal.get("user_id"),
                        conversation_id,
                        "Reply queued for delivery.",
                    )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal message enqueue")[0]), 503`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/portal_followups.py",
    swaps: [
      {
        name: "audit: follow-up ack",
        from: `                    " RETURNING f.stage, f.attempts",
                    (note, followup_id),
                )
                updated = portal_db.rows(cur)
            conn.commit()`,
        to: `                    " RETURNING f.stage, f.attempts, f.client_id,"
                    " f.conversation_id",
                    (note, followup_id),
                )
                updated = portal_db.rows(cur)
                if updated:
                    portal_db.log_action(
                        cur,
                        updated[0].get("client_id"),
                        "followup.ack",
                        "connector",
                        None,
                        updated[0].get("conversation_id"),
                        ("Follow-up delivered." if ok
                         else "Follow-up failed: " + str(note or ""))[:200],
                    )
            conn.commit()`,
      },
    ],
  },
  {
    file: "OmniFlow-Control-Plane/portal_kb.py",
    swaps: [
      {
        name: "audit: instant answer",
        from: `        cur.execute(
            "UPDATE " + portal_db._q(KB_TABLE) +
            " SET usage_count = usage_count + 1 WHERE id = %s",
            (entry.get("id"),),
        )
    logger.info(`,
        to: `        cur.execute(
            "UPDATE " + portal_db._q(KB_TABLE) +
            " SET usage_count = usage_count + 1 WHERE id = %s",
            (entry.get("id"),),
        )
        portal_db.log_action(
            cur,
            client_id,
            "kb.auto_reply",
            "system",
            None,
            conversation_id,
            ("Instant answer sent: "
             + str(entry.get("title") or ""))[:200],
        )
    logger.info(`,
      },
    ],
  },
  // ---------------------------------------------------------------- website
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      {
        name: "business-core client helpers",
        from: `export type ConversationStatusResult =`,
        to: `export interface CatalogItem {
  id: number;
  kind: "product" | "service";
  name: string;
  priceText: string;
  notes: string;
  isActive: boolean;
}

export interface CatalogItemInput {
  kind: "product" | "service";
  name: string;
  priceText: string;
  notes: string;
  isActive: boolean;
}

export interface IndustryPreset {
  id: string;
  label: string;
  description: string;
  entryCount: number;
}

export interface ActivityItem {
  id: number;
  action: string;
  label: string;
  note: string;
  createdAt: string;
  timeAgo: string;
}

function mapCatalogItem(raw: Record<string, unknown>): CatalogItem {
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    kind: raw.kind === "service" ? "service" : "product",
    name: typeof raw.name === "string" ? raw.name : "",
    priceText: typeof raw.price_text === "string" ? raw.price_text : "",
    notes: typeof raw.notes === "string" ? raw.notes : "",
    isActive: raw.is_active === true,
  };
}

export async function getCatalog(
  accessToken: string
): Promise<{ items: CatalogItem[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/catalog");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawItems = (payload as Record<string, unknown>).items;
  if (!Array.isArray(rawItems)) return { items: [] };
  return {
    items: rawItems
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object"
      )
      .map(mapCatalogItem),
  };
}

export async function createCatalogItem(
  accessToken: string,
  item: CatalogItemInput
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        item: {
          kind: item.kind,
          name: item.name,
          price_text: item.priceText,
          notes: item.notes,
          is_active: item.isActive,
        },
      }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function updateCatalogItem(
  accessToken: string,
  itemId: number,
  item: CatalogItemInput
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/catalog/" + itemId,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item: {
            kind: item.kind,
            name: item.name,
            price_text: item.priceText,
            notes: item.notes,
            is_active: item.isActive,
          },
        }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function deleteCatalogItem(
  accessToken: string,
  itemId: number
): Promise<boolean> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/catalog/" + itemId,
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return false;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  return response.ok;
}

export async function getIndustryPresets(
  accessToken: string
): Promise<{ presets: IndustryPreset[] } | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/presets");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawPresets = (payload as Record<string, unknown>).presets;
  if (!Array.isArray(rawPresets)) return { presets: [] };
  return {
    presets: rawPresets
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object"
      )
      .map((raw) => ({
        id: typeof raw.id === "string" ? raw.id : "",
        label: typeof raw.label === "string" ? raw.label : "",
        description: typeof raw.description === "string" ? raw.description : "",
        entryCount: typeof raw.entryCount === "number" ? raw.entryCount : 0,
      })),
  };
}

export async function applyIndustryPreset(
  accessToken: string,
  industry: string
): Promise<
  | { kind: "ok"; applied: number; skipped: number }
  | { kind: "bad_request" }
  | null
> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/presets/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ industry }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "bad_request" };
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  return {
    kind: "ok",
    applied: typeof p.applied === "number" ? p.applied : 0,
    skipped: typeof p.skipped === "number" ? p.skipped : 0,
  };
}

const ACTION_LABELS: Record<string, string> = {
  "kb.auto_reply": "Instant answer sent",
  "message.enqueued": "Reply queued",
  "conversation.status_changed": "Conversation status changed",
  "followup.ack": "Follow-up delivered",
  "preset.applied": "Starter pack loaded",
  "catalog.changed": "Catalog updated",
};

function timeAgoLabel(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  return days + "d ago";
}

export async function getRecentActivity(
  accessToken: string
): Promise<ActivityItem[] | null> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/activity");
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawItems = (payload as Record<string, unknown>).items;
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .filter(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === "object"
    )
    .map((raw) => {
      const action = typeof raw.action === "string" ? raw.action : "";
      const createdAt =
        typeof raw.created_at === "string" ? raw.created_at : "";
      return {
        id: typeof raw.id === "number" ? raw.id : 0,
        action,
        label: ACTION_LABELS[action] || action,
        note: typeof raw.note === "string" ? raw.note : "",
        createdAt,
        timeAgo: timeAgoLabel(createdAt),
      };
    });
}

export type ConversationStatusResult =`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/components/DashSidebar.tsx",
    swaps: [
      {
        name: "enable Business profile link",
        from: `  {
    label: "Business profile",
    href: "/dashboard/profile",
    icon: "◇",
    enabled: false,
  },`,
        to: `  {
    label: "Business profile",
    href: "/dashboard/profile",
    icon: "◇",
    enabled: true,
  },`,
      },
      {
        name: "enable Settings link",
        from: `  { label: "Settings", href: "/dashboard/settings", icon: "⌘", enabled: false },`,
        to: `  { label: "Settings", href: "/dashboard/settings", icon: "⌘", enabled: true },`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/profile/page.tsx",
    swaps: [
      {
        name: "import catalog section",
        from: `import ProfileForm, { type BusinessProfile } from "./ProfileForm";`,
        to: `import ProfileForm, { type BusinessProfile } from "./ProfileForm";
import CatalogSection from "./CatalogSection";`,
      },
      {
        name: "render catalog section",
        from: `      <ProfileForm profile={profile} />
    </div>
  );
}`,
        to: `      <ProfileForm profile={profile} />

      <div className="mt-6">
        <CatalogSection />
      </div>
    </div>
  );
}`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/page.tsx",
    swaps: [
      {
        name: "imports for activity",
        from: `import { requireOmniFlowPrincipal } from "../../../lib/omniflow/auth-dal";`,
        to: `import { requireOmniFlowPrincipal } from "../../../lib/omniflow/auth-dal";
import { getRecentActivity } from "../../../lib/omniflow/portal";
import { readSessionCookies } from "../../../lib/omniflow/session-cookies";`,
      },
      {
        name: "load recent activity",
        from: `  const principal = await requireOmniFlowPrincipal();`,
        to: `  const principal = await requireOmniFlowPrincipal();
  const { accessToken } = await readSessionCookies();
  const activity = accessToken ? await getRecentActivity(accessToken) : null;`,
      },
      {
        name: "render recent activity card",
        from: `      <div className="grid gap-4 sm:grid-cols-2">`,
        to: `      {activity && activity.length > 0 && (
        <div className="mb-8 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5">
          <h2 className="text-sm font-semibold text-white">Recent activity</h2>
          <p className="mt-1 text-xs text-slate-500">
            Live audit trail of what your assistant and team did across
            conversations.
          </p>
          <ul className="mt-4 space-y-2.5">
            {activity.slice(0, 6).map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-4 text-xs"
              >
                <span className="min-w-0 truncate text-slate-300">
                  {item.label}
                  {item.note ? (
                    <span className="text-slate-600"> — {item.note}</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-slate-600">{item.timeAgo}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">`,
      },
    ],
  },
];

let appliedTotal = 0;
let alreadyTotal = 0;
let warnTotal = 0;

function compilePython(pathArg) {
  for (const py of ["python", "python3"]) {
    try {
      execFileSync(py, ["-m", "py_compile", pathArg], { stdio: "pipe" });
      return true;
    } catch {
      /* try next interpreter */
    }
  }
  return false;
}

function writeFileEnsuringDir(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.replace(/\r\n/g, "\n"), "utf8");
}

for (const target of TARGETS) {
  if (target.swaps.length === 0) continue;
  if (!fs.existsSync(target.file)) {
    console.log("SKIP (file not found): " + target.file);
    warnTotal++;
    continue;
  }

  const original = fs.readFileSync(target.file, "utf8");
  let text = original.replace(/\r\n/g, "\n");
  let changed = false;
  const fileApplied = [];

  for (const swap of target.swaps) {
    if (swap.regex) {
      if (swap.alreadyMarker && text.includes(swap.alreadyMarker)) {
        alreadyTotal++;
        continue;
      }
      const global = new RegExp(swap.regex, (swap.flags || "") + "g");
      const hits = text.match(global);
      if (hits && hits.length === 1) {
        text = text.replace(global, swap.to);
        changed = true;
        appliedTotal++;
        fileApplied.push(swap.name);
      } else {
        warnTotal++;
        console.log(
          "  ? " + target.file + " :: " + swap.name + " NOT FOUND — report this"
        );
      }
      continue;
    }

    const fromCount = text.split(swap.from).length - 1;
    const toCount = text.split(swap.to).length - 1;

    if (fromCount === 1 && toCount === 0) {
      text = text.split(swap.from).join(swap.to);
      changed = true;
      appliedTotal++;
      fileApplied.push(swap.name);
    } else if (toCount > 0) {
      alreadyTotal++;
    } else {
      warnTotal++;
      console.log("  ? " + target.file + " :: " + swap.name + " NOT FOUND — report this");
    }
  }

  if (!changed) {
    console.log("= " + target.file + " (already patched)");
    continue;
  }

  const backup = target.file + ".pre_bc.bak";
  if (!fs.existsSync(backup)) fs.copyFileSync(target.file, backup);

  if (target.file.endsWith(".py")) {
    fs.writeFileSync(target.file, text, "utf8");
    if (!compilePython(target.file)) {
      fs.copyFileSync(backup, target.file);
      console.log("FAIL (compile failed, restored): " + target.file);
      warnTotal++;
      continue;
    }
  } else {
    fs.writeFileSync(target.file, text, "utf8");
  }

  console.log("+ " + target.file + " (" + fileApplied.length + "): " + fileApplied.join(", "));
}

// New files (written only when missing).
const NEW_FILES = [
  [MODULE_PATH, MODULE_FILE],
  [MIGRATION_PATH, MIGRATION_FILE],
  [BFF_CATALOG_PATH, BFF_CATALOG_FILE],
  [BFF_CATALOG_ID_PATH, BFF_CATALOG_ID_FILE],
  [BFF_PRESETS_PATH, BFF_PRESETS_FILE],
  [BFF_ACTIVITY_PATH, BFF_ACTIVITY_FILE],
  [CATALOG_SECTION_PATH, CATALOG_SECTION_FILE],
];
for (const [newPath, newContent] of NEW_FILES) {
  if (fs.existsSync(newPath)) {
    console.log("= " + newPath + " (already present)");
  } else {
    writeFileEnsuringDir(newPath, newContent);
    appliedTotal++;
    console.log("+ " + newPath);
  }
}
if (fs.existsSync(MODULE_PATH)) {
  if (!compilePython(MODULE_PATH)) {
    console.log("FAIL (new module compile failed): " + MODULE_PATH);
    warnTotal++;
  }
}

console.log("");
console.log(
  "SUMMARY: " +
    appliedTotal +
    " applied, " +
    alreadyTotal +
    " already done, " +
    warnTotal +
    " warnings"
);
