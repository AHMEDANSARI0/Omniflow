"""Notification service (MASTER-UPGRADE platform service): ONE fan-out for
everything that must reach the owner - an AI handoff, an approval waiting
for a 1/0, a dead delivery, a failed workflow run, a configuration
problem.

    portal_notify.notify(client_id, "escalation", "AI handed off a chat",
                         detail, severity="normal",
                         dedupe_key="conv:42", conversation_id=42)

does three things and never raises:

* in-app: ``portal_alerts.raise_alert`` (the bell + the Daily brief block;
  the tenant's alerts toggle and the unread-dedupe law stay exactly as
  they are);
* email: through the platform's saved SMTP / Brevo config
  (``admin_providers._deliver_email``) when THIS tenant switched email on
  for that kind and severity (opt-in; missing settings row = in-app only;
  recipient = the saved address or the workspace's first user); the send
  runs on a background thread so a slow mail server never stalls the
  message loop;
* ledger: one ``portal_notifications`` row per notification saying what
  went where (the owner's "recent notifications" list, and the honest
  answer to "did the email go out?").

Design laws:
  * callers do NOT pass their cursor - the service uses its own short
    connection, so a notification never rides (or breaks) the caller's
    transaction and pinned slot layouts stay untouched;
  * dedupe: when the same unread alert already exists (same kind +
    dedupe_key) no second email goes out either;
  * kinds are a registry (``KINDS``) the settings UI renders from - no
    per-kind toggles hard-coded in the web layer;
  * owner API: settings GET/PUT (human-only writes), recent list, and a
    synchronous "send a test" so the owner sees the real delivery result.
"""

import json
import logging
import os
import threading
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_db
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)

logger = logging.getLogger("omniflow.portal-notify")

bp = Blueprint("portal_notify", __name__, url_prefix="/api/v1/portal")

LEDGER_TABLE = "portal_notifications"
SETTINGS_TABLE = "portal_notify_settings"

#: (key, label, description) - the settings card renders its toggles from
#: this list, so adding a kind here is the whole change.
KINDS: Tuple[Tuple[str, str, str], ...] = (
    ("escalation", "Handoffs",
     "The AI or a workflow handed a chat to your team."),
    ("approval", "Approvals",
     "An AI action is waiting for your 1 / 0."),
    ("delivery", "Failed deliveries",
     "A message or COD confirmation could not be delivered."),
    ("workflow", "Workflow problems", "A workflow run failed."),
    ("knowledge", "Knowledge", "A document import or re-fetch failed."),
    ("system", "System", "Configuration problems and test notifications."),
    ("insights", "Business insights",
     "Weekly summary of problems the detector flagged."),
)
KIND_KEYS = tuple(k for k, _l, _d in KINDS)
SEVERITIES: Tuple[str, ...] = ("normal", "high")

#: Global kill switch for email (in-app alerts keep their own switch).
EMAIL_ENABLED = os.environ.get(
    "OF_NOTIFY_EMAIL", "1").strip().lower() not in ("0", "false", "no", "off")
#: OF_NOTIFY_EMAIL_SYNC=1 sends on the request thread (tests, debugging).
EMAIL_SYNC = os.environ.get(
    "OF_NOTIFY_EMAIL_SYNC", "0").strip().lower() in ("1", "true", "yes", "on")
#: Optional absolute base for links inside emails (e.g. https://app.example.com).
PORTAL_BASE_URL = os.environ.get("OF_PORTAL_BASE_URL", "").strip().rstrip("/")
LIST_LIMIT = 50
MAX_TITLE = 200
MAX_DETAIL = 500

_DDL_READY = False

_DDL = """
CREATE TABLE IF NOT EXISTS portal_notifications (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'normal',
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  conversation_id BIGINT,
  alert_id BIGINT,
  email_to TEXT NOT NULL DEFAULT '',
  email_status TEXT NOT NULL DEFAULT 'off',
  email_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_notifications_client
  ON portal_notifications (client_id, id DESC);
CREATE TABLE IF NOT EXISTS portal_notify_settings (
  client_id BIGINT PRIMARY KEY,
  email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  email_to TEXT NOT NULL DEFAULT '',
  min_severity TEXT NOT NULL DEFAULT 'normal',
  kinds JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""


def _ensure_ddl(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    _DDL_READY = True


# ---------------------------------------------------------------------------
# settings
# ---------------------------------------------------------------------------

def default_settings() -> Dict[str, Any]:
    return {"email_enabled": False, "email_to": "", "min_severity": "normal",
            "kinds": {k: True for k in KIND_KEYS}}


def _shape_settings(row: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    out = default_settings()
    if not row:
        return out
    out["email_enabled"] = bool(row.get("email_enabled"))
    out["email_to"] = str(row.get("email_to") or "").strip()[:200]
    severity = str(row.get("min_severity") or "normal")
    out["min_severity"] = severity if severity in SEVERITIES else "normal"
    raw = row.get("kinds")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = {}
    if isinstance(raw, dict):
        for key in KIND_KEYS:
            if key in raw:
                out["kinds"][key] = bool(raw.get(key))
    return out


def load_settings(cur, client_id: int) -> Dict[str, Any]:
    cur.execute(
        "SELECT email_enabled, email_to, min_severity, kinds FROM "
        + portal_db._q(SETTINGS_TABLE) + " WHERE client_id = %s",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    return _shape_settings(rows[0] if rows else None)


def save_settings(cur, client_id: int, settings: Dict[str, Any]) -> None:
    cur.execute(
        "INSERT INTO " + portal_db._q(SETTINGS_TABLE) +
        " (client_id, email_enabled, email_to, min_severity, kinds,"
        " updated_at) VALUES (%s, %s, %s, %s, CAST(%s AS JSONB), NOW())"
        " ON CONFLICT (client_id) DO UPDATE SET"
        " email_enabled = EXCLUDED.email_enabled,"
        " email_to = EXCLUDED.email_to,"
        " min_severity = EXCLUDED.min_severity,"
        " kinds = EXCLUDED.kinds, updated_at = NOW()",
        (client_id, bool(settings.get("email_enabled")),
         str(settings.get("email_to") or "")[:200],
         str(settings.get("min_severity") or "normal"),
         json.dumps(settings.get("kinds") or {})),
    )


def validate_settings(payload: Any, current: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Merge a PUT payload onto the current settings; (settings, error)."""
    if not isinstance(payload, dict):
        return None, "A JSON object is required."
    out = dict(current)
    out["kinds"] = dict(current.get("kinds") or {})
    if "email_enabled" in payload:
        if not isinstance(payload.get("email_enabled"), bool):
            return None, "email_enabled must be true or false."
        out["email_enabled"] = payload["email_enabled"]
    if "email_to" in payload:
        email = str(payload.get("email_to") or "").strip()
        if email and ("@" not in email or " " in email or len(email) > 200):
            return None, "email_to must be a valid e-mail address."
        out["email_to"] = email
    if "min_severity" in payload:
        severity = str(payload.get("min_severity") or "").strip().lower()
        if severity not in SEVERITIES:
            return None, "min_severity must be normal or high."
        out["min_severity"] = severity
    if "kinds" in payload:
        kinds = payload.get("kinds")
        if not isinstance(kinds, dict):
            return None, "kinds must be an object of booleans."
        for key, value in kinds.items():
            if key not in KIND_KEYS:
                return None, "Unknown notification kind: " + str(key)[:40]
            if not isinstance(value, bool):
                return None, "kinds." + key + " must be true or false."
            out["kinds"][key] = value
    return out, None


def _rank(severity: str) -> int:
    return SEVERITIES.index(severity) if severity in SEVERITIES else 0


def email_configured() -> bool:
    """Is the platform able to send mail at all (admin config or env)?"""
    try:
        import platform_settings

        config = platform_settings.smtp_config()
        if config.get("provider") == "brevo":
            return bool(config.get("brevo_api_key"))
        return bool(config.get("smtp_host"))
    except Exception:
        return False


def owner_email(cur, client_id: int) -> str:
    """Fallback recipient: the workspace's first user (the owner)."""
    try:
        cur.execute(
            "SELECT email FROM " + portal_db._q(portal_db.USERS_TABLE) +
            " WHERE client_id = %s ORDER BY id LIMIT 1",
            (client_id,),
        )
        rows = portal_db.rows(cur)
        return str((rows[0] if rows else {}).get("email") or "").strip()
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# email delivery
# ---------------------------------------------------------------------------

def _deliver(to_address: str, subject: str, body: str) -> Tuple[bool, str]:
    try:
        import admin_providers

        return admin_providers._deliver_email(to_address, subject, body)
    except Exception as error:
        return False, str(error) or "delivery failed"


def _mark_email(ledger_id: int, status: str, error: str = "") -> None:
    """Record the delivery result (own connection; retried briefly so a
    ledger row written on a caller's still-open transaction is found)."""
    import time

    for attempt in range(3):
        try:
            conn = portal_db._conn()
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE " + portal_db._q(LEDGER_TABLE) +
                        " SET email_status = %s, email_error = %s"
                        " WHERE id = %s",
                        (status, str(error or "")[:300], int(ledger_id)),
                    )
                    updated = cur.rowcount
                conn.commit()
            finally:
                conn.close()
            if updated:
                return
        except Exception as problem:
            logger.warning("notification ledger update failed: %s", problem)
        time.sleep(2)


def _email_body(title: str, detail: str, conversation_id: Optional[int]) -> str:
    lines = [title, ""]
    if detail:
        lines += [detail, ""]
    if conversation_id:
        path = "/dashboard/conversations/" + str(int(conversation_id))
        lines.append("Open the conversation: " + (PORTAL_BASE_URL + path
                                                  if PORTAL_BASE_URL else path))
        lines.append("")
    lines.append("- OmniFlow")
    return "\n".join(lines)


def _send(to_address: str, subject: str, body: str, ledger_id: int,
          sync: bool) -> Tuple[str, str]:
    """Send now (sync) or on a daemon thread; returns (status, error)."""
    if sync:
        ok, detail = _deliver(to_address, subject, body)
        status = "sent" if ok else "failed"
        _mark_email(ledger_id, status, "" if ok else detail)
        return status, ("" if ok else detail)

    def _worker() -> None:
        ok, detail = _deliver(to_address, subject, body)
        _mark_email(ledger_id, "sent" if ok else "failed",
                    "" if ok else detail)

    try:
        threading.Thread(target=_worker, daemon=True,
                         name="of-notify-" + str(ledger_id)).start()
        return "queued", ""
    except Exception as error:
        return "failed", str(error)


# ---------------------------------------------------------------------------
# the service
# ---------------------------------------------------------------------------

def notify(client_id: int, kind: str, title: str, detail: str = "",
           severity: str = "normal", dedupe_key: str = "",
           conversation_id: Optional[int] = None, in_app: bool = True,
           alert_id: Optional[int] = None,
           email_sync: bool = False) -> Dict[str, Any]:
    """Fan one notification out to the bell, email and the ledger. Never
    raises; the returned dict says what happened
    ({in_app, email, email_to, ledger_id, error})."""
    result: Dict[str, Any] = {"in_app": alert_id, "email": "off",
                              "email_to": "", "ledger_id": None, "error": ""}
    kind = str(kind or "system")
    if kind not in KIND_KEYS:
        kind = "system"
    severity = str(severity or "normal")
    if severity not in SEVERITIES:
        severity = "normal"
    title = str(title or "").strip()[:MAX_TITLE] or "Notification"
    detail = str(detail or "").strip()[:MAX_DETAIL]
    conv = int(conversation_id) if conversation_id else None
    conn = None
    try:
        conn = portal_db._conn()
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            settings = load_settings(cur, client_id)
            deduped = False
            if in_app:
                import portal_alerts

                if portal_alerts.alerts_on(cur, client_id):
                    new_id = portal_alerts.raise_alert(
                        cur, client_id, kind, title, detail, severity,
                        dedupe_key=dedupe_key)
                    result["in_app"] = new_id
                    deduped = bool(dedupe_key) and new_id is None
                else:
                    result["in_app"] = None
            email_status, email_to = "off", ""
            wants = (EMAIL_ENABLED and settings["email_enabled"]
                     and settings["kinds"].get(kind, True)
                     and _rank(severity) >= _rank(settings["min_severity"]))
            if wants:
                if deduped:
                    email_status = "deduped"
                else:
                    email_to = settings["email_to"] or owner_email(cur, client_id)
                    email_status = "queued" if email_to else "no_recipient"
            cur.execute(
                "INSERT INTO " + portal_db._q(LEDGER_TABLE) +
                " (client_id, kind, severity, title, detail, conversation_id,"
                " alert_id, email_to, email_status)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
                (client_id, kind, severity, title, detail, conv,
                 result["in_app"], email_to, email_status),
            )
            rows = portal_db.rows(cur)
            ledger_id = int((rows[0] if rows else {}).get("id") or 0)
        conn.commit()
        conn.close()
        conn = None
        result.update({"ledger_id": ledger_id or None, "email": email_status,
                       "email_to": email_to})
        if email_status == "queued" and ledger_id:
            status, error = _send(
                email_to, "[OmniFlow] " + title, _email_body(title, detail, conv),
                ledger_id, sync=bool(email_sync or EMAIL_SYNC))
            result["email"] = status
            result["error"] = error
    except Exception as error:
        logger.warning("notify failed (%s): %s", kind, error)
        result["error"] = str(error)[:200]
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
    return result


def list_recent(cur, client_id: int, limit: int = LIST_LIMIT) -> List[Dict[str, Any]]:
    cur.execute(
        "SELECT id, kind, severity, title, detail, conversation_id, alert_id,"
        " email_to, email_status, email_error, created_at FROM "
        + portal_db._q(LEDGER_TABLE) +
        " WHERE client_id = %s ORDER BY id DESC LIMIT %s",
        (client_id, max(1, min(200, int(limit or LIST_LIMIT)))),
    )
    return [_public(r) for r in portal_db.rows(cur)]


def _iso(value: Any) -> Optional[str]:
    if value is None or value == "":
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _public(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": int(row.get("id") or 0),
        "kind": str(row.get("kind") or ""),
        "severity": str(row.get("severity") or "normal"),
        "title": str(row.get("title") or ""),
        "detail": str(row.get("detail") or ""),
        "conversation_id": (int(row["conversation_id"])
                            if row.get("conversation_id") else None),
        "alert_id": int(row["alert_id"]) if row.get("alert_id") else None,
        "email_to": _mask(str(row.get("email_to") or "")),
        "email_status": str(row.get("email_status") or "off"),
        "email_error": str(row.get("email_error") or ""),
        "created_at": _iso(row.get("created_at")),
    }


def _mask(email: str) -> str:
    if "@" not in email:
        return email
    name, domain = email.split("@", 1)
    return (name[:2] + "\u2026" if len(name) > 2 else name) + "@" + domain


def kinds_public() -> List[Dict[str, str]]:
    return [{"key": k, "label": l, "description": d} for k, l, d in KINDS]


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": str(error)}}), 503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}),
                      401)
    return principal, None


def _human_or_error():
    principal, error = _principal_or_error()
    if error:
        return None, error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return None, forbidden
    return principal, None


def _bad(message: str, code: str = "bad_request", status: int = 400):
    return jsonify({"error": {"code": code, "message": message}}), status


@bp.get("/notifications")
def get_notifications():
    """Recent notifications + this tenant's settings + the kind registry."""
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    try:
        limit = int(request.args.get("limit") or LIST_LIMIT)
    except Exception:
        limit = LIST_LIMIT
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            items = list_recent(cur, client_id, limit)
            settings = load_settings(cur, client_id)
        conn.commit()
    finally:
        conn.close()
    return jsonify({"items": items, "settings": settings,
                    "kinds": kinds_public(), "severities": list(SEVERITIES),
                    "email_configured": email_configured()}), 200


@bp.get("/notifications/settings")
def get_settings():
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            settings = load_settings(cur, client_id)
        conn.commit()
    finally:
        conn.close()
    return jsonify({"settings": settings, "kinds": kinds_public(),
                    "email_configured": email_configured()}), 200


@bp.put("/notifications/settings")
def put_settings():
    principal, error = _human_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return _bad("A JSON object is required.")
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            current = load_settings(cur, client_id)
            merged, problem = validate_settings(payload, current)
            if problem:
                conn.rollback()
                return _bad(problem)
            save_settings(cur, client_id, merged)
            portal_db.log_action(
                cur, client_id, "notifications.settings", "customer_user",
                principal.get("user_id"), None,
                "Email " + ("on" if merged["email_enabled"] else "off")
                + ", min severity " + merged["min_severity"],
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "settings": merged}), 200


@bp.post("/notifications/test")
def send_test():
    """Synchronous test through every configured channel - the owner sees
    exactly what a real notification would do."""
    principal, error = _human_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    result = notify(
        client_id, "system", "Test notification",
        "Sent from Settings by " + str(principal.get("email") or "you")
        + ". If you can read this, notifications work.",
        severity="normal", email_sync=True)
    return jsonify({"ok": not result.get("error"), "result": result}), 200
