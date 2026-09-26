"""Setup progress: which onboarding milestones this client has reached."""

import logging

from flask import Blueprint, jsonify

from portal_auth import PortalAuthUnavailable, authenticate_portal_request
import portal_db

bp = Blueprint("portal_setup", __name__, url_prefix="/api/v1/portal")

logger = logging.getLogger(__name__)


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


def _table_exists(cur, name: str) -> bool:
    cur.execute("SELECT to_regclass(%s) AS oid", (name,))
    found = portal_db.rows(cur)
    return bool(found and found[0].get("oid"))


@bp.get("/setup/status")
def setup_status():
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = principal["client_id"]
    checks: dict = {}
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT state FROM " + portal_db._q(portal_db.STATUS_TABLE) +
                    " WHERE client_id = %s",
                    (client_id,),
                )
                found = portal_db.rows(cur)
                checks["whatsapp"] = bool(found) and found[0].get("state") == "connected"

                cur.execute(
                    "SELECT settings->'business_hours' AS bh FROM client_settings"
                    " WHERE client_id = %s",
                    (client_id,),
                )
                found = portal_db.rows(cur)
                bh = found[0].get("bh") if found else None
                checks["hours"] = bh is not None
                checks["away"] = isinstance(bh, dict) and bh.get("enabled") is True

                checks["kb"] = False
                if _table_exists(cur, "portal_kb_entries"):
                    cur.execute(
                        "SELECT COUNT(*) AS total FROM " + portal_db._q("portal_kb_entries") +
                        " WHERE client_id = %s",
                        (client_id,),
                    )
                    found = portal_db.rows(cur)
                    checks["kb"] = bool(found) and int(found[0].get("total") or 0) > 0

                cur.execute(
                    "SELECT COUNT(*) AS total FROM " + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE client_id = %s",
                    (client_id,),
                )
                found = portal_db.rows(cur)
                checks["customers"] = bool(found) and int(found[0].get("total") or 0) > 0

                checks["broadcast"] = False
                if _table_exists(cur, "portal_broadcasts"):
                    cur.execute(
                        "SELECT 1 FROM " + portal_db._q("portal_broadcasts") +
                        " WHERE client_id = %s LIMIT 1",
                        (client_id,),
                    )
                    checks["broadcast"] = bool(portal_db.rows(cur))

                checks["cod"] = False
                if _table_exists(cur, "portal_cod_settings"):
                    cur.execute(
                        "SELECT 1 FROM " + portal_db._q("portal_cod_settings") +
                        " WHERE client_id = %s AND enabled IS TRUE LIMIT 1",
                        (client_id,),
                    )
                    checks["cod"] = bool(portal_db.rows(cur))
        finally:
            conn.close()
    except Exception as error:
        logger.warning("setup status read failed: %s", error)
        return jsonify(portal_db.portal_unavailable(error, "setup status read")[0]), 503
    return jsonify({"setup": {"checks": checks}}), 200
