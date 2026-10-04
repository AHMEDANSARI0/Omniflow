"""Admin panel provider inputs (Integrations page) + weekly report mail.

The owner types provider keys ONCE in the admin panel - email
(SMTP/Brevo), the LLM engine, the AI feature switches, and the
future-channel credentials (voice, video, payments, phone
verification, the WhatsApp E2E test number) - and every feature that
was parked on "needs a key" lights up as soon as its group is saved.
Storage lives in platform_settings (see that module); this module is
the admin API (service-key guarded, same as admin_users) plus the two
email actions the panel exposes: a send-test-email button and a
send-the-weekly-report-now button.

Secrets are write-only through this API: GET returns masked values and
a blank value on PUT keeps the stored secret (the catalog-sync rule).
"""

import json
import logging
import os
import re
import secrets as _secrets
import smtplib
from email.message import EmailMessage

import urllib.request

from flask import Blueprint, jsonify, request

import platform_settings
import portal_db

logger = logging.getLogger("omniflow.admin-providers")

bp = Blueprint("admin_providers", __name__,
               url_prefix="/api/v1/admin")

MASK = "\u2022\u2022\u2022\u2022"
MAX_CLIENTS_PER_RUN = 50

PROVIDER_WHITELISTS = {
    "email.provider": ("smtp", "brevo"),
    "voice.provider": ("twilio",),
    "video.provider": ("whereby", "daily", "zoom"),
    "payments.provider": ("stripe",),
    "ai.kill_switch": ("on", "off"),
    "ai.autonomy_cap": ("off", "suggest", "auto"),
    "ai.guard_mode": ("off", "standard", "strict"),
    "embeddings.mode": ("on", "off"),
    # D5 voice + vision switches
    "vision.mode": ("on", "off"),
    "assistant.mode": ("on", "off"),
    "stt.mode": ("on", "off"),
    "voice.ai_loop": ("on", "off"),
    "voice.signature_check": ("enforce", "log", "off"),
}

#: Groups whose whitelisted values are case-insensitive switches.
LOWERCASE_SWITCH_GROUPS = ("ai", "embeddings", "vision", "stt", "voice",
                           "assistant")

# Numeric settings (blank = unset).
NUMERIC_KEYS = {"ai.daily_call_cap": (0, 1000000),
                "embeddings.dimensions": (0, 4096),
                "embeddings.min_similarity": (0, 100),
                "assistant.daily_limit": (0, 100000)}


def _authorized() -> bool:
    key = request.headers.get("X-Omniflow-Key", "")
    if not key:
        return False
    accepted = [
        os.environ.get("OMNIFLOW_SERVICE_KEY"),
        os.environ.get("OMNIFLOW_ADMIN_API_KEY"),
    ]
    return any(k for k in accepted if k and _secrets.compare_digest(key, k))


@bp.before_request
def _guard():
    if request.method == "OPTIONS":
        return None
    if not _authorized():
        return jsonify({"error": {"code": "forbidden",
                                  "message": "Service key missing or invalid."}}), 403


def _mask(value: str) -> str:
    value = str(value or "")
    if not value:
        return ""
    return MASK + value[-4:] if len(value) > 4 else MASK


def _is_secret(group: str, name: str) -> bool:
    full = group + "." + name
    if full in ("payments.secret_key", "payments.webhook_secret",
                "payments.publishable_key"):
        return True
    return any(hint in name for hint in platform_settings.SECRET_HINTS)


def _configured(group: str, values: dict) -> bool:
    """Minimum bar for the panel's Saved chip, per group."""
    if group == "email":
        if str(values.get("provider") or "smtp") == "brevo":
            return bool(values.get("brevo_api_key"))
        return bool(values.get("smtp_host"))
    if group == "llm":
        return bool(values.get("api_key"))
    if group == "voice":
        return bool(values.get("account_sid")
                    and values.get("auth_token"))
    if group == "video":
        return bool(values.get("api_key"))
    if group == "payments":
        return bool(values.get("secret_key"))
    if group == "flags":
        return any(v == "on" for v in values.values())
    if group == "whatsapp_e2e":
        return bool(values.get("live_number"))
    if group == "ai":
        return any(str(v or "").strip() for v in values.values())
    if group == "embeddings":
        return any(str(v or "").strip() for v in values.values())
    if group == "vision":
        return any(str(v or "").strip() for v in values.values())
    if group == "assistant":
        return any(str(v or "").strip() for v in values.values())
    if group == "stt":
        return bool(values.get("api_key"))
    if group == "router":
        return any(str(v or "").strip() for v in values.values())
    return False


@bp.get("/providers")
def list_providers():
    groups = {}
    for group in platform_settings.GROUP_KEYS:
        stored = platform_settings.get_group(group)
        out = {}
        for name in platform_settings.GROUP_KEYS[group]:
            value = str(stored.get(name) or "")
            out[name] = _mask(value) if _is_secret(group, name) else value
        out["configured"] = _configured(group, stored)
        groups[group] = out
    return jsonify({"groups": groups}), 200


def _clean_group(group: str, raw: dict):
    """Whitelist-filter one group's values. Returns (values, error)."""
    allowed = platform_settings.GROUP_KEYS.get(group)
    if allowed is None:
        return None, "group must be one of: " + ", ".join(
            sorted(platform_settings.GROUP_KEYS))
    if not isinstance(raw, dict):
        return None, "values object is required."
    values = {}
    for name, value in raw.items():
        if name not in allowed:
            continue
        text = "" if value is None else str(value).strip()
        full = group + "." + name
        if group == "router":
            import portal_model_router

            text, router_error = portal_model_router.clean_value(name, text)
            if router_error:
                return None, router_error
        if full in PROVIDER_WHITELISTS:
            text = text.lower() if group in LOWERCASE_SWITCH_GROUPS \
                and full != "voice.provider" else text
            if text and text not in PROVIDER_WHITELISTS[full]:
                return None, (full + " must be one of: "
                              + ", ".join(PROVIDER_WHITELISTS[full]) + ".")
        if full in NUMERIC_KEYS and text:
            low, high = NUMERIC_KEYS[full]
            if not text.isdigit() or not low <= int(text) <= high:
                return None, (full + " must be a whole number between "
                              + str(low) + " and " + str(high) + ".")
        if full == "voice.greeting" and len(text) > 200:
            return None, "voice.greeting must be 200 characters or fewer."
        if full == "voice.webhook_base" and text:
            text = text.rstrip("/")
            if platform_settings.clean_webhook_base(text) != text:
                return None, ("voice.webhook_base must be the public https"
                              " address of the Control Plane, e.g."
                              " https://cp.example.com (no query).")
        if full == "email.smtp_port":
            if text and (not text.isdigit() or not 1 <= int(text) <= 65535):
                return None, "email.smtp_port must be a port number."
        if full == "email.reports_to" and text and "@" not in text:
            return None, "email.reports_to must be an email address."
        if full == "flags.phone_verification":
            text = text.lower()
            if text not in ("on", "off"):
                return None, "flags.phone_verification must be on or off."
        if name in ("true_sentiment", "kb_autodraft"):
            text = text.lower()
            if text not in ("on", "off"):
                return None, full + " must be on or off."
        values[name] = text
    return values, None


@bp.put("/providers")
def put_providers():
    payload = request.get_json(silent=True) or {}
    group = str(payload.get("group") or "").strip()
    values, error = _clean_group(group, payload.get("values"))
    if error is not None:
        return jsonify({"error": {"code": "bad_request",
                                  "message": error}}), 400
    stored = platform_settings.get_group(group)
    kept_blank = []
    for name, text in list(values.items()):
        if text == "" and _is_secret(group, name) \
                and str(stored.get(name) or ""):
            values.pop(name)
            kept_blank.append(name)
    if not values:
        return jsonify({"ok": True, "kept_blank": kept_blank,
                        "configured": _configured(group, stored)}), 200
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                platform_settings._ensure(cur)
                platform_settings.put_group(cur, group, values)
                portal_db.log_action(
                    cur, 0, "providers.updated", "platform_admin", None,
                    None, "group=" + group + " keys="
                    + ",".join(sorted(values))
                    + (" kept_blank=" + ",".join(kept_blank)
                       if kept_blank else ""),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(
            error, "platform settings")[0]), 503
    platform_settings.invalidate_cache()
    stored = platform_settings.get_group(group)
    return jsonify({"ok": True, "kept_blank": kept_blank,
                    "configured": _configured(group, stored)}), 200


def _deliver_email(to_address: str, subject: str, body: str):
    """Send via the saved config (Brevo API or SMTP); (ok, detail)."""
    config = platform_settings.smtp_config()
    try:
        if config["provider"] == "brevo":
            if not config["brevo_api_key"]:
                return False, "Brevo API key is not set."
            payload = json.dumps({
                "sender": _split_from(config["smtp_from"]),
                "to": [{"email": to_address}],
                "subject": subject,
                "textContent": body,
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
                if resp.status < 200 or resp.status >= 300:
                    return False, "Brevo returned HTTP " + str(resp.status)
            return True, "sent via Brevo"
        if not config["smtp_host"]:
            return False, "SMTP host is not set."
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = config["smtp_from"] or "OmniFlow <no-reply@omniflow.app>"
        msg["To"] = to_address
        msg.set_content(body)
        port = int(config["smtp_port"] or "587")
        with smtplib.SMTP(config["smtp_host"], port, timeout=15) as server:
            server.starttls()
            if config["smtp_user"]:
                server.login(config["smtp_user"],
                             config["smtp_password"])
            server.send_message(msg)
        return True, "sent via SMTP"
    except Exception as error:
        logger.warning("admin email delivery failed: %s", error)
        return False, str(error) or "delivery failed"


def _split_from(from_value: str):
    """'OmniFlow <no-reply@x>' -> {name, email} for Brevo."""
    text = str(from_value or "").strip()
    if "<" in text and text.endswith(">"):
        name = text[:text.index("<")].strip()
        email = text[text.index("<") + 1:text.rindex(">")].strip()
        payload = {"email": email}
        if name:
            payload["name"] = name
        return payload
    return {"email": text or "no-reply@omniflow.app"}


def _recipient(explicit: str) -> str:
    if explicit:
        return explicit.strip()
    return platform_settings.smtp_config()["reports_to"]


@bp.post("/email/test")
def email_test():
    payload = request.get_json(silent=True) or {}
    to_address = _recipient(str(payload.get("to") or ""))
    if not to_address or "@" not in to_address:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Set a recipient: type an"
                                             " email or save 'Reports"
                                             " to' first."}}), 400
    ok, detail = _deliver_email(
        to_address, "OmniFlow test email",
        "This is a test email from your OmniFlow admin panel.\n"
        "If you can read this, the email integration works.")
    return (jsonify({"ok": True, "detail": detail}), 200) if ok else \
        (jsonify({"error": {"code": "delivery_failed",
                            "message": detail}}), 502)


@bp.post("/weekly-report/send")
def weekly_report_send():
    payload = request.get_json(silent=True) or {}
    to_address = _recipient(str(payload.get("to") or ""))
    if not to_address or "@" not in to_address:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Set a recipient: type an"
                                             " email or save 'Reports"
                                             " to' first."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT client_id FROM "
                    + portal_db._q("portal_conversations") +
                    " GROUP BY client_id ORDER BY client_id LIMIT %s",
                    (MAX_CLIENTS_PER_RUN,),
                )
                clients = [int(r["client_id"]) for r in portal_db.rows(cur)]
                rows = []
                for client_id in clients:
                    rows.append(_client_week(cur, conn, client_id))
                portal_db.log_action(
                    cur, 0, "weekly_report.sent", "platform_admin", None,
                    None, "clients=" + str(len(rows)) + " to=" + to_address,
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(
            error, "weekly report")[0]), 503
    if not rows:
        return jsonify({"error": {"code": "not_found",
                                  "message": "No workspaces to report on"
                                             " yet."}}), 404
    ok, detail = _deliver_email(
        to_address, "OmniFlow weekly report",
        _render_weekly(rows))
    if not ok:
        return jsonify({"error": {"code": "delivery_failed",
                                  "message": detail}}), 502
    return jsonify({"ok": True, "detail": detail,
                    "clients": len(rows)}), 200


def _client_week(cur, conn, client_id: int) -> dict:
    """One workspace's last-7-days counters (4 cheap queries)."""
    week = "created_at > NOW() - INTERVAL '7 days'"
    out = {"client_id": client_id}
    cur.execute(
        "SELECT COUNT(*) AS n FROM " + portal_db._q("portal_conversations")
        + " WHERE client_id = %s AND " + week, (client_id,))
    out["conversations"] = int(portal_db.rows(cur)[0]["n"])
    cur.execute(
        "SELECT COUNT(*) AS n FROM " + portal_db._q("portal_messages")
        + " WHERE client_id = %s AND " + week, (client_id,))
    out["messages"] = int(portal_db.rows(cur)[0]["n"])
    cur.execute(
        "SELECT COALESCE(SUM(recipient_count), 0) AS n FROM "
        + portal_db._q("portal_broadcasts")
        + " WHERE client_id = %s AND " + week, (client_id,))
    out["broadcast_recipients"] = int(portal_db.rows(cur)[0]["n"])
    try:
        cur.execute(
            "SELECT COUNT(*) AS paid, COALESCE(SUM(total), 0) AS amount"
            " FROM " + portal_db._q("portal_checkout_links")
            + " WHERE client_id = %s AND status = 'paid' AND " + week,
            (client_id,))
        row = portal_db.rows(cur)[0]
        out["paid_orders"] = int(row["paid"])
        out["paid_total"] = int(row["amount"])
    except Exception:
        # checkout tables land lazily; a workspace that never opened
        # the checkout feature simply reports zeros.
        conn.rollback()
        out["paid_orders"] = 0
        out["paid_total"] = 0
    return out


def _render_weekly(rows: list) -> str:
    lines = ["OmniFlow weekly report (last 7 days)", ""]
    for row in rows:
        lines.append(
            "Workspace #" + str(row["client_id"])
            + ": " + str(row["conversations"]) + " conversations, "
            + str(row["messages"]) + " messages, "
            + str(row["broadcast_recipients"]) + " broadcast recipients, "
            + str(row["paid_orders"]) + " paid orders (Rs "
            + str(row["paid_total"]) + ").")
    lines.append("")
    lines.append("Sent by the OmniFlow admin panel.")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# D5: phone numbers -> workspaces (the Twilio account is platform-owned, so
# only the platform admin decides which number answers for which workspace)
# ---------------------------------------------------------------------------

@bp.get("/voice/numbers")
def list_voice_numbers():
    import portal_voice
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                numbers = portal_voice.list_number_assignments(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(
            error, "voice numbers")[0]), 503
    return jsonify({"numbers": numbers}), 200


@bp.put("/voice/numbers")
def put_voice_number():
    import portal_voice
    payload = request.get_json(silent=True) or {}
    try:
        client_id = int(payload.get("client_id") or 0)
    except (TypeError, ValueError):
        client_id = 0
    if client_id <= 0:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "client_id is required."}}), 400
    number = str(payload.get("number") or "").strip()
    if number and not portal_voice.valid_e164(number):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Use the full international"
                                             " format, e.g. +14155550100."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                result = portal_voice.assign_number(cur, client_id, number)
                if result.get("error"):
                    conn.rollback()
                    return jsonify({"error": {"code": "conflict",
                                              "message": result["error"]}}), 409
                portal_db.log_action(
                    cur, client_id, "voice.number_assigned",
                    "platform_admin", None, None,
                    ("Phone number " + (number[-4:] if number else "removed")
                     )[:200],
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(
            error, "voice numbers")[0]), 503
    return jsonify({"ok": True, "client_id": client_id,
                    "number": result.get("number", "")}), 200



# ---------------------------------------------------------------------------
# §214: Twilio number setup from the panel (no manual console step)
# ---------------------------------------------------------------------------

_PN_SID = re.compile(r"^PN[0-9a-fA-F]{32}$")


def _twilio_keys_or_error():
    import portal_voice

    keys = portal_voice._voice_keys()
    if not (keys.get("account_sid") and keys.get("auth_token")):
        return None, (jsonify({"error": {
            "code": "not_configured",
            "message": "Save the Twilio Account SID and auth token in the"
                       " Voice channel group first."}}), 409)
    return keys, None


def _assigned_by_digits() -> dict:
    import portal_voice

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                rows = portal_voice.list_number_assignments(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception:
        return {}
    return {portal_voice._digits(r["number"]): r["client_id"]
            for r in rows if r.get("number")}


@bp.get("/voice/twilio")
def list_twilio_numbers_route():
    import portal_voice

    keys, error = _twilio_keys_or_error()
    if error:
        return error
    base, source = portal_voice.webhook_base()
    try:
        raw, truncated = portal_voice.list_twilio_numbers(keys)
    except portal_voice.TwilioApiError as failure:
        return jsonify({"error": {"code": "twilio_error",
                                  "message": "Twilio: " + failure.message}}), \
            502
    assigned = _assigned_by_digits()
    numbers = []
    for item in raw:
        public = portal_voice.twilio_number_state(item, base)
        public["assigned_client_id"] = assigned.get(
            portal_voice._digits(public["phone_number"]))
        numbers.append(public)
    return jsonify({
        "base_url": base, "base_source": source,
        "voice_url": (base + portal_voice.INCOMING_PATH) if base else "",
        "status_url": (base + portal_voice.STATUS_PATH) if base else "",
        "numbers": numbers, "truncated": truncated,
    }), 200


@bp.post("/voice/twilio/connect")
def connect_twilio_number_route():
    import portal_voice

    payload = request.get_json(silent=True) or {}
    sid = str(payload.get("sid") or "").strip()
    if not _PN_SID.match(sid):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Pick a number from the"
                                             " Twilio list."}}), 400
    keys, error = _twilio_keys_or_error()
    if error:
        return error
    base, source = portal_voice.webhook_base()
    if not base:
        return jsonify({"error": {
            "code": "no_webhook_base",
            "message": "Set the Control Plane address (Voice channel >"
                       " Webhook address) first."}}), 409
    try:
        current = portal_voice.get_twilio_number(keys, sid)
        state = portal_voice.twilio_number_state(current, base)
        if state["state"] in ("app", "trunk"):
            what = "a TwiML app" if state["state"] == "app" else "a SIP trunk"
            return jsonify({"error": {
                "code": "number_in_use",
                "message": "This number is handled by " + what + " in"
                           " Twilio, so Twilio ignores webhook URLs. Remove"
                           " it from the number in the Twilio console, then"
                           " connect again."}}), 409
        updated = portal_voice.connect_twilio_number(keys, sid, base)
    except portal_voice.TwilioApiError as failure:
        status = 404 if failure.status == 404 else 502
        return jsonify({"error": {"code": "twilio_error",
                                  "message": "Twilio: " + failure.message}}), \
            status
    public = portal_voice.twilio_number_state(updated or current, base)
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                portal_db.log_action(
                    cur, 0, "voice.twilio_connected", "platform_admin",
                    None, None,
                    ("Twilio number ..." + public["phone_number"][-4:]
                     + " -> " + (portal_voice._host_of(base) or "?")
                     + " (" + source + ")")[:200])
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass
    return jsonify({"ok": True, "number": public, "base_url": base}), 200


# ---------------------------------------------------------------------------
# §223 Secrets vault - status + "Encrypt stored secrets" (service key only)
# ---------------------------------------------------------------------------

@bp.get("/security/vault")
def vault_status_route():
    import portal_vault
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                report = portal_vault.scan(cur, migrate=False)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(
            error, "secrets vault")[0]), 503
    return jsonify(report), 200


@bp.post("/security/vault/migrate")
def vault_migrate_route():
    import portal_vault
    state = portal_vault.status()
    if not state["configured"]:
        return jsonify({"error": {
            "code": "vault_not_configured",
            "message": {
                "library_missing": "The Control Plane is missing the"
                                   " cryptography package - redeploy"
                                   " with the updated requirements.txt.",
                "key_too_short": "OF_SECRETS_KEY must be at least "
                                 + str(state["min_key_chars"])
                                 + " characters.",
            }.get(state["problem"], "Set OF_SECRETS_KEY in the Control"
                                    " Plane environment, redeploy, then"
                                    " try again."),
        }, "status": state}), 409
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                report = portal_vault.scan(cur, migrate=True)
                portal_db.log_action(
                    cur, 0, "security.vault_migrated", "platform_admin",
                    None, None,
                    ("resealed=" + str(report["totals"]["resealed"])
                     + " remaining=" + str(report["remaining"])
                     + " unreadable=" + str(report["totals"]["unreadable"])
                     + " key=" + state["key_id"])[:200])
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(
            error, "secrets vault")[0]), 503
    platform_settings.invalidate_cache()
    return jsonify(report), 200
