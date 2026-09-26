"""
OmniFlow Control Plane — portal API keys (customer-generated `ofk_` keys).

GET  /api/v1/portal/api-key          -> {configured, key_prefix, key_last4,
                                         revoked, created_at, last_used_at}
POST /api/v1/portal/api-key/rotate   -> {ok, key}   (plaintext shown ONCE)
POST /api/v1/portal/api-key/revoke   -> {ok}

Storage: SHA-256 hash of the full token (portal_api_keys, migration 008 /
lazy DDL). The plaintext never touches the database and is returned exactly
once at rotate time. Rotate implicitly revokes the previous active key —
ek tenant ki aik hi active key hoti hai.

All three endpoints are HUMAN-only (session Bearer). Portal API keys are
read-only by design — ensure_human_principal() rejects them with 403.
"""

import hashlib
import logging
import secrets
from datetime import datetime, timezone
from typing import Any, Optional

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db


logger = logging.getLogger("omniflow.portal-apikeys")

bp = Blueprint("portal_apikeys", __name__, url_prefix="/api/v1/portal")

TOKEN_PREFIX = "ofk_"


def _iso(value: Any) -> Optional[str]:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return None


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _auth():
    """Common auth: returns (principal, error_response)."""
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": str(error)}}), 503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}), 401)
    return principal, None


@bp.get("/api-key")
def get_api_key():
    principal, error = _auth()
    if error:
        return error

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT key_prefix, key_last4, revoked_at, created_at,"
                    " last_used_at FROM "
                    + portal_db._q(portal_db.APIKEY_TABLE) +
                    " WHERE client_id = %s ORDER BY id DESC LIMIT 1",
                    (principal["client_id"],),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "api-key read")[0]), 503

    if not found:
        return jsonify({
            "configured": False,
            "key_prefix": None,
            "key_last4": None,
            "revoked": False,
            "created_at": None,
            "last_used_at": None,
        }), 200

    row = found[0]
    return jsonify({
        "configured": True,
        "key_prefix": row.get("key_prefix"),
        "key_last4": row.get("key_last4"),
        "revoked": row.get("revoked_at") is not None,
        "created_at": _iso(row.get("created_at")),
        "last_used_at": _iso(row.get("last_used_at")),
    }), 200


@bp.post("/api-key/rotate")
def rotate_api_key():
    principal, error = _auth()
    if error:
        return error

    forbidden = ensure_human_principal(principal)
    if forbidden:
        return forbidden

    token = TOKEN_PREFIX + secrets.token_urlsafe(24)
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(portal_db.APIKEY_TABLE) +
                    " SET revoked_at = NOW()"
                    " WHERE client_id = %s AND revoked_at IS NULL",
                    (principal["client_id"],),
                )
                cur.execute(
                    "INSERT INTO " + portal_db._q(portal_db.APIKEY_TABLE) +
                    " (client_id, token_hash, key_prefix, key_last4,"
                    " created_by, created_at) "
                    "VALUES (%s, %s, %s, %s, %s, NOW()) RETURNING created_at",
                    (principal["client_id"], _hash_token(token),
                     token[:12], token[-4:], principal["user_id"]),
                )
                created = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "api-key rotate")[0]), 503

    logger.info("portal api-key rotated client_id=%s by user_id=%s",
                principal["client_id"], principal["user_id"])
    return jsonify({
        "ok": True,
        "key": token,  # plaintext — shown exactly once, never stored
        "created_at": _iso(created[0].get("created_at")) if created else None,
    }), 200


@bp.post("/api-key/revoke")
def revoke_api_key():
    principal, error = _auth()
    if error:
        return error

    forbidden = ensure_human_principal(principal)
    if forbidden:
        return forbidden

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q(portal_db.APIKEY_TABLE) +
                    " SET revoked_at = NOW()"
                    " WHERE client_id = %s AND revoked_at IS NULL",
                    (principal["client_id"],),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "api-key revoke")[0]), 503

    logger.info("portal api-key revoked client_id=%s by user_id=%s",
                principal["client_id"], principal["user_id"])
    return jsonify({"ok": True}), 200
