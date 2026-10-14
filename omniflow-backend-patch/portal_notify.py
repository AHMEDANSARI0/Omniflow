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

§239 templates + rate limits:
  * email templates per kind (subject + body with {title} {detail} {kind}
    {severity} {link}); no saved template = the built-in default, which
    produces exactly the old email. Values are inserted once (a customer's
    text can never inject a variable) and the subject is one line.
  * rate limits per workspace, counted from the ledger (no extra table):
    bell alerts per kind per hour, emails per kind per hour, emails per
    day. High-severity notifications skip the hourly caps; the daily email
    cap holds for everything except "Send a test". A held-back notification
    is still in the ledger (status "limited"); the next email that goes out
    says how many were held back. Owners / admins change limits and
    templates (``OF_NOTIFY_ROLES``).
"""

import json
import logging
import os
import re
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
    ("proactive", "Business alerts",
     "Demand or complaint patterns spotted in recent customer chats (§242)."),
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


def _env_int(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(os.environ.get(name, "") or default)
    except ValueError:
        value = default
    return max(low, min(high, value))


#: §239 rate-limit defaults (a workspace may set its own, 1..LIMIT_MAX).
BELL_PER_HOUR = _env_int("OF_NOTIFY_BELL_PER_HOUR", 30, 1, 100000)
EMAIL_PER_HOUR = _env_int("OF_NOTIFY_EMAIL_PER_HOUR", 6, 1, 100000)
EMAIL_PER_DAY = _env_int("OF_NOTIFY_EMAIL_PER_DAY", 40, 1, 100000)
LIMIT_MAX = _env_int("OF_NOTIFY_LIMIT_MAX", 500, 1, 100000)
LIMIT_DEFAULTS: Tuple[Tuple[str, int], ...] = (
    ("bell_per_hour", BELL_PER_HOUR),
    ("email_per_hour", EMAIL_PER_HOUR),
    ("email_per_day", EMAIL_PER_DAY),
)
LIMIT_KEYS = tuple(key for key, _default in LIMIT_DEFAULTS)
#: Who may change limits and templates.
EDIT_ROLES = frozenset(
    role.strip().lower() for role in
    (os.environ.get("OF_NOTIFY_ROLES", "owner,admin") or "owner,admin").split(",")
    if role.strip())
#: Ledger email statuses that mean "an email was (or is being) sent".
EMAILED = ("queued", "sent", "failed")
_EMAILED_SQL = "('queued', 'sent', 'failed')"

TEMPLATES_TABLE = "portal_notify_templates"
SUBJECT_MAX = 200
BODY_MAX = 2000
RENDERED_MAX = 4000
DEFAULT_SUBJECT = "[OmniFlow] {title}"
DEFAULT_BODY = "{title}\n\n{detail}\n\n{link}\n\n- OmniFlow"
VARIABLES: Tuple[Tuple[str, str], ...] = (
    ("title", "What happened, e.g. \"AI handed off a chat\"."),
    ("detail", "The details line (may be blank)."),
    ("kind", "The kind, e.g. Handoffs."),
    ("severity", "normal or high."),
    ("link", "\"Open the conversation: ...\" (blank when there is no chat)."),
)
VARIABLE_KEYS = tuple(key for key, _d in VARIABLES)
_VAR_RE = re.compile(r"\{([a-z_]+)\}")

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
ALTER TABLE portal_notify_settings ADD COLUMN IF NOT EXISTS bell_per_hour INT;
ALTER TABLE portal_notify_settings ADD COLUMN IF NOT EXISTS email_per_hour INT;
ALTER TABLE portal_notify_settings ADD COLUMN IF NOT EXISTS email_per_day INT;
ALTER TABLE portal_notifications
  ADD COLUMN IF NOT EXISTS in_app_status TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_portal_notifications_recent
  ON portal_notifications (client_id, created_at);
CREATE TABLE IF NOT EXISTS portal_notify_templates (
  client_id BIGINT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, kind)
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
    out: Dict[str, Any] = {"email_enabled": False, "email_to": "",
                           "min_severity": "normal",
                           "kinds": {k: True for k in KIND_KEYS}}
    out.update(LIMIT_DEFAULTS)
    return out


def _limit(value: Any, default: int) -> int:
    """A stored limit (NULL / junk = the platform default)."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return number if 1 <= number <= LIMIT_MAX else default


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
    for key, default in LIMIT_DEFAULTS:
        out[key] = _limit(row.get(key), default)
    return out


def load_settings(cur, client_id: int) -> Dict[str, Any]:
    cur.execute(
        "SELECT email_enabled, email_to, min_severity, kinds,"
        " bell_per_hour, email_per_hour, email_per_day FROM "
        + portal_db._q(SETTINGS_TABLE) + " WHERE client_id = %s",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    return _shape_settings(rows[0] if rows else None)


def save_settings(cur, client_id: int, settings: Dict[str, Any]) -> None:
    # a limit equal to the platform default is stored as NULL, so a later
    # change of the OF_NOTIFY_* default still reaches this workspace
    limits = [None if settings.get(key, default) == default
              else _limit(settings.get(key), default)
              for key, default in LIMIT_DEFAULTS]
    cur.execute(
        "INSERT INTO " + portal_db._q(SETTINGS_TABLE) +
        " (client_id, email_enabled, email_to, min_severity, kinds,"
        " updated_at, bell_per_hour, email_per_hour, email_per_day)"
        " VALUES (%s, %s, %s, %s, CAST(%s AS JSONB), NOW(), %s, %s, %s)"
        " ON CONFLICT (client_id) DO UPDATE SET"
        " email_enabled = EXCLUDED.email_enabled,"
        " email_to = EXCLUDED.email_to,"
        " min_severity = EXCLUDED.min_severity,"
        " kinds = EXCLUDED.kinds, updated_at = NOW(),"
        " bell_per_hour = EXCLUDED.bell_per_hour,"
        " email_per_hour = EXCLUDED.email_per_hour,"
        " email_per_day = EXCLUDED.email_per_day",
        (client_id, bool(settings.get("email_enabled")),
         str(settings.get("email_to") or "")[:200],
         str(settings.get("min_severity") or "normal"),
         json.dumps(settings.get("kinds") or {}), *limits),
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
    for key in LIMIT_KEYS:
        if key in payload:
            value = payload.get(key)
            if (isinstance(value, bool) or not isinstance(value, int)
                    or not 1 <= value <= LIMIT_MAX):
                return None, (key + " must be a whole number from 1 to "
                              + str(LIMIT_MAX) + ".")
            out[key] = value
    return out, None


def can_edit(principal: Dict[str, Any]) -> bool:
    return str(principal.get("role") or "").strip().lower() in EDIT_ROLES


# ---------------------------------------------------------------------------
# §239 rate limits (counted from the ledger)
# ---------------------------------------------------------------------------

def recent_counts(cur, client_id: int, kind: str) -> Dict[str, int]:
    """This kind's bell alerts + emails in the last hour, all emails in the
    last 24h, and emails held back since the last one that went out."""
    cur.execute(
        "SELECT"
        " COUNT(*) FILTER (WHERE n.kind = %s AND n.alert_id IS NOT NULL"
        "   AND n.created_at > NOW() - INTERVAL '1 hour') AS bell_hour,"
        " COUNT(*) FILTER (WHERE n.kind = %s AND n.email_status IN "
        + _EMAILED_SQL + " AND n.created_at > NOW() - INTERVAL '1 hour')"
        "   AS email_hour,"
        " COUNT(*) FILTER (WHERE n.email_status IN " + _EMAILED_SQL + ")"
        "   AS email_day,"
        " COUNT(*) FILTER (WHERE n.email_status = 'limited'"
        "   AND n.id > COALESCE(last.id, 0)) AS held"
        " FROM " + portal_db._q(LEDGER_TABLE) + " n"
        " CROSS JOIN (SELECT MAX(id) AS id FROM " + portal_db._q(LEDGER_TABLE) +
        "   WHERE client_id = %s AND email_status IN " + _EMAILED_SQL + ") last"
        " WHERE n.client_id = %s AND n.created_at > NOW() - INTERVAL '24 hours'",
        (kind, kind, client_id, client_id),
    )
    rows = portal_db.rows(cur)
    row = rows[0] if rows else {}
    return {key: int(row.get(key) or 0)
            for key in ("bell_hour", "email_hour", "email_day", "held")}


# ---------------------------------------------------------------------------
# §239 email templates
# ---------------------------------------------------------------------------

def kind_label(kind: str) -> str:
    return next((label for key, label, _d in KINDS if key == kind), kind)


def clean_template(subject: Any, body: Any) -> Tuple[Optional[Tuple[str, str]], str]:
    """((subject, body), "") or (None, reason)."""
    if not isinstance(subject, str) or not isinstance(body, str):
        return None, "subject and body must be text."
    subject = subject.strip()
    body = body.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not subject or not body:
        return None, "Write a subject and a body (or reset to the default)."
    if "\n" in subject:
        return None, "The subject must be one line."
    if len(subject) > SUBJECT_MAX:
        return None, "Keep the subject under " + str(SUBJECT_MAX) + " characters."
    if len(body) > BODY_MAX:
        return None, "Keep the body under " + str(BODY_MAX) + " characters."
    unknown = sorted(set(_VAR_RE.findall(subject + "\n" + body)) - set(VARIABLE_KEYS))
    if unknown:
        return None, ("Unknown variable {" + unknown[0] + "}. Use "
                      + ", ".join("{" + key + "}" for key in VARIABLE_KEYS) + ".")
    if "{title}" not in subject + body and "{detail}" not in subject + body:
        return None, "Include {title} or {detail} so the email says what happened."
    return (subject, body), ""


def load_template(cur, client_id: int, kind: str) -> Optional[Dict[str, Any]]:
    cur.execute(
        "SELECT subject, body, updated_at FROM " + portal_db._q(TEMPLATES_TABLE) +
        " WHERE client_id = %s AND kind = %s", (client_id, kind))
    rows = portal_db.rows(cur)
    return rows[0] if rows else None


def render_email(template: Optional[Dict[str, Any]], kind: str, severity: str,
                 title: str, detail: str, conversation_id: Optional[int],
                 held: int = 0) -> Tuple[str, str]:
    """(subject, body). Values go in once - text inside a value is never
    read as a variable; the subject is always one line."""
    link = ""
    if conversation_id:
        path = "/dashboard/conversations/" + str(int(conversation_id))
        link = "Open the conversation: " + (PORTAL_BASE_URL + path
                                             if PORTAL_BASE_URL else path)
    values = {"title": title, "detail": detail, "kind": kind_label(kind),
              "severity": severity, "link": link}

    def fill(text: str) -> str:
        return _VAR_RE.sub(lambda m: values.get(m.group(1), m.group(0)), text)

    subject_t = str((template or {}).get("subject") or "") or DEFAULT_SUBJECT
    body_t = str((template or {}).get("body") or "") or DEFAULT_BODY
    subject = (" ".join(fill(subject_t).split())
               or " ".join(title.split()) or "Notification")[:SUBJECT_MAX]
    body = re.sub(r"\n{3,}", "\n\n", fill(body_t)).strip()
    if held > 0:
        body += ("\n\n" + str(held) + " more notification"
                 + (" was" if held == 1 else "s were")
                 + " held back by your email limits - see Settings >"
                 " Notifications.")
    return subject, body[:RENDERED_MAX]


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
    """The built-in body (the default template)."""
    return render_email(None, "system", "normal", title, detail,
                        conversation_id)[1]


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
           email_sync: bool = False,
           bypass_limits: bool = False) -> Dict[str, Any]:
    """Fan one notification out to the bell, email and the ledger. Never
    raises; the returned dict says what happened
    ({in_app, email, email_to, ledger_id, error}). bypass_limits is for
    "Send a test" only."""
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
            counts = recent_counts(cur, client_id, kind)
            # §239: high severity skips the hourly caps; tests skip all
            hourly = not bypass_limits and severity != "high"
            deduped = False
            in_app_status = "shown" if (not in_app and alert_id) else "off"
            if in_app:
                import portal_alerts

                # §239: a fresh database has no alert tables until the
                # first alert - alerts_on() would fail the whole notify
                portal_alerts._ensure_ddl(cur)
                if not portal_alerts.alerts_on(cur, client_id):
                    result["in_app"] = None
                elif hourly and counts["bell_hour"] >= settings["bell_per_hour"]:
                    result["in_app"] = None
                    in_app_status = "limited"
                else:
                    new_id = portal_alerts.raise_alert(
                        cur, client_id, kind, title, detail, severity,
                        dedupe_key=dedupe_key)
                    result["in_app"] = new_id
                    deduped = bool(dedupe_key) and new_id is None
                    in_app_status = ("shown" if new_id else
                                     "deduped" if deduped else "off")
            email_status, email_to = "off", ""
            subject = body = ""
            wants = (EMAIL_ENABLED and settings["email_enabled"]
                     and settings["kinds"].get(kind, True)
                     and _rank(severity) >= _rank(settings["min_severity"]))
            if wants:
                if deduped:
                    email_status = "deduped"
                elif not bypass_limits and (
                        counts["email_day"] >= settings["email_per_day"]
                        or (hourly and counts["email_hour"]
                            >= settings["email_per_hour"])):
                    email_status = "limited"
                else:
                    email_to = settings["email_to"] or owner_email(cur, client_id)
                    email_status = "queued" if email_to else "no_recipient"
            if email_status == "queued":
                subject, body = render_email(
                    load_template(cur, client_id, kind), kind, severity,
                    title, detail, conv, counts["held"])
            cur.execute(
                "INSERT INTO " + portal_db._q(LEDGER_TABLE) +
                " (client_id, kind, severity, title, detail, conversation_id,"
                " alert_id, email_to, email_status, in_app_status)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
                (client_id, kind, severity, title, detail, conv,
                 result["in_app"], email_to, email_status, in_app_status),
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
                email_to, subject, body,
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
        " email_to, email_status, email_error, created_at, in_app_status FROM "
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
        "in_app_status": str(row.get("in_app_status") or ""),
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
                    "email_configured": email_configured(),
                    "limit_max": LIMIT_MAX,
                    "can_edit": can_edit(principal)}), 200


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
    if any(key in payload for key in LIMIT_KEYS) and not can_edit(principal):
        return _bad("Only owners and admins can change notification limits.",
                    "forbidden", 403)
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
                + ", min severity " + merged["min_severity"]
                + ", limits " + "/".join(str(merged[key]) for key in LIMIT_KEYS),
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
    payload = request.get_json(silent=True)
    kind = str((payload or {}).get("kind") or "system") if isinstance(payload, dict) else "system"
    if kind not in KIND_KEYS:
        return _bad("Unknown notification kind.")
    result = notify(
        client_id, kind, "Test notification",
        "Sent from Settings by " + str(principal.get("email") or "you")
        + ". If you can read this, notifications work.",
        severity="normal", email_sync=True, bypass_limits=True)
    return jsonify({"ok": not result.get("error"), "result": result}), 200


# ---------------------------------------------------------------------------
# §239 template API
# ---------------------------------------------------------------------------

SAMPLE = {"title": "AI handed off a chat",
          "detail": "Customer Ali asked for a refund on order #1042.",
          "conversation_id": 42}


def templates_view(cur, client_id: int, principal: Dict[str, Any]) -> Dict[str, Any]:
    cur.execute(
        "SELECT kind, subject, body, updated_at FROM " + portal_db._q(TEMPLATES_TABLE) +
        " WHERE client_id = %s", (client_id,))
    saved = {str(row.get("kind")): row for row in portal_db.rows(cur)}
    items = []
    for key, label, _description in KINDS:
        row = saved.get(key)
        items.append({"kind": key, "label": label, "custom": bool(row),
                      "subject": str(row.get("subject") or "") if row else "",
                      "body": str(row.get("body") or "") if row else "",
                      "updated_at": _iso(row.get("updated_at")) if row else None})
    return {"templates": items,
            "defaults": {"subject": DEFAULT_SUBJECT, "body": DEFAULT_BODY},
            "variables": [{"key": k, "description": d} for k, d in VARIABLES],
            "subject_max": SUBJECT_MAX, "body_max": BODY_MAX,
            "can_edit": can_edit(principal)}


def _editor_or_error():
    principal, error = _human_or_error()
    if error:
        return None, error
    if not can_edit(principal):
        return None, _bad("Only owners and admins can change email templates.",
                          "forbidden", 403)
    return principal, None


@bp.get("/notifications/templates")
def get_templates():
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            view = templates_view(cur, client_id, principal)
        conn.commit()
    finally:
        conn.close()
    return jsonify(view), 200


@bp.put("/notifications/templates/<kind>")
def put_template(kind):
    principal, error = _editor_or_error()
    if error:
        return error
    if kind not in KIND_KEYS:
        return _bad("Unknown notification kind.", "not_found", 404)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return _bad("A JSON object is required.")
    cleaned, problem = clean_template(payload.get("subject"), payload.get("body"))
    if problem:
        return _bad(problem)
    subject, body = cleaned
    client_id = int(principal.get("client_id") or 0)
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "INSERT INTO " + portal_db._q(TEMPLATES_TABLE) +
                " (client_id, kind, subject, body, updated_at)"
                " VALUES (%s, %s, %s, %s, NOW())"
                " ON CONFLICT (client_id, kind) DO UPDATE SET"
                " subject = EXCLUDED.subject, body = EXCLUDED.body,"
                " updated_at = NOW()", (client_id, kind, subject, body))
            portal_db.log_action(
                cur, client_id, "notifications.template", "customer_user",
                principal.get("user_id"), None, "Email template saved: " + kind)
            view = templates_view(cur, client_id, principal)
        conn.commit()
    finally:
        conn.close()
    return jsonify(view), 200


@bp.delete("/notifications/templates/<kind>")
def reset_template(kind):
    principal, error = _editor_or_error()
    if error:
        return error
    if kind not in KIND_KEYS:
        return _bad("Unknown notification kind.", "not_found", 404)
    client_id = int(principal.get("client_id") or 0)
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            cur.execute(
                "DELETE FROM " + portal_db._q(TEMPLATES_TABLE) +
                " WHERE client_id = %s AND kind = %s", (client_id, kind))
            portal_db.log_action(
                cur, client_id, "notifications.template", "customer_user",
                principal.get("user_id"), None, "Email template reset: " + kind)
            view = templates_view(cur, client_id, principal)
        conn.commit()
    finally:
        conn.close()
    return jsonify(view), 200


@bp.post("/notifications/templates/preview")
def preview_template():
    """Render a draft with sample values (nothing is saved or sent)."""
    _principal, error = _human_or_error()
    if error:
        return error
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return _bad("A JSON object is required.")
    kind = str(payload.get("kind") or "system")
    if kind not in KIND_KEYS:
        return _bad("Unknown notification kind.")
    cleaned, problem = clean_template(payload.get("subject"), payload.get("body"))
    if problem:
        return _bad(problem)
    subject, body = render_email(
        {"subject": cleaned[0], "body": cleaned[1]}, kind, "normal",
        SAMPLE["title"], SAMPLE["detail"], SAMPLE["conversation_id"])
    return jsonify({"subject": subject, "body": body}), 200
