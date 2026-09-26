"""
OmniFlow Control Plane — customer business profile endpoints (portal).

GET /api/v1/portal/profile   -> {profile: {...}, updated_at: iso|null}
PUT /api/v1/portal/profile   {profile: {...}} -> {ok: true, updated_at}

The profile is a free-form JSONB document (the website owns the field
schema and merges defaults client-side). Validation here: must be a JSON
object and must stay <= 32 KB serialized. PUT is human-only — portal API
keys (ofk_) are read-only (ensure_human_principal).
"""

import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db


logger = logging.getLogger("omniflow.portal-profile")

bp = Blueprint("portal_profile", __name__, url_prefix="/api/v1/portal")

MAX_PROFILE_BYTES = 32 * 1024


def _iso(value: Any) -> Optional[str]:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return None


@bp.get("/profile")
def get_profile():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return jsonify({"error": {"code": "portal_unavailable",
                                  "message": str(error)}}), 503
    if principal is None:
        return jsonify({"error": {"code": "unauthorized",
                                  "message": "Sign in required."}}), 401

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT profile, updated_at FROM "
                    + portal_db._q(portal_db.PROFILE_TABLE) +
                    " WHERE client_id = %s",
                    (principal["client_id"],),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "profile read")[0]), 503

    if not found:
        return jsonify({"profile": {}, "updated_at": None}), 200

    row = found[0]
    profile = row.get("profile")
    if not isinstance(profile, dict):
        profile = {}
    return jsonify({"profile": profile,
                    "updated_at": _iso(row.get("updated_at"))}), 200


@bp.put("/profile")
def put_profile():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return jsonify({"error": {"code": "portal_unavailable",
                                  "message": str(error)}}), 503
    if principal is None:
        return jsonify({"error": {"code": "unauthorized",
                                  "message": "Sign in required."}}), 401

    forbidden = ensure_human_principal(principal)
    if forbidden:
        return forbidden

    payload = request.get_json(silent=True) or {}
    if "profile" not in payload or not isinstance(payload.get("profile"), dict):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "profile object zaroori hai."}}), 400

    profile = payload["profile"]
    try:
        serialized = jsonify(profile).get_data(as_text=True)
    except Exception:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Profile JSON serializable nahi hai."}}), 400
    if len(serialized.encode("utf-8")) > MAX_PROFILE_BYTES:
        return jsonify({"error": {"code": "too_large",
                                  "message": "Profile 32KB se bara nahi ho sakta."}}), 400

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(portal_db.PROFILE_TABLE) +
                    " (client_id, profile, updated_by, updated_at) "
                    "VALUES (%s, CAST(%s AS JSONB), %s, NOW()) "
                    "ON CONFLICT (client_id) DO UPDATE SET "
                    " profile = EXCLUDED.profile, "
                    " updated_by = EXCLUDED.updated_by, "
                    " updated_at = NOW() "
                    "RETURNING updated_at",
                    (principal["client_id"],
                     json.dumps(profile),
                     principal["user_id"]),
                )
                updated = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "profile write")[0]), 503

    logger.info("profile saved client_id=%s by user_id=%s",
                principal["client_id"], principal["user_id"])
    return jsonify({"ok": True,
                    "updated_at": _iso(updated[0].get("updated_at")) if updated else None}), 200
