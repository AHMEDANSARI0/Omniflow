"""Product recommendations v0: deterministic, zero AI. Scores catalog items
against four signals from data the workspace already has - the contact's own
paid orders (repeat), their chat mentions (interest), what other customers
bought alongside them (co-purchase), and workspace bestsellers (fallback).
Read-only: no new tables."""

import logging
import re

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
)
import portal_db
from typing import Any, Dict, List

bp = Blueprint("portal_reco", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)

CATALOG_TABLE = "portal_catalog"
LINKS_TABLE = "portal_checkout_links"

WEIGHT_PAID = 100
WEIGHT_MENTION = 60
WEIGHT_COPURCHASE = 40
WEIGHT_BESTSELLER = 20

MAX_SUGGESTIONS = 5
MAX_PAID_LINKS = 20
MAX_ALL_LINKS = 200
MAX_INBOUND = 50
MAX_CATALOG = 100
MAX_RECO_NAME = 200

_TOKEN_RE = re.compile(r"[a-z0-9]{3,}")

_RECO_DDL_READY = True  # module owns no tables


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


def _table_exists(cur, table: str) -> bool:
    cur.execute("SELECT to_regclass(%s) AS oid", (table,))
    rows = portal_db.rows(cur)
    return bool(rows and rows[0].get("oid"))


def _items_of(payload: Any) -> List[Dict[str, str]]:
    """[{name, price}] from a checkout items JSONB value (defensive)."""
    items: List[Dict[str, str]] = []
    if not isinstance(payload, list):
        return items
    for entry in payload:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        if name:
            items.append({
                "name": name[:MAX_RECO_NAME],
                "price": str(entry.get("price") or ""),
            })
    return items


def _load_catalog(cur, client_id) -> List[Dict[str, str]]:
    if not _table_exists(cur, CATALOG_TABLE):
        return []
    cur.execute(
        "SELECT name, price_text, notes, kind FROM " + portal_db._q(CATALOG_TABLE) +
        " WHERE client_id = %s AND is_active"
        " ORDER BY id DESC LIMIT " + str(MAX_CATALOG),
        (client_id,),
    )
    rows = portal_db.rows(cur)
    catalog = []
    for row in rows:
        name = str(row.get("name") or "").strip()[:MAX_RECO_NAME]
        if name:
            catalog.append({
                "name": name,
                "price_text": str(row.get("price_text") or ""),
                "notes": str(row.get("notes") or "")[:160],
                "kind": str(row.get("kind") or "product"),
            })
    return catalog


def _load_paid_items(cur, client_id, contact) -> List[Dict[str, str]]:
    if not _table_exists(cur, LINKS_TABLE):
        return []
    cur.execute(
        "SELECT items FROM " + portal_db._q(LINKS_TABLE) +
        " WHERE client_id = %s AND contact_id = %s AND status = 'paid'"
        " ORDER BY id DESC LIMIT " + str(MAX_PAID_LINKS),
        (client_id, contact),
    )
    items: List[Dict[str, str]] = []
    for row in portal_db.rows(cur):
        items.extend(_items_of(row.get("items")))
    return items


def _load_open_names(cur, client_id, contact) -> set:
    if not _table_exists(cur, LINKS_TABLE):
        return set()
    cur.execute(
        "SELECT items FROM " + portal_db._q(LINKS_TABLE) +
        " WHERE client_id = %s AND contact_id = %s AND status = 'open'"
        " ORDER BY id DESC LIMIT " + str(MAX_PAID_LINKS),
        (client_id, contact),
    )
    names: set = set()
    for row in portal_db.rows(cur):
        for item in _items_of(row.get("items")):
            names.add(item["name"].lower())
    return names


def _load_all_paid_links(cur, client_id) -> List[Dict[str, Any]]:
    if not _table_exists(cur, LINKS_TABLE):
        return []
    cur.execute(
        "SELECT contact_id, items FROM " + portal_db._q(LINKS_TABLE) +
        " WHERE client_id = %s AND status = 'paid'"
        " ORDER BY id DESC LIMIT " + str(MAX_ALL_LINKS),
        (client_id,),
    )
    links = []
    for row in portal_db.rows(cur):
        links.append({
            "contact_id": str(row.get("contact_id") or ""),
            "items": _items_of(row.get("items")),
        })
    return links


def _load_inbound_bodies(cur, client_id, contact) -> List[str]:
    cur.execute(
        "SELECT m.body AS body FROM " + portal_db._q(portal_db.MSGS_TABLE) +
        " m JOIN " + portal_db._q(portal_db.CONV_TABLE) + " c"
        " ON c.id = m.conversation_id"
        " WHERE c.client_id = %s AND c.contact_id = %s"
        " AND m.direction = 'in' AND COALESCE(m.body, '') <> ''"
        " ORDER BY m.id DESC LIMIT " + str(MAX_INBOUND),
        (client_id, contact),
    )
    return [str(row.get("body") or "") for row in portal_db.rows(cur)]


def _catalog_lookup(catalog: List[Dict[str, str]]) -> Dict[str, Dict[str, str]]:
    return {entry["name"].lower(): entry for entry in catalog}


def _mentions(name: str, bodies: List[str]) -> int:
    """How many recent inbound messages reference this catalog name."""
    needle = name.lower().strip()
    if len(needle) < 4:
        # ultra-short names ("pao", "rup") would false-positive everywhere
        return 0
    hits = 0
    for body in bodies:
        if needle in body.lower():
            hits += 1
    return hits


def build_suggestions(cur, client_id, contact) -> Dict[str, Any]:
    """Four deterministic signals -> scored, deduped, capped suggestions."""
    contact = str(contact or "").strip()[:100]
    catalog = _load_catalog(cur, client_id)
    lookup = _catalog_lookup(catalog)
    paid_items = _load_paid_items(cur, client_id, contact)
    open_names = _load_open_names(cur, client_id, contact)
    all_links = _load_all_paid_links(cur, client_id)
    bodies = _load_inbound_bodies(cur, client_id, contact)

    scores: Dict[str, Dict[str, Any]] = {}

    def bump(name: str, points: int, reason: str, price_text: str = "",
             notes: str = "", kind: str = "product") -> None:
        key = name.lower().strip()[:MAX_RECO_NAME]
        if not key or key in open_names:
            return
        entry = scores.setdefault(key, {
            "name": name[:MAX_RECO_NAME],
            "price_text": price_text,
            "notes": notes,
            "kind": kind,
            "score": 0,
            "reasons": [],
        })
        entry["score"] += points
        if len(entry["reasons"]) < 2:
            entry["reasons"].append(reason)
        if price_text and not entry["price_text"]:
            entry["price_text"] = price_text
        if notes and not entry["notes"]:
            entry["notes"] = notes

    # Signal A: the contact's own paid orders (minus what they already have)
    paid_names = set()
    for item in paid_items:
        key = item["name"].lower().strip()
        paid_names.add(key)
        entry = lookup.get(key)
        # the purchased item itself is not a recommendation, but its siblings are
        bump(item["name"], 0, "", entry.get("price_text", "") if entry else
             item["price"], entry.get("notes", "") if entry else "", )
    for key in list(scores):
        if key in paid_names:
            del scores[key]

    # co-purchase pool from OTHER contacts' paid links
    copurchase: Dict[str, Dict[str, int]] = {}

    # Signal B: chat mentions of catalog names
    for entry in catalog:
        hits = _mentions(entry["name"], bodies)
        if hits > 0 and entry["name"].lower() not in paid_names:
            bump(entry["name"], WEIGHT_MENTION + min(hits, 3) * 5,
                 "Asked about it in chat", entry["price_text"],
                 entry["notes"], entry["kind"])

    # Signal C: co-purchase - items bought by others who share paid items
    for link in all_links:
        if link["contact_id"] == contact:
            continue
        other_names = {item["name"].lower().strip() for item in link["items"]}
        overlap = other_names & paid_names
        if not overlap:
            continue
        for item in link["items"]:
            key = item["name"].lower().strip()
            if key in paid_names or key in overlap:
                continue
            bucket = copurchase.setdefault(key, {"count": 0, "with": ""})
            bucket["count"] += 1
            if not bucket["with"]:
                bucket["with"] = sorted(overlap)[0]

    for key, info in copurchase.items():
        entry = lookup.get(key)
        bump(
            entry["name"] if entry else key,
            WEIGHT_COPURCHASE + min(info["count"], 5) * 5,
            "Goes well with " + info["with"],
            entry.get("price_text", "") if entry else "",
            entry.get("notes", "") if entry else "",
            entry.get("kind", "product") if entry else "product",
        )

    # Signal D: workspace bestsellers (fills the rest)
    bestseller: Dict[str, int] = {}
    for link in all_links:
        for item in link["items"]:
            key = item["name"].lower().strip()
            bestseller[key] = bestseller.get(key, 0) + 1
    for key, count in sorted(bestseller.items(), key=lambda kv: (-kv[1], kv[0])):
        if len(scores) >= MAX_SUGGESTIONS + 3:
            break
        if count < 2 or key in paid_names:
            continue
        entry = lookup.get(key)
        bump(
            entry["name"] if entry else key,
            WEIGHT_BESTSELLER + min(count, 6) * 5,
            "Popular with your customers",
            entry.get("price_text", "") if entry else "",
            entry.get("notes", "") if entry else "",
            entry.get("kind", "product") if entry else "product",
        )

    ranked = sorted(scores.values(),
                    key=lambda entry: (-entry["score"], entry["name"].lower()))
    return {
        "suggestions": [
            {
                "name": entry["name"],
                "price_text": entry["price_text"],
                "notes": entry["notes"],
                "kind": entry["kind"],
                "score": entry["score"],
                "reasons": entry["reasons"],
            }
            for entry in ranked[:MAX_SUGGESTIONS]
        ],
        "signals": {
            "paid_items": len(paid_items),
            "mentions": sum(1 for entry in catalog
                            if _mentions(entry["name"], bodies) > 0),
            "bestsellers": len([k for k, v in bestseller.items() if v >= 2]),
            "catalog_items": len(catalog),
        },
    }


@bp.get("/reco/suggest")
def reco_suggest():
    principal, error = _principal_or_error()
    if error:
        return error
    contact = (request.args.get("contact") or "").strip()[:100]
    if not contact:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contact is required."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                result = build_suggestions(cur, principal["client_id"], contact)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("reco suggest failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "reco suggest")[0]), 503
    result["contact_id"] = contact
    return jsonify(result), 200


@bp.get("/reco/surface")
def reco_surface():
    """Suggestions for ONE conversation - what the agent sees in the thread."""
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        conversation_id = int(request.args.get("conversation_id") or "")
    except ValueError:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "conversation_id must be a"
                                             " number."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT contact_id, contact_name FROM " +
                    portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE id = %s AND client_id = %s",
                    (conversation_id, principal["client_id"]),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Conversation not"
                                                         " found."}}), 404
                contact = str(rows[0].get("contact_id") or "")
                contact_name = str(rows[0].get("contact_name") or "")
                result = build_suggestions(cur, principal["client_id"], contact)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("reco surface failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "reco surface")[0]), 503
    result["conversation_id"] = conversation_id
    result["contact_name"] = contact_name
    return jsonify(result), 200


@bp.get("/reco/report")
def reco_report():
    """Workspace-level view: bestsellers and coverage counts."""
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                catalog = _load_catalog(cur, client_id)
                links = _load_all_paid_links(cur, client_id)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("reco report failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "reco report")[0]), 503
    bestseller: Dict[str, Dict[str, Any]] = {}
    buyers: set = set()
    for link in links:
        if link["contact_id"]:
            buyers.add(link["contact_id"])
        for item in link["items"]:
            key = item["name"].lower().strip()
            entry = bestseller.setdefault(key, {
                "name": item["name"], "orders": 0, "price_text": ""})
            entry["orders"] += 1
            if not entry["price_text"]:
                entry["price_text"] = item["price"]
    for entry in bestseller.values():
        lookup = _catalog_lookup(catalog).get(entry["name"].lower().strip())
        if lookup and not entry["price_text"]:
            entry["price_text"] = lookup["price_text"]
    ranked = sorted(bestseller.values(),
                    key=lambda entry: (-entry["orders"], entry["name"].lower()))
    return jsonify({
        "bestsellers": ranked[:10],
        "paid_links": len(links),
        "buyers": len(buyers),
        "catalog_items": len(catalog),
    }), 200
