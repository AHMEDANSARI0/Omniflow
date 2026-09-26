"""Customer change requests: address changes and cancellations, self-serve.

The public checkout page gains a "Request a change" panel: the customer can
send an address correction or ask to cancel while the link is still open.
Requests land in a review queue - the owner approves or declines from the
growth page; an approved address update writes onto the link, an approved
cancel closes it, and the customer gets a WhatsApp confirmation either way
(queued through the connector command queue, so opted-out contacts are
never messaged).
"""

import datetime
import logging

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db
import portal_checkout
from typing import Any, Dict, List, Optional

bp = Blueprint("portal_changes", __name__, url_prefix="/api/v1/portal")
public_bp = Blueprint("portal_changes_public", __name__,
                      url_prefix="/api/v1/public")

logger = logging.getLogger(__name__)

REQUESTS_TABLE = "portal_change_requests"
TYPES = ("address", "cancel")
MESSAGE_MAX = 500
ADDRESS_MAX = 500
LIST_LIMIT = 50

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


def _ensure_changes_tables(conn) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS " + portal_db._q(REQUESTS_TABLE) +
            " (id BIGSERIAL PRIMARY KEY,"
            " client_id BIGINT NOT NULL,"
            " link_id BIGINT NOT NULL,"
            " token TEXT NOT NULL,"
            " kind TEXT NOT NULL,"
            " message TEXT NOT NULL DEFAULT '',"
            " address_text TEXT NOT NULL DEFAULT '',"
            " status TEXT NOT NULL DEFAULT 'pending',"
            " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
            " decided_at TIMESTAMPTZ)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS portal_change_requests_client_idx ON "
            + portal_db._q(REQUESTS_TABLE) + " (client_id, status, id DESC)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS portal_change_requests_token_idx ON "
            + portal_db._q(REQUESTS_TABLE) + " (token)"
        )
        cur.execute(
            "ALTER TABLE " + portal_db._q(portal_checkout.LINKS_TABLE) +
            " ADD COLUMN IF NOT EXISTS delivery_address TEXT NOT NULL"
            " DEFAULT ''"
        )
    conn.commit()
    _DDL_READY = True


def _iso(value: Any) -> Optional[str]:
    return value.isoformat() if hasattr(value, "isoformat") else None


def _public(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": int(row.get("id") or 0),
        "linkId": int(row.get("link_id") or 0),
        "token": str(row.get("token") or ""),
        "kind": str(row.get("kind") or ""),
        "message": str(row.get("message") or ""),
        "addressText": str(row.get("address_text") or ""),
        "status": str(row.get("status") or "pending"),
        "createdAt": _iso(row.get("created_at")),
        "decidedAt": _iso(row.get("decided_at")),
        "title": str(row.get("title") or ""),
    }


def _load_link_by_token(cur, token: str) -> Optional[Dict[str, Any]]:
    cur.execute(
        "SELECT id, client_id, contact_id, status, expires_at FROM "
        + portal_db._q(portal_checkout.LINKS_TABLE) +
        " WHERE token = %s LIMIT 1",
        (token,),
    )
    rows = portal_db.rows(cur)
    return rows[0] if rows else None


def _link_expired(link: Dict[str, Any]) -> bool:
    expires_at = link.get("expires_at")
    if expires_at is None:
        return False
    try:
        return expires_at < datetime.datetime.now(datetime.timezone.utc)
    except TypeError:
        return str(expires_at) < datetime.datetime.now(
            datetime.timezone.utc).isoformat()


@public_bp.post("/checkout/<token>/change-request")
def submit_change_request(token: str):
    token = str(token or "").strip()[:64]
    payload = request.get_json(silent=True) or {}
    kind = str(payload.get("kind") or "").strip().lower()
    message = str(payload.get("message") or "").strip()[:MESSAGE_MAX]
    address_text = str(payload.get("address_text") or "").strip()[:ADDRESS_MAX]
    if kind not in TYPES:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "kind must be address or"
                                             " cancel."}}), 400
    if not token:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "token is required."}}), 400
    if kind == "address" and not address_text:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "The new address is required."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_changes_tables(conn)
            with conn.cursor() as cur:
                try:
                    import portal_ratelimit

                    if not portal_ratelimit.allow(
                        cur,
                        "changereq:" + token,
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
                link = _load_link_by_token(cur, token)
                if link is None:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "This order link is"
                                                         " not valid."}}), 404
                if (link.get("status") or "open") != "open":
                    return jsonify({"error": {"code": "bad_request",
                                              "message": "This order is"
                                                         " already closed."}}), 400
                if _link_expired(link):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "This order link has"
                                                         " expired."}}), 404
                cur.execute(
                    "SELECT 1 FROM " + portal_db._q(REQUESTS_TABLE) +
                    " WHERE token = %s AND kind = %s AND status = 'pending'"
                    " LIMIT 1",
                    (token, kind),
                )
                if portal_db.rows(cur):
                    return jsonify({"error": {"code": "conflict",
                                              "message": "A similar request"
                                                         " is already waiting"
                                                         " for review."}}), 409
                cur.execute(
                    "INSERT INTO " + portal_db._q(REQUESTS_TABLE) +
                    " (client_id, link_id, token, kind, message, address_text)"
                    " VALUES (%s, %s, %s, %s, %s, %s)"
                    " RETURNING id, link_id, token, kind, message,"
                    " address_text, status, created_at, decided_at",
                    (link.get("client_id"), link.get("id"), token, kind,
                     message, address_text),
                )
                created = portal_db.rows(cur)
                portal_db.log_action(
                    cur,
                    link.get("client_id"),
                    "change.submitted",
                    "customer",
                    None,
                    None,
                    ("Customer asked to "
                     + ("change the address" if kind == "address"
                        else "cancel the order")
                     + " (" + token[:8] + ")")[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("change request submit failed: %s", error)
        return jsonify({"error": {"code": "portal_unavailable",
                                  "message": "Try again shortly."}}), 503
    return jsonify({"ok": True,
                    "request": _public(created[0] if created else {})}), 200


@bp.get("/changes/requests")
def list_change_requests():
    principal, error = _principal_or_error()
    if error:
        return error
    want = request.args.get("status") or "pending"
    if want not in ("all", "pending", "approved", "declined"):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "status must be all, pending,"
                                             " approved, or declined."}}), 400
    clause = ""
    params: List[Any] = [principal["client_id"]]
    if want != "all":
        clause = " AND r.status = %s"
        params.append(want)
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_changes_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT r.id, r.link_id, r.token, r.kind, r.message,"
                    " r.address_text, r.status, r.created_at, r.decided_at,"
                    " l.title FROM " + portal_db._q(REQUESTS_TABLE) + " r"
                    " LEFT JOIN " + portal_db._q(portal_checkout.LINKS_TABLE) +
                    " l ON l.id = r.link_id"
                    " WHERE r.client_id = %s" + clause +
                    " ORDER BY (r.status = 'pending') DESC, r.id DESC"
                    " LIMIT " + str(LIST_LIMIT),
                    params,
                )
                rows = portal_db.rows(cur)
                cur.execute(
                    "SELECT status, COUNT(*) AS n FROM "
                    + portal_db._q(REQUESTS_TABLE) +
                    " WHERE client_id = %s GROUP BY status",
                    (principal["client_id"],),
                )
                counts = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("change requests read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "change requests read")[0]), 503
    summary = {"pending": 0, "approved": 0, "declined": 0}
    for row in counts:
        key = str(row.get("status") or "")
        if key in summary:
            summary[key] = int(row.get("n") or 0)
    return jsonify({"requests": [_public(row) for row in rows],
                    "counts": summary}), 200


def _notify_customer(cur, client_id, contact_id, body: str) -> None:
    """Queue the decision note into the customer's chat (best effort)."""
    try:
        import portal_growth

        portal_growth._send_command(cur, client_id, str(contact_id or ""),
                                    "", body[:1000], "change_request")
    except Exception:
        pass


@bp.post("/changes/requests/<int:request_id>/decide")
def decide_change_request(request_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return forbidden
    payload = request.get_json(silent=True) or {}
    action = str(payload.get("action") or "").strip().lower()
    if action not in ("approve", "decline"):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "action must be approve or"
                                             " decline."}}), 400
    decided: list = []
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_changes_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, link_id, token, kind, message, address_text,"
                    " status, created_at, decided_at FROM "
                    + portal_db._q(REQUESTS_TABLE) +
                    " WHERE id = %s AND client_id = %s LIMIT 1",
                    (request_id, principal["client_id"]),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Request not"
                                                         " found."}}), 404
                row = rows[0]
                if (row.get("status") or "pending") != "pending":
                    return jsonify({"error": {"code": "conflict",
                                              "message": "This request was"
                                                         " already decided."}}), 409
                kind = str(row.get("kind") or "")
                cur.execute(
                    "SELECT id, contact_id, status FROM "
                    + portal_db._q(portal_checkout.LINKS_TABLE) +
                    " WHERE id = %s AND client_id = %s LIMIT 1",
                    (row.get("link_id"), principal["client_id"]),
                )
                links = portal_db.rows(cur)
                if not links:
                    return jsonify({"error": {"code": "not_found",
                                              "message": "The order link no"
                                                         " longer exists."}}), 404
                link = links[0]
                note = ""
                if action == "approve":
                    if kind == "address":
                        if not str(row.get("address_text") or "").strip():
                            return jsonify({"error": {"code": "bad_request",
                                                      "message": "The request"
                                                                 " has no"
                                                                 " address to"
                                                                 " apply."}}), 400
                        cur.execute(
                            "UPDATE " + portal_db._q(portal_checkout.LINKS_TABLE) +
                            " SET delivery_address = %s, updated_at = NOW()"
                            " WHERE id = %s AND client_id = %s RETURNING id",
                            (str(row.get("address_text")),
                             row.get("link_id"), principal["client_id"]),
                        )
                        if not portal_db.rows(cur):
                            return jsonify({"error": {"code": "not_found",
                                                      "message": "The order"
                                                                 " link no"
                                                                 " longer"
                                                                 " exists."}}), 404
                        note = "Address updated on order " + row["token"][:8]
                    else:
                        cur.execute(
                            "UPDATE " + portal_db._q(portal_checkout.LINKS_TABLE) +
                            " SET status = 'cancelled', updated_at = NOW()"
                            " WHERE id = %s AND client_id = %s"
                            " AND status = 'open' RETURNING id",
                            (row.get("link_id"), principal["client_id"]),
                        )
                        if not portal_db.rows(cur):
                            return jsonify({"error": {"code": "conflict",
                                                      "message": "The order is"
                                                                 " not open"
                                                                 " anymore."}}), 409
                        note = "Order cancelled " + row["token"][:8]
                new_status = "approved" if action == "approve" else "declined"
                cur.execute(
                    "UPDATE " + portal_db._q(REQUESTS_TABLE) +
                    " SET status = %s, decided_at = NOW()"
                    " WHERE id = %s AND client_id = %s"
                    " RETURNING id, link_id, token, kind, message,"
                    " address_text, status, created_at, decided_at",
                    (new_status, request_id, principal["client_id"]),
                )
                decided = portal_db.rows(cur)
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "change.approved" if action == "approve"
                    else "change.declined",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    (note or ("Change request declined ("
                              + kind + ")"))[:200],
                )
                _notify_customer(
                    cur,
                    principal["client_id"],
                    link.get("contact_id"),
                    ("Your request was approved by the business."
                     if action == "approve"
                     else "Your request could not be approved this time - "
                          "please continue on WhatsApp."),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        logger.warning("change decide failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "change decide")[0]), 503
    if not decided:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Request not found."}}), 404
    return jsonify({"ok": True, "request": _public(decided[0])}), 200
