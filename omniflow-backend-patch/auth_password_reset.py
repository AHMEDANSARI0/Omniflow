"""
OmniFlow Control Plane — customer password reset (self-service).

Endpoints (extension app — dispatched by app.py):
  POST /api/v1/auth/forgot-password  {email} -> {"ok": true, "delivered": bool}
  POST /api/v1/auth/reset-password   {code, password} -> {"ok": true}

Design:
  - 6-digit code, SHA-256 stored (password_reset_tokens, migration 007).
    The plain code is NEVER persisted.
  - TTL 10 minutes, single use (used_at), attempts cap 3.
  - No user enumeration: forgot-password always answers ok:true.
  - SMTP configured -> code is mailed (delivered:true). Otherwise the code is
    logged (Vercel runtime logs) AND surfaced to the admin dashboard via
    recent_reset_codes() (consumed by admin_users.reset-codes endpoint).
"""

import logging
import os
import secrets
import smtplib
import threading
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

from flask import Blueprint, jsonify, request
from werkzeug.security import generate_password_hash


logger = logging.getLogger("omniflow.auth-password-reset")

bp = Blueprint("auth_password_reset", __name__, url_prefix="/api/v1/auth")

CODE_TTL_MINUTES = 10
CODE_MAX_ATTEMPTS = 3
CODE_LENGTH = 6

USERS_TABLE = os.environ.get("OF_USERS_TABLE", "platform_users")
USER_EMAIL_COL = os.environ.get("OF_USER_EMAIL_COL", "email")
TOKENS_TABLE = os.environ.get("OF_TOKENS_TABLE", "password_reset_tokens")
CREDS_TABLE = os.environ.get("OF_CREDS_TABLE", "user_password_credentials")

# TEST-PHASE: per-instance mirror of undelivered codes for the admin dashboard.
_RECENT_LOCK = threading.Lock()
_RECENT_CODES = []
_RECENT_CAP = 50


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


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _generate_code() -> str:
    return "".join(secrets.choice("0123456789") for _ in range(CODE_LENGTH))


def _code_hash(code: str) -> str:
    import hashlib

    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def _smtp_configured() -> bool:
    """Admin-panel email config first, env fallback (DB-backed config)."""
    try:
        import platform_settings
        config = platform_settings.smtp_config()
        if config["provider"] == "brevo":
            return bool(config["brevo_api_key"])
        return bool(config["smtp_host"])
    except Exception:
        return bool(os.environ.get("SMTP_HOST", "").strip())


def _send_email(to_address: str, code: str) -> bool:
    """Best-effort code delivery. False = code stays in logs/admin panel.

    Brevo API when the panel says provider=brevo, SMTP otherwise;
    both fall back to the environment variables when the panel has
    nothing saved.
    """
    try:
        import platform_settings
        config = platform_settings.smtp_config()
    except Exception:
        config = None
    host = (config or {}).get("smtp_host") or os.environ.get("SMTP_HOST", "").strip()
    if (config or {}).get("provider") == "brevo" \
            and (config or {}).get("brevo_api_key"):
        try:
            import json as _json
            import urllib.request
            sender = (config or {}).get("smtp_from") \
                or os.environ.get("SMTP_FROM",
                                  "OmniFlow <no-reply@omniflow.app>")
            name = sender[:sender.index("<")].strip() \
                if "<" in sender else "OmniFlow"
            email_addr = sender[sender.index("<") + 1:sender.rindex(">")] \
                if "<" in sender else (sender or "no-reply@omniflow.app")
            sender_payload = {"email": email_addr}
            if name:
                sender_payload["name"] = name
            payload = _json.dumps({
                "sender": sender_payload,
                "to": [{"email": to_address}],
                "subject": "OmniFlow password reset code",
                "textContent":
                    "Your OmniFlow password reset code is: " + code + "\n\n"
                    "Ye code " + str(CODE_TTL_MINUTES)
                    + " minutes ke liye valid hai.\n"
                    "Agar aapne ye request nahi ki, is email ko ignore karein.",
            }).encode("utf8")
            req = urllib.request.Request(
                "https://api.brevo.com/v3/smtp/email",
                data=payload,
                headers={"api-key": config["brevo_api_key"],
                         "content-type": "application/json",
                         "accept": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                return 200 <= resp.status < 300
        except Exception:
            logger.exception("reset code email delivery failed")
            return False
    if not host:
        return False
    try:
        msg = EmailMessage()
        msg["Subject"] = "OmniFlow password reset code"
        msg["From"] = (config or {}).get("smtp_from") \
            or os.environ.get("SMTP_FROM", "OmniFlow <no-reply@omniflow.app>")
        msg["To"] = to_address
        msg.set_content(
            "Your OmniFlow password reset code is: " + code + "\n\n"
            "Ye code " + str(CODE_TTL_MINUTES) + " minutes ke liye valid hai.\n"
            "Agar aapne ye request nahi ki, is email ko ignore karein."
        )
        port = int((config or {}).get("smtp_port")
                   or os.environ.get("SMTP_PORT", "587"))
        with smtplib.SMTP(host, port, timeout=15) as server:
            server.starttls()
            user = (config or {}).get("smtp_user") \
                or os.environ.get("SMTP_USER", "").strip()
            password = (config or {}).get("smtp_password") \
                or os.environ.get("SMTP_PASSWORD", "")
            if user:
                server.login(user, password)
            server.send_message(msg)
        return True
    except Exception:
        logger.exception("reset code email delivery failed")
        return False


def recent_reset_codes():
    """TEST-PHASE: undelivered codes for the admin dashboard (this instance)."""
    with _RECENT_LOCK:
        return [dict(item) for item in _RECENT_CODES]


def _remember_code(user_id, email, code, expires_at):
    created = _utcnow()
    with _RECENT_LOCK:
        _RECENT_CODES.append({
            "user_id": user_id,
            "email": email,
            "code": code,
            "expires_at": expires_at.isoformat(),
            "created_at": created.isoformat(),
        })
        del _RECENT_CODES[:-_RECENT_CAP]


@bp.post("/forgot-password")
def forgot_password():
    payload = request.get_json(silent=True) or {}
    email = payload.get("email")
    if not isinstance(email, str) or not email.strip():
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Email zaroori hai."}}), 400
    email = email.strip().lower()

    delivered = False
    conn = None
    try:
        conn = _conn()
        cur = conn.cursor()
        cur.execute(
            f"SELECT id FROM {_q(USERS_TABLE)} WHERE {_q(USER_EMAIL_COL)} = %s LIMIT 1",
            (email,),
        )
        row = cur.fetchone()
        if row:
            user_id = row[0]
            code = _generate_code()
            expires_at = _utcnow() + timedelta(minutes=CODE_TTL_MINUTES)
            cur.execute(
                f"INSERT INTO {_q(TOKENS_TABLE)} (user_id, token_hash, expires_at) "
                f"VALUES (%s, %s, %s) RETURNING id",
                (user_id, _code_hash(code), expires_at),
            )
            conn.commit()

            if _smtp_configured():
                delivered = _send_email(email, code)
            if delivered:
                logger.info("password reset code emailed user_id=%s", user_id)
            else:
                # No SMTP on the free tier: code goes to the runtime log AND
                # the admin dashboard (reset-codes endpoint) — never to the user.
                logger.warning(
                    "password reset code user_id=%s code=%s (SMTP not configured)",
                    user_id, code,
                )
                _remember_code(user_id, email, code, expires_at)
        else:
            # Same response either way — no account enumeration.
            logger.info("forgot-password requested for unknown email")
    except Exception:
        logger.exception("forgot-password failed")
        if conn is not None:
            try:
                conn.rollback()
            except Exception:
                pass
        return jsonify({"error": {"code": "reset_unavailable",
                                  "message": "Could not start password reset. Try again."}}), 503
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    return jsonify({"ok": True, "delivered": delivered}), 200


@bp.post("/reset-password")
def reset_password():
    payload = request.get_json(silent=True) or {}
    code = payload.get("code")
    new_password = payload.get("password")

    if not isinstance(code, str) or not code.strip():
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Reset code zaroori hai."}}), 400
    if not isinstance(new_password, str) or len(new_password) < 8:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Password kam az kam 8 characters ka ho."}}), 400
    code = code.strip()

    conn = None
    try:
        conn = _conn()
        cur = conn.cursor()

        cur.execute(
            f"SELECT id, user_id, expires_at, attempts FROM {_q(TOKENS_TABLE)} "
            f"WHERE token_hash = %s AND used_at IS NULL "
            f"ORDER BY id DESC LIMIT 1",
            (_code_hash(code),),
        )
        row = cur.fetchone()
        if not row:
            return jsonify({"error": {"code": "invalid_code",
                                      "message": "Code galat hai. Dobara check karein."}}), 400

        token_id, user_id, expires_at, attempts = row
        now = _utcnow()
        if isinstance(expires_at, datetime) and expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if isinstance(expires_at, datetime) and expires_at < now:
            return jsonify({"error": {"code": "code_expired",
                                      "message": "Code expire ho gaya. Naya code mangwayein."}}), 400
        if int(attempts or 0) >= CODE_MAX_ATTEMPTS:
            return jsonify({"error": {"code": "too_many_attempts",
                                      "message": "Bohat zyada koshishen. Naya code mangwayein."}}), 400

        cur.execute(
            f"UPDATE {_q(TOKENS_TABLE)} SET used_at = NOW() WHERE id = %s",
            (token_id,),
        )
        new_hash = generate_password_hash(new_password)
        cur.execute(
            f"SELECT 1 FROM {_q(CREDS_TABLE)} WHERE user_id = %s",
            (user_id,),
        )
        if cur.fetchone():
            cur.execute(
                f"UPDATE {_q(CREDS_TABLE)} SET password_hash = %s, "
                f"password_changed_at = now(), failed_attempt_count = 0, "
                f"locked_until = NULL, updated_at = now() WHERE user_id = %s",
                (new_hash, user_id),
            )
        else:
            cur.execute(
                f"INSERT INTO {_q(CREDS_TABLE)} (user_id, password_hash, "
                f"password_changed_at) VALUES (%s, %s, now())",
                (user_id, new_hash),
            )
        conn.commit()
        logger.info("password reset completed user_id=%s", user_id)
    except Exception:
        logger.exception("reset-password failed")
        if conn is not None:
            try:
                conn.rollback()
            except Exception:
                pass
        return jsonify({"error": {"code": "reset_unavailable",
                                  "message": "Reset failed. Try again."}}), 503
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    return jsonify({"ok": True}), 200
