"""
OmniFlow Control Plane — ADMIN user management endpoints (admin resets a client's
password). Registers as a Flask blueprint. Auth: X-Omniflow-Key header must match
OMNIFLOW_SERVICE_KEY or OMNIFLOW_ADMIN_API_KEY (server-to-server only).

Endpoints:
  GET  /api/v1/admin/users                        -> list platform users + lock state
  GET  /api/v1/admin/reset-codes                  -> recent password reset codes (TEST PHASE)
  POST /api/v1/admin/users/<int:user_id>/password-reset  -> temp password (returned ONCE)
"""

import logging
import os
import secrets
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request
from werkzeug.security import generate_password_hash


logger = logging.getLogger("omniflow.admin-users")

bp = Blueprint("admin_users", __name__, url_prefix="/api/v1/admin")

# --- Schema (verified Neon tables) ---
USERS_TABLE = os.environ.get("OF_USERS_TABLE", "platform_users")
USER_ID_COL = "id"
USER_EMAIL_COL = "email"
CREDS_TABLE = os.environ.get("OF_CREDS_TABLE", "user_password_credentials")
CREDS_USER_COL = "user_id"
CREDS_PASSWORD_COL = "password_hash"


def _q(ident: str) -> str:
    return '"' + ident.replace('"', '""') + '"'


def _conn():
    import psycopg2

    return psycopg2.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ.get("DB_PORT", "5432")),
        dbname=os.environ["DB_NAME"],
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
        sslmode=os.environ.get("PGSSLMODE", "require"),
        connect_timeout=15,
    )


def _authorized() -> bool:
    key = request.headers.get("X-Omniflow-Key", "")
    if not key:
        return False
    accepted = [
        os.environ.get("OMNIFLOW_SERVICE_KEY"),
        os.environ.get("OMNIFLOW_ADMIN_API_KEY"),
    ]
    return any(k for k in accepted if k and secrets.compare_digest(key, k))


@bp.before_request
def _guard():
    if request.method == "OPTIONS":
        return None
    if not _authorized():
        return jsonify({"error": {"code": "forbidden",
                                  "message": "Service key missing or invalid."}}), 403


@bp.get("/reset-codes")
def recent_reset_codes():
    """TEST-PHASE: expose undelivered reset codes to the admin panel.

    Populated only when SMTP is not configured. In-memory per instance —
    cleared on cold start. Never log these beyond the existing warning line.
    """
    from auth_password_reset import recent_reset_codes as _codes

    return jsonify({"codes": _codes()}), 200


@bp.get("/users")
def list_users():
    conn = None
    try:
        conn = _conn()
        cur = conn.cursor()
        cur.execute(
            f"SELECT pu.{_q(USER_ID_COL)}, pu.{_q(USER_EMAIL_COL)}, pu.display_name, "
            f"pu.status, pu.last_login_at, "
            f"COALESCE(upc.failed_attempt_count, 0), upc.locked_until "
            f"FROM {_q(USERS_TABLE)} pu "
            f"LEFT JOIN {_q(CREDS_TABLE)} upc ON upc.{_q(CREDS_USER_COL)} = pu.{_q(USER_ID_COL)} "
            f"ORDER BY pu.{_q(USER_ID_COL)}"
        )
        now = datetime.now(timezone.utc)
        users = []
        for row in cur.fetchall():
            uid, email, display_name, status, last_login_at, failed, locked_until = row
            locked = False
            if locked_until is not None:
                lu = locked_until
                if lu.tzinfo is None:
                    lu = lu.replace(tzinfo=timezone.utc)
                locked = lu > now
            users.append({
                "id": uid,
                "email": email,
                "display_name": display_name,
                "status": status,
                "last_login_at": last_login_at.isoformat() if last_login_at else None,
                "failed_attempt_count": int(failed or 0),
                "locked": locked,
            })
        return jsonify({"users": users}), 200
    except Exception:
        logger.exception("admin list users failed")
        if conn is not None:
            try:
                conn.rollback()
            except Exception:
                pass
        return jsonify({"error": {"code": "admin_unavailable",
                                  "message": "Could not load users."}}), 503
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


@bp.post("/users/<int:user_id>/password-reset")
def reset_user_password(user_id: int):
    conn = None
    try:
        conn = _conn()
        cur = conn.cursor()

        cur.execute(
            f"SELECT {_q(USER_EMAIL_COL)}, display_name FROM {_q(USERS_TABLE)} "
            f"WHERE {_q(USER_ID_COL)} = %s",
            (user_id,),
        )
        user = cur.fetchone()
        if not user:
            return jsonify({"error": {"code": "user_not_found",
                                      "message": "No such client."}}), 404

        email = user[0]

        temp_password = secrets.token_urlsafe(12)  # 16 chars, safe charset
        new_hash = generate_password_hash(temp_password)

        cur.execute(
            f"SELECT 1 FROM {_q(CREDS_TABLE)} WHERE {_q(CREDS_USER_COL)} = %s",
            (user_id,),
        )
        if cur.fetchone():
            cur.execute(
                f"UPDATE {_q(CREDS_TABLE)} SET {_q(CREDS_PASSWORD_COL)} = %s, "
                f"password_changed_at = now(), failed_attempt_count = 0, "
                f"locked_until = NULL, updated_at = now() "
                f"WHERE {_q(CREDS_USER_COL)} = %s",
                (new_hash, user_id),
            )
        else:
            cur.execute(
                f"INSERT INTO {_q(CREDS_TABLE)} "
                f"({_q(CREDS_USER_COL)}, {_q(CREDS_PASSWORD_COL)}, password_changed_at) "
                f"VALUES (%s, %s, now())",
                (user_id, new_hash),
            )

        conn.commit()
        logger.info("admin password reset applied user_id=%s", user_id)

        # Temp password returned exactly once; never logged.
        return jsonify({
            "ok": True,
            "user_id": user_id,
            "email": email,
            "temp_password": temp_password,
        }), 200
    except Exception:
        logger.exception("admin password reset failed")
        if conn is not None:
            try:
                conn.rollback()
            except Exception:
                pass
        return jsonify({"error": {"code": "admin_unavailable",
                                  "message": "Reset failed. Try again."}}), 503
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
