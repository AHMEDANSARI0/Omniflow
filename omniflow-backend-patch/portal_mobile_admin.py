"""§275 OmniFlow Control Plane — Mobile ADMIN authorization + endpoints.

NEON-ONLY. The mobile Admin app authenticates with platform-owner
credentials stored in NEON — the same Postgres the Control Plane already
uses via DB_HOST. There is NO Supabase, no second database, and no external
auth provider anywhere in this module.

Owner/admin accounts live in ``mobile_admins`` (email + werkzeug password
hash). Login issues opaque access/refresh tokens whose SHA-256 hashes are
stored in ``mobile_admin_sessions``. Both tables are created lazily
(CREATE TABLE IF NOT EXISTS) on first use, so nothing has to be run by hand
— exactly like the other portal modules.

Routes (url_prefix=/api/v1/mobile):
  POST /admin/bootstrap  create/reset an admin login — guarded by the
                         X-Omniflow-Key service key (owner setup step; the
                         mobile app NEVER calls this)
  POST /admin/login      email+password -> access/refresh tokens
  POST /admin/refresh    refresh_token   -> rotated tokens
  POST /admin/logout     revoke the current session
  GET  /admin/me         current admin profile
  GET  /admin/overview   small platform health summary (platform_users, Neon)
  GET  /admin/users      client account list (read-only, Neon)
  GET  /admin/users/<id> single client account (read-only, Neon)
  GET  /config           public mobile config (flags/version), no auth

Env: DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD/PGSSLMODE (Neon, already
configured) + OMNIFLOW_SERVICE_KEY (already present; bootstrap only).
No Supabase env is read here. Fail-soft throughout.
"""

import hashlib
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify, request
from werkzeug.security import check_password_hash, generate_password_hash

import portal_auth

logger = logging.getLogger("omniflow.mobile-admin")

bp = Blueprint("mobile_admin", __name__, url_prefix="/api/v1/mobile")

ADMINS_TABLE = os.environ.get("OF_MOBILE_ADMINS_TABLE", "mobile_admins")
SESSIONS_TABLE = os.environ.get("OF_MOBILE_SESSIONS_TABLE", "mobile_admin_sessions")
USERS_TABLE = os.environ.get("OF_USERS_TABLE", "platform_users")
USER_ID_COL = "id"
USER_EMAIL_COL = "email"

ACCESS_TTL = int(os.environ.get("OF_MOBILE_ACCESS_TTL", str(12 * 3600)))
REFRESH_TTL = int(os.environ.get("OF_MOBILE_REFRESH_TTL", str(30 * 24 * 3600)))

_DDL_READY = False


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


def _ensure_ddl() -> bool:
    """Create the two auth tables on first use. Race-tolerant (§266)."""
    global _DDL_READY
    if _DDL_READY:
        return True
    try:
        conn = _conn()
    except Exception as exc:
        logger.warning("mobile admin ddl: connect failed: %s", exc)
        return False
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(
                "CREATE TABLE IF NOT EXISTS " + _q(ADMINS_TABLE) + " ("
                " id SERIAL PRIMARY KEY,"
                " email TEXT NOT NULL UNIQUE,"
                " password_hash TEXT NOT NULL,"
                " display_name TEXT,"
                " active BOOLEAN NOT NULL DEFAULT TRUE,"
                " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
            )
            cur.execute(
                "CREATE TABLE IF NOT EXISTS " + _q(SESSIONS_TABLE) + " ("
                " id SERIAL PRIMARY KEY,"
                " admin_id INTEGER NOT NULL REFERENCES " + _q(ADMINS_TABLE) + "(id) ON DELETE CASCADE,"
                " access_hash TEXT NOT NULL UNIQUE,"
                " refresh_hash TEXT NOT NULL UNIQUE,"
                " created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
                " expires_at TIMESTAMPTZ NOT NULL,"
                " refresh_expires_at TIMESTAMPTZ NOT NULL,"
                " last_seen_at TIMESTAMPTZ,"
                " revoked_at TIMESTAMPTZ)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS " + _q(SESSIONS_TABLE + "_refresh_idx")
                + " ON " + _q(SESSIONS_TABLE) + " (refresh_hash)"
            )
        _DDL_READY = True
        return True
    except Exception as exc:
        # A concurrent cold start may have won the DDL race; that is fine.
        msg = str(exc).lower()
        if "already exists" in msg or "42p07" in msg or "duplicate" in msg:
            _DDL_READY = True
            return True
        logger.warning("mobile admin ddl failed: %s", exc)
        return False
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _public_admin(admin_id, email, display_name) -> dict:
    return {
        "id": admin_id,
        "email": email,
        "name": display_name,
        "role": "admin",
    }


def _issue_session(admin_id: int):
    """Insert a fresh session row; return (access, refresh, expires_in)."""
    access = secrets.token_urlsafe(32)
    refresh = secrets.token_urlsafe(48)
    now = _now()
    conn = _conn()
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO " + _q(SESSIONS_TABLE)
                + " (admin_id, access_hash, refresh_hash, expires_at, refresh_expires_at)"
                " VALUES (%s, %s, %s, %s, %s)",
                (
                    admin_id,
                    _hash_token(access),
                    _hash_token(refresh),
                    now + timedelta(seconds=ACCESS_TTL),
                    now + timedelta(seconds=REFRESH_TTL),
                ),
            )
    finally:
        conn.close()
    return access, refresh, ACCESS_TTL


# ------------------------------------------------------------------ bootstrap
@bp.post("/admin/bootstrap")
def admin_bootstrap():
    """Create or reset an admin login. Service-key guarded (owner setup)."""
    if not portal_auth.service_key_ok():
        return jsonify({"error": "Service key required."}), 403
    payload = request.get_json(silent=True) or {}
    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")
    display_name = payload.get("name") or None
    if not email or len(password) < 8:
        return jsonify({"error": "Email and a password of 8+ characters are required."}), 400
    if not _ensure_ddl():
        return jsonify({"error": "Database unavailable."}), 503
    try:
        conn = _conn()
        try:
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + _q(ADMINS_TABLE)
                    + " (email, password_hash, display_name, active)"
                    " VALUES (%s, %s, %s, TRUE)"
                    " ON CONFLICT (email) DO UPDATE SET"
                    " password_hash = EXCLUDED.password_hash,"
                    " display_name = COALESCE(EXCLUDED.display_name, " + _q(ADMINS_TABLE) + ".display_name),"
                    " active = TRUE",
                    (email, generate_password_hash(password), display_name),
                )
        finally:
            conn.close()
    except Exception as exc:
        logger.warning("mobile admin bootstrap failed: %s", exc)
        return jsonify({"error": "Could not create the admin account."}), 503
    logger.info("mobile admin bootstrapped: %s", email)
    return jsonify({"ok": True, "email": email})


# ---------------------------------------------------------------------- login
@bp.post("/admin/login")
def admin_login():
    payload = request.get_json(silent=True) or {}
    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")
    if not email or not password:
        return jsonify({"error": "Email and password are required."}), 400
    if not _ensure_ddl():
        return jsonify({"error": "Database unavailable."}), 503
    row = None
    try:
        conn = _conn()
        try:
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, email, password_hash, display_name, active FROM "
                    + _q(ADMINS_TABLE) + " WHERE email = %s LIMIT 1",
                    (email,),
                )
                row = cur.fetchone()
        finally:
            conn.close()
    except Exception as exc:
        logger.warning("mobile admin login lookup failed: %s", exc)
        return jsonify({"error": "Sign-in unavailable right now."}), 503
    if not row or not row[4] or not check_password_hash(row[2], password):
        return jsonify({"error": "Invalid email or password."}), 401
    try:
        access, refresh, expires_in = _issue_session(row[0])
    except Exception as exc:
        logger.warning("mobile admin session issue failed: %s", exc)
        return jsonify({"error": "Sign-in unavailable right now."}), 503
    return jsonify(
        {
            "access_token": access,
            "refresh_token": refresh,
            "expires_in": expires_in,
            "user": _public_admin(row[0], row[1], row[3]),
        }
    )


# -------------------------------------------------------------------- refresh
@bp.post("/admin/refresh")
def admin_refresh():
    payload = request.get_json(silent=True) or {}
    refresh_token = str(payload.get("refresh_token") or "").strip()
    if not refresh_token:
        return jsonify({"error": "refresh_token is required."}), 400
    if not _ensure_ddl():
        return jsonify({"error": "Database unavailable."}), 503
    now = _now()
    new_access = secrets.token_urlsafe(32)
    new_refresh = secrets.token_urlsafe(48)
    updated = None
    try:
        conn = _conn()
        try:
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + _q(SESSIONS_TABLE) + " SET"
                    " access_hash = %s, refresh_hash = %s,"
                    " expires_at = %s, refresh_expires_at = %s, last_seen_at = %s"
                    " WHERE refresh_hash = %s AND revoked_at IS NULL AND refresh_expires_at > %s"
                    " RETURNING admin_id",
                    (
                        _hash_token(new_access),
                        _hash_token(new_refresh),
                        now + timedelta(seconds=ACCESS_TTL),
                        now + timedelta(seconds=REFRESH_TTL),
                        now,
                        _hash_token(refresh_token),
                        now,
                    ),
                )
                updated = cur.fetchone()
        finally:
            conn.close()
    except Exception as exc:
        logger.warning("mobile admin refresh failed: %s", exc)
        return jsonify({"error": "Session refresh unavailable right now."}), 503
    if not updated:
        return jsonify({"error": "Session expired. Sign in again."}), 401
    return jsonify(
        {
            "access_token": new_access,
            "refresh_token": new_refresh,
            "expires_in": ACCESS_TTL,
        }
    )


# --------------------------------------------------------------------- logout
@bp.post("/admin/logout")
def admin_logout():
    token = _bearer_token()
    if token and _ensure_ddl():
        try:
            conn = _conn()
            try:
                conn.autocommit = True
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE " + _q(SESSIONS_TABLE)
                        + " SET revoked_at = %s WHERE access_hash = %s AND revoked_at IS NULL",
                        (_now(), _hash_token(token)),
                    )
            finally:
                conn.close()
        except Exception as exc:
            logger.warning("mobile admin logout failed: %s", exc)
    return jsonify({"ok": True})


# ----------------------------------------------------------------------- me
@bp.get("/admin/me")
def admin_me():
    result = _guard()
    if not isinstance(result, dict):
        return result
    return jsonify({"user": result})


# ------------------------------------------------------------------ overview
@bp.get("/admin/overview")
def admin_overview():
    result = _guard()
    if not isinstance(result, dict):
        return result
    total_users = None
    try:
        conn = _conn()
        try:
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM " + _q(USERS_TABLE))
                total_users = int(cur.fetchone()[0])
        finally:
            conn.close()
    except Exception as exc:
        logger.warning("mobile admin overview count failed: %s", exc)
    return jsonify(
        {
            "platform_users": total_users,
            "database": total_users is not None,
            "mobile_admin": True,
        }
    )


# -------------------------------------------------------------------- users
@bp.get("/admin/users")
def admin_users_list():
    result = _guard()
    if not isinstance(result, dict):
        return result
    try:
        conn = _conn()
        try:
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT " + _q(USER_ID_COL) + ", " + _q(USER_EMAIL_COL)
                    + " FROM " + _q(USERS_TABLE)
                    + " ORDER BY " + _q(USER_ID_COL) + " LIMIT 500"
                )
                rows = cur.fetchall()
        finally:
            conn.close()
        return jsonify(
            {"users": [{"id": r[0], "email": r[1]} for r in rows], "count": len(rows)}
        )
    except Exception as exc:
        logger.warning("mobile admin users list failed: %s", exc)
        return jsonify({"error": "User list unavailable right now."}), 503


@bp.get("/admin/users/<user_id>")
def admin_user_detail(user_id: str):
    result = _guard()
    if not isinstance(result, dict):
        return result
    try:
        uid = int(user_id)
    except ValueError:
        return jsonify({"error": "Invalid user id."}), 400
    try:
        conn = _conn()
        try:
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT " + _q(USER_ID_COL) + ", " + _q(USER_EMAIL_COL)
                    + " FROM " + _q(USERS_TABLE)
                    + " WHERE " + _q(USER_ID_COL) + " = %s",
                    (uid,),
                )
                row = cur.fetchone()
        finally:
            conn.close()
        if not row:
            return jsonify({"error": "User not found."}), 404
        return jsonify({"user": {"id": row[0], "email": row[1]}})
    except Exception as exc:
        logger.warning("mobile admin user detail failed: %s", exc)
        return jsonify({"error": "User detail unavailable right now."}), 503


# ------------------------------------------------------------------- config
@bp.get("/config")
def mobile_config():
    """Public config for both mobile apps: flags, versions, maintenance."""
    flags = {}
    for pair in os.environ.get("OF_MOBILE_FLAGS", "").split(","):
        if "=" in pair:
            key, _, val = pair.partition("=")
            key = key.strip()
            if key:
                flags[key] = val.strip().lower() in ("1", "true", "yes", "on")
    return jsonify(
        {
            "min_version": os.environ.get("OF_MOBILE_MIN_VERSION") or None,
            "recommended_version": os.environ.get("OF_MOBILE_RECOMMENDED_VERSION") or None,
            "maintenance": os.environ.get("OF_MOBILE_MAINTENANCE", "").lower()
            in ("1", "true", "yes", "on"),
            "announcement": os.environ.get("OF_MOBILE_ANNOUNCEMENT") or None,
            "flags": flags,
        }
    )


# ------------------------------------------------------------------- guard
def _bearer_token() -> str:
    header = request.headers.get("Authorization", "")
    if header.startswith("Bearer "):
        return header[7:].strip()
    return ""


def _principal(access_token: str):
    """Resolve an access token to an admin profile, or None."""
    if not access_token:
        return None
    if not (_DDL_READY or _ensure_ddl()):
        return None
    now = _now()
    try:
        conn = _conn()
        try:
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT a.id, a.email, a.display_name, a.active, s.expires_at"
                    " FROM " + _q(SESSIONS_TABLE) + " s"
                    " JOIN " + _q(ADMINS_TABLE) + " a ON a.id = s.admin_id"
                    " WHERE s.access_hash = %s AND s.revoked_at IS NULL"
                    " AND s.expires_at > %s LIMIT 1",
                    (_hash_token(access_token), now),
                )
                row = cur.fetchone()
                if not row or not row[3]:
                    return None
                cur.execute(
                    "UPDATE " + _q(SESSIONS_TABLE) + " SET last_seen_at = %s WHERE access_hash = %s",
                    (now, _hash_token(access_token)),
                )
        finally:
            conn.close()
    except Exception as exc:
        logger.warning("mobile admin token verification failed: %s", exc)
        return None
    return _public_admin(row[0], row[1], row[2])


def _guard():
    """Returns the admin profile dict or a (response, status) tuple."""
    token = _bearer_token()
    if not token:
        return jsonify({"error": "Admin authorization required."}), 401
    principal = _principal(token)
    if not principal:
        return jsonify({"error": "Admin authorization required."}), 401
    return principal
